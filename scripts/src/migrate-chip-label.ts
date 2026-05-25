/**
 * Migration: Add chip_label column to projects (Task #794)
 *
 * Adds:
 *   chip_label TEXT NULL
 *     — name of the capability chip that pre-filled the prompt when the project
 *       was created (e.g. "React SaaS app", "REST API + Postgres"). NULL for
 *       projects created without a chip (direct prompt, template, or API).
 *       Immutable after creation.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-chip-label
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS chip_label TEXT
    `);

    await client.query("COMMIT");
    console.log("✓ projects.chip_label column added (nullable text)");
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
