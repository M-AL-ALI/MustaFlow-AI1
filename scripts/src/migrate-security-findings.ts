/**
 * migrate-security-findings.ts
 *
 * Adds the security_findings table to the database.
 * Safe to re-run — uses IF NOT EXISTS guards.
 * The check_runs FK is added only if that table already exists.
 */
import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    // Check if check_runs table exists
    const { rows } = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'check_runs'
      ) AS exists
    `);
    const checkRunsExists = rows[0]?.exists ?? false;

    const checkRunCol = checkRunsExists
      ? `check_run_id    INTEGER REFERENCES check_runs(id) ON DELETE SET NULL,`
      : `check_run_id    INTEGER,`;

    const sql = `
CREATE TABLE IF NOT EXISTS security_findings (
  id              SERIAL PRIMARY KEY,
  project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  ${checkRunCol}
  check_type      TEXT NOT NULL,
  severity        TEXT NOT NULL,
  fingerprint     TEXT NOT NULL,
  message         TEXT NOT NULL,
  file            TEXT,
  line            INTEGER,
  status          TEXT NOT NULL DEFAULT 'open',
  dismissed_by    TEXT,
  dismissed_at    TIMESTAMPTZ,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS security_findings_project_fingerprint_idx
  ON security_findings (project_id, fingerprint);

CREATE INDEX IF NOT EXISTS security_findings_project_id_idx
  ON security_findings (project_id);

CREATE INDEX IF NOT EXISTS security_findings_status_idx
  ON security_findings (status);
`;

    await client.query(sql);
    console.log(
      `security_findings table migrated successfully (check_runs FK: ${checkRunsExists ? "included" : "deferred — add manually after check_runs migration"}).`,
    );

    // If check_runs now exists but the FK wasn't previously added, upgrade the column
    if (checkRunsExists) {
      const { rows: fkRows } = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
          WHERE tc.table_name = 'security_findings'
            AND tc.constraint_type = 'FOREIGN KEY'
            AND kcu.column_name = 'check_run_id'
        ) AS exists
      `);
      if (!fkRows[0]?.exists) {
        await client.query(`
          ALTER TABLE security_findings
          ADD CONSTRAINT security_findings_check_run_id_fkey
          FOREIGN KEY (check_run_id) REFERENCES check_runs(id) ON DELETE SET NULL;
        `);
        console.log("Added check_run_id FK constraint to existing security_findings table.");
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
