/**
 * Migration: add draft / authored_by / authored_at / authoring_context columns
 * to builder_skills (Task #536). Safe to re-run — uses IF NOT EXISTS.
 *   pnpm --filter @workspace/scripts run migrate-builder-skills-drafts
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE builder_skills
        ADD COLUMN IF NOT EXISTS draft boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS authored_by text,
        ADD COLUMN IF NOT EXISTS authored_at timestamptz,
        ADD COLUMN IF NOT EXISTS authoring_context text
    `);
    await client.query("COMMIT");
    console.log("builder_skills draft columns migration complete.");
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
