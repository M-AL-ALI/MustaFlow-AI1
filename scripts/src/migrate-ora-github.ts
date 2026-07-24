/**
 * Migration: Ora GitHub read-only repo analysis.
 *
 * Creates ora_github_connections (encrypted OAuth token per user) and
 * ora_repo_sessions (selected-repo sessions; disk workspaces are ephemeral
 * and re-materialized from these rows). Idempotent — safe to re-run.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-github
 */
import { pool } from "@workspace/db";

async function migrateOraGithub() {
  console.log("[migrate-ora-github] Creating ora_github_connections + ora_repo_sessions …");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ora_github_connections (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      encrypted_token TEXT NOT NULL,
      github_login    TEXT NOT NULL,
      scopes          TEXT NOT NULL DEFAULT '',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ora_github_connections_user_uidx
      ON ora_github_connections(user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ora_github_connections_user_id_idx
      ON ora_github_connections(user_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ora_repo_sessions (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      conversation_id TEXT,
      owner           TEXT NOT NULL,
      repo            TEXT NOT NULL,
      ref             TEXT NOT NULL DEFAULT '',
      default_branch  TEXT NOT NULL DEFAULT 'main',
      status          TEXT NOT NULL DEFAULT 'active',
      file_count      INTEGER,
      total_bytes     INTEGER,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_id_idx
      ON ora_repo_sessions(user_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_status_idx
      ON ora_repo_sessions(user_id, status)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ora_repo_sessions_conversation_idx
      ON ora_repo_sessions(conversation_id)
  `);

  console.log("[migrate-ora-github] Done.");
}

migrateOraGithub()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[migrate-ora-github] Migration failed:", err);
    process.exit(1);
  });
