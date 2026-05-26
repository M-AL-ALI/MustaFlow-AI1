/**
 * Migration: Add canvas_state column to projects (Task #904)
 *
 * Adds:
 *   canvas_state JSONB NULL DEFAULT '{}'
 *     — Persisted canvas board state for the Developer Mode Canvas tab.
 *       Structure: { explorationId, tiles: { [variantId]: { device } } }
 *       Saved by PATCH /api/projects/:id/canvas/state; loaded on workspace open.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-canvas-state
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS canvas_state JSONB DEFAULT '{}'
    `);

    await client.query("COMMIT");
    console.log("✓ projects.canvas_state column added (jsonb, default '{}'");
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
