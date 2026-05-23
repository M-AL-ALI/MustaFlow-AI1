/**
 * Migration: add background-jobs columns to agent_tasks.
 * - run_mode            text NOT NULL DEFAULT 'foreground'
 * - wall_clock_cap_ms   integer
 * - credits_reserved    integer
 * - paused_at           timestamptz
 * - applied_at          timestamptz
 * - discarded_at        timestamptz
 * Safe to re-run — uses IF NOT EXISTS.
 * Run: pnpm --filter @workspace/scripts run migrate-background-jobs
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE agent_tasks
        ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'foreground',
        ADD COLUMN IF NOT EXISTS wall_clock_cap_ms integer,
        ADD COLUMN IF NOT EXISTS credits_reserved integer,
        ADD COLUMN IF NOT EXISTS paused_at timestamptz,
        ADD COLUMN IF NOT EXISTS applied_at timestamptz,
        ADD COLUMN IF NOT EXISTS discarded_at timestamptz
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_tasks_run_mode_status_idx
        ON agent_tasks (run_mode, status)
    `);
    await client.query("COMMIT");
    console.log("agent_tasks background-jobs migration complete.");
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
