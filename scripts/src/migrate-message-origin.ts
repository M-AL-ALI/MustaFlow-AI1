/**
 * Migration: Add origin column to chat_messages (Task #919)
 *
 * Adds:
 *   origin TEXT NULL
 *     — Identifies which surface sent this message.
 *       'zero' = Zero agent panel; NULL = main builder chat or other sources.
 *       Used by the Zero panel to filter its own thread view.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-message-origin
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS origin TEXT
    `);

    await client.query("COMMIT");
    console.log("✓ chat_messages.origin column added (text, nullable)");
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
