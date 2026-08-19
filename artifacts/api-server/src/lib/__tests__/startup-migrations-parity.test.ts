/**
 * Startup-migrations parity — production readiness for tables that MUST
 * exist without a manual migration run.
 *
 * Regression for: ora_github_connections / ora_repo_sessions (and brand_kits,
 * same class of gap) were only in scripts/src/migrate-*.ts, not in
 * runStartupMigrations(), so a production DB that never had the manual
 * migration run would 500 on first request after publish.
 *
 * This test is deliberately FUNCTIONAL, not textual: it drops the tables
 * against a real Postgres, runs the actual boot-time migration runner, and
 * asserts the tables/indexes exist afterward — proving the SQL really works,
 * not just that two files mention the same keywords.
 */
import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");

const hasDb = Boolean(process.env.DATABASE_URL);
const describeIfDb = hasDb ? describe : describe.skip;

describeIfDb("runStartupMigrations creates tables added since the last release", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
    // Simulate a production DB that never had the manual migration scripts
    // run — only automatic boot-time migrations are allowed to fix this.
    await pool.query(
      "DROP TABLE IF EXISTS ora_github_connections, ora_repo_sessions, brand_kits CASCADE",
    );
    await pool.query("DROP TABLE IF EXISTS knowledge_provenance_events CASCADE");
    await pool.query(
      "ALTER TABLE knowledge_entries DROP COLUMN IF EXISTS source_message_start_id, DROP COLUMN IF EXISTS source_message_end_id",
    );
    await pool.query(
      "ALTER TABLE projects DROP COLUMN IF EXISTS last_task_summary_provenance, DROP COLUMN IF EXISTS summary_provenance",
    );
    await pool.query("ALTER TABLE project_versions DROP COLUMN IF EXISTS plan_source_message_id");
  });

  it("creates ora_github_connections, ora_repo_sessions, and brand_kits with their indexes", async () => {
    const { runStartupMigrations } = await import("../startup-migrations");
    const result = await runStartupMigrations();

    const ourFailures = result.errors.filter((e) =>
      [
        "migrate-ora-github",
        "migrate-brand-kits",
        "migrate-knowledge-provenance",
        "migrate-project-summary-provenance",
        "migrate-plan-snapshot-provenance",
      ].includes(e.name),
    );
    expect(ourFailures).toEqual([]);

    for (const table of [
      "ora_github_connections",
      "ora_repo_sessions",
      "brand_kits",
      "brainstorm_admission_counters",
      "knowledge_usage_events",
      "knowledge_provenance_events",
    ]) {
      const { rows } = await pool.query("SELECT to_regclass($1) AS reg", [table]);
      expect(rows[0].reg, `table "${table}" should exist after boot migrations`).not.toBeNull();
    }

    for (const [table, columns] of Object.entries({
      knowledge_entries: ["source_message_start_id", "source_message_end_id"],
      projects: ["last_task_summary_provenance", "summary_provenance"],
      project_versions: ["plan_source_message_id"],
    })) {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = $1`,
        [table],
      );
      expect(
        columns.every((column) => rows.some((row) => row.column_name === column)),
        `provenance columns should exist on ${table}`,
      ).toBe(true);
    }

    for (const index of [
      "ora_github_connections_user_uidx",
      "ora_github_connections_user_id_idx",
      "ora_repo_sessions_user_id_idx",
      "ora_repo_sessions_user_status_idx",
      "ora_repo_sessions_conversation_idx",
      "brand_kits_user_personal_idx",
      "brand_kits_user_project_idx",
      "brand_kits_user_id_idx",
      "brainstorm_admission_counters_reset_idx",
    ]) {
      const { rows } = await pool.query("SELECT to_regclass($1) AS reg", [index]);
      expect(rows[0].reg, `index "${index}" should exist after boot migrations`).not.toBeNull();
    }
  });

  it("is idempotent — running it again on already-migrated tables does not fail", async () => {
    const { runStartupMigrations } = await import("../startup-migrations");
    const result = await runStartupMigrations();
    const ourFailures = result.errors.filter((e) =>
      [
        "migrate-ora-github",
        "migrate-brand-kits",
        "migrate-knowledge-provenance",
        "migrate-project-summary-provenance",
        "migrate-plan-snapshot-provenance",
      ].includes(e.name),
    );
    expect(ourFailures).toEqual([]);
  });
});
