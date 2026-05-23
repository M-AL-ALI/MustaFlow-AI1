/**
 * Migration: add projects.e2e_enabled boolean column (default true).
 * Run: pnpm --filter @workspace/scripts run migrate-e2e-enabled
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS e2e_enabled boolean NOT NULL DEFAULT true
    `);
    await client.query("COMMIT");
    console.log("projects.e2e_enabled migration complete.");
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
