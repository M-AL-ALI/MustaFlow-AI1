/**
 * Migration: deployment substrate (Task #543).
 *
 * Adds projects.{deploymentType,region,cdnEnabled,cdnLastPushedAt,healthCheckPath,uptimeAlertEmail}
 * and creates the deployment_schedules table.
 *
 * Safe to re-run — uses IF NOT EXISTS.
 *
 * Usage: pnpm --filter @workspace/scripts run migrate-deployment-substrate
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Adding deployment substrate columns + tables…");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS deployment_type      text NOT NULL DEFAULT 'static',
        ADD COLUMN IF NOT EXISTS region               text,
        ADD COLUMN IF NOT EXISTS cdn_enabled          boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS cdn_last_pushed_at   timestamptz,
        ADD COLUMN IF NOT EXISTS health_check_path    text NOT NULL DEFAULT '/',
        ADD COLUMN IF NOT EXISTS uptime_alert_email   text;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS deployment_schedules (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind text NOT NULL DEFAULT 'task_run',
        cron_expr text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        note text,
        last_run_at timestamptz,
        last_run_status text,
        last_run_message text,
        next_run_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS deployment_schedules_project_idx ON deployment_schedules(project_id);`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS deployment_schedules_next_run_idx ON deployment_schedules(next_run_at);`,
    );

    console.log("Migration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
