/**
 * Task #767 — Real preview and production loop.
 *
 * Adds the testing-approval columns to project_versions:
 *   - testing_approved_at   (nullable timestamp)
 *   - testing_approved_by   (nullable text — Clerk userId)
 *   - migration_status      (nullable text — pending|running|passed|failed)
 *   - migration_log         (nullable text — captured stdout/stderr)
 *   - testing_skipped       (boolean, default false — admin bypass flag)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-testing-approval
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_at timestamptz`,
    );
    await client.query(
      `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_by text`,
    );
    await client.query(
      `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_status text`,
    );
    await client.query(`ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_log text`);
    await client.query(
      `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_skipped boolean NOT NULL DEFAULT false`,
    );

    await client.query("COMMIT");
    console.log("Testing-approval migration complete.");
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
