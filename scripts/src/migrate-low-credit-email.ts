/**
 * Migration: Add last_low_credit_email_at to user_credits
 *
 * Adds:
 *   last_low_credit_email_at TIMESTAMPTZ NULL
 *     — Tracks when the last low-balance warning email was sent per user.
 *       Used to rate-limit low-credit emails to once per 24 hours.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-low-credit-email
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE user_credits
        ADD COLUMN IF NOT EXISTS last_low_credit_email_at TIMESTAMPTZ
    `);

    await client.query("COMMIT");
    console.log("✓ user_credits.last_low_credit_email_at column added");
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
