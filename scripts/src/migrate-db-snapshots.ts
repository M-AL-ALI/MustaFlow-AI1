/**
 * Adds the db_snapshots table for per-project database snapshot feature.
 * Also applies schema extensions for object storage (object_key, is_partial)
 * and makes dump_content nullable (blobs now stored in GCS when available).
 * Safe to re-run — uses IF NOT EXISTS / IF EXISTS guards.
 */
import { pool } from "@workspace/db";

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS db_snapshots (
        id             SERIAL PRIMARY KEY,
        project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id     INTEGER REFERENCES project_versions(id) ON DELETE SET NULL,
        label          TEXT NOT NULL,
        provider       TEXT NOT NULL,
        dump_content   TEXT,
        object_key     TEXT,
        is_partial     BOOLEAN NOT NULL DEFAULT FALSE,
        size_bytes     INTEGER NOT NULL DEFAULT 0,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_db_snapshots_project_id
        ON db_snapshots(project_id);

      CREATE INDEX IF NOT EXISTS idx_db_snapshots_version_id
        ON db_snapshots(version_id);

      -- Idempotent: make dump_content nullable for object-storage path
      ALTER TABLE db_snapshots
        ALTER COLUMN dump_content DROP NOT NULL;

      -- Idempotent: add object_key column if missing
      ALTER TABLE db_snapshots
        ADD COLUMN IF NOT EXISTS object_key TEXT;

      -- Idempotent: add is_partial column if missing
      ALTER TABLE db_snapshots
        ADD COLUMN IF NOT EXISTS is_partial BOOLEAN NOT NULL DEFAULT FALSE;
    `);
    console.log("db_snapshots table and extensions ready");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
