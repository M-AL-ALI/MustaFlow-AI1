/**
 * Migration: Stripe webhook idempotency status columns + credit_grants table
 *
 * 1. Adds status-tracking columns to stripe_processed_events:
 *      status VARCHAR(20) NOT NULL DEFAULT 'succeeded'
 *      processing_started_at TIMESTAMPTZ
 *      succeeded_at TIMESTAMPTZ
 *      failed_at TIMESTAMPTZ
 *      error_message TEXT
 *
 *    Existing rows default to 'succeeded' so they are treated as already processed.
 *
 * 2. Creates the credit_grants table used by the atomic monthly credit grant:
 *      id SERIAL PRIMARY KEY
 *      user_id TEXT NOT NULL
 *      subscription_id TEXT NOT NULL
 *      period_start TIMESTAMPTZ NOT NULL
 *      amount INTEGER NOT NULL
 *      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
 *      UNIQUE (subscription_id, period_start)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-stripe-events-status
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Add status columns to stripe_processed_events
    await client.query(`
      ALTER TABLE stripe_processed_events
        ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'succeeded',
        ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS succeeded_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS error_message TEXT
    `);
    console.log("✓ stripe_processed_events status columns added");

    // Create credit_grants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS credit_grants (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        period_start TIMESTAMPTZ NOT NULL,
        amount INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT credit_grants_subscription_period_unique UNIQUE (subscription_id, period_start)
      )
    `);
    console.log("✓ credit_grants table created");

    await client.query("COMMIT");
    console.log("Migration complete");
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
