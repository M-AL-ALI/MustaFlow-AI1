/**
 * Migration: Add GDPR erasure job columns to user_preferences (Task #1002)
 *
 * Adds:
 *   erasure_job_id       TEXT NULL  — pg-boss job ID for the scheduled hard-erasure
 *   erasure_requested_at TIMESTAMPTZ NULL — when the user initiated account deletion
 *
 * Run: pnpm --filter @workspace/scripts run migrate-gdpr-erasure-job
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS erasure_job_id TEXT,
        ADD COLUMN IF NOT EXISTS erasure_requested_at TIMESTAMPTZ
    `);

    await client.query("COMMIT");
    console.log("✓ user_preferences: erasure_job_id and erasure_requested_at columns added");
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
