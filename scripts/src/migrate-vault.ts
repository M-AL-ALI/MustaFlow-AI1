/**
 * Migration: Create Knowledge Vault tables (Phase 8A)
 *
 * Creates:
 *   vault_entries  — user-controlled organizational knowledge repository
 *   vault_versions — immutable edit history (one row per version bump)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-vault
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS vault_entries (
        id               serial PRIMARY KEY,
        user_id          text NOT NULL,
        title            text NOT NULL,
        category         text NOT NULL DEFAULT 'OTHER',
        subcategory      text,
        summary          text NOT NULL,
        content          text NOT NULL,
        tags             text,
        department       text,
        source_type      text NOT NULL DEFAULT 'USER_CREATED',
        source_reference text,
        status           text NOT NULL DEFAULT 'draft',
        version          integer NOT NULL DEFAULT 1,
        confidence_score integer,
        approved         boolean NOT NULL DEFAULT false,
        updated_by       text,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now(),
        archived_at      timestamptz
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_entries_user_idx
        ON vault_entries(user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_entries_category_idx
        ON vault_entries(user_id, category)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_entries_status_idx
        ON vault_entries(user_id, status)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS vault_versions (
        id            serial PRIMARY KEY,
        entry_id      integer NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
        version       integer NOT NULL,
        title         text NOT NULL,
        summary       text NOT NULL,
        content       text NOT NULL,
        tags          text,
        department    text,
        edited_by     text NOT NULL,
        edited_at     timestamptz NOT NULL DEFAULT now(),
        change_summary text
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_versions_entry_idx
        ON vault_versions(entry_id, version DESC)
    `);

    await client.query("COMMIT");
    console.log("✓ vault_entries and vault_versions tables created");
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
