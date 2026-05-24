/**
 * Migration: create `project_embeddings` table for the Task #534 semantic
 * project search. Idempotent — safe to re-run.
 * Run: pnpm --filter @workspace/scripts run migrate-project-embeddings
 */
import { pool } from "@workspace/db";

const EMBEDDING_DIM = 1536;

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS project_embeddings (
         id serial PRIMARY KEY,
         project_id integer NOT NULL,
         file_path text NOT NULL,
         content_hash text NOT NULL,
         model text NOT NULL DEFAULT 'text-embedding-3-small',
         embedding vector(${EMBEDDING_DIM}),
         snippet text NOT NULL DEFAULT '',
         created_at timestamptz NOT NULL DEFAULT now(),
         updated_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_embeddings_project_file_unique
         ON project_embeddings (project_id, file_path)`,
    );
    await client.query("COMMIT");
    console.log("project_embeddings table ensured.");
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
