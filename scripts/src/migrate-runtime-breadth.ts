/**
 * Migration: Runtime Breadth (Task #628 — Theme F)
 *
 * Creates tables for:
 *   - scheduled_job_runs   — per-run output for cron jobs
 *   - managed_addons       — per-project Redis/KV, Vector DB, Object Storage
 *   - project_environments — dev/staging/prod environment configs
 *   - environment_promotions — promotion audit log
 *   - usage_events         — metering events (container hours, storage, KV ops, etc.)
 *
 * Safe to re-run (uses IF NOT EXISTS). Run with:
 *   pnpm --filter @workspace/scripts run migrate-runtime-breadth
 */

import { pool } from "@workspace/db";

async function main() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── scheduled_job_runs ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS scheduled_job_runs (
        id               SERIAL PRIMARY KEY,
        schedule_id      INTEGER NOT NULL REFERENCES deployment_schedules(id) ON DELETE CASCADE,
        project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        status           TEXT    NOT NULL DEFAULT 'running',
        exit_code        INTEGER,
        output           TEXT,
        error_message    TEXT,
        duration_ms      INTEGER,
        triggered_by     TEXT    NOT NULL DEFAULT 'cron',
        started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at      TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scheduled_job_runs_schedule_idx ON scheduled_job_runs(schedule_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scheduled_job_runs_project_idx ON scheduled_job_runs(project_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS scheduled_job_runs_started_idx ON scheduled_job_runs(started_at);
    `);
    console.log("✓ scheduled_job_runs");

    // ── managed_addons ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS managed_addons (
        id                SERIAL PRIMARY KEY,
        project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind              TEXT    NOT NULL,
        status            TEXT    NOT NULL DEFAULT 'provisioning',
        external_id       TEXT,
        connection_info   JSONB,
        injected_env_keys JSONB   NOT NULL DEFAULT '[]',
        plan              TEXT    NOT NULL DEFAULT 'free',
        usage_bytes       INTEGER,
        usage_ops         INTEGER,
        last_metered_at   TIMESTAMPTZ,
        notes             TEXT,
        created_by        TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        removed_at        TIMESTAMPTZ,
        CONSTRAINT managed_addons_project_kind_unique UNIQUE (project_id, kind)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS managed_addons_project_idx ON managed_addons(project_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS managed_addons_kind_idx ON managed_addons(kind);
    `);
    console.log("✓ managed_addons");

    // ── project_environments ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_environments (
        id                    SERIAL PRIMARY KEY,
        project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name                  TEXT    NOT NULL,
        snapshot_version_id   INTEGER,
        status                TEXT    NOT NULL DEFAULT 'idle',
        url                   TEXT,
        auto_promote          BOOLEAN NOT NULL DEFAULT FALSE,
        protected             BOOLEAN NOT NULL DEFAULT FALSE,
        deployed_by           TEXT,
        deployed_at           TIMESTAMPTZ,
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_environments_project_name_unique UNIQUE (project_id, name)
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_environments_project_idx ON project_environments(project_id);
    `);
    console.log("✓ project_environments");

    // ── environment_promotions ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS environment_promotions (
        id                    SERIAL PRIMARY KEY,
        project_id            INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        from_environment      TEXT    NOT NULL,
        to_environment        TEXT    NOT NULL,
        snapshot_version_id   INTEGER,
        status                TEXT    NOT NULL DEFAULT 'pending',
        notes                 TEXT,
        triggered_by          TEXT,
        started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at          TIMESTAMPTZ
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS environment_promotions_project_idx ON environment_promotions(project_id);
    `);
    console.log("✓ environment_promotions");

    // ── usage_events ──────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id             SERIAL PRIMARY KEY,
        project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id        TEXT    NOT NULL,
        kind           TEXT    NOT NULL,
        quantity       NUMERIC(18,6) NOT NULL DEFAULT 1,
        resource_type  TEXT,
        resource_id    TEXT,
        unit           TEXT    NOT NULL DEFAULT 'units',
        recorded_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS usage_events_project_idx ON usage_events(project_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events(user_id);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events(kind);
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS usage_events_recorded_at_idx ON usage_events(recorded_at);
    `);
    console.log("✓ usage_events");

    await client.query("COMMIT");
    console.log("\nMigration complete — runtime breadth tables created.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
