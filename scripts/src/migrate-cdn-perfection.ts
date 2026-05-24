/**
 * Migration: cdn-perfection (Task #624)
 *
 * Adds:
 *   - projects.error_page_404  — custom 404 HTML for edge / DB serving
 *   - projects.error_page_500  — custom 500 HTML for edge / DB serving
 *   - project_bandwidth table  — per-project monthly bandwidth metering
 *
 * Safe to re-run (uses IF NOT EXISTS / IF NOT EXISTS column guards).
 */

import { pool } from "@workspace/db";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS error_page_404 text,
        ADD COLUMN IF NOT EXISTS error_page_500 text;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_bandwidth (
        id           serial PRIMARY KEY,
        project_id   integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        month        text    NOT NULL,
        bytes_served bigint  NOT NULL DEFAULT 0,
        request_count integer NOT NULL DEFAULT 0,
        updated_at   timestamp with time zone NOT NULL DEFAULT now(),
        UNIQUE (project_id, month)
      );
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS project_bandwidth_project_month_idx ON project_bandwidth (project_id, month);`,
    );

    await client.query("COMMIT");
    console.log("Migration cdn-perfection: applied successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration cdn-perfection: ROLLBACK due to error:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
