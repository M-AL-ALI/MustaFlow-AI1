/**
 * Per-project database provisioning routes (Phase G).
 *
 * POST   /api/projects/:id/database/provision  — provision Postgres or SQLite, inject DATABASE_URL secret
 * GET    /api/projects/:id/database             — get current DB status
 * DELETE /api/projects/:id/database             — deprovision DB and remove DATABASE_URL secret
 * POST   /api/projects/:id/database/query       — run read-only SQL (SELECT only, 200-row limit)
 * GET    /api/projects/:id/database/schema      — get tables + columns
 */

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, secretsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService, maskValue } from "../lib/encryption";
import { logger } from "../lib/logger";

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
async function verifyPostgresConnection(connectionString: string): Promise<boolean> {
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

// ── Neon provisioning (optional — requires NEON_API_KEY env var) ──────────────

async function provisionNeonDatabase(
  projectId: number,
  projectName: string,
): Promise<{ connectionString: string; neonProjectId: string } | null> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return null;

  const safeName = `mf-project-${projectId}-${Date.now()}`;
  const dbName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .slice(0, 32);

  const res = await fetch("https://console.neon.tech/api/v2/projects", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      project: {
        name: safeName,
        pg_version: 16,
        default_database_name: dbName,
        default_role_name: "mustaflow",
        region_id: "aws-us-east-1",
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    logger.error({ err, projectId }, "Neon project creation failed");
    return null;
  }

  const data = (await res.json()) as {
    connection_uris?: Array<{ connection_uri: string }>;
    project?: { id: string };
  };

  const connectionString = data.connection_uris?.[0]?.connection_uri;
  const neonProjectId = data.project?.id;

  if (!connectionString || !neonProjectId) return null;
  return { connectionString, neonProjectId };
}

async function deleteNeonDatabase(neonProjectId: string): Promise<void> {
  const apiKey = process.env.NEON_API_KEY;
  if (!apiKey) return;
  try {
    await fetch(`https://console.neon.tech/api/v2/projects/${neonProjectId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (err) {
    logger.warn({ err, neonProjectId }, "Failed to delete Neon project");
  }
}

// ── POST /api/projects/:id/database/provision ─────────────────────────────────
router.post(
  "/projects/:id/database/provision",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { provider } = req.body as { provider?: string };

    if (provider !== "postgres" && provider !== "sqlite") {
      res.status(400).json({ error: "provider must be 'postgres' or 'sqlite'" });
      return;
    }

    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbStatus === "connected" || project.dbStatus === "provisioning") {
      res.status(400).json({ error: "Database already provisioned for this project" });
      return;
    }

    await db
      .update(projectsTable)
      .set({ dbProvider: provider, dbStatus: "provisioning" })
      .where(eq(projectsTable.id, projectId));

    let connectionString: string;
    let dbConnectionId: string | null = null;

    if (provider === "postgres") {
      const neon = await provisionNeonDatabase(projectId, project.name);
      if (neon) {
        connectionString = neon.connectionString;
        dbConnectionId = neon.neonProjectId;
      } else {
        // Fallback: use a placeholder URL if Neon is not configured.
        // The DATABASE_URL secret will be injected but users need to replace it.
        connectionString = `postgresql://user:password@localhost:5432/project_${projectId}`;
        dbConnectionId = `local-${projectId}`;
        logger.warn(
          { projectId },
          "NEON_API_KEY not set — injecting placeholder Postgres URL. Set NEON_API_KEY to auto-provision real databases.",
        );
      }
    } else {
      // SQLite — path-based connection that lives inside the container volume
      connectionString = `file:/data/db.sqlite`;
      dbConnectionId = `sqlite-${projectId}`;
    }

    try {
      // Upsert the DATABASE_URL secret (encrypted)
      const existing = await db
        .select()
        .from(secretsTable)
        .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));

      const encrypted = encryptionService.encrypt(connectionString);

      if (existing.length > 0) {
        await db
          .update(secretsTable)
          .set({ valueEncrypted: encrypted })
          .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
      } else {
        await db.insert(secretsTable).values({
          projectId,
          name: "DATABASE_URL",
          valueEncrypted: encrypted,
          environment: "production",
          category: "database",
        });
      }

      await db
        .update(projectsTable)
        .set({ dbStatus: "connected", dbConnectionId })
        .where(eq(projectsTable.id, projectId));

      const maskedUrl = maskValue(connectionString);
      res.json({
        dbProvider: provider,
        dbStatus: "connected",
        dbConnectionId,
        maskedUrl,
      });
    } catch (err) {
      logger.error({ err, projectId }, "Database provisioning failed");
      await db
        .update(projectsTable)
        .set({ dbStatus: "error" })
        .where(eq(projectsTable.id, projectId));
      res.status(500).json({ error: "Database provisioning failed" });
    }
  },
);

// ── GET /api/projects/:id/database ───────────────────────────────────────────
router.get(
  "/projects/:id/database",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
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
  },
);

// ── DELETE /api/projects/:id/database ────────────────────────────────────────
router.delete(
  "/projects/:id/database",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.dbProvider === "postgres" && project.dbConnectionId) {
      const looksLikeNeon = !project.dbConnectionId.startsWith("local-");
      if (looksLikeNeon) {
        await deleteNeonDatabase(project.dbConnectionId);
      }
    }

    await db
      .delete(secretsTable)
      .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));

    await db
      .update(projectsTable)
      .set({ dbProvider: "none", dbStatus: "none", dbConnectionId: null })
      .where(eq(projectsTable.id, projectId));

    res.json({ ok: true });
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
      const message = err instanceof Error ? err.message : "Query failed";
      logger.warn({ err, projectId }, "Database query failed");
      res.status(400).json({ error: message });
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

export default router;
