/**
 * Migration: Add is_preview_safe column to project_secrets (Task #766 — preview environment isolation)
 *
 * Adds:
 *   is_preview_safe BOOLEAN NOT NULL DEFAULT FALSE
 *     — when true, this secret is safe to inject into the draft preview container.
 *     Production secrets default to false so they are never automatically exposed in preview.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-preview-secrets
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE project_secrets
        ADD COLUMN IF NOT EXISTS is_preview_safe BOOLEAN NOT NULL DEFAULT FALSE
    `);

    await client.query("COMMIT");
    console.log("✓ project_secrets.is_preview_safe column added (default: false)");
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
