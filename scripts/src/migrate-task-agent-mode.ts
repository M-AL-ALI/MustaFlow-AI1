/**
 * Migration: freeze agent mode at task-creation time.
 *
 * Adds task_agent_mode (text, nullable) to agent_tasks so queued tasks always
 * execute at the mode the user intended, even if project.agentMode changes
 * before the task drains from the queue.
 *
 * Existing rows receive NULL — drain functions fall back to project.agentMode
 * for legacy rows, preserving current behaviour.
 *
 * Safe to re-run (IF NOT EXISTS).
 * Run: pnpm --filter @workspace/scripts run migrate-task-agent-mode
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE agent_tasks
        ADD COLUMN IF NOT EXISTS task_agent_mode text
    `);
    await client.query("COMMIT");
    console.log("agent_tasks task_agent_mode migration complete.");
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
