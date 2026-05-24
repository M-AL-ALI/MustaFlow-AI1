/**
 * Migration: add Knowledge Vault v2 columns to knowledge_entries.
 * - scope TEXT NOT NULL DEFAULT 'project'
 * - thumbs_up INTEGER NOT NULL DEFAULT 0
 * - thumbs_down INTEGER NOT NULL DEFAULT 0
 * - usage_count INTEGER NOT NULL DEFAULT 0
 * - is_public BOOLEAN NOT NULL DEFAULT FALSE
 *
 * Idempotent — safe to re-run.
 * Run: pnpm --filter @workspace/scripts run migrate-knowledge-vault-v2
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE knowledge_entries
        ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'project',
        ADD COLUMN IF NOT EXISTS thumbs_up INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS thumbs_down INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // Back-fill scope from existing data:
    // - entries with approvedForReuse=true → scope='global'
    // - entries with projectId IS NULL and userId IS NOT NULL → scope='user'
    // - everything else → 'project' (already the default)
    await client.query(`
      UPDATE knowledge_entries
         SET scope = 'global'
       WHERE approved_for_reuse = TRUE
         AND scope = 'project'
    `);

    await client.query(`
      UPDATE knowledge_entries
         SET scope = 'user'
       WHERE project_id IS NULL
         AND user_id IS NOT NULL
         AND approved_for_reuse = FALSE
         AND scope = 'project'
    `);

    await client.query("COMMIT");
    console.log("Knowledge Vault v2 migration complete.");
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
