/**
 * Task #631 — Ecosystem migration.
 * Creates tables for:
 *   - gallery_templates     (public template gallery)
 *   - template_ratings      (user ratings for gallery templates)
 *   - extensions            (third-party extensions registry)
 *   - project_extensions    (per-project installed extensions)
 *   - community_profiles    (public user profiles)
 *   - profile_follows       (follower/following graph)
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ecosystem
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── gallery_templates ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS gallery_templates (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        title text NOT NULL,
        description text NOT NULL,
        readme text,
        category text NOT NULL DEFAULT 'web',
        tags jsonb NOT NULL DEFAULT '[]',
        author_id text,
        author_name text,
        files_snapshot jsonb,
        preview_url text,
        thumbnail_url text,
        platform text NOT NULL DEFAULT 'web',
        stack text NOT NULL DEFAULT 'react-vite',
        rating real NOT NULL DEFAULT 0,
        rating_count integer NOT NULL DEFAULT 0,
        fork_count integer NOT NULL DEFAULT 0,
        use_count integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'draft',
        featured boolean NOT NULL DEFAULT false,
        editors_pick boolean NOT NULL DEFAULT false,
        is_system boolean NOT NULL DEFAULT false,
        forked_from_id integer,
        source_project_id integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS gallery_templates_status_idx ON gallery_templates(status)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS gallery_templates_category_idx ON gallery_templates(category)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS gallery_templates_featured_idx ON gallery_templates(featured)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS gallery_templates_rating_idx ON gallery_templates(rating DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS gallery_templates_author_idx ON gallery_templates(author_id)`,
    );

    // ── template_ratings ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS template_ratings (
        id serial PRIMARY KEY,
        template_id integer NOT NULL,
        user_id text NOT NULL,
        rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
        comment text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS template_ratings_template_idx ON template_ratings(template_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS template_ratings_user_idx ON template_ratings(user_id)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS template_ratings_user_template_unique ON template_ratings(template_id, user_id)`,
    );

    // ── extensions ────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS extensions (
        id serial PRIMARY KEY,
        slug text NOT NULL UNIQUE,
        name text NOT NULL,
        description text NOT NULL,
        long_description text,
        version text NOT NULL DEFAULT '1.0.0',
        author_id text,
        author_name text,
        manifest_url text,
        manifest jsonb,
        scopes jsonb NOT NULL DEFAULT '[]',
        icon_url text,
        homepage_url text,
        repository_url text,
        category text NOT NULL DEFAULT 'productivity',
        tags jsonb NOT NULL DEFAULT '[]',
        install_count integer NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'draft',
        vetted boolean NOT NULL DEFAULT false,
        featured boolean NOT NULL DEFAULT false,
        is_system boolean NOT NULL DEFAULT false,
        vetting_notes text,
        vetted_at timestamptz,
        vetted_by text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS extensions_status_idx ON extensions(status)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS extensions_category_idx ON extensions(category)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS extensions_featured_idx ON extensions(featured)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS extensions_author_idx ON extensions(author_id)`);

    // ── project_extensions ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_extensions (
        id serial PRIMARY KEY,
        project_id integer NOT NULL,
        extension_id integer NOT NULL,
        extension_slug text NOT NULL,
        installed_by text,
        config jsonb,
        enabled boolean NOT NULL DEFAULT true,
        installed_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS project_extensions_project_idx ON project_extensions(project_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_extensions_extension_idx ON project_extensions(extension_id)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_extensions_unique ON project_extensions(project_id, extension_id)`,
    );

    // ── community_profiles ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS community_profiles (
        id serial PRIMARY KEY,
        user_id text NOT NULL UNIQUE,
        username text NOT NULL UNIQUE,
        display_name text,
        bio text,
        avatar_url text,
        website_url text,
        twitter_handle text,
        github_handle text,
        location text,
        public_project_ids jsonb NOT NULL DEFAULT '[]',
        showcased_project_ids jsonb NOT NULL DEFAULT '[]',
        follower_count integer NOT NULL DEFAULT 0,
        following_count integer NOT NULL DEFAULT 0,
        badge_embed_enabled boolean NOT NULL DEFAULT false,
        profile_public boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS community_profiles_username_idx ON community_profiles(username)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS community_profiles_user_id_idx ON community_profiles(user_id)`,
    );

    // ── profile_follows ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS profile_follows (
        id serial PRIMARY KEY,
        follower_id text NOT NULL,
        following_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await client.query(
      `CREATE INDEX IF NOT EXISTS profile_follows_follower_idx ON profile_follows(follower_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS profile_follows_following_idx ON profile_follows(following_id)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS profile_follows_unique ON profile_follows(follower_id, following_id)`,
    );

    await client.query("COMMIT");
    console.log("Ecosystem migration complete.");
    console.log("  ✓ gallery_templates");
    console.log("  ✓ template_ratings");
    console.log("  ✓ extensions");
    console.log("  ✓ project_extensions");
    console.log("  ✓ community_profiles");
    console.log("  ✓ profile_follows");
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
