/**
 * Migration: Ora Project Spaces (Phase 6)
 *
 *  - Adds `ora_project_id` to `ora_assets` so generated files/images and their
 *    revision chains are scoped to an Ora project (null = Personal space).
 *  - Adds `ora_project_id` to `ora_file_contexts` so persisted upload contexts
 *    are scoped the same way.
 *  - Composite (user_id, ora_project_id) indexes for project-filtered lists.
 *
 * No FK by design, matching ora_conversations.project_id — archiving a project
 * never cascades into asset rows.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-project-spaces
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_assets_user_project_idx ON ora_assets(user_id, ora_project_id)`,
    );

    await client.query(
      `ALTER TABLE ora_file_contexts ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_file_contexts_user_project_idx ON ora_file_contexts(user_id, ora_project_id)`,
    );

    await client.query("COMMIT");
    console.log("migrate-ora-project-spaces: done");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((err) => {
  console.error("migrate-ora-project-spaces failed:", err);
  process.exit(1);
});
