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
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDisposableStartupMigrationDatabase } from "./startup-migrations-parity-guard";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");

const guardedDatabase = vi.hoisted(() => ({ pool: null as import("pg").Pool | null }));
vi.mock("@workspace/db", () => ({
  get pool() {
    if (!guardedDatabase.pool) throw new Error("startup_migrations_parity_pool_not_initialized");
    return guardedDatabase.pool;
  },
}));

const disposableDatabase = resolveDisposableStartupMigrationDatabase(process.env);
const describeIfDb = disposableDatabase ? describe : describe.skip;

describeIfDb("runStartupMigrations creates tables added since the last release", () => {
  let pool: Pool;
  const fixtureUserId = `startup-migrations-parity-${randomUUID()}`;
  const nullSafeStorageKey = `generated-images/${randomUUID()}/null-safe/full.webp`;
  const verifiedScopeStorageKey = `generated-images/${randomUUID()}/verified/full.webp`;
  const insertedScopeStorageKey = `generated-images/${randomUUID()}/inserted/full.webp`;
  const rawUploadStorageKey = `/objects/uploads/${randomUUID()}`;
  let nullSafeAssetId: number;
  let nullSafeImageId: number;
  let verifiedScopeAssetId: number;
  let verifiedScopeImageId: number;
  let insertedScopeImageId: number;
  let rawUploadAssetId: number;

  beforeAll(async () => {
    if (!disposableDatabase)
      throw new Error("startup_migrations_parity_disposable_database_required");
    // Do not let a cached migration module retain an ambient application pool.
    vi.resetModules();
    pool = new Pool({ connectionString: disposableDatabase.connectionString });
    guardedDatabase.pool = pool;
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
      "ALTER TABLE projects DROP COLUMN IF EXISTS last_task_summary_provenance, DROP COLUMN IF EXISTS summary_provenance, DROP COLUMN IF EXISTS preview_db_allocation",
    );
    await pool.query("ALTER TABLE project_versions DROP COLUMN IF EXISTS plan_source_message_id");
    await pool.query(
      "ALTER TABLE IF EXISTS asset_storage_objects DROP COLUMN IF EXISTS provider_generation, DROP COLUMN IF EXISTS provider_checksum",
    );

    const insertAsset = async (input: {
      source: string;
      storageBackend: string;
      storageKey: string;
      productScope: "nabuflow" | null;
    }): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO assets (
           owner_user_id, actor_user_id, product_scope, scope, kind, source,
           filename, mime_type, size_bytes, storage_backend, storage_key,
           state, scan_state, created_at, ready_at
         ) VALUES ($1, $1, $2, 'account', 'generated', $3,
                   'parity.webp', 'image/webp', 1, $4, $5,
                   'ready', 'not-scanned', NOW(), NOW())
         RETURNING id`,
        [fixtureUserId, input.productScope, input.source, input.storageBackend, input.storageKey],
      );
      return rows[0].id;
    };

    const insertGeneratedImage = async (input: {
      storageKey: string;
      productScope: "nabuflow" | null;
    }): Promise<number> => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO generated_images (
           user_id, product_scope, prompt, status, storage_key, source_type,
           created_at, updated_at
         ) VALUES ($1, $2, 'startup migration parity', 'completed', $3,
                   'generated', NOW(), NOW())
         RETURNING id`,
        [fixtureUserId, input.productScope, input.storageKey],
      );
      return rows[0].id;
    };

    nullSafeAssetId = await insertAsset({
      source: "generated",
      storageBackend: "r2",
      storageKey: nullSafeStorageKey,
      productScope: null,
    });
    nullSafeImageId = await insertGeneratedImage({
      storageKey: nullSafeStorageKey,
      productScope: null,
    });
    verifiedScopeAssetId = await insertAsset({
      source: "generated",
      storageBackend: "r2",
      storageKey: verifiedScopeStorageKey,
      productScope: null,
    });
    verifiedScopeImageId = await insertGeneratedImage({
      storageKey: verifiedScopeStorageKey,
      productScope: "nabuflow",
    });
    insertedScopeImageId = await insertGeneratedImage({
      storageKey: insertedScopeStorageKey,
      productScope: "nabuflow",
    });
    rawUploadAssetId = await insertAsset({
      source: "legacy-project-upload",
      storageBackend: "legacy-object",
      storageKey: rawUploadStorageKey,
      productScope: "nabuflow",
    });
  });

  afterAll(async () => {
    const database = guardedDatabase.pool;
    guardedDatabase.pool = null;
    await database?.end();
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
        "migrate-preview-database-allocation-receipt",
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
      asset_storage_objects: ["provider_generation", "provider_checksum"],
      knowledge_entries: ["source_message_start_id", "source_message_end_id"],
      projects: ["last_task_summary_provenance", "summary_provenance", "preview_db_allocation"],
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

    const { rows: generatedRows } = await pool.query<{
      id: number;
      asset_id: number | null;
      image_product_scope: string | null;
      asset_product_scope: string | null;
    }>(
      `SELECT image.id,
              image.asset_id,
              image.product_scope AS image_product_scope,
              asset.product_scope AS asset_product_scope
         FROM generated_images image
         LEFT JOIN assets asset ON asset.id = image.asset_id
        WHERE image.id = ANY($1::integer[])
        ORDER BY image.id`,
      [[nullSafeImageId, verifiedScopeImageId, insertedScopeImageId]],
    );
    const nullSafeRow = generatedRows.find((row) => row.id === nullSafeImageId);
    expect(nullSafeRow).toMatchObject({
      asset_id: nullSafeAssetId,
      image_product_scope: null,
      asset_product_scope: null,
    });
    const verifiedScopeRow = generatedRows.find((row) => row.id === verifiedScopeImageId);
    expect(verifiedScopeRow).toMatchObject({
      asset_id: verifiedScopeAssetId,
      image_product_scope: "nabuflow",
      asset_product_scope: "nabuflow",
    });
    const insertedScopeRow = generatedRows.find((row) => row.id === insertedScopeImageId);
    expect(insertedScopeRow?.asset_id).not.toBeNull();
    expect(insertedScopeRow?.image_product_scope).toBe("nabuflow");
    expect(insertedScopeRow?.asset_product_scope).toBe("nabuflow");

    const { rows: rawResolverRows } = await pool.query<{ resolves: boolean }>(
      `SELECT $1::integer IN (
         SELECT public.resolve_durable_asset_ids(
           jsonb_build_object('url', $2::text)
         )
       ) AS resolves`,
      [rawUploadAssetId, rawUploadStorageKey],
    );
    expect(rawResolverRows[0].resolves).toBe(true);

    const { rows: functionRows } = await pool.query<{ name: string; definition: string }>(`
      SELECT procedure.oid::regprocedure::text AS name,
             pg_get_functiondef(procedure.oid) AS definition
        FROM pg_proc procedure
       WHERE procedure.oid IN (
         to_regprocedure('public.asset_has_verified_nabuflow_provenance(integer)'),
         to_regprocedure('public.generated_image_has_verified_nabuflow_provenance(integer)'),
         to_regprocedure('public.resolve_durable_asset_ids(jsonb)'),
         to_regprocedure(
           'public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)'
         )
       )
    `);
    const functionDefinition = (name: string) =>
      functionRows.find((row) => row.name.startsWith(`${name}(`))?.definition ?? "";
    expect(functionDefinition("asset_has_verified_nabuflow_provenance")).toContain(
      "legacy-project-upload",
    );
    expect(functionDefinition("asset_has_verified_nabuflow_provenance")).toContain(
      "conflicting_project.owner_id IS DISTINCT FROM candidate.owner_user_id",
    );
    expect(functionDefinition("generated_image_has_verified_nabuflow_provenance")).not.toContain(
      "image.project_id IS NOT NULL",
    );
    expect(functionDefinition("generated_image_has_verified_nabuflow_provenance")).toContain(
      "asset.product_scope = 'nabuflow'",
    );
    expect(functionDefinition("resolve_durable_asset_ids")).toContain("/objects/uploads/");
    expect(functionDefinition("resolve_durable_asset_ids")).toContain("/api/ora/assets/");
    expect(functionDefinition("durable_asset_reference_exists_excluding_upload")).toContain(
      "FROM public.support_tickets ticket",
    );

    const { rows: supportTriggerRows } = await pool.query<{ definition: string }>(`
      SELECT pg_get_triggerdef(trigger.oid) AS definition
        FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND relation.relname = 'support_tickets'
         AND trigger.tgname = 'durable_asset_reference_guard_support_tickets'
         AND NOT trigger.tgisinternal
    `);
    expect(supportTriggerRows).toHaveLength(1);
    expect(supportTriggerRows[0].definition).toContain("user_id");
    expect(supportTriggerRows[0].definition).toContain("project_id");
    expect(supportTriggerRows[0].definition).toContain("transcript");
    expect(supportTriggerRows[0].definition).toContain("attachments");
    expect(supportTriggerRows[0].definition).toContain(
      "require_attachable_assets_in_durable_reference()",
    );

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
        "migrate-preview-database-allocation-receipt",
      ].includes(e.name),
    );
    expect(ourFailures).toEqual([]);
  });
});
