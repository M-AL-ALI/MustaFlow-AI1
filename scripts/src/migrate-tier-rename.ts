/**
 * Migration: Rename legacy subscription tiers to the GPT-style pricing model.
 *
 * The subscription tiers were restructured to: free / core (Core Pack, $20) /
 * wave (Deep Wave, $40). The old "pro" and "team" tiers are collapsed into
 * "wave" (the top paid tier) so existing paying customers keep their highest
 * benefits. Free is unchanged.
 *
 *   pro  → wave
 *   team → wave
 *
 * Idempotent: re-running is a no-op once no pro/team rows remain.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-tier-rename
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(`
      UPDATE user_subscriptions
        SET tier = 'wave', updated_at = now()
        WHERE tier IN ('pro', 'team')
    `);

    await client.query("COMMIT");
    console.log(
      `✓ user_subscriptions tier rename complete (${result.rowCount ?? 0} rows pro/team → wave)`,
    );
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
