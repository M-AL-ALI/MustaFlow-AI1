/**
 * ORAX Phase 2B - approval-gated execution foundation.
 *
 * Adds task approval records for controlled read-only actions. This migration
 * does not add edit, terminal, push, PR, or deploy capability.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax-approvals
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

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

    await client.query("COMMIT");
    console.log("orax approvals migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-orax-approvals failed:", err);
  process.exit(1);
});
