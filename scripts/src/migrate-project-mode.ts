/**
 * Migration: add project_mode column to projects — Task #898
 *
 * Adds a project mode stamp to differentiate AI Build Mode projects
 * from Developer Mode cloud IDE projects:
 *   project_mode  TEXT  NOT NULL DEFAULT 'builder'
 *
 * Valid values: 'builder' | 'developer'
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-project-mode
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS project_mode TEXT NOT NULL DEFAULT 'builder'
    `);

    await client.query(`
      ALTER TABLE projects
        DROP CONSTRAINT IF EXISTS projects_project_mode_check
    `);

    await client.query(`
      ALTER TABLE projects
        ADD CONSTRAINT projects_project_mode_check
          CHECK (project_mode IN ('builder', 'developer'))
    `);

    await client.query("COMMIT");
    console.log("Migration complete: project_mode column added to projects.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
