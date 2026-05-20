/**
 * Migration: add production_container_id and production_container_url columns to projects table.
 * Run: pnpm --filter @workspace/scripts run migrate-production-container
 * Safe to re-run — uses IF NOT EXISTS.
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_id text",
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_url text",
    );

    await client.query("COMMIT");
    console.log("Production container migration complete.");
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
