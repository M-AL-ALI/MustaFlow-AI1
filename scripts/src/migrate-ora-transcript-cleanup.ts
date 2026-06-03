/**
 * Migration: ora_transcripts — add created_at column
 *
 * Adds a created_at column to the ora_transcripts table so the inactivity
 * TTL cleanup job can accurately target old rows.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-transcript-cleanup
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE ora_transcripts
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_transcripts.created_at column added");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

await migrate();
