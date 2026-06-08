/**
 * Migration: knowledge_entries.ora_project_id (persistent Ora project memory)
 *
 *  - Adds `ora_project_id` to `knowledge_entries`. When set (origin="ora" rows
 *    only), the memory belongs to a specific Ora project and persists across
 *    every conversation in that project.
 *  - Deliberately SEPARATE from Builder's `project_id` so the AI Builder
 *    Knowledge Vault read paths never select Ora project memories.
 *  - Index on (ora_project_id) for fast per-project lookup.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-project-memory
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS ora_project_id integer`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS knowledge_entries_ora_project_id_idx ON knowledge_entries(ora_project_id)`,
    );
    await client.query("COMMIT");
    console.log("Migration complete: knowledge_entries.ora_project_id added");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
