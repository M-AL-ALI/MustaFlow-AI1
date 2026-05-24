/**
 * Migration: add security and suspension columns to project_domains + create abuse_reports — Task #560
 *
 * 1. Adds security_config JSONB, suspended_at TIMESTAMPTZ, suspension_reason TEXT
 *    to project_domains using ALTER TABLE ... ADD COLUMN IF NOT EXISTS (safe to re-run).
 * 2. Creates abuse_reports table if it does not exist.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-domain-security
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Step 1: adding security columns to project_domains...");
    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS security_config    JSONB,
        ADD COLUMN IF NOT EXISTS suspended_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS suspension_reason  TEXT;
    `);
    console.log("  project_domains columns added (or already existed).");

    console.log("Step 2: creating abuse_reports table...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS abuse_reports (
        id               SERIAL PRIMARY KEY,
        domain_id        INTEGER REFERENCES project_domains(id) ON DELETE SET NULL,
        hostname         TEXT NOT NULL,
        category         TEXT NOT NULL DEFAULT 'other',
        reason           TEXT NOT NULL,
        details          TEXT,
        reporter_email   TEXT,
        reporter_ip      TEXT,
        status           TEXT NOT NULL DEFAULT 'open',
        resolved_by      TEXT,
        resolved_at      TIMESTAMPTZ,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS abuse_reports_status_idx    ON abuse_reports(status);
      CREATE INDEX IF NOT EXISTS abuse_reports_hostname_idx  ON abuse_reports(hostname);
      CREATE INDEX IF NOT EXISTS abuse_reports_domain_id_idx ON abuse_reports(domain_id);
    `);
    console.log("  abuse_reports table ensured.");

    console.log("\nDone. All migrations applied successfully.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
