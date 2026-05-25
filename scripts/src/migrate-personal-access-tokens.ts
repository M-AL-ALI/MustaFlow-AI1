/**
 * Migration: Create personal_access_tokens table (Task #845)
 *
 * Creates the personal_access_tokens table if it does not already exist.
 * Without this table, token creation fails with a "relation does not exist"
 * error on deployed environments where the schema was defined after the
 * initial DB push.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-personal-access-tokens
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id             SERIAL PRIMARY KEY,
        user_id        TEXT        NOT NULL,
        name           TEXT        NOT NULL,
        token_hash     TEXT        NOT NULL UNIQUE,
        token_preview  TEXT        NOT NULL,
        project_id     INTEGER     REFERENCES projects(id) ON DELETE CASCADE,
        scopes         JSONB       NOT NULL DEFAULT '["domains:read","domains:write"]',
        active         BOOLEAN     NOT NULL DEFAULT TRUE,
        last_used_at   TIMESTAMPTZ,
        expires_at     TIMESTAMPTZ,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query("COMMIT");
    console.log("✓ personal_access_tokens table created (or already existed)");
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
