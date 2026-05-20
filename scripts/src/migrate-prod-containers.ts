/**
 * Migration: Add production container columns to the projects table (Phase E).
 *
 * Safe to re-run — uses ALTER TABLE ... IF NOT EXISTS pattern via individual
 * column existence checks so re-runs are no-ops.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-prod-containers
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Adding prod container columns to projects table…");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS prod_container_id    text,
        ADD COLUMN IF NOT EXISTS prod_container_status text NOT NULL DEFAULT 'stopped',
        ADD COLUMN IF NOT EXISTS prod_container_url   text;
    `);

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
