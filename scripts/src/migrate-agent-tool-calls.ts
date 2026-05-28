/**
 * Migration: agent_tool_calls table + toolCallRateCapPerHour column on projects
 *
 * Creates the comprehensive per-tool-call audit log for the agentic builder
 * loop and adds the per-project hourly rate-cap setting.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-agent-tool-calls
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Create agent_tool_calls table
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_tool_calls (
        id                 SERIAL PRIMARY KEY,
        project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        task_id            INTEGER,
        tool_name          TEXT NOT NULL,
        args_summary       TEXT,
        stdout_preview     TEXT,
        exit_code          INTEGER,
        ok                 BOOLEAN NOT NULL DEFAULT TRUE,
        duration_ms        INTEGER NOT NULL DEFAULT 0,
        called_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // 2. Indexes for efficient rate-limit queries and task lookups
    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_tool_calls_project_called_idx
        ON agent_tool_calls (project_id, called_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS agent_tool_calls_task_idx
        ON agent_tool_calls (task_id)
    `);

    // 3. Add toolCallRateCapPerHour to projects (idempotent)
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS tool_call_rate_cap_per_hour INTEGER NOT NULL DEFAULT 200
    `);

    await client.query("COMMIT");
    console.log(
      "Migration complete: agent_tool_calls table created, tool_call_rate_cap_per_hour added to projects",
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
