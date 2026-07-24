import { pool } from "@workspace/db";

async function migrateBrandKits() {
  console.log("[migrate-brand-kits] Creating brand_kits table …");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_kits (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL,
      ora_project_id  INTEGER,
      logo_asset_id   INTEGER,
      primary_color   TEXT,
      secondary_color TEXT,
      accent_color    TEXT,
      heading_font    TEXT,
      body_font       TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_personal_idx
      ON brand_kits(user_id)
      WHERE ora_project_id IS NULL
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_project_idx
      ON brand_kits(user_id, ora_project_id)
      WHERE ora_project_id IS NOT NULL
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS brand_kits_user_id_idx
      ON brand_kits(user_id)
  `);

  console.log("[migrate-brand-kits] Done.");
}

migrateBrandKits().catch((err) => {
  console.error("[migrate-brand-kits] FAILED:", err);
  process.exit(1);
});
