/**
 * Startup migration runner — Task #859
 *
 * Runs all outstanding schema migrations inline at server startup using the
 * shared DB pool. No subprocess spawning, no `pool.end()`.
 *
 * Every SQL statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so the
 * entire runner is idempotent and safe to execute on every boot.
 *
 * Migrations run in the same dependency order as migrate-all-outstanding.ts.
 * Each step is isolated in its own try/catch so a single failure never
 * prevents subsequent migrations from running.
 */

import { pool } from "@workspace/db";
import { logger } from "./logger";

type MigrationStep = {
  name: string;
  run: (client: import("pg").PoolClient) => Promise<void>;
};

const MIGRATION_STEPS: MigrationStep[] = [
  // ── migrate-containers ──────────────────────────────────────────────────────
  {
    name: "migrate-containers",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_id text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_status text NOT NULL DEFAULT 'stopped'`,
      );
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_url text`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS container_logs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          level      text NOT NULL DEFAULT 'stdout',
          message    text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-production-container ────────────────────────────────────────────
  {
    name: "migrate-production-container",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_id text`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_url text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-prod-containers ─────────────────────────────────────────────────
  {
    name: "migrate-prod-containers",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS prod_container_id text, ADD COLUMN IF NOT EXISTS prod_container_status text NOT NULL DEFAULT 'stopped', ADD COLUMN IF NOT EXISTS prod_container_url text`,
      );
    },
  },

  // ── migrate-db-snapshots ────────────────────────────────────────────────────
  {
    name: "migrate-db-snapshots",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS db_snapshots (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_id  INTEGER REFERENCES project_versions(id) ON DELETE SET NULL,
          label       TEXT NOT NULL,
          provider    TEXT NOT NULL,
          dump_content TEXT,
          object_key  TEXT,
          is_partial  BOOLEAN NOT NULL DEFAULT FALSE,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_db_snapshots_project_id ON db_snapshots(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_db_snapshots_version_id ON db_snapshots(version_id)`,
      );
      await client.query(`ALTER TABLE db_snapshots ALTER COLUMN dump_content DROP NOT NULL`);
      await client.query(`ALTER TABLE db_snapshots ADD COLUMN IF NOT EXISTS object_key TEXT`);
      await client.query(
        `ALTER TABLE db_snapshots ADD COLUMN IF NOT EXISTS is_partial BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    },
  },

  // ── migrate-check-runs ──────────────────────────────────────────────────────
  {
    name: "migrate-check-runs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS check_runs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id    integer REFERENCES agent_tasks(id) ON DELETE CASCADE,
          check_name text NOT NULL,
          status     text NOT NULL,
          findings   jsonb NOT NULL DEFAULT '[]',
          ai_reason  text,
          ran_at     timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS check_runs_project_id_task_id_idx ON check_runs(project_id, task_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS check_runs_task_id_idx ON check_runs(task_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-e2e-enabled ─────────────────────────────────────────────────────
  {
    name: "migrate-e2e-enabled",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS e2e_enabled boolean NOT NULL DEFAULT true`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-multiplayer-uploads ─────────────────────────────────────────────
  {
    name: "migrate-multiplayer-uploads",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS multiplayer_enabled boolean NOT NULL DEFAULT false`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_uploads (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          uploader_id text,
          filename    text NOT NULL,
          mime_type   text NOT NULL DEFAULT 'application/octet-stream',
          size_bytes  bigint NOT NULL DEFAULT 0,
          object_path text NOT NULL,
          text_preview text,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_uploads_project_id_idx ON project_uploads(project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-security-gate ───────────────────────────────────────────────────
  {
    name: "migrate-security-gate",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS block_publish_on_critical boolean NOT NULL DEFAULT true`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS dismissed_finding_hashes jsonb NOT NULL DEFAULT '[]'::jsonb`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-security-findings ───────────────────────────────────────────────
  {
    name: "migrate-security-findings",
    async run(client) {
      const { rows } = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'check_runs'
        ) AS exists
      `);
      const checkRunsExists = rows[0]?.exists ?? false;
      const checkRunCol = checkRunsExists
        ? `check_run_id INTEGER REFERENCES check_runs(id) ON DELETE SET NULL,`
        : `check_run_id INTEGER,`;

      await client.query(`
        CREATE TABLE IF NOT EXISTS security_findings (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          ${checkRunCol}
          check_type    TEXT NOT NULL,
          severity      TEXT NOT NULL,
          fingerprint   TEXT NOT NULL,
          message       TEXT NOT NULL,
          file          TEXT,
          line          INTEGER,
          status        TEXT NOT NULL DEFAULT 'open',
          dismissed_by  TEXT,
          dismissed_at  TIMESTAMPTZ,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS security_findings_project_fingerprint_idx ON security_findings(project_id, fingerprint)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS security_findings_project_id_idx ON security_findings(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS security_findings_status_idx ON security_findings(status)`,
      );

      if (checkRunsExists) {
        const { rows: fkRows } = await client.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = 'security_findings'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND kcu.column_name = 'check_run_id'
          ) AS exists
        `);
        if (!fkRows[0]?.exists) {
          await client.query(`
            ALTER TABLE security_findings
              ADD CONSTRAINT security_findings_check_run_id_fkey
              FOREIGN KEY (check_run_id) REFERENCES check_runs(id) ON DELETE SET NULL
          `);
        }
      }
    },
  },

  // ── migrate-app-test-runs ───────────────────────────────────────────────────
  {
    name: "migrate-app-test-runs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_test_runs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id    integer REFERENCES agent_tasks(id) ON DELETE SET NULL,
          ran_at     timestamptz NOT NULL DEFAULT now(),
          test_script text,
          results    jsonb NOT NULL DEFAULT '[]',
          passed     integer NOT NULL DEFAULT 0,
          failed     integer NOT NULL DEFAULT 0
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS app_test_runs_project_id_ran_at_idx ON app_test_runs(project_id, ran_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS app_test_runs_task_id_idx ON app_test_runs(task_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-cve-patch-columns ───────────────────────────────────────────────
  {
    name: "migrate-cve-patch-columns",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS cve_findings (
          id                     serial PRIMARY KEY,
          project_id             integer REFERENCES projects(id) ON DELETE CASCADE,
          severity               text NOT NULL,
          package_name           text NOT NULL,
          current_version        text,
          patched_version        text,
          cve_id                 text,
          title                  text,
          advisory_url           text,
          detected_at            timestamptz NOT NULL DEFAULT now(),
          status                 text NOT NULL DEFAULT 'open',
          dismissed_at           timestamptz,
          dismissed_by           text,
          patch_status           text,
          patch_content          text,
          patch_typecheck_passed boolean,
          patch_prepared_at      timestamptz,
          patch_applied_at       timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_status_idx ON cve_findings(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_severity_idx ON cve_findings(severity)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_project_id_idx ON cve_findings(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_patch_status_idx ON cve_findings(patch_status)`,
      );
      await client.query(`
        ALTER TABLE cve_findings
          ADD COLUMN IF NOT EXISTS patch_status text,
          ADD COLUMN IF NOT EXISTS patch_content text,
          ADD COLUMN IF NOT EXISTS patch_typecheck_passed boolean,
          ADD COLUMN IF NOT EXISTS patch_prepared_at timestamptz,
          ADD COLUMN IF NOT EXISTS patch_applied_at timestamptz
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-embeddings ────────────────────────────────────────────
  {
    name: "migrate-knowledge-embeddings",
    async run(client) {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch {
        // vector extension may not be available in all environments
      }
      const { rows } = await client.query<{ data_type: string }>(`
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'knowledge_entries' AND column_name = 'embedding'
      `);
      if (rows[0] && rows[0].data_type !== "USER-DEFINED") {
        await client.query(`ALTER TABLE knowledge_entries DROP COLUMN embedding`);
      }
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-vault-v2 ──────────────────────────────────────────────
  {
    name: "migrate-knowledge-vault-v2",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE knowledge_entries
          ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'project',
          ADD COLUMN IF NOT EXISTS thumbs_up INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS thumbs_down INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE
      `);
      await client.query(
        `UPDATE knowledge_entries SET scope = 'global' WHERE approved_for_reuse = TRUE AND scope = 'project'`,
      );
      await client.query(
        `UPDATE knowledge_entries SET scope = 'user' WHERE project_id IS NULL AND user_id IS NOT NULL AND approved_for_reuse = FALSE AND scope = 'project'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-version-validation-status ──────────────────────────────────────
  {
    name: "migrate-version-validation-status",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS validation_status text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-architect-review ────────────────────────────────────────────────
  {
    name: "migrate-architect-review",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS architect_review_enabled boolean NOT NULL DEFAULT true`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-prod-logs ───────────────────────────────────────────────────────
  {
    name: "migrate-prod-logs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_logs (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_id INTEGER,
          kind        TEXT NOT NULL,
          method      TEXT,
          path        TEXT,
          status      INTEGER,
          latency_ms  INTEGER,
          request_id  TEXT,
          ip_hash     TEXT,
          user_agent  TEXT,
          error_class TEXT,
          message     TEXT,
          stack       TEXT,
          signature   TEXT,
          ts          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_logs_project_ts_idx ON prod_logs(project_id, ts)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_logs_signature_idx ON prod_logs(signature)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS prod_logs_kind_idx ON prod_logs(kind)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_error_groups (
          id             SERIAL PRIMARY KEY,
          project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          signature      TEXT NOT NULL,
          sample_message TEXT NOT NULL,
          sample_stack   TEXT,
          kind           TEXT NOT NULL DEFAULT 'browser',
          count          INTEGER NOT NULL DEFAULT 1,
          first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS prod_error_groups_project_signature_idx ON prod_error_groups(project_id, signature)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_error_groups_last_seen_idx ON prod_error_groups(last_seen)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_health_checks (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_id     INTEGER,
          public_slug     TEXT,
          status          TEXT NOT NULL,
          root_status     INTEGER,
          root_latency_ms INTEGER,
          routes_checked  INTEGER NOT NULL DEFAULT 0,
          routes_failed   INTEGER NOT NULL DEFAULT 0,
          failure_summary TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_health_checks_project_idx ON prod_health_checks(project_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-policy-audit ────────────────────────────────────────────────────
  {
    name: "migrate-policy-audit",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS policy_strictness text NOT NULL DEFAULT 'standard'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS tool_audit (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id          integer,
          tool_name        text NOT NULL,
          stack            text,
          argv             jsonb NOT NULL,
          exit_code        integer,
          stdout_tail      text,
          stderr_tail      text,
          duration_ms      integer NOT NULL DEFAULT 0,
          blocked          boolean NOT NULL DEFAULT false,
          block_reason     text,
          policy_strictness text NOT NULL DEFAULT 'standard',
          created_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS tool_audit_project_idx ON tool_audit(project_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS tool_audit_blocked_idx ON tool_audit(blocked, created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-background-jobs ─────────────────────────────────────────────────
  {
    name: "migrate-background-jobs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE agent_tasks
          ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'foreground',
          ADD COLUMN IF NOT EXISTS wall_clock_cap_ms integer,
          ADD COLUMN IF NOT EXISTS credits_reserved integer,
          ADD COLUMN IF NOT EXISTS paused_at timestamptz,
          ADD COLUMN IF NOT EXISTS applied_at timestamptz,
          ADD COLUMN IF NOT EXISTS discarded_at timestamptz
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_run_mode_status_idx ON agent_tasks(run_mode, status)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-builder-skills ──────────────────────────────────────────────────
  {
    name: "migrate-builder-skills",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS builder_skills (
          name        text PRIMARY KEY,
          enabled     boolean NOT NULL DEFAULT true,
          load_count  integer NOT NULL DEFAULT 0,
          last_loaded_at timestamptz,
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-builder-skills-drafts ──────────────────────────────────────────
  {
    name: "migrate-builder-skills-drafts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE builder_skills
          ADD COLUMN IF NOT EXISTS draft boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS authored_by text,
          ADD COLUMN IF NOT EXISTS authored_at timestamptz,
          ADD COLUMN IF NOT EXISTS authoring_context text
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-project-embeddings ──────────────────────────────────────────────
  {
    name: "migrate-project-embeddings",
    async run(client) {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch {
        // vector extension may not be available in all environments
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_embeddings (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL,
          file_path    text NOT NULL,
          content_hash text NOT NULL,
          model        text NOT NULL DEFAULT 'text-embedding-3-small',
          embedding    vector(1536),
          snippet      text NOT NULL DEFAULT '',
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_embeddings_project_file_unique ON project_embeddings(project_id, file_path)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-project-domains ─────────────────────────────────────────────────
  {
    name: "migrate-project-domains",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_domains (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hostname            TEXT NOT NULL,
          is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
          record_type         TEXT NOT NULL DEFAULT 'cname',
          verification_token  TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending',
          ssl_status          TEXT NOT NULL DEFAULT 'pending',
          verified_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_domains_hostname_unique ON project_domains(hostname)`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS redirect_www_apex BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      // data migration: backfill existing custom domains into project_domains
      const { rows } = await client.query<{
        id: number;
        custom_domain: string;
        domain_status: string | null;
        ssl_status: string | null;
        verification_token: string | null;
        domain_verified_at: string | null;
      }>(
        `SELECT id, custom_domain, domain_status, ssl_status, verification_token, domain_verified_at
         FROM projects WHERE custom_domain IS NOT NULL AND deleted_at IS NULL`,
      );
      for (const project of rows) {
        const isDns = (project.custom_domain ?? "").includes(".");
        await client.query(
          `INSERT INTO project_domains
             (project_id, hostname, is_primary, record_type, verification_token,
              verification_status, ssl_status, verified_at, created_at, updated_at)
           VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (hostname) DO NOTHING`,
          [
            project.id,
            project.custom_domain,
            isDns ? "cname" : "a",
            project.verification_token ?? crypto.randomUUID(),
            project.domain_status ?? "pending",
            project.ssl_status ?? "pending",
            project.domain_verified_at ?? null,
          ],
        );
      }
    },
  },

  // ── migrate-checkpoint-id ───────────────────────────────────────────────────
  {
    name: "migrate-checkpoint-id",
    async run(client) {
      await client.query(
        `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS checkpoint_id integer`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_checkpoint_id_idx ON chat_messages(checkpoint_id) WHERE checkpoint_id IS NOT NULL`,
      );
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_checkpoint_id_fkey'
          ) THEN
            ALTER TABLE chat_messages
              ADD CONSTRAINT chat_messages_checkpoint_id_fkey
              FOREIGN KEY (checkpoint_id) REFERENCES project_versions(id) ON DELETE SET NULL;
          END IF;
        END $$
      `);
    },
  },

  // ── migrate-staging-domains ─────────────────────────────────────────────────
  // Persist the chat surface that created each task so delayed reports can be
  // written back to the correct thread (for example Zero background tasks).
  {
    name: "migrate-agent-task-origin",
    async run(client) {
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS origin text`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_origin_idx ON agent_tasks(origin) WHERE origin IS NOT NULL`,
      );
    },
  },

  {
    name: "migrate-staging-domains",
    async run(client) {
      await client.query(`ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS environment TEXT`);
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS staging_published_snapshot_id INTEGER`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_snapshots (
          id           SERIAL PRIMARY KEY,
          project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_id   INTEGER NOT NULL,
          task_id      INTEGER,
          preview_slug TEXT NOT NULL,
          expires_at   TIMESTAMPTZ NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS preview_snapshots_slug_unique ON preview_snapshots(preview_slug)`,
      );
    },
  },

  // ── migrate-cf-hostname-columns ─────────────────────────────────────────────
  {
    name: "migrate-cf-hostname-columns",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_domains (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hostname            TEXT NOT NULL,
          is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
          record_type         TEXT NOT NULL DEFAULT 'cname',
          verification_token  TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending',
          ssl_status          TEXT NOT NULL DEFAULT 'pending',
          verified_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_domains_hostname_unique ON project_domains(hostname)`,
      );
      await client.query(`
        ALTER TABLE project_domains
          ADD COLUMN IF NOT EXISTS cf_hostname_id TEXT,
          ADD COLUMN IF NOT EXISTS ssl_last_checked_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ssl_expires_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-canvas-variants ─────────────────────────────────────────────────
  {
    name: "migrate-canvas-variants",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_variants (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          exploration_id   text NOT NULL,
          label            text NOT NULL,
          prompt           text NOT NULL,
          status           text NOT NULL DEFAULT 'pending',
          files            jsonb,
          assistant_summary text,
          error_message    text,
          rank             integer NOT NULL DEFAULT 1,
          source           text NOT NULL DEFAULT 'explore',
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          last_viewed_at   timestamptz NOT NULL DEFAULT now()
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
    },
  },

  // ── migrate-lesson-contribution-reward ──────────────────────────────────────
  {
    name: "migrate-lesson-contribution-reward",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS contributor_rewarded_at timestamptz`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-canvas-variants-v2 ──────────────────────────────────────────────
  {
    name: "migrate-canvas-variants-v2",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE canvas_variants
          ADD COLUMN IF NOT EXISTS variant_parent_id integer REFERENCES canvas_variants(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS share_token text,
          ADD COLUMN IF NOT EXISTS saved_to_library boolean NOT NULL DEFAULT false
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS canvas_variants_share_token_idx ON canvas_variants(share_token) WHERE share_token IS NOT NULL`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_variant_library (
          id               serial PRIMARY KEY,
          user_id          text NOT NULL,
          label            text NOT NULL,
          description      text,
          files            jsonb NOT NULL,
          source_project_id integer REFERENCES projects(id) ON DELETE SET NULL,
          source_variant_id integer,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_variant_library_user_idx ON canvas_variant_library(user_id, created_at DESC)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_ab_tests (
          id             serial PRIMARY KEY,
          project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          variant_a_id   integer NOT NULL,
          variant_b_id   integer NOT NULL,
          traffic_split_pct integer NOT NULL DEFAULT 50,
          metric         text NOT NULL DEFAULT 'clicks',
          status         text NOT NULL DEFAULT 'running',
          winner_id      integer,
          views_a        integer NOT NULL DEFAULT 0,
          views_b        integer NOT NULL DEFAULT 0,
          conversions_a  integer NOT NULL DEFAULT 0,
          conversions_b  integer NOT NULL DEFAULT 0,
          created_at     timestamptz NOT NULL DEFAULT now(),
          ended_at       timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_ab_tests_project_idx ON canvas_ab_tests(project_id, created_at DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-blueprints ──────────────────────────────────────────────────────
  {
    name: "migrate-blueprints",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_blueprints (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          blueprint_id text NOT NULL,
          version      text NOT NULL DEFAULT '1.0.0',
          installed_by text,
          result       jsonb,
          installed_at timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_blueprints_pk_idx ON project_blueprints(project_id, blueprint_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id           serial PRIMARY KEY,
          name         text NOT NULL,
          description  text,
          endpoint     text NOT NULL,
          auth_header  text,
          enabled      boolean NOT NULL DEFAULT true,
          cached_tools jsonb,
          cached_at    timestamptz,
          created_by   text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS mcp_servers_enabled_idx ON mcp_servers(enabled)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-deployment-substrate ────────────────────────────────────────────
  {
    name: "migrate-deployment-substrate",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS deployment_type text NOT NULL DEFAULT 'static',
          ADD COLUMN IF NOT EXISTS region text,
          ADD COLUMN IF NOT EXISTS cdn_enabled boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS cdn_last_pushed_at timestamptz,
          ADD COLUMN IF NOT EXISTS health_check_path text NOT NULL DEFAULT '/',
          ADD COLUMN IF NOT EXISTS uptime_alert_email text
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS deployment_schedules (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind             text NOT NULL DEFAULT 'task_run',
          cron_expr        text NOT NULL,
          enabled          boolean NOT NULL DEFAULT true,
          note             text,
          last_run_at      timestamptz,
          last_run_status  text,
          last_run_message text,
          next_run_at      timestamptz,
          created_by       text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS deployment_schedules_project_idx ON deployment_schedules(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS deployment_schedules_next_run_idx ON deployment_schedules(next_run_at)`,
      );
    },
  },

  // ── migrate-project-artifacts ───────────────────────────────────────────────
  {
    name: "migrate-project-artifacts",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_artifacts (
          id              serial PRIMARY KEY,
          project_id      integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind            text NOT NULL DEFAULT 'web',
          platform        text NOT NULL DEFAULT 'web',
          project_format  text NOT NULL DEFAULT 'static-html',
          stack           text NOT NULL DEFAULT 'react-vite',
          name            text NOT NULL,
          slug            text NOT NULL,
          is_primary      boolean NOT NULL DEFAULT false,
          status          text NOT NULL DEFAULT 'draft',
          last_task_summary text,
          deleted_at      timestamptz,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_artifacts_project_slug_unique ON project_artifacts(project_id, slug)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_artifacts_project_idx ON project_artifacts(project_id)`,
      );
      await client.query(`ALTER TABLE project_files ADD COLUMN IF NOT EXISTS artifact_id integer`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_files_artifact_idx ON project_files(artifact_id)`,
      );

      // data migration: create a primary artifact for each existing project
      const { rows: projects } = await client.query<{
        id: number;
        name: string;
        kind: string | null;
        platform: string | null;
        project_format: string | null;
        stack: string | null;
        status: string | null;
        last_task_summary: string | null;
      }>(
        `SELECT id, name, kind, platform, project_format, stack, status, last_task_summary
         FROM projects WHERE deleted_at IS NULL`,
      );
      for (const proj of projects) {
        const { rows: existing } = await client.query(
          `SELECT 1 FROM project_artifacts WHERE project_id = $1 AND is_primary = true LIMIT 1`,
          [proj.id],
        );
        if (!existing.length) {
          const { rows: arts } = await client.query(
            `INSERT INTO project_artifacts
               (project_id, kind, platform, project_format, stack, name, slug, is_primary, status, last_task_summary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
             RETURNING id`,
            [
              proj.id,
              proj.kind ?? "web",
              proj.platform ?? "web",
              proj.project_format ?? "static-html",
              proj.stack ?? "react-vite",
              proj.name,
              "main",
              proj.status ?? "draft",
              proj.last_task_summary,
            ],
          );
          if (arts[0]) {
            await client.query(
              `UPDATE project_files SET artifact_id = $1 WHERE project_id = $2 AND artifact_id IS NULL`,
              [arts[0].id, proj.id],
            );
          }
        }
      }

      await client.query(`DROP INDEX IF EXISTS project_files_project_path_unique`);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_files_project_artifact_path_unique ON project_files(project_id, artifact_id, path)`,
      );
    },
  },

  // ── migrate-security-scanners ───────────────────────────────────────────────
  {
    name: "migrate-security-scanners",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS scanner_hounddog_enabled BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS scanner_trivy_enabled    BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS scanner_semgrep_enabled  BOOLEAN NOT NULL DEFAULT true
      `);
    },
  },

  // ── migrate-agent-inbox ─────────────────────────────────────────────────────
  {
    name: "migrate-agent-inbox",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_inbox (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id     text,
          category    text NOT NULL DEFAULT 'bug',
          severity    text NOT NULL DEFAULT 'medium',
          description text NOT NULL,
          screenshot_url text,
          status      text NOT NULL DEFAULT 'unread',
          created_at  timestamptz NOT NULL DEFAULT now(),
          read_at     timestamptz,
          resolved_at timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_inbox_project_status_idx ON agent_inbox(project_id, status, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_inbox_status_created_idx ON agent_inbox(status, created_at DESC)`,
      );
      await client.query(
        `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_content_tsv_idx ON chat_messages USING GIN (content_tsv)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-preferred-region ────────────────────────────────────────────────
  {
    name: "migrate-preferred-region",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preferred_region TEXT`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-receipt-url ─────────────────────────────────────────────────────
  {
    name: "migrate-receipt-url",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS receipt_url TEXT`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-domain-cert-fields ──────────────────────────────────────────────
  {
    name: "migrate-domain-cert-fields",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS ssl_source TEXT NOT NULL DEFAULT 'cloudflare'`,
      );
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS byo_cert_expires_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS byo_cert_subject TEXT`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-webhooks-pat ────────────────────────────────────────────────────
  {
    name: "migrate-webhooks-pat",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_webhooks (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          url         TEXT NOT NULL,
          secret      TEXT NOT NULL,
          events      JSONB NOT NULL DEFAULT '[]',
          active      BOOLEAN NOT NULL DEFAULT true,
          description TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_project_webhooks_project ON project_webhooks(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id           SERIAL PRIMARY KEY,
          webhook_id   INTEGER NOT NULL REFERENCES project_webhooks(id) ON DELETE CASCADE,
          project_id   INTEGER NOT NULL,
          event        TEXT NOT NULL,
          payload      JSONB NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          status_code  INTEGER,
          response_body TEXT,
          attempt      INTEGER NOT NULL DEFAULT 1,
          duration_ms  INTEGER,
          error        TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project ON webhook_deliveries(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          name          TEXT NOT NULL,
          token_hash    TEXT NOT NULL UNIQUE,
          token_preview TEXT NOT NULL,
          project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          scopes        JSONB NOT NULL DEFAULT '["domains:read","domains:write"]',
          active        BOOLEAN NOT NULL DEFAULT true,
          last_used_at  TIMESTAMPTZ,
          expires_at    TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS domain_serve_events (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          domain_id   INTEGER,
          snapshot_id INTEGER,
          hostname    TEXT,
          ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_domain ON domain_serve_events(domain_id, ts DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_project ON domain_serve_events(project_id, ts DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-domain-security ─────────────────────────────────────────────────
  {
    name: "migrate-domain-security",
    async run(client) {
      await client.query(`
        ALTER TABLE project_domains
          ADD COLUMN IF NOT EXISTS security_config JSONB,
          ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS suspension_reason TEXT
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS abuse_reports (
          id           SERIAL PRIMARY KEY,
          domain_id    INTEGER REFERENCES project_domains(id) ON DELETE SET NULL,
          hostname     TEXT NOT NULL,
          category     TEXT NOT NULL DEFAULT 'other',
          reason       TEXT NOT NULL,
          details      TEXT,
          reporter_email TEXT,
          reporter_ip  TEXT,
          status       TEXT NOT NULL DEFAULT 'open',
          resolved_by  TEXT,
          resolved_at  TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_hostname_idx ON abuse_reports(hostname)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_domain_id_idx ON abuse_reports(domain_id)`,
      );
    },
  },

  // ── migrate-dns-records ─────────────────────────────────────────────────────
  {
    name: "migrate-dns-records",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS dns_records (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          domain_id   integer NOT NULL REFERENCES project_domains(id) ON DELETE CASCADE,
          hostname    text NOT NULL,
          name        text NOT NULL,
          type        text NOT NULL,
          content     text,
          priority    integer,
          ttl         integer NOT NULL DEFAULT 1,
          proxied     boolean NOT NULL DEFAULT false,
          data        text,
          source      text NOT NULL DEFAULT 'local',
          cf_record_id text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS dns_records_domain_idx ON dns_records(domain_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-pg-boss (schema auto-created by pg-boss on first start) ─────────
  // Skipped — pg-boss manages its own pgboss.* schema automatically.

  // ── migrate-workspace-domains ───────────────────────────────────────────────
  {
    name: "migrate-workspace-domains",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domains (
          id                   SERIAL PRIMARY KEY,
          workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          hostname             TEXT NOT NULL,
          record_type          TEXT NOT NULL DEFAULT 'cname',
          verification_token   TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'pending_verification',
          verified_at          TIMESTAMPTZ,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_hostname_unique ON workspace_domains(hostname)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domain_roles (
          id                   SERIAL PRIMARY KEY,
          workspace_domain_id  INTEGER NOT NULL REFERENCES workspace_domains(id) ON DELETE CASCADE,
          user_id              TEXT NOT NULL,
          role                 TEXT NOT NULL DEFAULT 'viewer',
          granted_by           TEXT NOT NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_domain_roles_domain_user_unique ON workspace_domain_roles(workspace_domain_id, user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_usage_daily (
          id                         SERIAL PRIMARY KEY,
          workspace_id               INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          date                       DATE NOT NULL,
          hostname                   TEXT NOT NULL DEFAULT '',
          request_count              BIGINT NOT NULL DEFAULT 0,
          bandwidth_bytes            BIGINT NOT NULL DEFAULT 0,
          stripe_meter_reported_at   TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_usage_daily_workspace_date_host_unique ON workspace_usage_daily(workspace_id, date, hostname)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domain_audit (
          id                   SERIAL PRIMARY KEY,
          workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          workspace_domain_id  INTEGER,
          user_id              TEXT NOT NULL,
          action               TEXT NOT NULL,
          hostname             TEXT,
          payload              TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS workspace_domain_id INTEGER REFERENCES workspace_domains(id) ON DELETE SET NULL`,
      );
      await client.query(
        `ALTER TABLE domain_serve_events ADD COLUMN IF NOT EXISTS bytes_served BIGINT`,
      );
    },
  },

  // ── migrate-purchased-domains ───────────────────────────────────────────────
  {
    name: "migrate-purchased-domains",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS purchased_domains (
          id                               serial PRIMARY KEY,
          user_id                          text NOT NULL,
          hostname                         text NOT NULL UNIQUE,
          registrar                        text NOT NULL DEFAULT 'namecheap',
          registered_at                    timestamptz,
          expires_at                       timestamptz,
          auto_renew                       boolean NOT NULL DEFAULT true,
          whois_privacy                    boolean NOT NULL DEFAULT true,
          status                           text NOT NULL DEFAULT 'pending',
          namecheap_order_id               text,
          stripe_payment_intent_id         text,
          project_id                       integer,
          renewal_stripe_payment_intent_id text,
          last_renewal_at                  timestamptz,
          renewal_failed_at                timestamptz,
          renewal_failure_reason           text,
          transfer_auth_code               text,
          whois_first_name                 text,
          whois_last_name                  text,
          whois_email                      text,
          whois_phone                      text,
          whois_address                    text,
          whois_city                       text,
          whois_state_province             text,
          whois_postal_code                text,
          whois_country                    text,
          stripe_customer_id               text,
          price_paid_usd                   text,
          renewal_price_usd                text,
          created_at                       timestamptz NOT NULL DEFAULT now(),
          updated_at                       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `ALTER TABLE purchased_domains ADD COLUMN IF NOT EXISTS stripe_customer_id text`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_user_idx ON purchased_domains(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_project_idx ON purchased_domains(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_expires_idx ON purchased_domains(expires_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-workspace-subscriptions ────────────────────────────────────────
  {
    name: "migrate-workspace-subscriptions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_subscriptions (
          workspace_id           integer PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          stripe_customer_id     text,
          stripe_subscription_id text UNIQUE,
          stripe_price_id        text,
          plan_tier              text NOT NULL DEFAULT 'free',
          status                 text NOT NULL DEFAULT 'inactive',
          current_period_end     timestamptz,
          cancel_at_period_end   text,
          created_at             timestamptz NOT NULL DEFAULT now(),
          updated_at             timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS workspace_subscriptions_customer_idx ON workspace_subscriptions(stripe_customer_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS workspace_subscriptions_status_idx ON workspace_subscriptions(status)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-plan-templates ──────────────────────────────────────────────────
  {
    name: "migrate-plan-templates",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS plan_templates (
          id          serial PRIMARY KEY,
          slug        text NOT NULL UNIQUE,
          category    text NOT NULL,
          name        text NOT NULL,
          description text NOT NULL,
          platform    text NOT NULL DEFAULT 'web',
          plan        jsonb NOT NULL,
          is_system   boolean NOT NULL DEFAULT true,
          sort_order  integer NOT NULL DEFAULT 0,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS plan_templates_category_idx ON plan_templates(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS plan_templates_sort_order_idx ON plan_templates(sort_order)`,
      );
      await client.query("COMMIT");
      // Note: system template seeding is handled by the seed script
    },
  },

  // ── migrate-cdn-perfection ──────────────────────────────────────────────────
  {
    name: "migrate-cdn-perfection",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS error_page_404 text, ADD COLUMN IF NOT EXISTS error_page_500 text`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_bandwidth (
          id            serial PRIMARY KEY,
          project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          month         text NOT NULL,
          bytes_served  bigint NOT NULL DEFAULT 0,
          request_count integer NOT NULL DEFAULT 0,
          updated_at    timestamp with time zone NOT NULL DEFAULT now(),
          UNIQUE(project_id, month)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_bandwidth_project_month_idx ON project_bandwidth(project_id, month)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-subscriptions ───────────────────────────────────────────────────
  {
    name: "migrate-subscriptions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_subscriptions (
          id                     SERIAL PRIMARY KEY,
          user_id                TEXT NOT NULL UNIQUE,
          stripe_customer_id     TEXT,
          stripe_subscription_id TEXT,
          tier                   TEXT NOT NULL DEFAULT 'free',
          status                 TEXT NOT NULL DEFAULT 'active',
          current_period_end     TIMESTAMPTZ,
          grace_period_end       TIMESTAMPTZ,
          cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
          last_monthly_grant_at  TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_customer_idx ON user_subscriptions(stripe_customer_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_sub_idx ON user_subscriptions(stripe_subscription_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-runtime-breadth ─────────────────────────────────────────────────
  {
    name: "migrate-runtime-breadth",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduled_job_runs (
          id           SERIAL PRIMARY KEY,
          schedule_id  INTEGER NOT NULL REFERENCES deployment_schedules(id) ON DELETE CASCADE,
          project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status       TEXT NOT NULL DEFAULT 'running',
          exit_code    INTEGER,
          output       TEXT,
          error_message TEXT,
          duration_ms  INTEGER,
          triggered_by TEXT NOT NULL DEFAULT 'cron',
          started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_schedule_idx ON scheduled_job_runs(schedule_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_project_idx ON scheduled_job_runs(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_started_idx ON scheduled_job_runs(started_at)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS managed_addons (
          id                SERIAL PRIMARY KEY,
          project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'provisioning',
          external_id       TEXT,
          connection_info   JSONB,
          injected_env_keys JSONB NOT NULL DEFAULT '[]',
          plan              TEXT NOT NULL DEFAULT 'free',
          usage_bytes       INTEGER,
          usage_ops         INTEGER,
          last_metered_at   TIMESTAMPTZ,
          notes             TEXT,
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          removed_at        TIMESTAMPTZ,
          CONSTRAINT managed_addons_project_kind_unique UNIQUE (project_id, kind)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS managed_addons_project_idx ON managed_addons(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS managed_addons_kind_idx ON managed_addons(kind)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_environments (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name                TEXT NOT NULL,
          snapshot_version_id INTEGER,
          status              TEXT NOT NULL DEFAULT 'idle',
          url                 TEXT,
          auto_promote        BOOLEAN NOT NULL DEFAULT FALSE,
          protected           BOOLEAN NOT NULL DEFAULT FALSE,
          deployed_by         TEXT,
          deployed_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT project_environments_project_name_unique UNIQUE (project_id, name)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_environments_project_idx ON project_environments(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS environment_promotions (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_environment    TEXT NOT NULL,
          to_environment      TEXT NOT NULL,
          snapshot_version_id INTEGER,
          status              TEXT NOT NULL DEFAULT 'pending',
          notes               TEXT,
          triggered_by        TEXT,
          started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at        TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS environment_promotions_project_idx ON environment_promotions(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id       TEXT NOT NULL,
          kind          TEXT NOT NULL,
          quantity      NUMERIC(18,6) NOT NULL DEFAULT 1,
          resource_type TEXT,
          resource_id   TEXT,
          unit          TEXT NOT NULL DEFAULT 'units',
          recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_project_idx ON usage_events(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events(user_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events(kind)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_recorded_at_idx ON usage_events(recorded_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-collaboration ───────────────────────────────────────────────────
  {
    name: "migrate-collaboration",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id                  serial PRIMARY KEY,
          name                text NOT NULL,
          slug                text NOT NULL UNIQUE,
          description         text,
          type                text NOT NULL DEFAULT 'team',
          avatar_url          text,
          billing_email       text,
          stripe_customer_id  text,
          created_by_user_id  text NOT NULL,
          deleted_at          timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_members (
          id              serial PRIMARY KEY,
          organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id         text NOT NULL,
          role            text NOT NULL DEFAULT 'member',
          display_name    text,
          email           text,
          avatar_url      text,
          joined_at       timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          UNIQUE (organization_id, user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members(user_id)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_members_org_idx ON org_members(organization_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_invites (
          id                   serial PRIMARY KEY,
          organization_id      integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          token                text NOT NULL UNIQUE,
          email                text NOT NULL,
          role                 text NOT NULL DEFAULT 'member',
          invited_by_user_id   text NOT NULL,
          status               text NOT NULL DEFAULT 'pending',
          accepted_by_user_id  text,
          expires_at           timestamptz NOT NULL,
          accepted_at          timestamptz,
          created_at           timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(organization_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(email)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_comments (
          id                  serial PRIMARY KEY,
          project_id          integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          author_id           text NOT NULL,
          author_name         text,
          author_avatar       text,
          parent_id           integer,
          file_path           text,
          line_start          integer,
          line_end            integer,
          build_result_id     integer,
          body                text NOT NULL,
          resolved            boolean NOT NULL DEFAULT false,
          resolved_by_user_id text,
          resolved_at         timestamptz,
          edited_at           timestamptz,
          deleted_at          timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id            serial PRIMARY KEY,
          recipient_id  text NOT NULL,
          type          text NOT NULL,
          title         text NOT NULL,
          body          text,
          actor_id      text,
          actor_name    text,
          resource_type text,
          resource_id   text,
          project_id    integer,
          metadata      jsonb,
          read          boolean NOT NULL DEFAULT false,
          read_at       timestamptz,
          created_at    timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(recipient_id, read) WHERE read = false`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_activity (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          actor_id     text,
          actor_name   text,
          actor_avatar text,
          event_type   text NOT NULL,
          summary      text NOT NULL,
          metadata     jsonb,
          created_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_actor_idx ON project_activity(actor_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS share_links (
          id                  serial PRIMARY KEY,
          project_id          integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          token               text NOT NULL UNIQUE,
          label               text,
          created_by_user_id  text NOT NULL,
          scope               text NOT NULL DEFAULT 'draft',
          snapshot_version_id integer,
          password_hash       text,
          expires_at          timestamptz,
          revoked             boolean NOT NULL DEFAULT false,
          revoked_at          timestamptz,
          view_count          integer NOT NULL DEFAULT 0,
          last_viewed_at      timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS share_links_token_idx ON share_links(token)`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id)`,
      );

      // data migration: create personal orgs for existing users
      const { rows: owners } = await client.query<{ owner_id: string }>(`
        SELECT DISTINCT p.owner_id FROM projects p
        WHERE p.owner_id IS NOT NULL AND p.owner_id != ''
          AND NOT EXISTS (
            SELECT 1 FROM organizations o
            WHERE o.created_by_user_id = p.owner_id AND o.type = 'personal'
          )
      `);
      for (const { owner_id } of owners) {
        const slug = `personal-${owner_id
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-")
          .slice(0, 40)}`;
        const { rows: orgs } = await client.query(
          `INSERT INTO organizations (name, slug, type, created_by_user_id)
           VALUES ($1, $2, 'personal', $3)
           ON CONFLICT (slug) DO UPDATE SET updated_at = now()
           RETURNING id`,
          ["Personal", slug, owner_id],
        );
        if (orgs[0]) {
          await client.query(
            `INSERT INTO org_members (organization_id, user_id, role)
             VALUES ($1, $2, 'owner')
             ON CONFLICT (organization_id, user_id) DO NOTHING`,
            [orgs[0].id, owner_id],
          );
          await client.query(
            `UPDATE projects SET organization_id = $1 WHERE owner_id = $2 AND organization_id IS NULL`,
            [orgs[0].id, owner_id],
          );
        }
      }

      await client.query("COMMIT");
    },
  },

  // ── migrate-ecosystem ───────────────────────────────────────────────────────
  {
    name: "migrate-ecosystem",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS gallery_templates (
          id            serial PRIMARY KEY,
          slug          text NOT NULL UNIQUE,
          title         text NOT NULL,
          description   text NOT NULL,
          readme        text,
          category      text NOT NULL DEFAULT 'web',
          tags          jsonb NOT NULL DEFAULT '[]',
          author_id     text,
          author_name   text,
          files_snapshot jsonb,
          preview_url   text,
          thumbnail_url text,
          platform      text NOT NULL DEFAULT 'web',
          stack         text NOT NULL DEFAULT 'react-vite',
          rating        real NOT NULL DEFAULT 0,
          rating_count  integer NOT NULL DEFAULT 0,
          fork_count    integer NOT NULL DEFAULT 0,
          use_count     integer NOT NULL DEFAULT 0,
          status        text NOT NULL DEFAULT 'draft',
          featured      boolean NOT NULL DEFAULT false,
          editors_pick  boolean NOT NULL DEFAULT false,
          is_system     boolean NOT NULL DEFAULT false,
          forked_from_id integer,
          source_project_id integer,
          created_at    timestamptz NOT NULL DEFAULT now(),
          updated_at    timestamptz NOT NULL DEFAULT now(),
          published_at  timestamptz
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS template_ratings (
          id          serial PRIMARY KEY,
          template_id integer NOT NULL,
          user_id     text NOT NULL,
          rating      integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment     text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS extensions (
          id               serial PRIMARY KEY,
          slug             text NOT NULL UNIQUE,
          name             text NOT NULL,
          description      text NOT NULL,
          long_description text,
          version          text NOT NULL DEFAULT '1.0.0',
          author_id        text,
          author_name      text,
          manifest_url     text,
          manifest         jsonb,
          scopes           jsonb NOT NULL DEFAULT '[]',
          icon_url         text,
          homepage_url     text,
          repository_url   text,
          category         text NOT NULL DEFAULT 'productivity',
          tags             jsonb NOT NULL DEFAULT '[]',
          install_count    integer NOT NULL DEFAULT 0,
          status           text NOT NULL DEFAULT 'draft',
          vetted           boolean NOT NULL DEFAULT false,
          featured         boolean NOT NULL DEFAULT false,
          is_system        boolean NOT NULL DEFAULT false,
          vetting_notes    text,
          vetted_at        timestamptz,
          vetted_by        text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          published_at     timestamptz
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS extensions_status_idx ON extensions(status)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_category_idx ON extensions(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_featured_idx ON extensions(featured)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_author_idx ON extensions(author_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_extensions (
          id             serial PRIMARY KEY,
          project_id     integer NOT NULL,
          extension_id   integer NOT NULL,
          extension_slug text NOT NULL,
          installed_by   text,
          config         jsonb,
          enabled        boolean NOT NULL DEFAULT true,
          installed_at   timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now()
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
      await client.query(`
        CREATE TABLE IF NOT EXISTS community_profiles (
          id                  serial PRIMARY KEY,
          user_id             text NOT NULL UNIQUE,
          username            text NOT NULL UNIQUE,
          display_name        text,
          bio                 text,
          avatar_url          text,
          website_url         text,
          twitter_handle      text,
          github_handle       text,
          location            text,
          public_project_ids  jsonb NOT NULL DEFAULT '[]',
          showcased_project_ids jsonb NOT NULL DEFAULT '[]',
          follower_count      integer NOT NULL DEFAULT 0,
          following_count     integer NOT NULL DEFAULT 0,
          badge_embed_enabled boolean NOT NULL DEFAULT false,
          profile_public      boolean NOT NULL DEFAULT true,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_username_idx ON community_profiles(username)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_user_id_idx ON community_profiles(user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS profile_follows (
          id           serial PRIMARY KEY,
          follower_id  text NOT NULL,
          following_id text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now()
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
    },
  },

  // ── migrate-secret-scoping ──────────────────────────────────────────────────
  {
    name: "migrate-secret-scoping",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS min_role TEXT NOT NULL DEFAULT 'viewer'`,
      );
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'project_secrets_min_role_check'
          ) THEN
            ALTER TABLE project_secrets
              ADD CONSTRAINT project_secrets_min_role_check
              CHECK (min_role IN ('viewer', 'member', 'admin', 'owner'));
          END IF;
        END
        $$
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-agentic-provisioning ────────────────────────────────────────────
  {
    name: "migrate-agentic-provisioning",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS builder_mode text NOT NULL DEFAULT 'static-legacy'`,
      );
      await client.query(`ALTER TABLE projects ALTER COLUMN builder_mode SET DEFAULT 'agentic'`);
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS neon_project_id text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'idle'`,
      );
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_error text`);
      await client.query("COMMIT");
    },
  },

  // Builder architecture selection lock.
  {
    name: "migrate-builder-stack-lock",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS stack_locked BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    },
  },

  // ── migrate-task-agent-mode ─────────────────────────────────────────────────
  {
    name: "migrate-task-agent-mode",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task_agent_mode text`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-preview-secrets ─────────────────────────────────────────────────
  {
    name: "migrate-preview-secrets",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS is_preview_safe BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-testing-approval ────────────────────────────────────────────────
  {
    name: "migrate-testing-approval",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_at timestamptz`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_by text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_status text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_log text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_skipped boolean NOT NULL DEFAULT false`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-preview-db ──────────────────────────────────────────────────────
  {
    name: "migrate-preview-db",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_url text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_status text NOT NULL DEFAULT 'none'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-testing-workflow ────────────────────────────────────────────────
  {
    name: "migrate-testing-workflow",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_id text`);
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_url text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_status text NOT NULL DEFAULT 'stopped'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS running_test_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS static_test_candidate_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_candidate_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_status text NOT NULL DEFAULT 'idle'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS tested_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS previous_published_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_preview_session_id text`,
      );
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS exposure_type text NOT NULL DEFAULT 'server'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_sessions (
          id                serial PRIMARY KEY,
          session_id        text NOT NULL UNIQUE,
          project_id        integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id           text NOT NULL,
          launch_token_hash text NOT NULL,
          launch_token_used boolean NOT NULL DEFAULT false,
          cookie_issued_at  timestamptz,
          expires_at        timestamptz NOT NULL,
          revoked_at        timestamptz,
          revoke_reason     text,
          created_at        timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS preview_sessions_project_idx ON preview_sessions(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS preview_sessions_session_id_idx ON preview_sessions(session_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-deployment-logs-mobile ──────────────────────────────────────────
  {
    name: "migrate-deployment-logs-mobile",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS build_id text`);
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS platform text`);
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS download_url text`);
      await client.query(
        `ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS testflight_url text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-token-count ─────────────────────────────────────────────────────
  {
    name: "migrate-token-count",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS token_count integer`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-chip-label ──────────────────────────────────────────────────────
  {
    name: "migrate-chip-label",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS chip_label TEXT`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-personal-access-tokens ─────────────────────────────────────────
  {
    name: "migrate-personal-access-tokens",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          name          TEXT NOT NULL,
          token_hash    TEXT NOT NULL UNIQUE,
          token_preview TEXT NOT NULL,
          project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          scopes        JSONB NOT NULL DEFAULT '["domains:read","domains:write"]',
          active        BOOLEAN NOT NULL DEFAULT TRUE,
          last_used_at  TIMESTAMPTZ,
          expires_at    TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-pat-rotation (Task #864) ────────────────────────────────────────
  {
    name: "migrate-pat-rotation",
    async run(client) {
      await client.query(
        `ALTER TABLE personal_access_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ`,
      );
    },
  },

  // ── migrate-message-origin (Task #919) ──────────────────────────────────────
  {
    name: "migrate-message-origin",
    async run(client) {
      await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS origin TEXT`);
    },
  },

  // ── migrate-command-approval (Task #964) ─────────────────────────────────────
  {
    name: "migrate-command-approval",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS require_command_approval BOOLEAN NOT NULL DEFAULT false`,
      );
    },
  },

  // ── migrate-voice-lang ───────────────────────────────────────────────────────
  {
    name: "migrate-voice-lang",
    async run(client) {
      await client.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS voice_lang TEXT`);
    },
  },

  // ── migrate-auto-read-replies ────────────────────────────────────────────────
  {
    name: "migrate-auto-read-replies",
    async run(client) {
      await client.query(
        `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS auto_read_replies BOOLEAN NOT NULL DEFAULT false`,
      );
    },
  },

  // ── migrate-reinforced-count (Task #980) ─────────────────────────────────────
  {
    name: "migrate-reinforced-count",
    async run(client) {
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS reinforced_count INTEGER NOT NULL DEFAULT 0`,
      );
    },
  },

  // ── migrate-canvas-state (Task #904) ─────────────────────────────────────────
  {
    name: "migrate-canvas-state",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS canvas_state JSONB DEFAULT '{}'`,
      );
    },
  },

  // ── migrate-brainstorm-context ───────────────────────────────────────────────
  {
    name: "migrate-brainstorm-context",
    async run(client) {
      await client.query(`
        ALTER TABLE agent_tasks
          ADD COLUMN IF NOT EXISTS has_brainstorm_context BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS brainstorm_turn_count INTEGER
      `);
    },
  },

  // ── migrate-gdpr-erasure-job (Task #1002) ────────────────────────────────────
  {
    name: "migrate-gdpr-erasure-job",
    async run(client) {
      await client.query(`
        ALTER TABLE user_preferences
          ADD COLUMN IF NOT EXISTS erasure_job_id TEXT,
          ADD COLUMN IF NOT EXISTS erasure_requested_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-low-credit-email (Task #1003) ────────────────────────────────────
  {
    name: "migrate-low-credit-email",
    async run(client) {
      await client.query(
        `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS last_low_credit_email_at TIMESTAMPTZ`,
      );
    },
  },

  // ── migrate-ora-project-description ───────────────────────────────────────────
  {
    name: "migrate-ora-project-description",
    async run(client) {
      await client.query(`ALTER TABLE ora_projects ADD COLUMN IF NOT EXISTS description TEXT`);
    },
  },

  // ── migrate-mobile-deployment-columns (Task #776) ────────────────────────────
  {
    name: "migrate-mobile-deployment-columns",
    async run(client) {
      await client.query(`
        ALTER TABLE deployment_logs
          ADD COLUMN IF NOT EXISTS build_id text,
          ADD COLUMN IF NOT EXISTS platform text,
          ADD COLUMN IF NOT EXISTS download_url text,
          ADD COLUMN IF NOT EXISTS testflight_url text
      `);
    },
  },

  // ── migrate-preferred-mode (Task #897) ───────────────────────────────────────
  {
    name: "migrate-preferred-mode",
    async run(client) {
      await client.query(
        `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS preferred_mode TEXT`,
      );
      await client.query(
        `ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_preferred_mode_check`,
      );
      await client.query(
        `ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_preferred_mode_check CHECK (preferred_mode IN ('builder','developer','ora'))`,
      );
    },
  },

  // ── migrate-project-mode (Task #898) ─────────────────────────────────────────
  {
    name: "migrate-project-mode",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_mode TEXT NOT NULL DEFAULT 'builder'`,
      );
      await client.query(
        `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_mode_check`,
      );
      await client.query(
        `ALTER TABLE projects ADD CONSTRAINT projects_project_mode_check CHECK (project_mode IN ('builder','developer'))`,
      );
    },
  },

  // ── migrate-provisioning-steps (Task #988) ───────────────────────────────────
  {
    name: "migrate-provisioning-steps",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS provisioning_step TEXT,
          ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-stripe-events-status ─────────────────────────────────────────────
  {
    name: "migrate-stripe-events-status",
    async run(client) {
      await client.query(`
        ALTER TABLE stripe_processed_events
          ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'succeeded',
          ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS succeeded_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS error_message TEXT
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS credit_grants (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          period_start TIMESTAMPTZ NOT NULL,
          amount INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT credit_grants_subscription_period_unique UNIQUE (subscription_id, period_start)
        )
      `);
    },
  },

  // ── migrate-drop-conversations ───────────────────────────────────────────────
  {
    name: "migrate-drop-conversations",
    async run(client) {
      await client.query(`DROP TABLE IF EXISTS conversations`);
    },
  },

  // ── migrate-agent-tool-calls ───────────────────────────────────────────────
  // Per-tool-call audit log for the agentic builder loop + per-project hourly
  // rate cap on projects. Without this table the agent-loop INSERT/COUNT in
  // handleToolResult silently falls back to a stale estimate (try/catch) so
  // the audit feed stays empty and the rate limiter never enforces.
  {
    name: "migrate-agent-tool-calls",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_tool_calls (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id         INTEGER,
          tool_name       TEXT NOT NULL,
          args_summary    TEXT,
          stdout_preview  TEXT,
          exit_code       INTEGER,
          ok              BOOLEAN NOT NULL DEFAULT TRUE,
          duration_ms     INTEGER NOT NULL DEFAULT 0,
          called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tool_calls_project_called_idx ON agent_tool_calls (project_id, called_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tool_calls_task_idx ON agent_tool_calls (task_id)`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS tool_call_rate_cap_per_hour INTEGER NOT NULL DEFAULT 200`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-collaboration ────────────────────────────────────────────────────
  {
    name: "migrate-collaboration",
    async run(client) {
      await client.query("BEGIN");
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
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id)
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ecosystem ─────────────────────────────────────────────────────────
  {
    name: "migrate-ecosystem",
    async run(client) {
      await client.query("BEGIN");
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
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_author_idx ON extensions(author_id)`,
      );
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
    },
  },

  // ── migrate-ora-transcripts ──────────────────────────────────────────────────
  {
    name: "migrate-ora-transcripts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_transcripts (
          id         SERIAL PRIMARY KEY,
          user_id    TEXT NOT NULL UNIQUE,
          messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_transcripts_user_id_idx ON ora_transcripts (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault ────────────────────────────────────────────────────────────
  {
    name: "migrate-vault",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_entries (
          id               serial PRIMARY KEY,
          user_id          text NOT NULL,
          title            text NOT NULL,
          category         text NOT NULL DEFAULT 'OTHER',
          subcategory      text,
          summary          text NOT NULL,
          content          text NOT NULL,
          tags             text,
          department       text,
          source_type      text NOT NULL DEFAULT 'USER_CREATED',
          source_reference text,
          status           text NOT NULL DEFAULT 'draft',
          version          integer NOT NULL DEFAULT 1,
          confidence_score integer,
          approved         boolean NOT NULL DEFAULT false,
          updated_by       text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          archived_at      timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_user_idx ON vault_entries(user_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_category_idx ON vault_entries(user_id, category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_status_idx ON vault_entries(user_id, status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_versions (
          id             serial PRIMARY KEY,
          entry_id       integer NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
          version        integer NOT NULL,
          title          text NOT NULL,
          summary        text NOT NULL,
          content        text NOT NULL,
          tags           text,
          department     text,
          edited_by      text NOT NULL,
          edited_at      timestamptz NOT NULL DEFAULT now(),
          change_summary text
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_versions_entry_idx ON vault_versions(entry_id, version DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault-phase81 ─────────────────────────────────────────────────
  {
    name: "migrate-vault-phase81",
    async run(client) {
      await client.query("BEGIN");
      // Convert tags TEXT → TEXT[] in vault_entries
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'vault_entries' AND column_name = 'tags'
              AND data_type = 'text'
          ) THEN
            ALTER TABLE vault_entries
              ALTER COLUMN tags TYPE text[]
              USING (
                CASE
                  WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                  ELSE string_to_array(tags, ',')
                END
              );
            ALTER TABLE vault_entries ALTER COLUMN tags SET DEFAULT '{}';
            ALTER TABLE vault_entries ALTER COLUMN tags SET NOT NULL;
          END IF;
        END $$
      `);
      // Convert tags TEXT → TEXT[] in vault_versions
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'vault_versions' AND column_name = 'tags'
              AND data_type = 'text'
          ) THEN
            ALTER TABLE vault_versions
              ALTER COLUMN tags TYPE text[]
              USING (
                CASE
                  WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                  ELSE string_to_array(tags, ',')
                END
              );
            ALTER TABLE vault_versions ALTER COLUMN tags SET DEFAULT '{}';
            ALTER TABLE vault_versions ALTER COLUMN tags SET NOT NULL;
          END IF;
        END $$
      `);
      // Create a stable IMMUTABLE wrapper so the GIN index expression stored in
      // pg_indexes does NOT contain || (pipe-pipe). Replit's deployment tool
      // misparses || in functional GIN index definitions and generates broken SQL.
      // Using a named function means pg_indexes shows `vault_fts(title, summary)` —
      // no || — so the tool copies it to production without corruption.
      await client.query(`
        CREATE OR REPLACE FUNCTION vault_fts(title text, summary text)
          RETURNS tsvector
          LANGUAGE sql
          IMMUTABLE PARALLEL SAFE
          AS $fn$
            SELECT to_tsvector('english'::regconfig,
              coalesce(title, '') || ' ' || coalesce(summary, ''))
          $fn$
      `);
      // Drop-then-recreate so any stale definition (e.g. the old inline ||
      // expression) is replaced with the function-based definition on every boot.
      await client.query(`DROP INDEX IF EXISTS vault_entries_search_idx`);
      await client.query(`
        CREATE INDEX vault_entries_search_idx
          ON vault_entries
          USING GIN(vault_fts(title, summary))
      `);
      // GIN index on tags array
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_tags_idx ON vault_entries USING GIN(tags)`,
      );
      // Performance indexes
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_updated_idx ON vault_entries (user_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_dept_idx ON vault_entries (user_id, department)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_archived_idx ON vault_entries (user_id, archived_at) WHERE archived_at IS NOT NULL`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault-embeddings ───────────────────────────────────────────────
  {
    name: "migrate-vault-embeddings",
    async run(client) {
      await client.query("BEGIN");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_embeddings (
          id              serial PRIMARY KEY,
          entry_id        integer NOT NULL,
          user_id         text NOT NULL,
          chunk_index     integer NOT NULL,
          chunk_text      text NOT NULL,
          chunk_hash      text NOT NULL,
          embedding       vector(1536),
          embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
          source_version  integer NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT vault_embeddings_entry_chunk_unique UNIQUE (entry_id, chunk_index)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS vault_embeddings_entry_idx
          ON vault_embeddings (entry_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS vault_embeddings_user_idx
          ON vault_embeddings (user_id, entry_id)
      `);
      await client.query("COMMIT");
    },
  },
  {
    name: "knowledge_usage_events",
    run: async (client) => {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS knowledge_usage_events (
          id                      BIGSERIAL   PRIMARY KEY,
          user_id                 TEXT        NOT NULL,
          query                   TEXT        NOT NULL,
          report_type             TEXT        NOT NULL DEFAULT 'knowledge-report',
          selected_entry_ids      INTEGER[]   NOT NULL DEFAULT '{}',
          selected_entry_versions INTEGER[]   NOT NULL DEFAULT '{}',
          entry_count             INTEGER     NOT NULL DEFAULT 0,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_kue_user_id ON knowledge_usage_events (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_kue_created_at ON knowledge_usage_events (created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-image-studio ─────────────────────────────────────────────────
  {
    name: "migrate-image-studio",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS generated_images (
          id                     SERIAL PRIMARY KEY,
          user_id                TEXT NOT NULL,
          project_id             INTEGER,
          prompt                 TEXT NOT NULL,
          revised_prompt         TEXT,
          style                  TEXT,
          quality                TEXT NOT NULL DEFAULT 'standard',
          aspect_ratio           TEXT NOT NULL DEFAULT '1:1',
          transparent_background BOOLEAN NOT NULL DEFAULT false,
          status                 TEXT NOT NULL DEFAULT 'pending',
          file_url               TEXT,
          storage_key            TEXT,
          safety_status          TEXT NOT NULL DEFAULT 'pending',
          credit_cost            INTEGER NOT NULL DEFAULT 3,
          error_message          TEXT,
          error_category         TEXT,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at             TIMESTAMPTZ
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
    },
  },

  // ── migrate-image-studio-v2 ───────────────────────────────────────────────
  {
    name: "migrate-image-studio-v2",
    async run(client) {
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
    },
  },

  // ── migrate-tier-rename ─────────────────────────────────────────────────
  // Collapse legacy paid tiers (pro, team) into the new top tier (wave) so
  // existing paying customers keep their highest benefits under the GPT-style
  // pricing model (free / core / wave). Idempotent.
  {
    name: "migrate-tier-rename",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        UPDATE user_subscriptions
          SET tier = 'wave', updated_at = now()
          WHERE tier IN ('pro', 'team')
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-usage-events ──────────────────────────────────────
  {
    name: "migrate-knowledge-usage-events",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS knowledge_usage_events (
          id                      BIGSERIAL   PRIMARY KEY,
          user_id                 TEXT        NOT NULL,
          query                   TEXT        NOT NULL,
          report_type             TEXT        NOT NULL DEFAULT 'knowledge-report',
          selected_entry_ids      INTEGER[]   NOT NULL DEFAULT '{}',
          selected_entry_versions INTEGER[]   NOT NULL DEFAULT '{}',
          entry_count             INTEGER     NOT NULL DEFAULT 0,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_kue_user_id ON knowledge_usage_events (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_kue_created_at ON knowledge_usage_events (created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-agent-task-heartbeat (Task #1182) ────────────────────────────
  {
    name: "migrate-agent-task-heartbeat",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
      );
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS current_step INTEGER`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_heartbeat_status_idx
         ON agent_tasks (status, last_heartbeat_at)
         WHERE status = 'building'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-task-events-data (Preview Sync Pipeline) ─────────────────────
  {
    name: "migrate-task-events-data",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE task_events ADD COLUMN IF NOT EXISTS data JSONB`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-conversations (Ora Step 2: projects + conversations) ──────
  {
    name: "migrate-ora-conversations",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_projects (
          id          SERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          name        TEXT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_projects_user_id_idx ON ora_projects (user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_conversations (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          project_id      INTEGER,
          title           TEXT,
          messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at     TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_user_id_idx ON ora_conversations (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_project_id_idx ON ora_conversations (project_id)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-assets (Task #1278) ─────────────────────────────────────────
  {
    name: "migrate-ora-assets",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_assets (
          id          SERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          kind        TEXT NOT NULL,
          file_name   TEXT NOT NULL,
          mime_type   TEXT NOT NULL,
          format      TEXT,
          prompt      TEXT,
          data        TEXT NOT NULL,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_user_id_idx ON ora_assets (user_id)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-asset-storage (R2 offload, additive) ────────────────────────
  {
    name: "migrate-ora-asset-storage",
    async run(client) {
      await client.query("BEGIN");
      // Record the R2 object key when bytes are offloaded to object storage.
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS storage_key TEXT`);
      // `data` becomes nullable: offloaded rows store bytes in R2, not the DB.
      await client.query(`ALTER TABLE ora_assets ALTER COLUMN data DROP NOT NULL`);
      // Enforce the storage invariant: exactly one of `data` / `storage_key`.
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
    },
  },
  // ── migrate-drop-ora-daily-usage ─────────────────────────────────────────────
  // Ora usage metering moved from per-UTC-day caps (ora_daily_usage) to per-user
  // rolling windows (ora_usage_windows). Nothing reads the legacy table anymore;
  // drop it so the schema stays tidy. Idempotent via DROP TABLE IF EXISTS.
  {
    name: "migrate-drop-ora-daily-usage",
    async run(client) {
      await client.query(`DROP TABLE IF EXISTS ora_daily_usage`);
    },
  },

  // ── migrate-ora-memory-center (Phase 3B.1) ──────────────────────────────────
  {
    name: "migrate-ora-memory-center",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_profiles (
          id                 SERIAL PRIMARY KEY,
          user_id            TEXT NOT NULL UNIQUE,
          preferred_name     TEXT,
          occupation         TEXT,
          industry           TEXT,
          goals              TEXT,
          skill_level        TEXT,
          preferred_language TEXT,
          response_style     TEXT,
          avoid              TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      );
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS source_conversation_id INTEGER`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-origin (Ora ↔ Builder isolation) ──────────────────────
  {
    name: "migrate-knowledge-origin",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS origin TEXT`);
      await client.query(`UPDATE knowledge_entries SET origin = 'builder' WHERE origin IS NULL`);
      await client.query("COMMIT");
    },
  },
  // ── migrate-recover-ora-memories (re-tag misfiled Ora saves) ────────────────
  // Recovers Ora memories that the buggy save paths POSTed to /api/knowledge
  // (origin="builder"). Genuine Builder user-scope data (brand profiles +
  // inferred style memories, both type="style_memory") is excluded. Idempotent:
  // recovered rows carry origin="ora" and no longer match. Must run AFTER the
  // knowledge-origin backfill above so origin is populated.
  {
    name: "migrate-recover-ora-memories",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `UPDATE knowledge_entries
            SET origin = 'ora'
          WHERE scope = 'user'
            AND origin = 'builder'
            AND type = 'note'
            AND type <> 'style_memory'
            AND project_id IS NULL`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-help-center (Task #1312) ────────────────────────────────────────
  {
    name: "migrate-help-center",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS help_articles (
          id serial PRIMARY KEY,
          slug text NOT NULL UNIQUE,
          category text NOT NULL DEFAULT 'getting-started',
          title text NOT NULL,
          body text NOT NULL,
          tags jsonb NOT NULL DEFAULT '[]'::jsonb,
          is_faq boolean NOT NULL DEFAULT false,
          sort_order integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS help_articles_category_idx ON help_articles(category, sort_order)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS help_articles_is_faq_idx ON help_articles(is_faq)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id serial PRIMARY KEY,
          user_id text NOT NULL,
          user_email text,
          plan text NOT NULL DEFAULT 'free',
          category text NOT NULL DEFAULT 'other',
          status text NOT NULL DEFAULT 'new',
          subject text NOT NULL,
          transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
          project_id integer,
          attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
          device_info jsonb,
          support_email_used text,
          email_status text NOT NULL DEFAULT 'skipped',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx ON support_tickets(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, created_at)`,
      );
      // Triage lifecycle moved to new/open/resolved; align the column default
      // for any table created under the old 'open' default.
      await client.query(`ALTER TABLE support_tickets ALTER COLUMN status SET DEFAULT 'new'`);
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'normal'`,
      );
      await client.query(`UPDATE ora_conversations SET surface = 'normal' WHERE surface IS NULL`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_surface_idx ON ora_conversations(user_id, surface)`,
      );
      const { HELP_ARTICLE_SEED } = await import("@workspace/db");
      for (const a of HELP_ARTICLE_SEED) {
        await client.query(
          `INSERT INTO help_articles (slug, category, title, body, tags, is_faq, sort_order)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (slug) DO NOTHING`,
          [a.slug, a.category, a.title, a.body, JSON.stringify(a.tags), a.isFaq, a.sortOrder],
        );
      }
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-usage-windows (Ora per-user rolling-window quotas) ───────────
  {
    name: "migrate-ora-usage-windows",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_usage_windows (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          message_count INTEGER NOT NULL DEFAULT 0,
          image_count   INTEGER NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_usage_windows_user_uniq
           ON ora_usage_windows (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-memory-category (backfill typed Ora memory categories) ──────
  {
    name: "migrate-ora-memory-category",
    async run(client) {
      await client.query("BEGIN");
      // Coarse keyword heuristic mirroring lib/ora-memory-category.ts. Only
      // touches Ora user-scoped rows still at the legacy default, so it's safe
      // to re-run and never overrides a user's explicit re-categorization.
      await client.query(`
        UPDATE knowledge_entries
        SET category = CASE
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(prefer|favorite|favourite|i like|i love|always use|never use|avoid|don''t|do not|tone|style|concise|verbose|formal|casual|dark mode|light mode|default to|colour|color|theme|font|format)'
            THEN 'preference'
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(my name|name is|i am |i''m |i live|i work|based in|located in|email is|phone|birthday|i was born|pronoun|my job|my role|my title|my company|i have a|family|married|speak |native)'
            THEN 'personal'
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(project|app called|building|website for|feature|deadline|tech stack|stack|database|deploy|client|customer|product|launch|repo|codebase|endpoint|integration)'
            THEN 'project'
          ELSE 'other'
        END
        WHERE origin = 'ora'
          AND scope = 'user'
          AND (category IS NULL OR category = 'note' OR category = 'other')
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax (isolated coding-agent foundation) ───────────────────────
  {
    name: "migrate-orax",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repositories (
          id                SERIAL PRIMARY KEY,
          user_id           TEXT NOT NULL,
          provider          TEXT NOT NULL DEFAULT 'github',
          owner             TEXT NOT NULL,
          name              TEXT NOT NULL,
          repository_url    TEXT NOT NULL,
          default_branch    TEXT NOT NULL DEFAULT 'main',
          connection_status TEXT NOT NULL DEFAULT 'metadata_only',
          github_account_name TEXT,
          token_scopes      TEXT,
          encrypted_token   TEXT,
          connected_at      TIMESTAMPTZ,
          last_scan_at      TIMESTAMPTZ,
          scan_status       TEXT NOT NULL DEFAULT 'idle',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repositories_user_id_idx ON orax_repositories(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repositories_provider_idx
           ON orax_repositories(provider, owner, name)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_tasks (
          id                SERIAL PRIMARY KEY,
          user_id           TEXT NOT NULL,
          repository_id     INTEGER NOT NULL,
          kind              TEXT NOT NULL DEFAULT 'analyze',
          status            TEXT NOT NULL DEFAULT 'planned',
          title             TEXT NOT NULL,
          prompt            TEXT NOT NULL,
          plan              JSONB NOT NULL DEFAULT '{}'::jsonb,
          result            JSONB NOT NULL DEFAULT '{}'::jsonb,
          approval_required TEXT NOT NULL DEFAULT 'write_and_push',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at      TIMESTAMPTZ,
          archived_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_tasks_user_id_idx ON orax_tasks(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_tasks_repository_id_idx ON orax_tasks(repository_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS orax_tasks_status_idx ON orax_tasks(status)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_approvals (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          action        TEXT NOT NULL DEFAULT 'read_files',
          status        TEXT NOT NULL DEFAULT 'pending',
          request       JSONB NOT NULL DEFAULT '{}'::jsonb,
          result        JSONB NOT NULL DEFAULT '{}'::jsonb,
          risk_summary  TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at    TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_user_id_idx
           ON orax_task_approvals(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_task_id_idx
           ON orax_task_approvals(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_status_idx
           ON orax_task_approvals(status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_artifacts (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          approval_id   INTEGER,
          type          TEXT NOT NULL DEFAULT 'draft_patch',
          status        TEXT NOT NULL DEFAULT 'draft',
          title         TEXT NOT NULL,
          summary       TEXT,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_user_id_idx
           ON orax_task_artifacts(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_task_id_idx
           ON orax_task_artifacts(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_status_idx
           ON orax_task_artifacts(status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repository_scans (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          repository_id   INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'completed',
          branch          TEXT NOT NULL,
          commit_sha      TEXT,
          file_count      INTEGER NOT NULL DEFAULT 0,
          directory_count INTEGER NOT NULL DEFAULT 0,
          total_bytes     INTEGER NOT NULL DEFAULT 0,
          summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
          error           TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_user_id_idx
           ON orax_repository_scans(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_repository_id_idx
           ON orax_repository_scans(repository_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-github-readonly (repo scan upgrade) ──────────────────────
  {
    name: "migrate-orax-github-readonly",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS github_account_name TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS token_scopes TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS encrypted_token TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'idle'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repository_scans (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          repository_id   INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'completed',
          branch          TEXT NOT NULL,
          commit_sha      TEXT,
          file_count      INTEGER NOT NULL DEFAULT 0,
          directory_count INTEGER NOT NULL DEFAULT 0,
          total_bytes     INTEGER NOT NULL DEFAULT 0,
          summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
          error           TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_user_id_idx
           ON orax_repository_scans(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_repository_id_idx
           ON orax_repository_scans(repository_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-approvals (approval-gated execution foundation) ──────────
  {
    name: "migrate-orax-approvals",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_approvals (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          action        TEXT NOT NULL DEFAULT 'read_files',
          status        TEXT NOT NULL DEFAULT 'pending',
          request       JSONB NOT NULL DEFAULT '{}'::jsonb,
          result        JSONB NOT NULL DEFAULT '{}'::jsonb,
          risk_summary  TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at    TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_user_id_idx
           ON orax_task_approvals(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_task_id_idx
           ON orax_task_approvals(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_status_idx
           ON orax_task_approvals(status)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-artifacts (draft patch previews) ─────────────────────────
  {
    name: "migrate-orax-artifacts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_artifacts (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          approval_id   INTEGER,
          type          TEXT NOT NULL DEFAULT 'draft_patch',
          status        TEXT NOT NULL DEFAULT 'draft',
          title         TEXT NOT NULL,
          summary       TEXT,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_user_id_idx
           ON orax_task_artifacts(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_task_id_idx
           ON orax_task_artifacts(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_status_idx
           ON orax_task_artifacts(status)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-project-memory (persistent Ora project memory) ─────────────
  {
    name: "migrate-ora-project-memory",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS ora_project_id integer`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS knowledge_entries_ora_project_id_idx ON knowledge_entries(ora_project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-messages (task conversation threads) ─────────────────────
  {
    name: "migrate-orax-messages",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_messages (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          role          TEXT NOT NULL DEFAULT 'user',
          content       TEXT NOT NULL,
          metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
          artifact_id   INTEGER,
          approval_id   INTEGER,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_user_task_idx
           ON orax_task_messages(user_id, task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_task_id_idx
           ON orax_task_messages(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_artifact_id_idx
           ON orax_task_messages(artifact_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_approval_id_idx
           ON orax_task_messages(approval_id)`,
      );
      await client.query("COMMIT");
    },
  },
  {
    name: "migrate-ora-memory-supersede",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS superseded_by INTEGER`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-conversation-summary ────────────────────────────────────────
  {
    name: "migrate-ora-conversation-summary",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary text`);
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary_msg_count integer NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-spend-ledger ─────────────────────────────────────────────────
  {
    name: "migrate-ora-spend-ledger",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_spend_ledger (
          id          SERIAL PRIMARY KEY,
          date_key    DATE NOT NULL,
          ledger_key  TEXT NOT NULL,
          units       INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ora_spend_ledger_date_key_unique
          ON ora_spend_ledger (date_key, ledger_key)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_spend_ledger_date_idx
          ON ora_spend_ledger (date_key)
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-realtime-usage ───────────────────────────────────────────────
  {
    name: "migrate-ora-realtime-usage",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_realtime_usage_windows (
          id           serial PRIMARY KEY,
          usage_key    text NOT NULL,
          window_start timestamptz NOT NULL DEFAULT now(),
          used_seconds integer NOT NULL DEFAULT 0,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_realtime_usage_windows_key_uniq ON ora_realtime_usage_windows(usage_key)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_realtime_sessions (
          id                   text PRIMARY KEY,
          usage_key            text NOT NULL,
          tier                 text NOT NULL,
          max_duration_seconds integer NOT NULL,
          started_at           timestamptz NOT NULL DEFAULT now(),
          last_heartbeat_at    timestamptz NOT NULL DEFAULT now(),
          charged_seconds      integer NOT NULL DEFAULT 0,
          status               text NOT NULL DEFAULT 'active',
          created_at           timestamptz NOT NULL DEFAULT now(),
          updated_at           timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_key_status_idx ON ora_realtime_sessions(usage_key, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_status_heartbeat_idx ON ora_realtime_sessions(status, last_heartbeat_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-file-contexts ───────────────────────────────────────────────
  {
    name: "migrate-ora-file-contexts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_file_contexts (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          file_ref        TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          asset_id        INTEGER,
          filename        TEXT NOT NULL,
          mime_type       TEXT NOT NULL,
          file_type       TEXT NOT NULL,
          extracted_text  TEXT NOT NULL DEFAULT '',
          char_count      INTEGER NOT NULL DEFAULT 0,
          dataset_summary JSONB,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at      TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_file_contexts_user_ref_unique ON ora_file_contexts (user_id, file_ref)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_file_contexts_user_id_idx ON ora_file_contexts (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-desktop (Phase 2B base tables: hosts, threads, etc.) ────────
  // Must run BEFORE desktop-actions/command-approvals/projects, which reference
  // these tables (e.g. migrate-orax-projects ALTERs orax_threads). Mirrors
  // scripts/src/migrate-orax-desktop.ts. Every statement is IF NOT EXISTS, so
  // this is a no-op on DBs already provisioned by the standalone script.
  {
    name: "migrate-orax-desktop",
    async run(client) {
      await client.query("BEGIN");

      // orax_hosts
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_hosts (
          id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id         TEXT NOT NULL,
          device_name     TEXT NOT NULL,
          platform        TEXT NOT NULL DEFAULT 'windows',
          os_version      TEXT,
          app_version     TEXT NOT NULL DEFAULT '0.0.0',
          install_id      TEXT NOT NULL,
          public_key      TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'offline',
          last_seen_at    TIMESTAMPTZ,
          paired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at      TIMESTAMPTZ,
          capabilities    JSONB NOT NULL DEFAULT '{}',
          permission_mode TEXT NOT NULL DEFAULT 'ask_risky',
          trusted_project_ids JSONB NOT NULL DEFAULT '[]',
          metadata        JSONB NOT NULL DEFAULT '{}',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_hosts_install_id_uidx ON orax_hosts (install_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_hosts_user_id_idx ON orax_hosts (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_hosts_status_idx ON orax_hosts (user_id, status)`,
      );

      // orax_pairing_codes
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_pairing_codes (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id     TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id     TEXT NOT NULL,
          code        TEXT NOT NULL,
          qr_payload  TEXT NOT NULL,
          expires_at  TIMESTAMPTZ NOT NULL,
          redeemed_at TIMESTAMPTZ,
          redeemed_by TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_pairing_codes_code_uidx ON orax_pairing_codes (code)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pairing_codes_host_id_idx ON orax_pairing_codes (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pairing_codes_user_id_idx ON orax_pairing_codes (user_id)`,
      );

      // orax_paired_devices
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_paired_devices (
          id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id          TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id          TEXT NOT NULL,
          mobile_device_id TEXT NOT NULL,
          display_name     TEXT,
          platform         TEXT,
          paired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at     TIMESTAMPTZ,
          revoked_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_paired_devices_host_mobile_uidx ON orax_paired_devices (host_id, mobile_device_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_paired_devices_user_id_idx ON orax_paired_devices (user_id)`,
      );

      // orax_projects (host-local folder concept; renamed to
      // orax_desktop_local_folders by migrate-orax-projects on the next step)
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_projects (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id                  TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id                  TEXT NOT NULL,
          local_path               TEXT NOT NULL,
          display_name             TEXT NOT NULL,
          git_remote_url           TEXT,
          current_branch           TEXT,
          last_opened_at           TIMESTAMPTZ,
          permission_mode_override TEXT,
          setup_scripts            JSONB,
          status                   TEXT NOT NULL DEFAULT 'active',
          created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // These indexes target the OLD host-local orax_projects schema (host_id
      // only exists there). On DBs where the cloud orax_projects already exists
      // (e.g. provisioned via drizzle push), host_id is absent, so guard on the
      // local_path column to avoid a failing CREATE INDEX that would roll back
      // this entire step on every boot.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'orax_projects'
              AND column_name = 'local_path'
          ) THEN
            CREATE INDEX IF NOT EXISTS orax_projects_host_id_idx ON orax_projects (host_id);
            CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx ON orax_projects (user_id);
          END IF;
        END $$
      `);

      // orax_threads
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_threads (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id    TEXT NOT NULL,
          host_id    TEXT,
          project_id TEXT REFERENCES orax_projects(id),
          title      TEXT,
          status     TEXT NOT NULL DEFAULT 'idle',
          last_event JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_user_id_idx ON orax_threads (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_host_id_idx ON orax_threads (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_project_id_idx ON orax_threads (project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_status_idx ON orax_threads (user_id, status)`,
      );

      // orax_thread_messages
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_thread_messages (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          thread_id  TEXT NOT NULL REFERENCES orax_threads(id),
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          event_type TEXT,
          payload    JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_thread_messages_thread_id_idx ON orax_thread_messages (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_thread_messages_created_at_idx ON orax_thread_messages (thread_id, created_at)`,
      );

      // orax_pending_approvals
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_pending_approvals (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          thread_id   TEXT NOT NULL REFERENCES orax_threads(id),
          host_id     TEXT NOT NULL,
          description TEXT NOT NULL,
          command     TEXT,
          file_path   TEXT,
          diff        TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_thread_id_idx ON orax_pending_approvals (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_host_id_idx ON orax_pending_approvals (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_status_idx ON orax_pending_approvals (host_id, status)`,
      );

      // orax_usage_events
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_usage_events (
          id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id       TEXT NOT NULL,
          host_id       TEXT NOT NULL REFERENCES orax_hosts(id),
          project_id    TEXT REFERENCES orax_projects(id),
          thread_id     TEXT REFERENCES orax_threads(id),
          action_type   TEXT NOT NULL,
          model_used    TEXT,
          input_tokens  INTEGER,
          output_tokens INTEGER,
          compute_ms    INTEGER,
          status        TEXT NOT NULL DEFAULT 'success',
          metadata      JSONB NOT NULL DEFAULT '{}',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_user_id_idx ON orax_usage_events (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_host_id_idx ON orax_usage_events (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_thread_id_idx ON orax_usage_events (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_created_at_idx ON orax_usage_events (user_id, created_at)`,
      );

      // orax_audit_log (denormalized, no FK so it survives host/thread deletion)
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_audit_log (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id    TEXT NOT NULL,
          host_id    TEXT NOT NULL,
          project_id TEXT,
          thread_id  TEXT,
          action     TEXT NOT NULL,
          command    TEXT,
          file_path  TEXT,
          outcome    TEXT NOT NULL,
          error_msg  TEXT,
          metadata   JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_user_id_idx ON orax_audit_log (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_host_id_idx ON orax_audit_log (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_thread_id_idx ON orax_audit_log (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_created_at_idx ON orax_audit_log (user_id, created_at)`,
      );

      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-desktop-actions (Phase 2E relay action table) ───────────────
  {
    name: "migrate-orax-desktop-actions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_actions (
          id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id         TEXT NOT NULL,
          host_id         TEXT NOT NULL,
          thread_id       TEXT,
          type            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'queued',
          payload         JSONB NOT NULL DEFAULT '{}',
          result          JSONB,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at      TIMESTAMPTZ,
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_user_id_idx
           ON orax_desktop_actions(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_host_id_idx
           ON orax_desktop_actions(host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_status_idx
           ON orax_desktop_actions(host_id, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_thread_id_idx
           ON orax_desktop_actions(thread_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-command-approvals ──────────────────────────────────────────
  {
    name: "migrate-orax-command-approvals",
    async run(client) {
      await client.query("BEGIN");
      // Check table existence before altering (table may not exist in some envs)
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT 1 AS exists FROM information_schema.tables
         WHERE table_name = 'orax_pending_approvals'`,
      );
      if (rows.length > 0) {
        // thread_id was NOT NULL in original CREATE TABLE; make nullable for Phase 2F
        await client.query(
          `ALTER TABLE orax_pending_approvals ALTER COLUMN thread_id DROP NOT NULL`,
        );
        // Phase 2F columns
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS user_id text`,
        );
        await client.query(`ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS cwd text`);
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS reason text`,
        );
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low'`,
        );
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS orax_pending_approvals_user_id_idx
             ON orax_pending_approvals(user_id)`,
        );
      }
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-projects (Phase 2G: cloud workspace tables) ────────────────
  {
    name: "migrate-orax-projects",
    async run(client) {
      await client.query("BEGIN");

      // Rename old orax_projects (host-local folder concept) to orax_desktop_local_folders
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
        END $$
      `);

      // Ensure orax_desktop_local_folders exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_local_folders (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          host_id                  TEXT NOT NULL,
          user_id                  TEXT NOT NULL,
          local_path               TEXT NOT NULL,
          display_name             TEXT NOT NULL,
          git_remote_url           TEXT,
          current_branch           TEXT,
          last_opened_at           TIMESTAMPTZ,
          permission_mode_override TEXT,
          setup_scripts            JSONB,
          status                   TEXT NOT NULL DEFAULT 'active',
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
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

      // New cloud workspace: orax_projects
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_projects (
          id                          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id                     TEXT NOT NULL,
          name                        TEXT NOT NULL,
          description                 TEXT,
          icon                        TEXT,
          color                       TEXT,
          status                      TEXT NOT NULL DEFAULT 'active',
          default_execution_source_id TEXT,
          memory                      JSONB NOT NULL DEFAULT '{}',
          settings                    JSONB NOT NULL DEFAULT '{}',
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx ON orax_projects(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_projects_status_idx ON orax_projects(user_id, status)
      `);

      // Execution sources table
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

      // Add Phase 2G columns to existing tables
      await client.query(
        `ALTER TABLE orax_threads ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_threads ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat_only'`,
      );
      await client.query(
        `ALTER TABLE orax_audit_log ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_usage_events ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );

      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-desktop-auth (browser-approved desktop sign-in) ──────────
  {
    name: "migrate-orax-desktop-auth",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_auth_challenges (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id                  TEXT,
          status                   TEXT NOT NULL DEFAULT 'pending',
          user_code                TEXT NOT NULL,
          poll_token_hash          TEXT NOT NULL,
          session_id               TEXT,
          session_token_ciphertext TEXT,
          install_id               TEXT,
          device_name              TEXT,
          platform                 TEXT,
          app_version              TEXT,
          expires_at               TIMESTAMPTZ NOT NULL,
          approved_at              TIMESTAMPTZ,
          redeemed_at              TIMESTAMPTZ,
          denied_at                TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_code_uidx
          ON orax_desktop_auth_challenges(user_code)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_id_idx
          ON orax_desktop_auth_challenges(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_status_idx
          ON orax_desktop_auth_challenges(status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_expires_at_idx
          ON orax_desktop_auth_challenges(expires_at)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_sessions (
          id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id      TEXT NOT NULL,
          token_hash   TEXT NOT NULL UNIQUE,
          challenge_id TEXT,
          install_id   TEXT,
          device_name  TEXT,
          platform     TEXT,
          app_version  TEXT,
          metadata     JSONB NOT NULL DEFAULT '{}',
          expires_at   TIMESTAMPTZ NOT NULL,
          last_used_at TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_user_id_idx
          ON orax_desktop_sessions(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_token_hash_idx
          ON orax_desktop_sessions(token_hash)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_expires_at_idx
          ON orax_desktop_sessions(expires_at)
      `);
      await client.query("COMMIT");
    },
  },
  {
    name: "ora-history-v2",
    run: async (client) => {
      await client.query("BEGIN");

      // Pinned conversations
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`,
      );

      // Title source: 'client' (first-msg truncation) | 'ai' (smart title) | 'user' (renamed)
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'client'`,
      );

      // History metadata badges — stored columns for fast list queries (no jsonb scan on every list)
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_images BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_generated_files BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_sources BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_voice BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_last_activity_type TEXT`,
      );

      // Partial index to speed up pinned-first sorting
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_pinned_idx ON ora_conversations(user_id, pinned_at) WHERE pinned_at IS NOT NULL`,
      );

      // Full-text search index on title for fast ?q= queries
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_title_gin_idx ON ora_conversations USING gin(to_tsvector('english', coalesce(title,'')))`,
      );

      // Per-user Ora settings (last-active conversation ID, etc.)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_user_settings (
          user_id    TEXT PRIMARY KEY,
          settings   JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-asset-versions (file revision lineage, Ora Phase 2) ────────
  {
    name: "migrate-ora-asset-versions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS root_asset_id INTEGER`);
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS parent_asset_id INTEGER`);
      await client.query(
        `ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1`,
      );
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS source_file_ref TEXT`);
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS edit_summary TEXT`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_root_asset_id_idx ON ora_assets(root_asset_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-project-spaces (Ora Phase 6: project-scoped assets/uploads) ─
  // Null ora_project_id = the user's default "Personal" space (standalone).
  // No FK by design, matching ora_conversations.project_id.
  {
    name: "migrate-ora-project-spaces",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_user_project_idx ON ora_assets(user_id, ora_project_id)`,
      );
      await client.query(
        `ALTER TABLE ora_file_contexts ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_file_contexts_user_project_idx ON ora_file_contexts(user_id, ora_project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-brand-kits ───────────────────────────────────────────────────────
  // Mirrors scripts/src/migrate-brand-kits.ts. Keep both in sync on schema change.
  {
    name: "migrate-brand-kits",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
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
      // Self-healing: if brand_kits_user_personal_idx exists but lacks the correct
      // partial WHERE clause (ora_project_id IS NULL), drop it so the CREATE below
      // can replace it with the right unique partial index.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename  = 'brand_kits'
              AND indexname  = 'brand_kits_user_personal_idx'
              AND indexdef   NOT ILIKE '%where%ora_project_id is null%'
          ) THEN
            DROP INDEX IF EXISTS brand_kits_user_personal_idx;
          END IF;
        END
        $$
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_personal_idx
          ON brand_kits(user_id)
          WHERE ora_project_id IS NULL
      `);
      // Self-healing: if brand_kits_user_project_idx exists but lacks the correct
      // partial WHERE clause (ora_project_id IS NOT NULL), drop it so the CREATE
      // below can replace it with the right unique partial index.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename  = 'brand_kits'
              AND indexname  = 'brand_kits_user_project_idx'
              AND indexdef   NOT ILIKE '%where%ora_project_id is not null%'
          ) THEN
            DROP INDEX IF EXISTS brand_kits_user_project_idx;
          END IF;
        END
        $$
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_project_idx
          ON brand_kits(user_id, ora_project_id)
          WHERE ora_project_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS brand_kits_user_id_idx
          ON brand_kits(user_id)
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-github ───────────────────────────────────────────────────────
  // Mirrors scripts/src/migrate-ora-github.ts. Keep both in sync on schema change.
  // Read-only GitHub repo analysis: encrypted OAuth token + selected-repo sessions.
  {
    name: "migrate-ora-github",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_github_connections (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          encrypted_token TEXT NOT NULL,
          github_login    TEXT NOT NULL,
          scopes          TEXT NOT NULL DEFAULT '',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ora_github_connections_user_uidx
          ON ora_github_connections(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_github_connections_user_id_idx
          ON ora_github_connections(user_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_repo_sessions (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          conversation_id TEXT,
          owner           TEXT NOT NULL,
          repo            TEXT NOT NULL,
          ref             TEXT NOT NULL DEFAULT '',
          default_branch  TEXT NOT NULL DEFAULT 'main',
          status          TEXT NOT NULL DEFAULT 'active',
          file_count      INTEGER,
          total_bytes     INTEGER,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_id_idx
          ON ora_repo_sessions(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_status_idx
          ON ora_repo_sessions(user_id, status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_conversation_idx
          ON ora_repo_sessions(conversation_id)
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-builder-task-completion-kind (Builder Wave 7B) ───────────────
  {
    name: "migrate-builder-task-completion-kind",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS completion_kind TEXT`);
      await client.query("COMMIT");
    },
  },
  {
    name: "migrate-builder-task-deep-reasoning",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS deep_reasoning BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-nabuflow-billing (Task #1516) ─────────────────────────────────
  // NabuFlow Builder billing core: plan subscriptions, spend-cap settings,
  // per-cycle buckets/counters, and the per-build usage ledger. Fully separate
  // from Ora's user_subscriptions — nothing here touches Ora plan state.
  {
    name: "migrate-nabuflow-billing",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          plan_id TEXT NOT NULL,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          stripe_item_id TEXT,
          status TEXT NOT NULL DEFAULT 'incomplete',
          cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
          current_cycle_start TIMESTAMPTZ,
          current_cycle_end TIMESTAMPTZ,
          rollover_credits INTEGER NOT NULL DEFAULT 0,
          default_payment_method_id TEXT,
          card_brand TEXT,
          card_last4 TEXT,
          card_exp_month INTEGER,
          card_exp_year INTEGER,
          dunning_status TEXT NOT NULL DEFAULT 'none',
          dunning_started_at TIMESTAMPTZ,
          dunning_grace_until TIMESTAMPTZ,
          dunning_paused_at TIMESTAMPTZ,
          dunning_attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_subscriptions_stripe_sub_idx
           ON nabuflow_subscriptions (stripe_subscription_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_subscriptions_stripe_customer_idx
           ON nabuflow_subscriptions (stripe_customer_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_billing_settings (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          spend_cap_usd_cents INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_billing_cycles (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          cycle_start TIMESTAMPTZ NOT NULL,
          cycle_end TIMESTAMPTZ NOT NULL,
          included_credits INTEGER NOT NULL DEFAULT 0,
          rollover_credits INTEGER NOT NULL DEFAULT 0,
          used_included_credits INTEGER NOT NULL DEFAULT 0,
          overage_credits INTEGER NOT NULL DEFAULT 0,
          overage_usd_cents INTEGER NOT NULL DEFAULT 0,
          pro_builds_used INTEGER NOT NULL DEFAULT 0,
          deep_builds_used INTEGER NOT NULL DEFAULT 0,
          bucket_notify_level INTEGER NOT NULL DEFAULT 0,
          cap_notify_level INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_cycles_user_cycle_unique UNIQUE (user_id, cycle_start)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_cycles_user_idx
           ON nabuflow_billing_cycles (user_id, cycle_start)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_usage_events (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          cycle_id INTEGER NOT NULL,
          cycle_start TIMESTAMPTZ NOT NULL,
          project_id INTEGER,
          task_id INTEGER,
          source TEXT NOT NULL DEFAULT 'pipeline',
          engine_mode TEXT,
          deep_reasoning BOOLEAN NOT NULL DEFAULT FALSE,
          credits INTEGER NOT NULL,
          included_credits INTEGER NOT NULL DEFAULT 0,
          overage_credits INTEGER NOT NULL DEFAULT 0,
          overage_usd_cents INTEGER NOT NULL DEFAULT 0,
          usd_value_cents INTEGER NOT NULL DEFAULT 0,
          attribution TEXT NOT NULL DEFAULT 'included',
          description TEXT,
          stripe_invoice_item_id TEXT,
          stripe_reported_at TIMESTAMPTZ,
          reversed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_user_idx
           ON nabuflow_usage_events (user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_cycle_idx
           ON nabuflow_usage_events (cycle_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-nabuflow-orgs (Task #1518) ────────────────────────────────────
  // Constellation enterprise lane: company billing records, seat membership,
  // shared credit-pool ledger, bulk purchases and monthly draw counters for
  // the org-wide cap + per-seat sub-caps. Usage events grow a nullable org
  // linkage (pool draws have no personal cycle). Ora/Orax untouched.
  {
    name: "migrate-nabuflow-orgs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_orgs (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
          company_name TEXT NOT NULL,
          billing_contact_name TEXT,
          billing_contact_email TEXT NOT NULL,
          tax_id TEXT,
          address_line1 TEXT NOT NULL,
          address_line2 TEXT,
          city TEXT NOT NULL,
          region TEXT,
          postal_code TEXT NOT NULL,
          country TEXT NOT NULL,
          po_reference TEXT,
          invoice_terms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          terms_net_days INTEGER NOT NULL DEFAULT 30,
          stripe_customer_id TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          pool_credits INTEGER NOT NULL DEFAULT 0,
          monthly_spend_cap_usd_cents INTEGER,
          created_by_user_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_orgs_created_by_idx
           ON nabuflow_orgs (created_by_user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_seats (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'member',
          seat_spend_cap_usd_cents INTEGER,
          email TEXT,
          added_by_user_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_seats_org_idx
           ON nabuflow_org_seats (org_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_purchases (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          credits INTEGER NOT NULL,
          amount_usd_cents INTEGER NOT NULL,
          method TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          stripe_invoice_id TEXT UNIQUE,
          hosted_invoice_url TEXT,
          invoice_pdf_url TEXT,
          po_reference TEXT,
          requested_by_user_id TEXT NOT NULL,
          due_at TIMESTAMPTZ,
          paid_at TIMESTAMPTZ,
          credited_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_purchases_org_idx
           ON nabuflow_org_purchases (org_id, created_at)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_ledger (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          entry_type TEXT NOT NULL,
          credits INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          usd_cents INTEGER NOT NULL DEFAULT 0,
          user_id TEXT,
          usage_event_id INTEGER,
          purchase_id INTEGER,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_ledger_org_idx
           ON nabuflow_org_ledger (org_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_ledger_user_idx
           ON nabuflow_org_ledger (user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_months (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          month_start TIMESTAMPTZ NOT NULL,
          credits_drawn INTEGER NOT NULL DEFAULT 0,
          drawn_usd_cents INTEGER NOT NULL DEFAULT 0,
          cap_notify_level INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_org_months_unique UNIQUE (org_id, month_start)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_seat_months (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          month_start TIMESTAMPTZ NOT NULL,
          credits_drawn INTEGER NOT NULL DEFAULT 0,
          drawn_usd_cents INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_org_seat_months_unique UNIQUE (org_id, user_id, month_start)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_seat_months_user_idx
           ON nabuflow_org_seat_months (user_id, month_start)`,
      );
      // Usage events: pool draws carry an org id and no personal cycle.
      await client.query(
        `ALTER TABLE nabuflow_usage_events ADD COLUMN IF NOT EXISTS org_id INTEGER`,
      );
      await client.query(
        `ALTER TABLE nabuflow_usage_events ALTER COLUMN cycle_id DROP NOT NULL`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_org_idx
           ON nabuflow_usage_events (org_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },
];

/**
 * Run all outstanding schema migrations at server startup.
 *
 * Each migration is isolated: a failure in one step is logged and skipped so
 * the remaining steps still run. The shared pool is never closed.
 *
 * @returns Summary of how many migrations passed and failed.
 */
export async function runStartupMigrations(): Promise<{
  passed: number;
  failed: number;
  errors: { name: string; message: string }[];
}> {
  logger.info(
    { count: MIGRATION_STEPS.length },
    "startup-migrations: running all outstanding schema migrations",
  );

  let passed = 0;
  let failed = 0;
  const errors: { name: string; message: string }[] = [];

  for (const step of MIGRATION_STEPS) {
    const client = await pool.connect();
    try {
      await step.run(client);
      passed++;
      logger.debug({ migration: step.name }, "startup-migrations: step passed");
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ name: step.name, message });
      logger.warn(
        { migration: step.name, err },
        "startup-migrations: step failed (non-fatal, continuing)",
      );
      // Attempt rollback for open transactions
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
    } finally {
      client.release();
    }
  }

  if (failed === 0) {
    logger.info({ passed }, "startup-migrations: all migrations completed successfully");
  } else {
    logger.warn(
      { passed, failed },
      "startup-migrations: some migrations failed — schema may be partially applied",
    );
  }

  return { passed, failed, errors };
}
