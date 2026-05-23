/**
 * Migration: add validation_status column to project_versions.
 * Tracks whether a snapshot's required checks passed (values: 'passed' | 'failed').
 * Safe to re-run — uses IF NOT EXISTS.
 * Run: pnpm --filter @workspace/scripts run migrate-version-validation-status
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE project_versions
        ADD COLUMN IF NOT EXISTS validation_status text
    `);
    await client.query("COMMIT");
    console.log("project_versions.validation_status migration complete.");
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
