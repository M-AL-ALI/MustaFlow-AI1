/**
 * Migration: Add rolling-summary columns to ora_conversations
 *
 * Adds (all idempotent):
 *   summary            text NULL
 *     — Model-generated gist of the conversation, persisted best-effort on save.
 *   summary_msg_count  integer NOT NULL DEFAULT 0
 *     — Turn count reflected in `summary` (throttles re-summarisation).
 *   summary_updated_at timestamptz NULL
 *
 * Powers Ora's cross-conversation recall: other conversations' summaries are
 * fetched (same memory tier) and injected under "## From your past conversations".
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-conversation-summary
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE ora_conversations
        ADD COLUMN IF NOT EXISTS summary text
    `);
    await client.query(`
      ALTER TABLE ora_conversations
        ADD COLUMN IF NOT EXISTS summary_msg_count integer NOT NULL DEFAULT 0
    `);
    await client.query(`
      ALTER TABLE ora_conversations
        ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz
    `);

    await client.query("COMMIT");
    console.log("✓ ora_conversations summary columns added");
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
