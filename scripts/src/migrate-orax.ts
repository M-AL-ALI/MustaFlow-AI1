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
