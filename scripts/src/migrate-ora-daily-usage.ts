/**
 * Migration: ora_daily_usage table (Ora message-based daily quotas)
 *
 * Meters the standalone Ora assistant by per-user, per-UTC-day message + image
 * counters, decoupled from the AI Builder credit wallet. One row per user/day;
 * counters are bumped atomically via upsert keyed on (user_id, usage_date).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-daily-usage
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_daily_usage (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        usage_date    TEXT NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        image_count   INTEGER NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ora_daily_usage_user_date_uniq
        ON ora_daily_usage (user_id, usage_date)
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_daily_usage table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
