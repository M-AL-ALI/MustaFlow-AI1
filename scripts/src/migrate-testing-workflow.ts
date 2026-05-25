/**
 * Task #770 — Testing workflow migration.
 *
 * Adds the test-then-publish columns to `projects`:
 *   - test_container_id          text
 *   - test_container_url         text
 *   - test_container_status      text NOT NULL DEFAULT 'stopped'
 *   - running_test_snapshot_id   integer
 *   - static_test_candidate_snapshot_id  integer
 *   - testing_candidate_snapshot_id      integer
 *   - testing_status             text NOT NULL DEFAULT 'idle'
 *   - tested_snapshot_id         integer
 *   - previous_published_snapshot_id     integer
 *   - active_preview_session_id  text
 *
 * Adds to `project_secrets`:
 *   - exposure_type              text NOT NULL DEFAULT 'server'
 *
 * Creates the `preview_sessions` table.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-testing-workflow
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── projects: testing workflow columns ────────────────────────────────────
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_id text`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_url text`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_status text NOT NULL DEFAULT 'stopped'`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS running_test_snapshot_id integer`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS static_test_candidate_snapshot_id integer`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_candidate_snapshot_id integer`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_status text NOT NULL DEFAULT 'idle'`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS tested_snapshot_id integer`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS previous_published_snapshot_id integer`,
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_preview_session_id text`,
    );

    // ── project_secrets: exposure_type ────────────────────────────────────────
    await client.query(
      `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS exposure_type text NOT NULL DEFAULT 'server'`,
    );

    // ── preview_sessions table ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS preview_sessions (
        id                serial PRIMARY KEY,
        session_id        text NOT NULL UNIQUE,
        project_id        integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id           text NOT NULL,
        launch_token_hash text NOT NULL,
        launch_token_used boolean NOT NULL DEFAULT false,
        cookie_issued_at  timestamptz,
        expires_at        timestamptz NOT NULL,
        revoked_at        timestamptz,
        revoke_reason     text,
        created_at        timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS preview_sessions_project_idx ON preview_sessions (project_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS preview_sessions_session_id_idx ON preview_sessions (session_id)`,
    );

    await client.query("COMMIT");
    console.log("Testing-workflow migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
