/**
 * One-time migration: add blockPublishOnCritical and dismissedFindingHashes columns to projects.
 * Run: pnpm --filter @workspace/scripts run migrate-security-gate
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS block_publish_on_critical boolean NOT NULL DEFAULT true
    `);

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS dismissed_finding_hashes jsonb NOT NULL DEFAULT '[]'::jsonb
    `);

    await client.query("COMMIT");
    console.log("Security gate migration complete.");
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
