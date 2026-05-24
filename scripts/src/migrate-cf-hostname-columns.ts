/**
 * Migration: add Cloudflare for SaaS columns to project_domains — Task #553
 *
 * 1. Creates project_domains table if it does not exist (idempotent, safe to
 *    re-run on databases that already have the table from Task #552).
 * 2. Adds the three new Cloudflare columns to an existing table:
 *      cf_hostname_id      TEXT
 *      ssl_last_checked_at TIMESTAMPTZ
 *      ssl_expires_at      TIMESTAMPTZ
 *
 * Uses ALTER TABLE … ADD COLUMN IF NOT EXISTS so it is safe to re-run.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-cf-hostname-columns
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // Step 1: create project_domains if not present (mirrors migrate-project-domains.ts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_domains (
        id                  SERIAL PRIMARY KEY,
        project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        hostname            TEXT NOT NULL,
        is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
        record_type         TEXT NOT NULL DEFAULT 'cname',
        verification_token  TEXT NOT NULL,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        ssl_status          TEXT NOT NULL DEFAULT 'pending',
        verified_at         TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_domains_hostname_unique
        ON project_domains(hostname);
    `);

    // Step 2: add the new Cloudflare-specific columns (safe on existing tables)
    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS cf_hostname_id      TEXT,
        ADD COLUMN IF NOT EXISTS ssl_last_checked_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS ssl_expires_at      TIMESTAMPTZ;
    `);

    console.log("Done. project_domains table ensured and CF columns added (or already existed).");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
