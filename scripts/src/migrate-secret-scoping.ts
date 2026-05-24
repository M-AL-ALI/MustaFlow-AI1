/**
 * Migration: Add min_role column to project_secrets (Task #632 — per-secret access scoping)
 *
 * Adds:
 *   min_role TEXT NOT NULL DEFAULT 'viewer'
 *     — minimum org role required to read the decrypted value.
 *     Values: viewer | member | admin | owner
 *
 * Run: pnpm --filter @workspace/scripts run migrate-secret-scoping
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE project_secrets
        ADD COLUMN IF NOT EXISTS min_role TEXT NOT NULL DEFAULT 'viewer'
    `);

    // Add a check constraint so only valid roles are accepted
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'project_secrets_min_role_check'
        ) THEN
          ALTER TABLE project_secrets
            ADD CONSTRAINT project_secrets_min_role_check
            CHECK (min_role IN ('viewer', 'member', 'admin', 'owner'));
        END IF;
      END
      $$;
    `);

    await client.query("COMMIT");
    console.log("✓ project_secrets.min_role column added (default: viewer)");
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
