/**
 * Migration: Add brainstorm context tracking columns to agent_tasks
 *
 * Adds:
 *   has_brainstorm_context BOOLEAN NOT NULL DEFAULT FALSE
 *     — true when the task was created with brainstorm conversation context forwarded to the builder
 *   brainstorm_turn_count INTEGER NULL
 *     — number of brainstorm conversation turns included as context (user + assistant messages)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-brainstorm-context
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE agent_tasks
        ADD COLUMN IF NOT EXISTS has_brainstorm_context BOOLEAN NOT NULL DEFAULT FALSE,
        ADD COLUMN IF NOT EXISTS brainstorm_turn_count INTEGER
    `);

    await client.query("COMMIT");
    console.log("✓ agent_tasks.has_brainstorm_context and brainstorm_turn_count columns added");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
