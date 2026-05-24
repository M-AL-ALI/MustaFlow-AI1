/**
 * Task #738 — Auto-provision container + Postgres per new project.
 *
 * Adds the agentic provisioning columns to the projects table:
 *   - builder_mode         (default: 'static-legacy' for existing rows)
 *   - neon_project_id      (nullable — captured at provision time)
 *   - provisioning_status  (default: 'idle')
 *   - provisioning_error   (nullable)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-agentic-provisioning
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Backfill: existing rows are flagged as 'static-legacy' so they don't
    // suddenly try to auto-provision infra they never had.
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS builder_mode text NOT NULL DEFAULT 'static-legacy'`,
    );
    // Going forward, every NEW project row defaults to 'agentic' so the
    // creation paths that omit builderMode (duplicate, gallery fork, etc.)
    // still get auto-provisioned.
    await client.query(`ALTER TABLE projects ALTER COLUMN builder_mode SET DEFAULT 'agentic'`);
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS neon_project_id text`);
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'idle'`,
    );
    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_error text`);

    await client.query("COMMIT");
    console.log("Agentic provisioning migration complete.");
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
