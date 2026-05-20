/**
 * One-time migration: add container columns to projects table + container_logs table.
 * Run: pnpm --filter @workspace/scripts run migrate-containers
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_id text",
    );
    await client.query(
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_status text NOT NULL DEFAULT 'stopped'`,
    );
    await client.query(
      "ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_url text",
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS container_logs (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        level text NOT NULL DEFAULT 'stdout',
        message text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query("COMMIT");
    console.log("Container migration complete.");
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
