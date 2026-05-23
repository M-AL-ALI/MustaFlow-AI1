/**
 * Migration: Task #510 — policy strictness + tool audit log.
 *
 * Adds:
 *   - projects.policy_strictness column (default 'standard').
 *   - tool_audit table + indexes.
 *
 * Safe to re-run — uses IF NOT EXISTS.
 */

import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS policy_strictness text NOT NULL DEFAULT 'standard'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS tool_audit (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id integer,
        tool_name text NOT NULL,
        stack text,
        argv jsonb NOT NULL,
        exit_code integer,
        stdout_tail text,
        stderr_tail text,
        duration_ms integer NOT NULL DEFAULT 0,
        blocked boolean NOT NULL DEFAULT false,
        block_reason text,
        policy_strictness text NOT NULL DEFAULT 'standard',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS tool_audit_project_idx
        ON tool_audit (project_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS tool_audit_blocked_idx
        ON tool_audit (blocked, created_at)
    `);

    await client.query("COMMIT");
    console.log("migrate-policy-audit: OK");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("migrate-policy-audit: FAILED", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void main();
