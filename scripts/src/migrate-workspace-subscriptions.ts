/**
 * One-time migration: add workspace_subscriptions table for Task #644
 * (Stripe subscription → plan tier wiring).
 * Run: pnpm --filter @workspace/scripts run migrate-workspace-subscriptions
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_subscriptions (
        workspace_id integer PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
        stripe_customer_id text,
        stripe_subscription_id text UNIQUE,
        stripe_price_id text,
        plan_tier text NOT NULL DEFAULT 'free',
        status text NOT NULL DEFAULT 'inactive',
        current_period_end timestamptz,
        cancel_at_period_end text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS workspace_subscriptions_customer_idx ON workspace_subscriptions(stripe_customer_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS workspace_subscriptions_status_idx ON workspace_subscriptions(status)`,
    );

    await client.query("COMMIT");
    console.log("workspace_subscriptions migration complete.");
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
