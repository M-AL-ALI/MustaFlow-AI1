/**
 * Task #1178 — Phase 9A-1: Image Generation + Image Studio Foundation.
 *
 * Creates the generated_images table for storing AI-generated images:
 *   - Tracks generation jobs (pending → generating → completed / failed)
 *   - Links optionally to a project
 *   - Stores file URL and storage key after upload
 *   - Enforces soft-delete via deleted_at
 *
 * Run: pnpm --filter @workspace/scripts run migrate-image-studio
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS generated_images (
        id                    SERIAL PRIMARY KEY,
        user_id               TEXT NOT NULL,
        project_id            INTEGER,
        prompt                TEXT NOT NULL,
        revised_prompt        TEXT,
        style                 TEXT,
        quality               TEXT NOT NULL DEFAULT 'standard',
        aspect_ratio          TEXT NOT NULL DEFAULT '1:1',
        transparent_background BOOLEAN NOT NULL DEFAULT false,
        status                TEXT NOT NULL DEFAULT 'pending',
        file_url              TEXT,
        storage_key           TEXT,
        safety_status         TEXT NOT NULL DEFAULT 'pending',
        credit_cost           INTEGER NOT NULL DEFAULT 3,
        error_message         TEXT,
        error_category        TEXT,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
        deleted_at            TIMESTAMPTZ
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images (user_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON generated_images (created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_generated_images_status ON generated_images (status) WHERE deleted_at IS NULL`,
    );

    await client.query("COMMIT");
    console.log("Image Studio migration complete.");
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
