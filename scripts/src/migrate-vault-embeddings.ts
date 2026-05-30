import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Ensure pgvector is available (already installed on this host at v0.8.0)
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");
    console.log("pgvector: ready");

    // Create vault_embeddings table
    await client.query(`
      CREATE TABLE IF NOT EXISTS vault_embeddings (
        id              serial PRIMARY KEY,
        entry_id        integer NOT NULL,
        user_id         text NOT NULL,
        chunk_index     integer NOT NULL,
        chunk_text      text NOT NULL,
        chunk_hash      text NOT NULL,
        embedding       vector(1536),
        embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
        source_version  integer NOT NULL,
        created_at      timestamptz NOT NULL DEFAULT now(),
        updated_at      timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT vault_embeddings_entry_chunk_unique UNIQUE (entry_id, chunk_index)
      )
    `);
    console.log("vault_embeddings: table created");

    // Index: look up chunks by entry (for status queries and deletion)
    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_embeddings_entry_idx
        ON vault_embeddings (entry_id)
    `);

    // Index: filter by user (for reindex-all scans)
    await client.query(`
      CREATE INDEX IF NOT EXISTS vault_embeddings_user_idx
        ON vault_embeddings (user_id, entry_id)
    `);

    // HNSW index on the vector column — disabled by default (needs data to be useful).
    // Will be created separately once the table has content.
    // For Phase 8B-1 (infrastructure only) we skip it to avoid empty-index overhead.
    // Kept as a comment so Phase 8B-2 (semantic search) can reference the pattern:
    //   CREATE INDEX vault_embeddings_hnsw_idx
    //     ON vault_embeddings USING hnsw (embedding vector_cosine_ops);

    await client.query("COMMIT");
    console.log("✓ migrate-vault-embeddings complete");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed, rolled back:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
