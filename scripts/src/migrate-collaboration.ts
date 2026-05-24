/**
 * Migration: Collaboration & Teams (Theme E)
 *
 * Creates:
 *   - organizations
 *   - org_members
 *   - org_invites
 *   - project_comments
 *   - notifications
 *   - project_activity
 *   - share_links
 *
 * Adds:
 *   - projects.organization_id (nullable FK → organizations)
 *
 * Backfill:
 *   - Every distinct owner_id gets a personal org (type='personal').
 *   - Every project gets organization_id set to its owner's personal org.
 *   - Every owner is added as 'owner' member of their personal org.
 *
 * Safe to re-run — all DDL uses IF NOT EXISTS.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-collaboration
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── organizations ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        id serial PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        description text,
        type text NOT NULL DEFAULT 'team',
        avatar_url text,
        billing_email text,
        stripe_customer_id text,
        created_by_user_id text NOT NULL,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ── org_members ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_members (
        id serial PRIMARY KEY,
        organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        display_name text,
        email text,
        avatar_url text,
        joined_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (organization_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members(user_id)`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS org_members_org_idx ON org_members(organization_id)`,
    );

    // ── org_invites ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS org_invites (
        id serial PRIMARY KEY,
        organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        email text NOT NULL,
        role text NOT NULL DEFAULT 'member',
        invited_by_user_id text NOT NULL,
        status text NOT NULL DEFAULT 'pending',
        accepted_by_user_id text,
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(organization_id)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(email)`);

    // ── project_comments ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_comments (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        author_id text NOT NULL,
        author_name text,
        author_avatar text,
        parent_id integer,
        file_path text,
        line_start integer,
        line_end integer,
        build_result_id integer,
        body text NOT NULL,
        resolved boolean NOT NULL DEFAULT false,
        resolved_by_user_id text,
        resolved_at timestamptz,
        edited_at timestamptz,
        deleted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_comments_project_idx ON project_comments(project_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_comments_parent_idx ON project_comments(parent_id)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_comments_file_idx ON project_comments(project_id, file_path)`,
    );

    // ── notifications ─────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id serial PRIMARY KEY,
        recipient_id text NOT NULL,
        type text NOT NULL,
        title text NOT NULL,
        body text,
        actor_id text,
        actor_name text,
        resource_type text,
        resource_id text,
        project_id integer,
        metadata jsonb,
        read boolean NOT NULL DEFAULT false,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(recipient_id, read) WHERE read = false`,
    );

    // ── project_activity ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_activity (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_id text,
        actor_name text,
        actor_avatar text,
        event_type text NOT NULL,
        summary text NOT NULL,
        metadata jsonb,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_activity_actor_idx ON project_activity(actor_id)`,
    );

    // ── share_links ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS share_links (
        id serial PRIMARY KEY,
        project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        token text NOT NULL UNIQUE,
        label text,
        created_by_user_id text NOT NULL,
        scope text NOT NULL DEFAULT 'draft',
        snapshot_version_id integer,
        password_hash text,
        expires_at timestamptz,
        revoked boolean NOT NULL DEFAULT false,
        revoked_at timestamptz,
        view_count integer NOT NULL DEFAULT 0,
        last_viewed_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id)`,
    );
    await client.query(`CREATE INDEX IF NOT EXISTS share_links_token_idx ON share_links(token)`);

    // ── organization_id column on projects ────────────────────────────────────
    await client.query(`
      ALTER TABLE projects
        ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id)
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id)`);

    // ── Backfill: personal orgs + org membership ──────────────────────────────
    // 1. Find every distinct owner in projects who doesn't yet have a personal org.
    const { rows: owners } = await client.query<{ owner_id: string }>(`
      SELECT DISTINCT p.owner_id
      FROM projects p
      WHERE p.owner_id IS NOT NULL
        AND p.owner_id != ''
        AND NOT EXISTS (
          SELECT 1 FROM organizations o
          WHERE o.created_by_user_id = p.owner_id
            AND o.type = 'personal'
        )
    `);

    for (const { owner_id } of owners) {
      const safeName = `personal-${owner_id.slice(0, 20)}`;
      const slug = `personal-${owner_id
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .slice(0, 30)}`;

      const {
        rows: [org],
      } = await client.query<{ id: number }>(
        `
        INSERT INTO organizations (name, slug, type, created_by_user_id)
        VALUES ($1, $2, 'personal', $3)
        ON CONFLICT (slug) DO UPDATE SET updated_at = now()
        RETURNING id
      `,
        [safeName, slug, owner_id],
      );

      if (!org) continue;

      await client.query(
        `
        INSERT INTO org_members (organization_id, user_id, role)
        VALUES ($1, $2, 'owner')
        ON CONFLICT (organization_id, user_id) DO NOTHING
      `,
        [org.id, owner_id],
      );

      await client.query(
        `
        UPDATE projects
        SET organization_id = $1
        WHERE owner_id = $2 AND organization_id IS NULL
      `,
        [org.id, owner_id],
      );
    }

    await client.query("COMMIT");
    console.log("Collaboration migration complete.");
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
