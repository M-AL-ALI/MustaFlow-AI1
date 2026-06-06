/**
 * Migration: Ora Memory + History Center (Phase 3B.1)
 *
 *  - Creates `ora_profiles` (one row per user; Ora-only custom instructions).
 *  - Adds `enabled` + `source_conversation_id` to `knowledge_entries` so the
 *    Ora Memory Center can pause/resume and trace individual saved memories.
 *
 * Idempotent (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS). Safe to re-run.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-memory-center
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_profiles (
        id                 SERIAL PRIMARY KEY,
        user_id            TEXT NOT NULL UNIQUE,
        preferred_name     TEXT,
        occupation         TEXT,
        industry           TEXT,
        goals              TEXT,
        skill_level        TEXT,
        preferred_language TEXT,
        response_style     TEXT,
        avoid              TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(
      `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
    );
    await client.query(
      `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS source_conversation_id INTEGER`,
    );

    await client.query("COMMIT");
    console.log("Migration complete: ora_profiles + knowledge_entries memory columns");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
