/**
 * Migration: add voice_lang column to user_preferences
 *
 * Adds an optional voice language preference column to the user_preferences table:
 *   voice_lang  TEXT  (nullable, no default)
 *
 * Stores the BCP-47 language tag (e.g. "en-US", "fr-FR") the user has chosen
 * for speech recognition, or NULL to mean "auto-detect from browser".
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-voice-lang
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS voice_lang TEXT
    `);

    await client.query("COMMIT");
    console.log("Migration complete: voice_lang column added to user_preferences.");
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
