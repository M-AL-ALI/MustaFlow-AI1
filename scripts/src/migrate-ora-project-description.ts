/**
 * Migration: Add description to ora_projects
 *
 * Adds:
 *   description TEXT NULL
 *     — Optional project description / "what this project is about", set on the
 *       dedicated Ora "New project" page.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-project-description
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE ora_projects
        ADD COLUMN IF NOT EXISTS description TEXT
    `);

    await client.query("COMMIT");
    console.log("✓ ora_projects.description column added");
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
