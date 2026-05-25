/**
 * Migration: Add rotated_at column to personal_access_tokens (Task #864)
 *
 * Adds a nullable rotated_at timestamptz column so the token rotation
 * endpoint (POST /api/me/tokens/:tokenId/rotate) can record when a token
 * was last rotated, enabling the "Rotated" badge in the UI for 24 h.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-pat-rotation
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE personal_access_tokens
        ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ
    `);

    await client.query("COMMIT");
    console.log("✓ personal_access_tokens.rotated_at column added (or already existed)");
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
