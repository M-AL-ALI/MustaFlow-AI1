/**
 * Migration: enable pgvector and add `embedding vector(1536)` column to
 * knowledge_entries. Idempotent — safe to re-run.
 * Handles the case where a previous run created the column as jsonb (drops it
 * before re-adding as vector).
 * Run: pnpm --filter @workspace/scripts run migrate-knowledge-embeddings
 */
import { pool } from "@workspace/db";

const EMBEDDING_DIM = 1536;

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);

    // If a prior version of this migration created `embedding` as jsonb, drop it
    // so we can re-add it as the pgvector type. Safe: embeddings are derived data.
    const { rows } = await client.query<{ data_type: string }>(
      `SELECT data_type
         FROM information_schema.columns
        WHERE table_name = 'knowledge_entries'
          AND column_name = 'embedding'`,
    );
    const current = rows[0]?.data_type;
    if (current && current.toLowerCase() !== "user-defined") {
      // pgvector reports as "USER-DEFINED"; anything else (e.g. "jsonb") is wrong.
      console.log(`  Existing embedding column is ${current}; dropping for re-add as vector.`);
      await client.query(`ALTER TABLE knowledge_entries DROP COLUMN embedding`);
    }

    await client.query(
      `ALTER TABLE knowledge_entries
         ADD COLUMN IF NOT EXISTS embedding vector(${EMBEDDING_DIM})`,
    );
    await client.query("COMMIT");
    console.log("knowledge_entries.embedding (pgvector) column ensured.");
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
