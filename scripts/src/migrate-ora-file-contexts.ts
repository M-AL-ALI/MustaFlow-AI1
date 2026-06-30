/**
 * Migration: ora_file_contexts table (durable uploaded-file context for Ora).
 *
 * Persists the EXTRACTED CONTEXT (document text or dataset summary) of files
 * signed-in users upload to Ora, keyed by (user_id, file_ref), so follow-up
 * questions and file generation still resolve the real data after the in-memory
 * file-store entry has expired, the session rotated, or the request hit a
 * different server. No raw bytes are stored here.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-file-contexts
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_file_contexts (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        file_ref        TEXT NOT NULL,
        session_id      TEXT NOT NULL,
        asset_id        INTEGER,
        filename        TEXT NOT NULL,
        mime_type       TEXT NOT NULL,
        file_type       TEXT NOT NULL,
        extracted_text  TEXT NOT NULL DEFAULT '',
        char_count      INTEGER NOT NULL DEFAULT 0,
        dataset_summary JSONB,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at      TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ora_file_contexts_user_ref_unique
        ON ora_file_contexts (user_id, file_ref)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_file_contexts_user_id_idx
        ON ora_file_contexts (user_id)
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_file_contexts table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
