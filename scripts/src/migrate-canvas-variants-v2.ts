/**
 * Task #634 — Canvas Variants Leadership.
 * Adds columns + tables needed for:
 *   - variant_parent_id  (lineage tree / fork)
 *   - share_token        (signed preview links)
 *   - saved_to_library   (library flag)
 *   - canvas_variant_library  table (cross-project saved variants)
 *   - canvas_ab_tests    table (live A/B traffic split)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-canvas-variants-v2
 * Safe to re-run (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS).
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── canvas_variants additions ──────────────────────────────────────────────
    await client.query(`
      ALTER TABLE canvas_variants
        ADD COLUMN IF NOT EXISTS variant_parent_id integer REFERENCES canvas_variants(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS share_token text,
        ADD COLUMN IF NOT EXISTS saved_to_library boolean NOT NULL DEFAULT false
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS canvas_variants_share_token_idx
        ON canvas_variants(share_token) WHERE share_token IS NOT NULL
    `);

    // ── canvas_variant_library ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_variant_library (
        id serial PRIMARY KEY,
        user_id text NOT NULL,
        label text NOT NULL,
        description text,
        files jsonb NOT NULL,
        source_project_id integer REFERENCES projects(id) ON DELETE SET NULL,
        source_variant_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS canvas_variant_library_user_idx
        ON canvas_variant_library(user_id, created_at DESC)
    `);

    // ── canvas_ab_tests ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_ab_tests (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        variant_a_id integer NOT NULL,
        variant_b_id integer NOT NULL,
        traffic_split_pct integer NOT NULL DEFAULT 50,
        metric text NOT NULL DEFAULT 'clicks',
        status text NOT NULL DEFAULT 'running',
        winner_id integer,
        views_a integer NOT NULL DEFAULT 0,
        views_b integer NOT NULL DEFAULT 0,
        conversions_a integer NOT NULL DEFAULT 0,
        conversions_b integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        ended_at timestamptz
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS canvas_ab_tests_project_idx
        ON canvas_ab_tests(project_id, created_at DESC)
    `);

    await client.query("COMMIT");
    console.log("canvas-variants-v2 migration complete.");
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
