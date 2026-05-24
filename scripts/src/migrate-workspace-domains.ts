/**
 * Migration: Create workspace_domains, workspace_domain_roles,
 *            workspace_usage_daily, workspace_domain_audit tables
 *            and add workspace_domain_id FK to project_domains.
 *
 * Safe to re-run — all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-workspace-domains
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Running workspace-domains migration…");

    // 1. workspace_domains — org-level claimed domains
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_domains (
        id                   SERIAL PRIMARY KEY,
        workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        hostname             TEXT NOT NULL,
        record_type          TEXT NOT NULL DEFAULT 'cname',
        verification_token   TEXT NOT NULL,
        status               TEXT NOT NULL DEFAULT 'pending_verification',
        verified_at          TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_hostname_unique
        ON workspace_domains(hostname);
    `);
    console.log("  ✓ workspace_domains table");

    // 2. workspace_domain_roles — per-user per-domain role grants
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_domain_roles (
        id                    SERIAL PRIMARY KEY,
        workspace_domain_id   INTEGER NOT NULL REFERENCES workspace_domains(id) ON DELETE CASCADE,
        user_id               TEXT NOT NULL,
        role                  TEXT NOT NULL DEFAULT 'viewer',
        granted_by            TEXT NOT NULL,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_domain_roles_domain_user_unique
        ON workspace_domain_roles(workspace_domain_id, user_id);
    `);
    console.log("  ✓ workspace_domain_roles table");

    // 3. workspace_usage_daily — daily bandwidth + request rollup
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_usage_daily (
        id                         SERIAL PRIMARY KEY,
        workspace_id               INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        date                       DATE NOT NULL,
        hostname                   TEXT NOT NULL DEFAULT '',
        request_count              BIGINT NOT NULL DEFAULT 0,
        bandwidth_bytes            BIGINT NOT NULL DEFAULT 0,
        stripe_meter_reported_at   TIMESTAMPTZ,
        created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // hostname stores '' (empty string) for platform traffic — never NULL.
    // This aligns with rollupUsage() which maps NULL source hostnames to ''.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_usage_daily_workspace_date_host_unique
        ON workspace_usage_daily(workspace_id, date, hostname);
    `);
    console.log("  ✓ workspace_usage_daily table");

    // 4. workspace_domain_audit — org-wide audit log
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_domain_audit (
        id                    SERIAL PRIMARY KEY,
        workspace_id          INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        workspace_domain_id   INTEGER,
        user_id               TEXT NOT NULL,
        action                TEXT NOT NULL,
        hostname              TEXT,
        payload               TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    console.log("  ✓ workspace_domain_audit table");

    // 5. Add workspace_domain_id FK to project_domains (backlink for sub-hostnames)
    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS workspace_domain_id INTEGER
          REFERENCES workspace_domains(id) ON DELETE SET NULL;
    `);
    console.log("  ✓ project_domains.workspace_domain_id column");

    // 6. Add bytes_served column to domain_serve_events (Task #645) — nullable so
    //    legacy rows (request-only) stay valid; rollup sums COALESCE(bytes_served, 0).
    await client.query(`
      ALTER TABLE domain_serve_events
        ADD COLUMN IF NOT EXISTS bytes_served BIGINT;
    `);
    console.log("  ✓ domain_serve_events.bytes_served column");

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
