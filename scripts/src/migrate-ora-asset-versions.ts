/**
 * Migration: file revision lineage columns on ora_assets (Ora roadmap Phase 2).
 *
 * Adds append-only version-chain metadata: root_asset_id groups a chain
 * (COALESCE(root_asset_id, id) — legacy rows and v1 roots keep null),
 * parent_asset_id is the previous version, version_number is 1-based within
 * the chain, source_file_ref links edited-upload chains back to the upload
 * fileRef, and edit_summary describes what a version changed.
 *
 * No backfill needed: version_number DEFAULT 1 is metadata-only in PG11+, and
 * null root/parent means "standalone v1" by definition.
 *
 *   pnpm --filter @workspace/scripts run migrate-ora-asset-versions
 */
import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS root_asset_id INTEGER`);
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS parent_asset_id INTEGER`);
    await client.query(
      `ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1`,
    );
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS source_file_ref TEXT`);
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS edit_summary TEXT`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS ora_assets_root_asset_id_idx ON ora_assets(root_asset_id)`,
    );
    await client.query("COMMIT");
    console.log("migrate-ora-asset-versions: done");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

run().catch((err) => {
  console.error("migrate-ora-asset-versions: FAILED", err);
  process.exit(1);
});
