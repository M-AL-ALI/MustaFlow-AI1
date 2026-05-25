/**
 * Task #767 — Real preview and production loop.
 *
 * Adds the preview database columns to projects:
 *   - preview_db_url     (nullable text — encrypted Neon connection string)
 *   - preview_db_status  (text NOT NULL DEFAULT 'none')
 *
 * Run: pnpm --filter @workspace/scripts run migrate-preview-db
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_url text`);
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_status text NOT NULL DEFAULT 'none'`,
    );

    await client.query("COMMIT");
    console.log("Preview-db migration complete.");
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
