/**
 * Phase 2G — Orax Project Workspace schema migration.
 *
 * Changes:
 * - Renames old host-local orax_projects → orax_desktop_local_folders
 *   (only when the old schema has the local_path column)
 * - Creates new orax_projects (cloud workspace, userId + name)
 * - Creates orax_project_sources (execution sources per project)
 * - Adds execution_source_id + mode columns to orax_threads
 * - Adds execution_source_id to orax_audit_log + orax_usage_events
 * - Creates all required indexes
 *
 * Safe to re-run: all DDL uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-orax-projects
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Step 1: Rename old orax_projects → orax_desktop_local_folders ──────────
    // Only triggered when the old table has a local_path column (old schema).
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'orax_projects'
        ) AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orax_projects'
            AND column_name = 'local_path'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'orax_desktop_local_folders'
        ) THEN
          ALTER TABLE orax_projects RENAME TO orax_desktop_local_folders;
        END IF;
      END $$;
    `);

    // ── Step 2: Ensure orax_desktop_local_folders exists ───────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_desktop_local_folders (
        id                     TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        host_id                TEXT NOT NULL,
        user_id                TEXT NOT NULL,
        local_path             TEXT NOT NULL,
        display_name           TEXT NOT NULL,
        git_remote_url         TEXT,
        current_branch         TEXT,
        last_opened_at         TIMESTAMPTZ,
        permission_mode_override TEXT,
        setup_scripts          JSONB,
        status                 TEXT NOT NULL DEFAULT 'active',
        created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_local_folders_host_id_idx
        ON orax_desktop_local_folders(host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_desktop_local_folders_user_id_idx
        ON orax_desktop_local_folders(user_id)
    `);

    // ── Step 3: Create new orax_projects (cloud workspace) ─────────────────────
    // Only created after old table has been renamed away (or never existed).
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_projects (
        id                        TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                   TEXT NOT NULL,
        name                      TEXT NOT NULL,
        description               TEXT,
        icon                      TEXT,
        color                     TEXT,
        status                    TEXT NOT NULL DEFAULT 'active',
        default_execution_source_id TEXT,
        memory                    JSONB NOT NULL DEFAULT '{}',
        settings                  JSONB NOT NULL DEFAULT '{}',
        created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx
        ON orax_projects(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_projects_status_idx
        ON orax_projects(user_id, status)
    `);

    // ── Step 4: Create orax_project_sources ────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS orax_project_sources (
        id           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        host_id      TEXT,
        type         TEXT NOT NULL DEFAULT 'local_folder',
        display_name TEXT NOT NULL,
        local_path   TEXT,
        repo_url     TEXT,
        branch       TEXT,
        worktree_path TEXT,
        status       TEXT NOT NULL DEFAULT 'active',
        metadata     JSONB NOT NULL DEFAULT '{}',
        last_seen_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_project_sources_project_id_idx
        ON orax_project_sources(project_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_project_sources_user_id_idx
        ON orax_project_sources(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_project_sources_host_id_idx
        ON orax_project_sources(host_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS orax_project_sources_status_idx
        ON orax_project_sources(project_id, status)
    `);

    // ── Step 5: Add columns to orax_threads ────────────────────────────────────
    await client.query(`
      ALTER TABLE orax_threads
        ADD COLUMN IF NOT EXISTS execution_source_id TEXT
    `);
    await client.query(`
      ALTER TABLE orax_threads
        ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat_only'
    `);

    // ── Step 6: Add execution_source_id to audit + usage tables ───────────────
    await client.query(`
      ALTER TABLE orax_audit_log
        ADD COLUMN IF NOT EXISTS execution_source_id TEXT
    `);
    await client.query(`
      ALTER TABLE orax_usage_events
        ADD COLUMN IF NOT EXISTS execution_source_id TEXT
    `);

    await client.query("COMMIT");
    console.log("migrate-orax-projects: all steps completed successfully.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("migrate-orax-projects failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
