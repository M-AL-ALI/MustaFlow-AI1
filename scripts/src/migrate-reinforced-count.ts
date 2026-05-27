/**
 * Migration: Add reinforced_count column to knowledge_entries
 *
 * Adds:
 *   reinforced_count INTEGER NOT NULL DEFAULT 0
 *     — how many times a near-duplicate entry was merged into this row
 *       instead of inserting a new row (semantic deduplication).
 *       Zero for all pre-existing entries.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-reinforced-count
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE knowledge_entries
        ADD COLUMN IF NOT EXISTS reinforced_count INTEGER NOT NULL DEFAULT 0
    `);

    await client.query("COMMIT");
    console.log("✓ knowledge_entries.reinforced_count column added (integer not null default 0)");
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
