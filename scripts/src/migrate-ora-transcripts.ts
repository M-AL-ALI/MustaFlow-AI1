/**
 * Migration: ora_transcripts table
 *
 * Stores Ora conversation history server-side so signed-in users
 * can resume their conversation across browser sessions.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-transcripts
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_transcripts (
        id         SERIAL PRIMARY KEY,
        user_id    TEXT NOT NULL UNIQUE,
        messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_transcripts_user_id_idx
        ON ora_transcripts (user_id)
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_transcripts table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
