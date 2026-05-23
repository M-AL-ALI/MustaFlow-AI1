/**
 * Migration: add prod observability tables (Task #511).
 *   - prod_logs            (raw request/browser/server/health rows)
 *   - prod_error_groups    (grouped by signature)
 *   - prod_health_checks   (post-publish synthetic check outcomes)
 *
 * Safe to re-run — uses IF NOT EXISTS everywhere.
 * Run: pnpm --filter @workspace/scripts run migrate-prod-logs
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS prod_logs (
        id           SERIAL PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_id  INTEGER,
        kind         TEXT NOT NULL,
        method       TEXT,
        path         TEXT,
        status       INTEGER,
        latency_ms   INTEGER,
        request_id   TEXT,
        ip_hash      TEXT,
        user_agent   TEXT,
        error_class  TEXT,
        message      TEXT,
        stack        TEXT,
        signature    TEXT,
        ts           TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS prod_logs_project_ts_idx ON prod_logs (project_id, ts)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS prod_logs_signature_idx ON prod_logs (signature)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS prod_logs_kind_idx ON prod_logs (kind)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS prod_error_groups (
        id              SERIAL PRIMARY KEY,
        project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        signature       TEXT NOT NULL,
        sample_message  TEXT NOT NULL,
        sample_stack    TEXT,
        kind            TEXT NOT NULL DEFAULT 'browser',
        count           INTEGER NOT NULL DEFAULT 1,
        first_seen      TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS prod_error_groups_project_signature_idx
         ON prod_error_groups (project_id, signature)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS prod_error_groups_last_seen_idx
         ON prod_error_groups (last_seen)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS prod_health_checks (
        id               SERIAL PRIMARY KEY,
        project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        snapshot_id      INTEGER,
        public_slug      TEXT,
        status           TEXT NOT NULL,
        root_status      INTEGER,
        root_latency_ms  INTEGER,
        routes_checked   INTEGER NOT NULL DEFAULT 0,
        routes_failed    INTEGER NOT NULL DEFAULT 0,
        failure_summary  TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS prod_health_checks_project_idx
         ON prod_health_checks (project_id, created_at)`,
    );

    await client.query("COMMIT");
    console.log("prod_logs migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
