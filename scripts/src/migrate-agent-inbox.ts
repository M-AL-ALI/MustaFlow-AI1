/**
 * Task #546 — Agent Inbox & Conversation History Search.
 *
 * Creates the `agent_inbox` table and adds a Postgres tsvector full-text
 * search index on `chat_messages.content`. Idempotent — safe to re-run.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-agent-inbox
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_inbox (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id text,
        category text NOT NULL DEFAULT 'bug',
        severity text NOT NULL DEFAULT 'medium',
        description text NOT NULL,
        screenshot_url text,
        status text NOT NULL DEFAULT 'unread',
        created_at timestamptz NOT NULL DEFAULT now(),
        read_at timestamptz,
        resolved_at timestamptz
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS agent_inbox_project_status_idx ON agent_inbox(project_id, status, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS agent_inbox_status_created_idx ON agent_inbox(status, created_at DESC)`,
    );

    // Add generated tsvector column on chat_messages.content for FTS.
    // Use IF NOT EXISTS so re-runs are safe.
    await client.query(`
      ALTER TABLE chat_messages
        ADD COLUMN IF NOT EXISTS content_tsv tsvector
        GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS chat_messages_content_tsv_idx ON chat_messages USING GIN (content_tsv)`,
    );

    await client.query("COMMIT");
    console.log("agent_inbox + chat_messages FTS migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
