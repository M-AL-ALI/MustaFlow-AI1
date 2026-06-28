/**
 * Migration: Ora LIVE-VOICE ("Talk to Ora") per-plan minute budgets.
 *
 * Adds two tables:
 *   - ora_realtime_usage_windows: per-key rolling-window voice-second ledger.
 *   - ora_realtime_sessions: per-session reconciliation / concurrency / audit.
 *
 * Safe to re-run — uses IF NOT EXISTS throughout.
 * Run: pnpm --filter @workspace/scripts run migrate-ora-realtime-usage
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_realtime_usage_windows (
        id           serial PRIMARY KEY,
        usage_key    text NOT NULL,
        window_start timestamptz NOT NULL DEFAULT now(),
        used_seconds integer NOT NULL DEFAULT 0,
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS ora_realtime_usage_windows_key_uniq ON ora_realtime_usage_windows(usage_key)`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_realtime_sessions (
        id                   text PRIMARY KEY,
        usage_key            text NOT NULL,
        tier                 text NOT NULL,
        max_duration_seconds integer NOT NULL,
        started_at           timestamptz NOT NULL DEFAULT now(),
        last_heartbeat_at    timestamptz NOT NULL DEFAULT now(),
        charged_seconds      integer NOT NULL DEFAULT 0,
        status               text NOT NULL DEFAULT 'active',
        created_at           timestamptz NOT NULL DEFAULT now(),
        updated_at           timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_key_status_idx ON ora_realtime_sessions(usage_key, status)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_status_heartbeat_idx ON ora_realtime_sessions(status, last_heartbeat_at)`,
    );
    await client.query("COMMIT");
    console.log("ora_realtime_usage_windows + ora_realtime_sessions migration complete.");
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
