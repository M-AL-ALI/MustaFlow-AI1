/**
 * Migration: Ora Memory consolidation (Consolidate conflicting Ora memories)
 *
 * Adds `superseded_by` to `knowledge_entries`:
 *   superseded_by INTEGER NULL
 *     — when a newer Ora memory supersedes this one (a contradicting update
 *       like "dark mode" → "light mode"), this points to the newer entry's id.
 *       Superseded rows are disabled (excluded from Ora's context) but kept and
 *       still shown in the Memory Center so consolidation is non-destructive and
 *       reversible. Null = active / never superseded.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS). Safe to re-run.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-memory-supersede
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS superseded_by INTEGER`,
    );

    await client.query("COMMIT");
    console.log("✓ knowledge_entries.superseded_by column added (nullable integer)");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
