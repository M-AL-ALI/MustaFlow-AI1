/**
 * ORAX Phase 2C - draft patch artifacts.
 *
 * Stores generated diff previews for user review. This migration does not add
 * file application, terminal, push, PR, or deploy capability.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax-artifacts
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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

    await client.query("COMMIT");
    console.log("orax artifacts migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-orax-artifacts failed:", err);
  process.exit(1);
});
