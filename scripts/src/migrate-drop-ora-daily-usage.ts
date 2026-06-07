// Drops the legacy `ora_daily_usage` table.
// Ora usage metering moved from per-UTC-day caps (ora_daily_usage) to per-user
// rolling windows (ora_usage_windows). Nothing reads the legacy table anymore.
// Run with: pnpm --filter @workspace/scripts run migrate-drop-ora-daily-usage

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("DROP TABLE IF EXISTS ora_daily_usage");
    console.log("ora_daily_usage table dropped (or did not exist).");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
