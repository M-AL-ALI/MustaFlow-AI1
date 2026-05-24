/**
 * Shared helpers to capture a project's database snapshot (Postgres JSON dump
 * or SQLite .dump via container exec) and persist a `db_snapshots` row.
 *
 * Extracted from routes/database.ts so the build/refine pipeline can take
 * snapshots automatically on every successful version (Task #538 — Unified
 * Checkpoints).
 */
import { db, dbSnapshotsTable, projectsTable, secretsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { execInContainer } from "./container";
import { encryptionService } from "./encryption";
import { uploadSnapshotBlob } from "./snapshot-storage";
import { logger } from "./logger";

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
 * Capture a full Postgres snapshot as structured JSON (lossless).
 */
export async function generatePostgresDump(connectionString: string): Promise<string> {
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
      const dataResult = await client.query(`SELECT * FROM "${tableName}"`);
      const columns = dataResult.fields.map((f) => f.name);
      const rows = dataResult.rows.map((row) =>
        columns.map((col) => {
          const val = row[col];
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

/**
 * Capture a SQLite snapshot via container exec.
 */
export async function captureSQLiteSnapshot(
  machineId: string,
  projectId: number,
): Promise<string | null> {
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
    "-- MustaFlow SQLite Snapshot",
    `-- Generated: ${new Date().toISOString()}`,
    `-- Provider: sqlite`,
    "",
  ].join("\n");
  return header + result.output;
}

async function getDatabaseUrlSecret(projectId: number): Promise<string | null> {
  const [row] = await db
    .select({ valueEncrypted: secretsTable.valueEncrypted })
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, "DATABASE_URL")));
  if (!row) return null;
  try {
    return encryptionService.decrypt(row.valueEncrypted);
  } catch {
    return null;
  }
}

/**
 * Best-effort: capture a snapshot of the project's database (if any) and
 * persist a `db_snapshots` row linked to the given version. Returns the new
 * snapshot id, or null if no snapshot could be taken (no DB, container off,
 * placeholder connection string, etc.). Never throws — failure is logged.
 */
export async function captureProjectDbSnapshot(
  projectId: number,
  versionId: number,
  label: string,
): Promise<number | null> {
  try {
    const [project] = await db
      .select({
        dbProvider: projectsTable.dbProvider,
        dbStatus: projectsTable.dbStatus,
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    if (!project || project.dbStatus !== "connected" || project.dbProvider === "none") {
      return null;
    }

    let dumpContent: string | null = null;
    if (project.dbProvider === "sqlite") {
      if (!project.containerId || project.containerStatus !== "running") {
        logger.info(
          { projectId, versionId },
          "captureProjectDbSnapshot: SQLite skipped — container not running",
        );
        return null;
      }
      dumpContent = await captureSQLiteSnapshot(project.containerId, projectId);
    } else if (project.dbProvider === "postgres") {
      const connectionString = await getDatabaseUrlSecret(projectId);
      if (!connectionString || connectionString.includes("localhost:5432")) {
        logger.info(
          { projectId, versionId },
          "captureProjectDbSnapshot: Postgres skipped — placeholder/missing DATABASE_URL",
        );
        return null;
      }
      dumpContent = await generatePostgresDump(connectionString);
    }

    if (!dumpContent) return null;
    const sizeBytes = Buffer.byteLength(dumpContent, "utf8");
    const objectKey = await uploadSnapshotBlob(projectId, dumpContent);

    const [snapshot] = await db
      .insert(dbSnapshotsTable)
      .values({
        projectId,
        versionId,
        label,
        provider: project.dbProvider,
        dumpContent: objectKey ? null : dumpContent,
        objectKey,
        isPartial: false,
        sizeBytes,
      })
      .returning({ id: dbSnapshotsTable.id });

    logger.info(
      { projectId, versionId, snapshotId: snapshot?.id, sizeBytes },
      "captureProjectDbSnapshot: snapshot captured",
    );
    return snapshot?.id ?? null;
  } catch (err) {
    logger.warn({ err, projectId, versionId }, "captureProjectDbSnapshot failed (non-fatal)");
    return null;
  }
}
