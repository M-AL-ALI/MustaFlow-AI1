/**
 * Migration: mobile deployment columns for deployment_logs (Task #776).
 *
 * Adds build_id, platform, download_url, testflight_url columns to deployment_logs
 * to support mobile (EAS/Expo) deployment tracking alongside web deployments.
 *
 * Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
 *
 * Usage: pnpm --filter @workspace/scripts run migrate-mobile-deployment-columns
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Adding mobile deployment columns to deployment_logs…");

    await client.query(`
      ALTER TABLE deployment_logs
        ADD COLUMN IF NOT EXISTS build_id       text,
        ADD COLUMN IF NOT EXISTS platform       text,
        ADD COLUMN IF NOT EXISTS download_url   text,
        ADD COLUMN IF NOT EXISTS testflight_url text;
    `);

    console.log("Done. deployment_logs now has all mobile columns.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
