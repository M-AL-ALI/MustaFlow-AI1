/**
 * ORAX Phase 1 - isolated coding-agent foundation.
 *
 * Creates user-scoped ORAX repository metadata and task tables. This migration
 * does not store provider tokens or secrets; write/push provider auth is a later
 * approval-gated phase.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_repositories (
        id                SERIAL PRIMARY KEY,
        user_id           TEXT NOT NULL,
        provider          TEXT NOT NULL DEFAULT 'github',
        owner             TEXT NOT NULL,
        name              TEXT NOT NULL,
        repository_url    TEXT NOT NULL,
        default_branch    TEXT NOT NULL DEFAULT 'main',
        connection_status TEXT NOT NULL DEFAULT 'metadata_only',
        github_account_name TEXT,
        token_scopes      TEXT,
        encrypted_token   TEXT,
        connected_at      TIMESTAMPTZ,
        last_scan_at      TIMESTAMPTZ,
        scan_status       TEXT NOT NULL DEFAULT 'idle',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at       TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_repositories_user_id_idx ON orax_repositories(user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_repositories_provider_idx ON orax_repositories(provider, owner, name)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_tasks (
        id                SERIAL PRIMARY KEY,
        user_id           TEXT NOT NULL,
        repository_id     INTEGER NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'analyze',
        status            TEXT NOT NULL DEFAULT 'planned',
        title             TEXT NOT NULL,
        prompt            TEXT NOT NULL,
        plan              JSONB NOT NULL DEFAULT '{}'::jsonb,
        result            JSONB NOT NULL DEFAULT '{}'::jsonb,
        approval_required TEXT NOT NULL DEFAULT 'write_and_push',
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at      TIMESTAMPTZ,
        archived_at       TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_tasks_user_id_idx ON orax_tasks(user_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_tasks_repository_id_idx ON orax_tasks(repository_id)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS orax_tasks_status_idx ON orax_tasks(status)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_task_approvals (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        repository_id INTEGER NOT NULL,
        task_id       INTEGER NOT NULL,
        action        TEXT NOT NULL DEFAULT 'read_files',
        status        TEXT NOT NULL DEFAULT 'pending',
        request       JSONB NOT NULL DEFAULT '{}'::jsonb,
        result        JSONB NOT NULL DEFAULT '{}'::jsonb,
        risk_summary  TEXT,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_approvals_user_id_idx
         ON orax_task_approvals(user_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_approvals_task_id_idx
         ON orax_task_approvals(task_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_approvals_status_idx
         ON orax_task_approvals(status)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_task_artifacts (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        repository_id INTEGER NOT NULL,
        task_id       INTEGER NOT NULL,
        approval_id   INTEGER,
        type          TEXT NOT NULL DEFAULT 'draft_patch',
        status        TEXT NOT NULL DEFAULT 'draft',
        title         TEXT NOT NULL,
        summary       TEXT,
        payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at   TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_artifacts_user_id_idx
         ON orax_task_artifacts(user_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_artifacts_task_id_idx
         ON orax_task_artifacts(task_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_artifacts_status_idx
         ON orax_task_artifacts(status)`,
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
    console.log("orax migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-orax failed:", err);
  process.exit(1);
});
