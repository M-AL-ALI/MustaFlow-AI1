import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_usage_events (
        id                      BIGSERIAL   PRIMARY KEY,
        user_id                 TEXT        NOT NULL,
        query                   TEXT        NOT NULL,
        report_type             TEXT        NOT NULL DEFAULT 'knowledge-report',
        selected_entry_ids      INTEGER[]   NOT NULL DEFAULT '{}',
        selected_entry_versions INTEGER[]   NOT NULL DEFAULT '{}',
        entry_count             INTEGER     NOT NULL DEFAULT 0,
        created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_kue_user_id ON knowledge_usage_events (user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_kue_created_at ON knowledge_usage_events (created_at)`,
    );
    await client.query("COMMIT");
    console.log("migration: knowledge_usage_events table ready");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
