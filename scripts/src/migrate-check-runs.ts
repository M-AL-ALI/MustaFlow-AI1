/**
 * Migration: add check_runs table for AI-driven check orchestration.
 * Run: pnpm --filter @workspace/scripts run migrate-check-runs
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS check_runs (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id integer REFERENCES agent_tasks(id) ON DELETE CASCADE,
        check_name text NOT NULL,
        status text NOT NULL,
        findings jsonb NOT NULL DEFAULT '[]',
        ai_reason text,
        ran_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS check_runs_project_id_task_id_idx
        ON check_runs(project_id, task_id)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS check_runs_task_id_idx
        ON check_runs(task_id)
    `);

    await client.query("COMMIT");
    console.log("check_runs migration complete.");
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
