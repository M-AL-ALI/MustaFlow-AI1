/**
 * Migration: add preferred_mode column to user_preferences — Task #897
 *
 * Adds an optional mode preference column to the user_preferences table:
 *   preferred_mode  TEXT  (nullable, no default)
 *
 * Valid values: 'builder' | 'developer' | NULL (not yet chosen)
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS — safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-preferred-mode
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE user_preferences
        ADD COLUMN IF NOT EXISTS preferred_mode TEXT
    `);

    await client.query(`
      ALTER TABLE user_preferences
        DROP CONSTRAINT IF EXISTS user_preferences_preferred_mode_check
    `);

    await client.query(`
      ALTER TABLE user_preferences
        ADD CONSTRAINT user_preferences_preferred_mode_check
          CHECK (preferred_mode IN ('builder', 'developer'))
    `);

    await client.query("COMMIT");
    console.log("Migration complete: preferred_mode column added to user_preferences.");
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
