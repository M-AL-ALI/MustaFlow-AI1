/**
 * Per-project database provisioning routes (Phase G).
 *
 * POST   /api/projects/:id/database/provision              - provision Neon Postgres, inject DATABASE_URL secret
 * GET    /api/projects/:id/database                         — get current DB status
 * DELETE /api/projects/:id/database                         — deprovision DB and remove DATABASE_URL secret
 * POST   /api/projects/:id/database/query                   — run read-only SQL (SELECT only, 200-row limit)
 * GET    /api/projects/:id/database/schema                  — get tables + columns
 * POST   /api/projects/:id/database/snapshots               — capture a database snapshot
 * GET    /api/projects/:id/database/snapshots               — list database snapshots
 * POST   /api/projects/:id/database/snapshots/:sid/restore  — restore a snapshot
 * DELETE /api/projects/:id/database/snapshots/:sid          — delete a snapshot
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  secretsTable,
  dbSnapshotsTable,
  projectVersionsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService, maskValue } from "../lib/encryption";
import { logger } from "../lib/logger";
import { databaseProviderErrorMessage } from "@workspace/ora-contracts";
import { execInContainer } from "../lib/tenant-runtime";
import { restorePostgresDump, restoreSQLiteSnapshot } from "../lib/db-snapshot-restore";
import {
  uploadSnapshotBlob,
  downloadSnapshotBlob,
  deleteSnapshotBlobAndProveAbsent as deleteSnapshotBlob,
} from "../lib/snapshot-storage";
import {
  deleteNeonProjectAndProveAbsent as deleteNeonDatabase,
  lookupNeonProjectsByStableName,
  neonProjectNameFor,
} from "../lib/neon-project-lifecycle";
import {
  holdResponseProjectLifecycleSession,
  requireActiveProjectLifecycleSession,
  responseProjectLifecycleSession,
} from "../lib/project-lifecycle";
import { ensureManualNeonAllocation } from "../lib/manual-neon-allocation";

const router: IRouter = Router();

const ROW_LIMIT = 200;
// ── helpers ───────────────────────────────────────────────────────────────────

async function loadProject(projectId: number) {
  const [p] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return p ?? null;
}

async function getDatabaseUrlSecret(projectId: number): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
  if (!row) return null;
  try {
    return encryptionService.decrypt(row.valueEncrypted);
  } catch {
    return null;
  }
}

function buildStatusResponse(project: {
  dbProvider: string;
  dbStatus: string;
  dbConnectionId: string | null;
}) {
  return {
    dbProvider: project.dbProvider,
    dbStatus: project.dbStatus,
    dbConnectionId: project.dbConnectionId,
    maskedUrl: null as string | null,
  };
}

/**
 * Verify the connection string is reachable by attempting a simple query.
 * Returns true if the DB is accessible, false otherwise.
 */
async function _verifyPostgresConnection(connectionString: string): Promise<boolean> {
  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 8000 });
    await client.connect();
    await client.query("SELECT 1");
    await client.end();
    return true;
  } catch {
    return false;
  }
}

/** Returns the latest version id for a project, or null if none exist. */
async function getLatestVersionId(projectId: number): Promise<number | null> {
  const [row] = await db
    .select({ id: projectVersionsTable.id })
    .from(projectVersionsTable)
    .where(eq(projectVersionsTable.projectId, projectId))
    .orderBy(desc(projectVersionsTable.createdAt))
    .limit(1);
  return row?.id ?? null;
}

// CAS every manual database receipt against the admitted owner and observed
// state. Provider work is outside SQL transactions, but inside the lifecycle
// session; the allocation intent is committed before crossing that boundary.
function manualDatabaseFence(project: NonNullable<Awaited<ReturnType<typeof loadProject>>>) {
  return and(
    eq(projectsTable.id, project.id),
    eq(projectsTable.ownerId, project.ownerId),
    isNull(projectsTable.deletedAt),
    eq(projectsTable.dbProvider, project.dbProvider),
    eq(projectsTable.dbStatus, project.dbStatus),
    project.dbConnectionId === null
      ? isNull(projectsTable.dbConnectionId)
      : eq(projectsTable.dbConnectionId, project.dbConnectionId),
    project.neonProjectId === null
      ? isNull(projectsTable.neonProjectId)
      : eq(projectsTable.neonProjectId, project.neonProjectId),
  );
}

// ── Postgres structured snapshot ──────────────────────────────────────────────

interface TableSnapshot {
  name: string;
  ddl: string;
  columns: string[];
  rows: unknown[][];
}

interface PostgresSnapshotData {
  version: 1;
  provider: "postgres";
  generatedAt: string;
  tables: TableSnapshot[];
}

/**
 * Capture a full Postgres snapshot as structured JSON.
 * No row limit — all rows are captured.
 * The JSON format is lossless and fully replayable: restore uses parameterised
 * INSERT queries so semicolons/newlines in string values never break parsing.
 */
async function generatePostgresDump(connectionString: string): Promise<string> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 30000 });
  await client.connect();

  try {
    const tablesResult = await client.query<{ table_name: string }>(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    const tables: TableSnapshot[] = [];

    for (const { table_name: tableName } of tablesResult.rows) {
      // Column definitions
      const colResult = await client.query<{
        column_name: string;
        data_type: string;
        character_maximum_length: number | null;
        is_nullable: string;
        column_default: string | null;
      }>(
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1
         ORDER BY ordinal_position`,
        [tableName],
      );

      // Primary key columns
      const pkResult = await client.query<{ column_name: string }>(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
         WHERE tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
           AND tc.table_name = $1
         ORDER BY kcu.ordinal_position`,
        [tableName],
      );

      const pkCols = new Set(pkResult.rows.map((r) => r.column_name));

      const colDefs = colResult.rows.map((c) => {
        let typeStr = c.data_type;
        if (c.character_maximum_length) typeStr += `(${c.character_maximum_length})`;
        const notNull = c.is_nullable === "NO" ? " NOT NULL" : "";
        const def = c.column_default ? ` DEFAULT ${c.column_default}` : "";
        return `  "${c.column_name}" ${typeStr}${notNull}${def}`;
      });

      if (pkCols.size > 0) {
        const pkList = [...pkCols].map((c) => `"${c}"`).join(", ");
        colDefs.push(`  PRIMARY KEY (${pkList})`);
      }

      const ddl = `CREATE TABLE "${tableName}" (\n${colDefs.join(",\n")}\n)`;

      // Fetch all rows — no row limit
      const dataResult = await client.query(`SELECT * FROM "${tableName}"`);
      const columns = dataResult.fields.map((f) => f.name);
      const rows = dataResult.rows.map((row) =>
        columns.map((col) => {
          const val = row[col];
          // Normalise dates to ISO strings so JSON round-trips cleanly
          return val instanceof Date ? val.toISOString() : val;
        }),
      );

      tables.push({ name: tableName, ddl, columns, rows });
    }

    const snapshot: PostgresSnapshotData = {
      version: 1,
      provider: "postgres",
      generatedAt: new Date().toISOString(),
      tables,
    };

    return JSON.stringify(snapshot);
  } finally {
    await client.end();
  }
}

// ── SQLite snapshot capture via container exec ───────────────────────────────

/**
 * Capture a SQLite snapshot from the container's /data/db.sqlite via exec.
 * Returns SQL text dump or null if the container is not running / DB missing.
 */
async function captureSQLiteSnapshot(machineId: string, projectId: number): Promise<string | null> {
  const result = await execInContainer(
    machineId,
    ["sh", "-c", "sqlite3 /data/db.sqlite .dump 2>/dev/null || echo '__SQLITE_MISSING__'"],
    projectId,
    "/",
  );

  if (!result.ok || result.output.includes("__SQLITE_MISSING__")) {
    return null;
  }

  const header = [
    "-- NabuFlow SQLite Snapshot",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Provider: sqlite`,
    "",
  ].join("\n");

  return header + result.output;
}

// ── POST /api/projects/:id/database/provision ─────────────────────────────────
router.post(
  "/projects/:id/database/provision",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { provider } = (req.body ?? {}) as { provider?: string };

    if (provider !== "postgres") {
      res.status(400).json({
        code: "database_provider_not_supported",
        error: "New databases must use PostgreSQL on Neon.",
      });
      return;
    }

    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus === "connected") {
      res.status(400).json({ error: "Database already provisioned for this project" });
      return;
    }

    const apiKey = process.env.NEON_API_KEY?.trim();
    if (!apiKey) {
      res.status(503).json({
        code: "neon_not_configured",
        error: "Database setup is unavailable. Please try again later.",
      });
      return;
    }

    const releaseHold = holdResponseProjectLifecycleSession(res);
    const session = responseProjectLifecycleSession(res);
    const observed = { ...project };
    let intentRecorded = project.dbProvider === "postgres" && project.dbStatus !== "none";
    try {
      const saveAllocation = async (neonProjectId?: string): Promise<boolean> => {
        if (!(await session.assertActive())) return false;
        const values = {
          dbProvider: "postgres",
          dbStatus: "provisioning",
          ...(neonProjectId ? { neonProjectId, dbConnectionId: neonProjectId } : {}),
        };
        const rows = await db
          .update(projectsTable)
          .set(values)
          .where(manualDatabaseFence(observed))
          .returning({ id: projectsTable.id });
        if (rows.length !== 1) return false;
        Object.assign(observed, values);
        intentRecorded = true;
        return true;
      };
      const neon = await ensureManualNeonAllocation({
        project,
        apiKey,
        assertActive: () => session.assertActive(),
        store: {
          recordIntent: () => saveAllocation(),
          recordOwnership: (id) => saveAllocation(id),
        },
      });
      if (!neon) throw new Error("neon_allocation_unresolved");
      const { connectionString, neonProjectId: dbConnectionId } = neon;
      const encrypted = encryptionService.encrypt(connectionString);
      if (!(await session.assertActive())) throw new Error("project_inactive");
      // Credential and success receipt either commit together or not at all.
      // Ownership was committed separately and survives a rollback here.
      await db.transaction(async (transaction) => {
        const existing = await transaction
          .select()
          .from(secretsTable)
          .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
        if (existing.length > 0) {
          await transaction
            .update(secretsTable)
            .set({ valueEncrypted: encrypted })
            .where(
              and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")),
            );
        } else {
          await transaction.insert(secretsTable).values({
            projectId,
            name: "DATABASE_URL",
            valueEncrypted: encrypted,
            environment: "production",
            category: "database",
          });
        }
        const rows = await transaction
          .update(projectsTable)
          .set({ dbStatus: "connected", dbConnectionId, neonProjectId: dbConnectionId })
          .where(manualDatabaseFence(observed))
          .returning({ id: projectsTable.id });
        if (rows.length !== 1) throw new Error("neon_allocation_receipt_conflict");
      });

      const maskedUrl = maskValue(connectionString);
      res.json({
        dbProvider: provider,
        dbStatus: "connected",
        dbConnectionId,
        maskedUrl,
      });
    } catch {
      logger.error({ projectId }, "Database provisioning failed");
      if (intentRecorded) {
        await db
          .update(projectsTable)
          .set({ dbStatus: "error" })
          .where(manualDatabaseFence(observed))
          .catch(() => undefined);
      }
      res.status(503).json({
        code: "neon_provisioning_unavailable",
        error:
          "Database setup is not confirmed. Retrying checks the existing attempt without creating another database.",
      });
    } finally {
      await releaseHold();
    }
  },
);

// ── GET /api/projects/:id/database ───────────────────────────────────────────
router.get("/projects/:id/database", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const project = await loadProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const response = buildStatusResponse(project);

  if (project.dbStatus === "connected") {
    const url = await getDatabaseUrlSecret(projectId);
    if (url) response.maskedUrl = maskValue(url);
  }

  res.json(response);
});

// ── DELETE /api/projects/:id/database ────────────────────────────────────────
router.delete(
  "/projects/:id/database",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const releaseHold = holdResponseProjectLifecycleSession(res);
    const session = responseProjectLifecycleSession(res);
    try {
      if (project.dbProvider === "postgres") {
        const knownIds = [
          ...new Set(
            [project.neonProjectId, project.dbConnectionId].filter(
              (id): id is string => id !== null,
            ),
          ),
        ];
        // An uncertain POST can complete after a currently empty catalog. Do
        // not erase its durable intent or allow a new allocation generation.
        if (knownIds.length !== 1 || !/^[A-Za-z0-9_-]{1,128}$/u.test(knownIds[0]!)) {
          throw new Error("neon_allocation_unresolved");
        }
        const stableName = neonProjectNameFor(projectId);
        const before = await lookupNeonProjectsByStableName(stableName);
        if (
          before.kind === "unavailable" ||
          (before.kind === "found" && before.projectIds.some((id) => id !== knownIds[0]))
        ) {
          throw new Error("neon_catalog_unresolved");
        }
        if (!(await session.assertActive()) || !(await deleteNeonDatabase(knownIds[0]!))) {
          throw new Error("neon_deletion_unconfirmed");
        }
        const after = await lookupNeonProjectsByStableName(stableName);
        if (after.kind !== "absent") throw new Error("neon_catalog_unresolved");
      }
      if (!(await session.assertActive())) throw new Error("project_inactive");
      await db.transaction(async (transaction) => {
        await transaction
          .delete(secretsTable)
          .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
        const rows = await transaction
          .update(projectsTable)
          .set({
            dbProvider: "none",
            dbStatus: "none",
            dbConnectionId: null,
            ...(project.dbProvider === "postgres" ? { neonProjectId: null } : {}),
          })
          .where(manualDatabaseFence(project))
          .returning({ id: projectsTable.id });
        if (rows.length !== 1) throw new Error("database_deletion_receipt_conflict");
      });
      res.json({ ok: true });
    } catch {
      res.status(503).json({
        error:
          "Database cleanup is not confirmed. Its ownership and pending setup have been retained.",
        code: "database_provider_cleanup_unconfirmed",
      });
    } finally {
      await releaseHold();
    }
  },
);

// ── POST /api/projects/:id/database/query ────────────────────────────────────
router.post(
  "/projects/:id/database/query",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { sql: userSql } = req.body as { sql?: string };

    if (!userSql || typeof userSql !== "string") {
      res.status(400).json({ error: "sql is required" });
      return;
    }

    const trimmed = userSql.trim().toUpperCase();
    const isSelect =
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("WITH") ||
      trimmed.startsWith("EXPLAIN") ||
      trimmed.startsWith("SHOW");

    if (!isSelect) {
      res.status(400).json({
        error: "Only read-only queries are allowed (SELECT, WITH, EXPLAIN, SHOW).",
      });
      return;
    }

    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus !== "connected") {
      res.status(400).json({ error: "No database provisioned for this project" });
      return;
    }

    if (project.dbProvider === "sqlite") {
      res.status(400).json({
        error:
          "Query browser for SQLite requires an active container. Use the Terminal tab to run sqlite3 queries directly.",
      });
      return;
    }

    const connectionString = await getDatabaseUrlSecret(projectId);
    if (!connectionString || connectionString.includes("localhost:5432")) {
      res.status(400).json({
        error:
          "DATABASE_URL is a placeholder. Replace it with a real Postgres connection string in the Secrets tab.",
      });
      return;
    }

    const start = Date.now();
    try {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
      await client.connect();

      const safeSql = userSql.replace(/\s*;?\s*$/, "") + ` LIMIT ${ROW_LIMIT}`;

      const result = await client.query(safeSql);
      await client.end();

      const executionMs = Date.now() - start;
      const columns = result.fields.map((f) => f.name);
      const rows = result.rows.map((row) => columns.map((col) => row[col] ?? null));
      const truncated = result.rowCount !== null && result.rowCount >= ROW_LIMIT;

      res.json({
        columns,
        rows,
        rowCount: result.rowCount ?? rows.length,
        truncated,
        executionMs,
      });
    } catch (err) {
      logger.warn({ err, projectId }, "Database query failed");
      res.status(400).json({ error: databaseProviderErrorMessage(err) });
    }
  },
);

// ── GET /api/projects/:id/database/schema ────────────────────────────────────
router.get(
  "/projects/:id/database/schema",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus !== "connected") {
      res.status(400).json({ error: "No database provisioned for this project" });
      return;
    }

    if (project.dbProvider === "sqlite") {
      res.status(400).json({
        error:
          "Schema browser for SQLite requires an active container. Use the Terminal tab to inspect the database.",
      });
      return;
    }

    const connectionString = await getDatabaseUrlSecret(projectId);
    if (!connectionString || connectionString.includes("localhost:5432")) {
      res.status(400).json({
        error:
          "DATABASE_URL is a placeholder. Replace it with a real Postgres connection string in the Secrets tab.",
      });
      return;
    }

    try {
      const { default: pg } = await import("pg");
      const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
      await client.connect();

      const tablesResult = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);

      const tables: Array<{
        tableName: string;
        columns: Array<{ name: string; type: string; nullable: boolean; isPrimaryKey: boolean }>;
      }> = [];

      for (const row of tablesResult.rows as Array<{ table_name: string }>) {
        const colResult = await client.query(
          `
          SELECT
            c.column_name,
            c.data_type,
            c.is_nullable,
            COALESCE(
              (
                SELECT true FROM information_schema.key_column_usage kcu
                JOIN information_schema.table_constraints tc
                  ON kcu.constraint_name = tc.constraint_name
                  AND kcu.table_name = tc.table_name
                WHERE tc.constraint_type = 'PRIMARY KEY'
                  AND kcu.table_name = c.table_name
                  AND kcu.column_name = c.column_name
                  AND kcu.table_schema = 'public'
                LIMIT 1
              ),
              false
            ) AS is_primary_key
          FROM information_schema.columns c
          WHERE c.table_schema = 'public' AND c.table_name = $1
          ORDER BY c.ordinal_position
        `,
          [row.table_name],
        );

        tables.push({
          tableName: row.table_name,
          columns: (
            colResult.rows as Array<{
              column_name: string;
              data_type: string;
              is_nullable: string;
              is_primary_key: boolean;
            }>
          ).map((c) => ({
            name: c.column_name,
            type: c.data_type,
            nullable: c.is_nullable === "YES",
            isPrimaryKey: c.is_primary_key,
          })),
        });
      }

      await client.end();
      res.json({ provider: project.dbProvider, tables });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Schema fetch failed";
      logger.warn({ err, projectId }, "Database schema fetch failed");
      res.status(400).json({ error: message });
    }
  },
);

// ── POST /api/projects/:id/database/snapshots ────────────────────────────────
router.post(
  "/projects/:id/database/snapshots",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { label, versionId: bodyVersionId } = req.body as {
      label?: string;
      versionId?: number;
    };

    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus !== "connected") {
      res.status(400).json({ error: "No database provisioned for this project" });
      return;
    }

    // Auto-link to latest version if no versionId provided
    const resolvedVersionId: number | null =
      bodyVersionId != null ? bodyVersionId : await getLatestVersionId(projectId);

    const snapshotLabel =
      label?.trim() ||
      `Snapshot ${new Date().toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

    try {
      let dumpContent: string;

      if (project.dbProvider === "sqlite") {
        // SQLite: use container exec to run sqlite3 .dump
        const machineId = project.containerId;
        if (!machineId || project.containerStatus !== "running") {
          res.status(400).json({
            error:
              "SQLite snapshots require an active container. Start the container first, then take a snapshot.",
          });
          return;
        }

        const dump = await captureSQLiteSnapshot(machineId, projectId);
        if (!dump) {
          res.status(400).json({
            error:
              "Could not read SQLite database from the container. Ensure the container is running and the database file exists at /data/db.sqlite.",
          });
          return;
        }
        dumpContent = dump;
      } else {
        // Postgres — structured JSON snapshot, no row limit
        const connectionString = await getDatabaseUrlSecret(projectId);
        if (!connectionString || connectionString.includes("localhost:5432")) {
          res.status(400).json({
            error:
              "DATABASE_URL is a placeholder. Replace it with a real Postgres connection string in the Secrets tab.",
          });
          return;
        }
        dumpContent = await generatePostgresDump(connectionString);
      }

      const sizeBytes = Buffer.byteLength(dumpContent, "utf8");

      // Prefer GCS for blob storage; fall back to inline DB column
      const objectKey = await uploadSnapshotBlob(projectId, dumpContent);

      const [snapshot] = await db
        .insert(dbSnapshotsTable)
        .values({
          projectId,
          versionId: resolvedVersionId,
          label: snapshotLabel,
          provider: project.dbProvider,
          // Store inline only when GCS is not available
          dumpContent: objectKey ? null : dumpContent,
          objectKey,
          isPartial: false,
          sizeBytes,
        })
        .returning({
          id: dbSnapshotsTable.id,
          projectId: dbSnapshotsTable.projectId,
          versionId: dbSnapshotsTable.versionId,
          label: dbSnapshotsTable.label,
          provider: dbSnapshotsTable.provider,
          sizeBytes: dbSnapshotsTable.sizeBytes,
          isPartial: dbSnapshotsTable.isPartial,
          createdAt: dbSnapshotsTable.createdAt,
        });

      res.status(201).json(snapshot);
    } catch (err) {
      logger.error({ err, projectId }, "Database snapshot capture failed");
      res.status(500).json({ error: databaseProviderErrorMessage(err) });
    }
  },
);

// ── GET /api/projects/:id/database/snapshots ─────────────────────────────────
router.get(
  "/projects/:id/database/snapshots",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const snapshots = await db
      .select({
        id: dbSnapshotsTable.id,
        projectId: dbSnapshotsTable.projectId,
        versionId: dbSnapshotsTable.versionId,
        label: dbSnapshotsTable.label,
        provider: dbSnapshotsTable.provider,
        sizeBytes: dbSnapshotsTable.sizeBytes,
        isPartial: dbSnapshotsTable.isPartial,
        createdAt: dbSnapshotsTable.createdAt,
      })
      .from(dbSnapshotsTable)
      .where(eq(dbSnapshotsTable.projectId, projectId))
      .orderBy(desc(dbSnapshotsTable.createdAt));

    res.json(snapshots);
  },
);

// ── POST /api/projects/:id/database/snapshots/:sid/restore ───────────────────
router.post(
  "/projects/:id/database/snapshots/:sid/restore",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const snapshotId = Number(req.params.sid);
    if (!Number.isFinite(snapshotId)) {
      res.status(400).json({ error: "Invalid snapshot id" });
      return;
    }

    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus !== "connected") {
      res.status(400).json({ error: "No database provisioned for this project" });
      return;
    }

    const [snapshot] = await db
      .select()
      .from(dbSnapshotsTable)
      .where(and(eq(dbSnapshotsTable.id, snapshotId), eq(dbSnapshotsTable.projectId, projectId)));

    if (!snapshot) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    try {
      // Resolve dump content: prefer GCS object, fall back to inline column
      const dumpContent = (await downloadSnapshotBlob(snapshot.objectKey)) ?? snapshot.dumpContent;

      if (!dumpContent) {
        res.status(500).json({ error: "Snapshot content is missing — cannot restore." });
        return;
      }

      let statementsRun: number;
      let errors: number;

      if (snapshot.provider === "postgres") {
        const connectionString = await getDatabaseUrlSecret(projectId);
        if (!connectionString || connectionString.includes("localhost:5432")) {
          res.status(400).json({
            error:
              "DATABASE_URL is a placeholder. Replace it with a real Postgres connection string in the Secrets tab.",
          });
          return;
        }
        ({ statementsRun, errors } = await restorePostgresDump(connectionString, dumpContent));
      } else if (snapshot.provider === "sqlite") {
        const machineId = project.containerId;
        if (!machineId || project.containerStatus !== "running") {
          res.status(400).json({
            error: "SQLite restore requires an active container. Start the container first.",
          });
          return;
        }
        ({ statementsRun, errors } = await restoreSQLiteSnapshot(
          machineId,
          dumpContent,
          projectId,
        ));
      } else {
        res.status(400).json({ error: `Unsupported snapshot provider: ${snapshot.provider}` });
        return;
      }

      logger.info({ projectId, snapshotId, statementsRun, errors }, "Database snapshot restored");
      res.json({
        ok: true,
        snapshotId,
        label: snapshot.label,
        statementsRun,
        errors,
        isPartial: snapshot.isPartial,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Restore failed";
      logger.error({ err, projectId, snapshotId }, "Database snapshot restore failed");
      res.status(500).json({ error: message });
    }
  },
);

// ── DELETE /api/projects/:id/database/snapshots/:sid ─────────────────────────
router.delete(
  "/projects/:id/database/snapshots/:sid",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const snapshotId = Number(req.params.sid);
    if (!Number.isFinite(snapshotId)) {
      res.status(400).json({ error: "Invalid snapshot id" });
      return;
    }

    // Load snapshot first to get objectKey for GCS cleanup
    const [toDelete] = await db
      .select({ id: dbSnapshotsTable.id, objectKey: dbSnapshotsTable.objectKey })
      .from(dbSnapshotsTable)
      .where(and(eq(dbSnapshotsTable.id, snapshotId), eq(dbSnapshotsTable.projectId, projectId)));

    if (!toDelete) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }

    const blobDeleted = await deleteSnapshotBlob(toDelete.objectKey);
    if (!blobDeleted) {
      res.status(503).json({
        error: "The snapshot could not be removed because storage deletion was not confirmed.",
        code: "database_snapshot_storage_cleanup_unconfirmed",
      });
      return;
    }

    await db
      .delete(dbSnapshotsTable)
      .where(and(eq(dbSnapshotsTable.id, snapshotId), eq(dbSnapshotsTable.projectId, projectId)));

    res.json({ ok: true });
  },
);

export default router;
