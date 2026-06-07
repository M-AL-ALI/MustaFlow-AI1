/**
 * ORAX Phase 2A - GitHub read-only repository scanning.
 *
 * Adds encrypted read-only GitHub token metadata to ORAX repositories and a
 * scan-history table. This migration is idempotent and does not add write/push
 * capability.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax-github-readonly
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS github_account_name TEXT`,
    );
    await client.query(`ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS token_scopes TEXT`);
    await client.query(
      `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS encrypted_token TEXT`,
    );
    await client.query(
      `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ`,
    );
    await client.query(
      `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'idle'`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_repository_scans (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        repository_id   INTEGER NOT NULL,
        status          TEXT NOT NULL DEFAULT 'completed',
        branch          TEXT NOT NULL,
        commit_sha      TEXT,
        file_count      INTEGER NOT NULL DEFAULT 0,
        directory_count INTEGER NOT NULL DEFAULT 0,
        total_bytes     INTEGER NOT NULL DEFAULT 0,
        summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
        error           TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_repository_scans_user_id_idx
         ON orax_repository_scans(user_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_repository_scans_repository_id_idx
         ON orax_repository_scans(repository_id, created_at)`,
    );

    await client.query("COMMIT");
    console.log("orax github read-only migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-orax-github-readonly failed:", err);
  process.exit(1);
});
