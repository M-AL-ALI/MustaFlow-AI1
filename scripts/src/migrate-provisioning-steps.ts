/**
 * Migration: Add provisioning_step and provisioning_started_at columns to projects (Task #988)
 *
 * Adds:
 *   provisioning_step       TEXT NULL
 *     — current named step executing in the provisioning pipeline.
 *       Values: "create_container" | "create_database" | "connect_and_test" | NULL
 *   provisioning_started_at TIMESTAMPTZ NULL
 *     — wall-clock timestamp when the most recent provisioning attempt began.
 *       Used by the UI to compute estimated time remaining.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-provisioning-steps
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS provisioning_step TEXT,
        ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ
    `);

    await client.query("COMMIT");
    console.log("✓ projects.provisioning_step and projects.provisioning_started_at columns added");
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
