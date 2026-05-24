/**
 * Migration: add preferred_region column to projects — Task #561
 *
 * Adds an optional geo-routing hint column to the projects table:
 *   preferred_region  TEXT  (nullable, no default)
 *
 * The Cloudflare Worker reads this value from the KV routing entry and uses
 * Cloudflare's regional routing feature to serve from the preferred PoP.
 * Null = no preference (Cloudflare picks the closest region automatically).
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-preferred-region
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS preferred_region TEXT
    `);

    await client.query("COMMIT");
    console.log("Migration complete: preferred_region column added to projects.");
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
