/**
 * Migration: add app_test_runs table for persisted browser test results.
 * Run: pnpm --filter @workspace/scripts run migrate-app-test-runs
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_test_runs (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id integer REFERENCES agent_tasks(id) ON DELETE SET NULL,
        ran_at timestamptz NOT NULL DEFAULT now(),
        test_script text,
        results jsonb NOT NULL DEFAULT '[]',
        passed integer NOT NULL DEFAULT 0,
        failed integer NOT NULL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS app_test_runs_project_id_ran_at_idx
        ON app_test_runs(project_id, ran_at)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS app_test_runs_task_id_idx
        ON app_test_runs(task_id)
    `);

    await client.query("COMMIT");
    console.log("app_test_runs migration complete.");
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
