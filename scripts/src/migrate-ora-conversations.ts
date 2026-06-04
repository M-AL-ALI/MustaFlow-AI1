/**
 * Migration: ora_projects + ora_conversations tables (Ora Step 2)
 *
 * Introduces multi-conversation support for the standalone Ora assistant.
 * - ora_projects: lightweight folders grouping related conversations.
 * - ora_conversations: individual chat threads, each owning its own JSONB
 *   message history. projectId is null for standalone/one-off chats.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-conversations
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_projects (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL,
        name        TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_projects_user_id_idx ON ora_projects (user_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ora_conversations (
        id              SERIAL PRIMARY KEY,
        user_id         TEXT NOT NULL,
        project_id      INTEGER,
        title           TEXT,
        messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at     TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_conversations_user_id_idx ON ora_conversations (user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS ora_conversations_project_id_idx ON ora_conversations (project_id)
    `);

    await client.query("COMMIT");
    console.log("Migration complete: ora_projects + ora_conversations tables created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
