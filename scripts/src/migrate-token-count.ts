/**
 * Migration: add token_count column to agent_tasks.
 *
 * Persists the total number of LLM tokens consumed by each task so billing
 * dashboards and admin analytics can report per-task AI cost. The column is
 * accumulated from streaming deltas during the build pipeline and written to
 * the DB on task completion (Task #806).
 *
 * Existing rows receive NULL — they pre-date the counter and can be treated
 * as "unknown" in reporting queries.
 *
 * Safe to re-run (ADD COLUMN IF NOT EXISTS).
 * Run: pnpm --filter @workspace/scripts run migrate-token-count
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE agent_tasks
        ADD COLUMN IF NOT EXISTS token_count integer
    `);
    await client.query("COMMIT");
    console.log("agent_tasks token_count migration complete.");
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
