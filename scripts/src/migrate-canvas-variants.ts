/**
 * One-time migration: add canvas_variants table for Task #541 (live mockup
 * sandbox on Canvas).
 * Run: pnpm --filter @workspace/scripts run migrate-canvas-variants
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_variants (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        exploration_id text NOT NULL,
        label text NOT NULL,
        prompt text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        files jsonb,
        assistant_summary text,
        error_message text,
        rank integer NOT NULL DEFAULT 1,
        source text NOT NULL DEFAULT 'explore',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        last_viewed_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS canvas_variants_project_idx ON canvas_variants(project_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS canvas_variants_exploration_idx ON canvas_variants(exploration_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS canvas_variants_last_viewed_idx ON canvas_variants(last_viewed_at)`,
    );

    await client.query("COMMIT");
    console.log("canvas_variants migration complete.");
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
