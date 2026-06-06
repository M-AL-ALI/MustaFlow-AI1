/**
 * Migration: knowledge_entries.origin (Ora ↔ Builder isolation)
 *
 *  - Adds `origin` to `knowledge_entries` to mark provenance:
 *      "ora"     = user-approved Ora memory (the only origin Ora surfaces/injects)
 *      "builder" = AI Builder Knowledge Vault entry (hidden from Ora)
 *      "system"  = auto-promoted cross-user knowledge
 *      "legacy"  = pre-existing untagged rows
 *  - Backfills every existing row to "builder": before this change Ora had no
 *    write path, so all current user-scope entries are Builder-generated. This
 *    keeps them in the Builder Knowledge Vault but hides them from Ora Memory.
 *    Nothing is deleted.
 *
 * Idempotent (ADD COLUMN IF NOT EXISTS; backfill only touches NULL rows).
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-knowledge-origin
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS origin TEXT`);

    const { rowCount } = await client.query(
      `UPDATE knowledge_entries SET origin = 'builder' WHERE origin IS NULL`,
    );

    await client.query("COMMIT");
    console.log(
      `Migration complete: knowledge_entries.origin added (${rowCount ?? 0} rows backfilled to 'builder')`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
