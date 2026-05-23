/**
 * Migration: add architect_review_enabled column to projects.
 * Per-project toggle for the architect review subagent (Task #507).
 * Safe to re-run — uses IF NOT EXISTS. Defaults to true so existing
 * projects opt in by default.
 * Run: pnpm --filter @workspace/scripts run migrate-architect-review
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS architect_review_enabled boolean NOT NULL DEFAULT true
    `);
    await client.query("COMMIT");
    console.log("projects.architect_review_enabled migration complete.");
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
