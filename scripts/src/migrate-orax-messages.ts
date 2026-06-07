/**
 * ORAX Phase 4A - task conversation messages.
 *
 * Stores conversational context for one ORAX coding task. This migration does
 * not add terminal, push, PR, deploy, Ora-chat, or AI Builder capability.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax-messages
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_task_messages (
        id            SERIAL PRIMARY KEY,
        user_id       TEXT NOT NULL,
        repository_id INTEGER NOT NULL,
        task_id       INTEGER NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        content       TEXT NOT NULL,
        metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
        artifact_id   INTEGER,
        approval_id   INTEGER,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        archived_at   TIMESTAMPTZ
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_messages_user_task_idx
         ON orax_task_messages(user_id, task_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_messages_task_id_idx
         ON orax_task_messages(task_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_messages_artifact_id_idx
         ON orax_task_messages(artifact_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS orax_task_messages_approval_id_idx
         ON orax_task_messages(approval_id)`,
    );

    await client.query("COMMIT");
    console.log("orax messages migration complete");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("migrate-orax-messages failed:", err);
  process.exit(1);
});
