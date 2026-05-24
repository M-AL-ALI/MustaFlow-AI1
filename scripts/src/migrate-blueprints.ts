/**
 * One-time migration: add project_blueprints + mcp_servers tables for Task #542.
 * Idempotent — safe to re-run.
 * Run: pnpm --filter @workspace/scripts run migrate-blueprints
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS project_blueprints (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        blueprint_id text NOT NULL,
        version text NOT NULL DEFAULT '1.0.0',
        installed_by text,
        result jsonb,
        installed_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_blueprints_pk_idx
       ON project_blueprints(project_id, blueprint_id)`,
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id serial PRIMARY KEY,
        name text NOT NULL,
        description text,
        endpoint text NOT NULL,
        auth_header text,
        enabled boolean NOT NULL DEFAULT true,
        cached_tools jsonb,
        cached_at timestamptz,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS mcp_servers_enabled_idx ON mcp_servers(enabled)`,
    );

    await client.query("COMMIT");
    console.log("project_blueprints + mcp_servers migration complete.");
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
