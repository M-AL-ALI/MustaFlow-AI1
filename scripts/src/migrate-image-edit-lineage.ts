/**
 * Migration: add parent_image_id, source_type, edit_instruction to generated_images.
 * Phase 9A-2 (Image Editing & Upload).
 */
import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE generated_images
        ADD COLUMN IF NOT EXISTS parent_image_id INTEGER REFERENCES generated_images(id),
        ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'generated',
        ADD COLUMN IF NOT EXISTS edit_instruction TEXT
    `);

    await client.query("COMMIT");
    console.log("migrate-image-edit-lineage: done");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

run().catch((err) => {
  console.error("migrate-image-edit-lineage: FAILED", err);
  process.exit(1);
});
