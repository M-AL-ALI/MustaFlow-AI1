/**
 * Migration: ora_assets table (Task #1278 — Durable Ora asset library)
 *
 * Persists assets generated inside Ora (files + images) keyed to the owning
 * user so they survive chat resets, reloads, and other devices. Bytes are
 * stored as base64 in `data` (no external object storage dependency).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-assets
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_assets (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        kind        TEXT NOT NULL,
        file_name   TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        format      TEXT,
        prompt      TEXT,
        data        TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_assets_user_id_idx ON ora_assets (user_id)
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_assets table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
