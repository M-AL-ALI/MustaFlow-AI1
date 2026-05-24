/**
 * Migration: add receipt_url column to credit_transactions — Task #648
 *
 *   receipt_url  TEXT  (nullable, no default)
 *
 * Populated by the Stripe webhook with the hosted receipt URL fetched from
 * the payment_intent's latest_charge. Read-only after that.
 *
 * Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-receipt-url
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE credit_transactions
        ADD COLUMN IF NOT EXISTS receipt_url TEXT
    `);
    await client.query("COMMIT");
    console.log("Migration complete: receipt_url column added to credit_transactions.");
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
