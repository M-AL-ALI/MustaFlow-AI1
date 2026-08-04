/**
 * Shared database snapshot restore helpers.
 * Used by both routes/database.ts (manual restore) and routes/versions.ts (rollback).
 *
 * ## Postgres restore (JSON format — v1 snapshots)
 *   1. Parse the structured JSON snapshot (tables, DDL, rows).
 *   2. Within a single transaction:
 *      a. DROP each snapshot table CASCADE (removes stale FK constraints).
 *      b. Re-create each table from its captured DDL.
 *      c. INSERT all rows using parameterized queries ($1, $2, …).
 *      d. COMMIT — any error triggers ROLLBACK, leaving the DB unchanged.
 *   Parameterised INSERTs mean semicolons/newlines inside string values
 *   never interfere with statement parsing.
 *
 * ## Postgres restore (legacy SQL format — pre-v1 snapshots)
 *   Falls back to the original regex-based path for backward compatibility.
 *
 * ## SQLite restore
 *   Writes the SQL dump to a temp file on the container in 32 KB chunks
 *   (multiple exec calls) to avoid shell/argv size limits, then replaces
 *   /data/db.sqlite atomically via sqlite3.
 */

import { execInContainer } from "./tenant-runtime";
import { logger } from "./logger";

// ── Postgres JSON snapshot types ──────────────────────────────────────────────

interface TableSnapshot {
  name: string;
  /** Exact CREATE TABLE statement at snapshot time (without IF NOT EXISTS). */
  ddl: string;
  /** Column names in declaration order. */
  columns: string[];
  /** Rows as arrays of values in column order. */
  rows: unknown[][];
}

interface PostgresSnapshotData {
  version: 1;
  provider: "postgres";
  generatedAt: string;
  tables: TableSnapshot[];
}

function isJsonSnapshot(content: string): boolean {
  return content.trimStart().startsWith("{");
}

// ── Postgres ─────────────────────────────────────────────────────────────────

/**
 * Restore a Postgres database from a snapshot.
 * Accepts both the structured JSON format (v1) and the legacy SQL text format.
 */
export async function restorePostgresDump(
  connectionString: string,
  dumpContent: string,
): Promise<{ statementsRun: number; errors: number }> {
  if (isJsonSnapshot(dumpContent)) {
    return restorePostgresJson(connectionString, dumpContent);
  }
  return restorePostgresLegacySql(connectionString, dumpContent);
}

async function restorePostgresJson(
  connectionString: string,
  dumpContent: string,
): Promise<{ statementsRun: number; errors: number }> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 30000 });
  await client.connect();

  try {
    const data: PostgresSnapshotData = JSON.parse(dumpContent) as PostgresSnapshotData;
    let statementsRun = 0;

    await client.query("BEGIN");
    try {
      for (const table of data.tables) {
        // DROP existing table (cascade removes dependent FK constraints)
        await client.query(`DROP TABLE IF EXISTS "${table.name}" CASCADE`);
        statementsRun++;

        // Re-create from captured DDL (restores exact schema at snapshot time)
        await client.query(table.ddl);
        statementsRun++;

        if (table.rows.length > 0) {
          const placeholders = table.columns.map((_, idx) => `$${idx + 1}`).join(", ");
          const cols = table.columns.map((c) => `"${c}"`).join(", ");
          const insertSql = `INSERT INTO "${table.name}" (${cols}) VALUES (${placeholders})`;

          for (const row of table.rows) {
            await client.query(insertSql, row as unknown[]);
            statementsRun++;
          }
        }
      }

      await client.query("COMMIT");
      return { statementsRun, errors: 0 };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    await client.end();
  }
}

// ── Legacy SQL restore (backward compatibility for pre-v1 snapshots) ──────────

function parseCreateTableStatements(dump: string): Map<string, string> {
  const result = new Map<string, string>();
  const re = /CREATE TABLE IF NOT EXISTS "([^"]+)"\s*\([^;]+\);/gms;
  let match: RegExpExecArray | null;
  while ((match = re.exec(dump)) !== null) {
    const tableName = match[1];
    const stmt = match[0].replace("IF NOT EXISTS ", "").replace(/;\s*$/, "");
    result.set(tableName, stmt);
  }
  return result;
}

function parseInsertStatements(dump: string): string[] {
  return dump
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith("INSERT INTO"));
}

async function restorePostgresLegacySql(
  connectionString: string,
  dumpContent: string,
): Promise<{ statementsRun: number; errors: number }> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 30000 });
  await client.connect();

  try {
    const createStmts = parseCreateTableStatements(dumpContent);
    const insertStmts = parseInsertStatements(dumpContent);
    const tableNames = [...createStmts.keys()];

    let statementsRun = 0;

    await client.query("BEGIN");
    try {
      for (const tableName of tableNames) {
        await client.query(`DROP TABLE IF EXISTS "${tableName}" CASCADE`);
        statementsRun++;
      }

      for (const [, createStmt] of createStmts) {
        await client.query(createStmt);
        statementsRun++;
      }

      for (const stmt of insertStmts) {
        await client.query(stmt);
        statementsRun++;
      }

      await client.query("COMMIT");
      return { statementsRun, errors: 0 };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
  } finally {
    await client.end();
  }
}

// ── SQLite ────────────────────────────────────────────────────────────────────

/**
 * Maximum bytes per exec call when writing the SQLite dump to the container.
 * Kept well below typical ARG_MAX (2 MB) to avoid argv size limits even after
 * shell escaping inflates single-quotes in the content.
 */
const SQLITE_WRITE_CHUNK = 32 * 1024; // 32 KB

/**
 * Restore a SQLite snapshot by uploading the SQL dump to the container in
 * 32 KB chunks (multiple exec calls) and then running sqlite3 on it.
 * Writes in chunks to avoid exceeding shell/argv size limits for large dumps.
 */
export async function restoreSQLiteSnapshot(
  machineId: string,
  dumpContent: string,
  projectId: number,
): Promise<{ statementsRun: number; errors: number }> {
  const tmpPath = `/tmp/mf_restore_${Date.now()}.sql`;

  // Write dump in fixed-size chunks to avoid shell/argv size limits
  for (let offset = 0; offset < dumpContent.length; offset += SQLITE_WRITE_CHUNK) {
    const chunk = dumpContent.slice(offset, offset + SQLITE_WRITE_CHUNK);
    // Escape single-quotes for the surrounding sh -c '...' literal
    const escaped = chunk.replace(/'/g, "'\\''");
    const redirectOp = offset === 0 ? ">" : ">>";

    const r = await execInContainer(
      machineId,
      ["sh", "-c", `printf '%s' '${escaped}' ${redirectOp} ${tmpPath}`],
      projectId,
      "/",
    );

    if (!r.ok) {
      throw new Error(`SQLite restore: failed to write chunk at offset ${offset}: ${r.output}`);
    }
  }

  // Import into a temp DB file first (non-destructive), then atomically replace the live DB.
  // `set -e` ensures any failure propagates a non-zero exit code so execInContainer sees ok=false.
  const newDbPath = `${tmpPath}.sqlite`;
  const restoreResult = await execInContainer(
    machineId,
    [
      "sh",
      "-c",
      [
        "set -e",
        `sqlite3 ${newDbPath} < ${tmpPath}`,
        `mv -f ${newDbPath} /data/db.sqlite`,
        `rm -f ${tmpPath}`,
        "echo done",
      ].join(" && "),
    ],
    projectId,
    "/",
  );

  if (!restoreResult.ok || !restoreResult.output.includes("done")) {
    // Best-effort cleanup of temp files on failure
    void execInContainer(machineId, ["sh", "-c", `rm -f ${tmpPath} ${newDbPath}`], projectId, "/");
    throw new Error(`SQLite restore failed: ${restoreResult.output}`);
  }

  logger.debug({ projectId, tmpPath }, "SQLite snapshot restore complete");

  const statementsRun = dumpContent
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("--")).length;

  return { statementsRun, errors: 0 };
}
