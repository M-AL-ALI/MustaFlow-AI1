/**
 * Migration: Add require_command_approval column to projects
 *
 * Adds:
 *   require_command_approval BOOLEAN NOT NULL DEFAULT false
 *     — When true, the agent loop pauses before executing any run_command or
 *       pkg_install call and asks the user to approve or reject it.
 *       Default false = fully autonomous (existing behaviour preserved).
 *
 * Run: pnpm --filter @workspace/scripts run migrate-command-approval
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS require_command_approval BOOLEAN NOT NULL DEFAULT false
    `);

    await client.query("COMMIT");
    console.log("✓ projects.require_command_approval column added (boolean, default false)");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
