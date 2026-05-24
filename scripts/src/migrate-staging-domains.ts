/**
 * Migration: staging / preview / production domain slots (Task #555)
 *
 * Adds the following columns using IF NOT EXISTS (safe to re-run):
 *   - project_versions.environment       TEXT  (production | staging | preview)
 *   - project_domains.environment        TEXT  NOT NULL DEFAULT 'production'
 *   - projects.staging_published_snapshot_id  INTEGER
 *
 * Creates preview_snapshots table if it does not already exist.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-staging-domains
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // --- project_versions.environment ---
    await client.query(`
      ALTER TABLE project_versions
        ADD COLUMN IF NOT EXISTS environment TEXT;
    `);
    console.log("  + project_versions.environment column ensured");

    // --- project_domains.environment ---
    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production';
    `);
    console.log("  + project_domains.environment column ensured");

    // --- projects.staging_published_snapshot_id ---
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS staging_published_snapshot_id INTEGER;
    `);
    console.log("  + projects.staging_published_snapshot_id column ensured");

    // --- preview_snapshots table ---
    await client.query(`
      CREATE TABLE IF NOT EXISTS preview_snapshots (
        id           SERIAL PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_id   INTEGER NOT NULL,
        task_id      INTEGER,
        preview_slug TEXT    NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS preview_snapshots_slug_unique
        ON preview_snapshots(preview_slug);
    `);
    console.log("  + preview_snapshots table ensured");

    console.log("\nMigration complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
