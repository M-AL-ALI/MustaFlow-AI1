/**
 * Migration: Create ora_usage_windows (Ora per-user rolling-window quotas)
 *
 * Replaces Ora's per-UTC-day metering (ora_daily_usage) with a per-user ROLLING
 * TIME WINDOW. Exactly one row per user:
 *   user_id       TEXT NOT NULL UNIQUE
 *   window_start  TIMESTAMPTZ — when the user's current window opened
 *   message_count INTEGER — messages used in the current window
 *   image_count   INTEGER — images used in the current window
 *
 * The window opens on the user's first metered action after a reset and the full
 * allowance refills exactly TIER_ORA_WINDOW_HOURS later. Messages and images
 * share ONE window timer per user. The old ora_daily_usage table is left in
 * place (harmless history) and is no longer read or written.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-usage-windows
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_usage_windows (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        message_count INTEGER NOT NULL DEFAULT 0,
        image_count   INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ora_usage_windows_user_uniq
        ON ora_usage_windows (user_id)
    `);

    await client.query("COMMIT");
    console.log("✓ ora_usage_windows table + unique index created");
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
