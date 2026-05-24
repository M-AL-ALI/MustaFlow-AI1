/**
 * Migration: backfill project_domains table from projects.custom_domain
 *
 * For every project that has a non-null custom_domain and no corresponding
 * row in project_domains, create a primary+verified (or primary+pending) row
 * preserving the existing domain_status as verification_status.
 *
 * Safe to re-run — uses INSERT ... ON CONFLICT DO NOTHING.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run migrate-project-domains
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    // Ensure the project_domains table exists (run db push first if not)
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

    // Ensure redirect_www_apex column exists on projects
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS redirect_www_apex BOOLEAN NOT NULL DEFAULT FALSE;
    `);

    // Backfill: for each project with a custom_domain, insert a row if absent
    const { rows: projects } = await client.query<{
      id: number;
      custom_domain: string;
      domain_status: string;
      ssl_status: string;
      verification_token: string | null;
      domain_verified_at: Date | null;
    }>(`
      SELECT id, custom_domain, domain_status, ssl_status, verification_token, domain_verified_at
      FROM projects
      WHERE custom_domain IS NOT NULL
        AND deleted_at IS NULL
    `);

    let inserted = 0;
    let skipped = 0;

    for (const proj of projects) {
      const hostname = proj.custom_domain;
      const labels = hostname.split(".");
      const recordType = labels.length === 2 ? "a" : "cname";

      // Map domain_status → verification_status
      let verificationStatus = "pending";
      if (proj.domain_status === "active") verificationStatus = "verified";
      else if (proj.domain_status === "error") verificationStatus = "failed";

      const token =
        proj.verification_token ??
        `mustaflow-verify=backfill-${proj.id.toString(16).padStart(8, "0")}`;

      const result = await client.query(
        `
        INSERT INTO project_domains
          (project_id, hostname, is_primary, record_type, verification_token,
           verification_status, ssl_status, verified_at, created_at, updated_at)
        VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT (hostname) DO NOTHING
        `,
        [
          proj.id,
          hostname,
          recordType,
          token,
          verificationStatus,
          proj.ssl_status ?? "pending",
          proj.domain_verified_at ?? null,
        ],
      );

      if ((result.rowCount ?? 0) > 0) {
        inserted++;
        console.log(`  + Inserted domain row for project ${proj.id}: ${hostname}`);
      } else {
        skipped++;
        console.log(`  ~ Skipped (already exists): ${hostname}`);
      }
    }

    console.log(`\nDone. Inserted: ${inserted}, Skipped: ${skipped}`);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
