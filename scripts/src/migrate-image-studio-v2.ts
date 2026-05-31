/**
 * Migration: Extend generated_images with full Phase 9A-1 metadata columns
 *
 * Adds to generated_images:
 *   negative_prompt TEXT NULL            — user-supplied negative prompt
 *   purpose         TEXT NULL            — general|marketing|avatar|illustration|background|product
 *   provider_name   TEXT NOT NULL DEFAULT 'openai'  — which image provider was used
 *   model_name      TEXT NULL            — specific model (e.g. dall-e-3)
 *   thumbnail_url   TEXT NULL            — URL/data URI of 512px thumbnail
 *
 * Run: pnpm --filter @workspace/scripts run migrate-image-studio-v2
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE generated_images
        ADD COLUMN IF NOT EXISTS negative_prompt TEXT,
        ADD COLUMN IF NOT EXISTS purpose         TEXT,
        ADD COLUMN IF NOT EXISTS provider_name   TEXT NOT NULL DEFAULT 'openai',
        ADD COLUMN IF NOT EXISTS model_name      TEXT,
        ADD COLUMN IF NOT EXISTS thumbnail_url   TEXT
    `);

    await client.query("COMMIT");
    console.log(
      "✓ generated_images extended with negative_prompt, purpose, provider_name, model_name, thumbnail_url",
    );
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
