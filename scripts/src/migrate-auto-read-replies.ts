/**
 * Migration: add auto_read_replies column to user_preferences
 *
 * Adds a boolean preference column to the user_preferences table:
 *   auto_read_replies  BOOLEAN  NOT NULL DEFAULT false
 *
 * When true, the Ora mobile client speaks each new assistant reply aloud
 * automatically (TTS) without the user tapping the per-message Listen button.
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-auto-read-replies
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS auto_read_replies BOOLEAN NOT NULL DEFAULT false
    `);

    await client.query("COMMIT");
    console.log("Migration complete: auto_read_replies column added to user_preferences.");
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
