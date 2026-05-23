/**
 * Migration: create builder_skills table for the per-task skills system.
 * Safe to re-run — uses IF NOT EXISTS.
 * Run: pnpm --filter @workspace/scripts run migrate-builder-skills
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS builder_skills (
        name text PRIMARY KEY,
        enabled boolean NOT NULL DEFAULT true,
        load_count integer NOT NULL DEFAULT 0,
        last_loaded_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query("COMMIT");
    console.log("builder_skills table ready.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
