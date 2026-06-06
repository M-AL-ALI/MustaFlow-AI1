/**
 * Migration: add `storage_key` to ora_assets and make `data` nullable.
 *
 * Enables R2 object-storage offload for Ora library assets (additive): when R2
 * offload is enabled, bytes live in R2 under `storage_key` and `data` is null;
 * otherwise bytes stay base64 in `data` exactly as before.
 *
 *   pnpm --filter @workspace/scripts run migrate-ora-asset-storage
 */
import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS storage_key TEXT`);
    await client.query(`ALTER TABLE ora_assets ALTER COLUMN data DROP NOT NULL`);
    // Enforce the storage invariant: exactly one of `data` / `storage_key`
    // carries the payload. Existing rows (data set, storage_key null) satisfy it.
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ora_assets_storage_xor'
        ) THEN
          ALTER TABLE ora_assets
            ADD CONSTRAINT ora_assets_storage_xor
            CHECK ((data IS NOT NULL) <> (storage_key IS NOT NULL));
        END IF;
      END $$;
    `);
    await client.query("COMMIT");
    console.log("migrate-ora-asset-storage: done");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

run().catch((err) => {
  console.error("migrate-ora-asset-storage: FAILED", err);
  process.exit(1);
});
