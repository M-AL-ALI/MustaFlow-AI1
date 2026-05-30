import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    console.log("Phase 8A.1: Converting vault_entries.tags TEXT → TEXT[]...");
    // Cannot use subqueries in ALTER TABLE USING; use string_to_array directly.
    // Tags were stored trimmed (Zod .trim() + join(",")) so no whitespace padding.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'vault_entries' AND column_name = 'tags'
            AND data_type = 'text'
        ) THEN
          ALTER TABLE vault_entries
            ALTER COLUMN tags TYPE text[]
            USING (
              CASE
                WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                ELSE string_to_array(tags, ',')
              END
            );
          ALTER TABLE vault_entries ALTER COLUMN tags SET DEFAULT '{}';
          ALTER TABLE vault_entries ALTER COLUMN tags SET NOT NULL;
        END IF;
      END $$
    `);
    console.log("  vault_entries.tags done");

    console.log("Phase 8A.1: Converting vault_versions.tags TEXT → TEXT[]...");
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'vault_versions' AND column_name = 'tags'
            AND data_type = 'text'
        ) THEN
          ALTER TABLE vault_versions
            ALTER COLUMN tags TYPE text[]
            USING (
              CASE
                WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                ELSE string_to_array(tags, ',')
              END
            );
          ALTER TABLE vault_versions ALTER COLUMN tags SET DEFAULT '{}';
          ALTER TABLE vault_versions ALTER COLUMN tags SET NOT NULL;
        END IF;
      END $$
    `);
    console.log("  vault_versions.tags done");

    // Functional GIN index on title+summary for full-text search.
    // NOTE: A GENERATED tsvector column was considered but array_to_string() is STABLE
    // (not IMMUTABLE), which PostgreSQL rejects in generated column expressions.
    // A functional index is equivalent for query planning and avoids the restriction.
    console.log("Phase 8A.1: Creating functional GIN index for full-text search...");
    await client.query(`
      CREATE OR REPLACE FUNCTION vault_fts(title text, summary text)
        RETURNS tsvector
        LANGUAGE sql
        IMMUTABLE PARALLEL SAFE
        AS $fn$
          SELECT to_tsvector('english'::regconfig,
            coalesce(title, '') || ' ' || coalesce(summary, ''))
        $fn$
    `);
    await client.query(`DROP INDEX IF EXISTS vault_entries_search_idx`);
    await client.query(`
      CREATE INDEX vault_entries_search_idx
        ON vault_entries
        USING GIN(vault_fts(title, summary))
    `);
    console.log("  vault_fts function + FTS GIN index created");

    console.log("Phase 8A.1: Creating GIN index on tags array...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS vault_entries_tags_idx ON vault_entries USING GIN(tags)`,
    );
    console.log("  GIN indexes created");

    console.log("Phase 8A.1: Creating performance indexes...");
    await client.query(
      `CREATE INDEX IF NOT EXISTS vault_entries_updated_idx ON vault_entries (user_id, updated_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS vault_entries_dept_idx ON vault_entries (user_id, department)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS vault_entries_archived_idx ON vault_entries (user_id, archived_at) WHERE archived_at IS NOT NULL`,
    );
    console.log("  Performance indexes created");

    await client.query("COMMIT");
    console.log("✓ Phase 8A.1 migration complete");
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
