/**
 * Task #776 — Add mobile / EAS build columns to deployment_logs.
 *
 * deployment_logs.build_id       text — EAS build ID for mobile builds
 * deployment_logs.platform       text — 'ios' | 'android' | 'web'
 * deployment_logs.download_url   text — APK / IPA download URL
 * deployment_logs.testflight_url text — TestFlight URL for iOS builds
 *
 * Idempotent — uses ADD COLUMN IF NOT EXISTS.
 * Run: pnpm --filter @workspace/scripts run migrate-deployment-logs-mobile
 */

import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS build_id text`);
    await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS platform text`);
    await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS download_url text`);
    await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS testflight_url text`);

    await client.query("COMMIT");
    console.log("deployment_logs mobile columns migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
