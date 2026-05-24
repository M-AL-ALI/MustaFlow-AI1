/**
 * Idempotent migration: creates the user_subscriptions table.
 * Safe to re-run — uses IF NOT EXISTS throughout.
 */
import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_subscriptions (
        id               SERIAL PRIMARY KEY,
        user_id          TEXT NOT NULL UNIQUE,
        stripe_customer_id    TEXT,
        stripe_subscription_id TEXT,
        tier             TEXT NOT NULL DEFAULT 'free',
        status           TEXT NOT NULL DEFAULT 'active',
        current_period_end    TIMESTAMPTZ,
        grace_period_end      TIMESTAMPTZ,
        cancel_at_period_end  BOOLEAN NOT NULL DEFAULT FALSE,
        last_monthly_grant_at TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_customer_idx
       ON user_subscriptions (stripe_customer_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_sub_idx
       ON user_subscriptions (stripe_subscription_id)`,
    );

    await client.query("COMMIT");
    console.log("✓ user_subscriptions table ready");
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
