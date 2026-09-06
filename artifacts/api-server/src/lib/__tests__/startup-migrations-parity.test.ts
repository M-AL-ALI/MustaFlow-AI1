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
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveDisposableStartupMigrationDatabase } from "./startup-migrations-parity-guard";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");

const guardedDatabase = vi.hoisted(() => ({ pool: null as import("pg").Pool | null }));
vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    get pool() {
      if (!guardedDatabase.pool) throw new Error("startup_migrations_parity_pool_not_initialized");
      return guardedDatabase.pool;
    },
  };
});

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
      asset_id: null,
      image_product_scope: null,
      asset_product_scope: null,
    });
    const { rows: ambiguousAssets } = await pool.query<{ product_scope: string | null }>(
      "SELECT product_scope FROM assets WHERE id=$1",
      [nullSafeAssetId],
    );
    expect(ambiguousAssets).toEqual([{ product_scope: null }]);
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
          to_regprocedure('public.require_live_owned_ora_asset_reference()'),
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
    expect(functionDefinition("require_live_owned_ora_asset_reference")).toContain(
      "FROM public.ora_assets ora",
    );
    expect(functionDefinition("require_live_owned_ora_asset_reference")).toContain("FOR SHARE");
    expect(functionDefinition("require_live_owned_ora_asset_reference")).toContain(
      "ora_asset_reference_unavailable",
    );
    expect(functionDefinition("require_live_owned_ora_asset_reference")).toContain(
      "SET search_path TO 'pg_catalog', 'public'",
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

    const { rows: oraReferenceTriggerRows } = await pool.query<{
      table_name: string;
      definition: string;
      argument_count: number;
      argument_bytes: string;
    }>(`
      SELECT relation.relname AS table_name,
             pg_get_triggerdef(trigger.oid) AS definition,
             trigger.tgnargs::integer AS argument_count,
             encode(trigger.tgargs, 'escape') AS argument_bytes
        FROM pg_trigger trigger
        JOIN pg_class relation ON relation.oid = trigger.tgrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND trigger.tgname IN (
           'ora_asset_reference_guard_ora_file_contexts',
           'ora_asset_reference_guard_brand_kits'
         )
         AND NOT trigger.tgisinternal
       ORDER BY relation.relname
    `);
    expect(oraReferenceTriggerRows).toHaveLength(2);
    expect(oraReferenceTriggerRows).toEqual([
      expect.objectContaining({
        argument_bytes: "logo_asset_id\\000",
        argument_count: 1,
        table_name: "brand_kits",
        definition: expect.stringContaining("UPDATE OF user_id, logo_asset_id"),
      }),
      expect.objectContaining({
        argument_bytes: "asset_id\\000deleted_at\\000",
        argument_count: 2,
        table_name: "ora_file_contexts",
        definition: expect.stringContaining("UPDATE OF user_id, asset_id, deleted_at"),
      }),
    ]);

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

  it("reconciles historical pointers even when legacy triggers have malformed arguments", async () => {
    const { runStartupMigrations } = await import("../startup-migrations");
    const owner = `ora-reference-reconciliation-${randomUUID()}`;
    await pool.query(
      "ALTER TABLE ora_file_contexts DISABLE TRIGGER ora_asset_reference_guard_ora_file_contexts",
    );
    await pool.query("ALTER TABLE brand_kits DISABLE TRIGGER ora_asset_reference_guard_brand_kits");
    try {
      await pool.query(
        `INSERT INTO ora_file_contexts (
           user_id, file_ref, session_id, asset_id, filename, mime_type, file_type
         ) VALUES ($1,$2,$3,2147483647,'stale.txt','text/plain','txt')`,
        [owner, randomUUID(), randomUUID()],
      );
      await pool.query("INSERT INTO brand_kits (user_id, logo_asset_id) VALUES ($1,2147483647)", [
        owner,
      ]);
    } finally {
      await pool.query(
        "ALTER TABLE ora_file_contexts ENABLE TRIGGER ora_asset_reference_guard_ora_file_contexts",
      );
      await pool.query(
        "ALTER TABLE brand_kits ENABLE TRIGGER ora_asset_reference_guard_brand_kits",
      );
    }
    await pool.query(`
      DROP TRIGGER ora_asset_reference_guard_ora_file_contexts ON ora_file_contexts;
      CREATE TRIGGER ora_asset_reference_guard_ora_file_contexts
        BEFORE INSERT OR UPDATE OF user_id, asset_id, deleted_at
        ON ora_file_contexts
        FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('filename', 'deleted_at');
      DROP TRIGGER ora_asset_reference_guard_brand_kits ON brand_kits;
      CREATE TRIGGER ora_asset_reference_guard_brand_kits
        BEFORE INSERT OR UPDATE OF user_id, logo_asset_id
        ON brand_kits
        FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('user_id')
    `);

    try {
      const migration = await runStartupMigrations();
      expect(migration.errors).toEqual([]);
      expect(
        (await pool.query("SELECT asset_id FROM ora_file_contexts WHERE user_id=$1", [owner])).rows,
      ).toEqual([{ asset_id: null }]);
      expect(
        (await pool.query("SELECT logo_asset_id FROM brand_kits WHERE user_id=$1", [owner])).rows,
      ).toEqual([{ logo_asset_id: null }]);
      const { rows: repairedTriggers } = await pool.query<{
        trigger_name: string;
        argument_bytes: string;
      }>(`
        SELECT trigger_row.tgname AS trigger_name,
               encode(trigger_row.tgargs, 'escape') AS argument_bytes
          FROM pg_trigger trigger_row
         WHERE trigger_row.tgname IN (
           'ora_asset_reference_guard_ora_file_contexts',
           'ora_asset_reference_guard_brand_kits'
         )
         ORDER BY trigger_row.tgname
      `);
      expect(repairedTriggers).toEqual([
        {
          trigger_name: "ora_asset_reference_guard_brand_kits",
          argument_bytes: "logo_asset_id\\000",
        },
        {
          trigger_name: "ora_asset_reference_guard_ora_file_contexts",
          argument_bytes: "asset_id\\000deleted_at\\000",
        },
      ]);
    } finally {
      await pool.query("DELETE FROM brand_kits WHERE user_id=$1", [owner]);
      await pool.query("DELETE FROM ora_file_contexts WHERE user_id=$1", [owner]);
    }
  });

  it("serializes Ora reference writers with deletion in both lock orderings", async () => {
    const { runStartupMigrations } = await import("../startup-migrations");
    const migration = await runStartupMigrations();
    expect(migration.errors.find((error) => error.name === "migrate-brand-kits")).toBeUndefined();

    const waitForBlock = async (observer: PoolClient, blockedPid: number, blockerPid: number) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const blocked = await observer.query<{ blocked: boolean }>(
          "SELECT $2::integer = ANY(pg_blocking_pids($1::integer)) AS blocked",
          [blockedPid, blockerPid],
        );
        if (blocked.rows[0]?.blocked === true) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("ora_asset_reference_lock_barrier_timeout");
    };
    const insertReference = (
      client: PoolClient,
      table: "ora_file_contexts" | "brand_kits" | "support_tickets",
      userId: string,
      assetId: number,
    ) => {
      if (table === "ora_file_contexts") {
        return client.query(
          `INSERT INTO ora_file_contexts (
               user_id, file_ref, session_id, asset_id, filename, mime_type, file_type
             ) VALUES ($1,$2,$3,$4,'fixture.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document','docx')`,
          [userId, randomUUID(), randomUUID(), assetId],
        );
      }
      if (table === "brand_kits") {
        return client.query("INSERT INTO brand_kits (user_id, logo_asset_id) VALUES ($1,$2)", [
          userId,
          assetId,
        ]);
      }
      return client.query(
        `INSERT INTO support_tickets (user_id, subject, transcript, attachments)
         VALUES ($1,'Ora deletion serialization','[]'::jsonb,
                 jsonb_build_array(jsonb_build_object(
                   'url', '/api/ora/assets/' || $2::text || '/download'
                 )))`,
        [userId, assetId],
      );
    };
    const createOraAsset = async (
      userId: string,
    ): Promise<{ oraAssetId: number; unifiedAssetId: number }> => {
      const storageKey = `ora/${randomUUID()}/fixture.png`;
      const unified = await pool.query<{ id: number }>(
        `INSERT INTO assets (
           owner_user_id, actor_user_id, product_scope, scope, kind, source,
           filename, mime_type, size_bytes, storage_backend, storage_key,
           state, scan_state, created_at, ready_at
         ) VALUES ($1,$1,'ora','account','image','ora-library','fixture.png',
                   'image/png',1,'r2',$2,'ready','not-required',NOW(),NOW())
         RETURNING id`,
        [userId, storageKey],
      );
      const unifiedAssetId = unified.rows[0]!.id;
      await pool.query(
        `INSERT INTO asset_storage_objects (
           asset_id, storage_backend, storage_key, role, size_bytes, state, ready_at
         ) VALUES ($1,'r2',$2,'original',1,'ready',NOW())`,
        [unifiedAssetId, storageKey],
      );
      const inserted = await pool.query<{ id: number }>(
        `INSERT INTO ora_assets (
           user_id, kind, file_name, mime_type, data, storage_key, asset_id, size_bytes
         ) VALUES ($1,'image','fixture.png','image/png',NULL,$2,$3,1)
          RETURNING id`,
        [userId, storageKey, unifiedAssetId],
      );
      const oraAssetId = inserted.rows[0]!.id;
      await pool.query("INSERT INTO asset_usage (asset_id, consumer) VALUES ($1,$2)", [
        unifiedAssetId,
        `ora-library:${oraAssetId}`,
      ]);
      return { oraAssetId, unifiedAssetId };
    };
    const cleanupUser = async (userId: string) => {
      const { rows: linkedAssets } = await pool.query<{ asset_id: number }>(
        "SELECT asset_id FROM ora_assets WHERE user_id=$1 AND asset_id IS NOT NULL",
        [userId],
      );
      const unifiedAssetIds = linkedAssets.map((row) => row.asset_id);
      await pool.query("DELETE FROM support_tickets WHERE user_id=$1", [userId]);
      await pool.query("DELETE FROM brand_kits WHERE user_id=$1", [userId]);
      await pool.query("DELETE FROM ora_file_contexts WHERE user_id=$1", [userId]);
      if (unifiedAssetIds.length > 0) {
        await pool.query("DELETE FROM asset_usage WHERE asset_id=ANY($1::integer[])", [
          unifiedAssetIds,
        ]);
      }
      await pool.query("DELETE FROM ora_assets WHERE user_id=$1", [userId]);
      if (unifiedAssetIds.length > 0) {
        await pool.query("DELETE FROM asset_storage_objects WHERE asset_id=ANY($1::integer[])", [
          unifiedAssetIds,
        ]);
        await pool.query("DELETE FROM assets WHERE id=ANY($1::integer[])", [unifiedAssetIds]);
      }
    };

    for (const table of ["ora_file_contexts", "brand_kits", "support_tickets"] as const) {
      const userId = `ora-reference-writer-first-${table}-${randomUUID()}`;
      const assetId = (await createOraAsset(userId)).oraAssetId;
      const writer = await pool.connect();
      const deleter = await pool.connect();
      const observer = await pool.connect();
      let deleteLock: Promise<unknown> | undefined;
      try {
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        const deleterPid = (await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await insertReference(writer, table, userId, assetId);
        await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        deleteLock = deleter.query(
          "SELECT id FROM ora_assets WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [assetId, userId],
        );
        await waitForBlock(observer, deleterPid, writerPid);
        await writer.query("COMMIT");
        await deleteLock;
        const reference = await deleter.query<{ referenced: boolean }>(
          table === "ora_file_contexts"
            ? "SELECT EXISTS (SELECT 1 FROM ora_file_contexts WHERE asset_id=$1 AND deleted_at IS NULL) AS referenced"
            : table === "brand_kits"
              ? "SELECT EXISTS (SELECT 1 FROM brand_kits WHERE logo_asset_id=$1) AS referenced"
              : "SELECT EXISTS (SELECT 1 FROM support_tickets WHERE user_id=$2 AND attachments::text LIKE '%/api/ora/assets/' || $1::text || '/download%') AS referenced",
          table === "support_tickets" ? [assetId, userId] : [assetId],
        );
        expect(reference.rows).toEqual([{ referenced: true }]);
        await deleter.query("ROLLBACK");
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        await deleter.query("ROLLBACK").catch(() => undefined);
        await deleteLock?.catch(() => undefined);
        observer.release();
        deleter.release();
        writer.release();
        await cleanupUser(userId);
      }

      const deleteFirstUserId = `ora-reference-delete-first-${table}-${randomUUID()}`;
      const deleteFirstAssetId = (await createOraAsset(deleteFirstUserId)).oraAssetId;
      const deleteFirst = await pool.connect();
      const lateWriter = await pool.connect();
      const deleteObserver = await pool.connect();
      let blockedWrite: Promise<unknown> | undefined;
      try {
        const deletePid = (
          await deleteFirst.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        const writerPid = (
          await lateWriter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
        ).rows[0]!.pid;
        await deleteFirst.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        await deleteFirst.query(
          "SELECT id FROM ora_assets WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE",
          [deleteFirstAssetId, deleteFirstUserId],
        );
        await deleteFirst.query("UPDATE ora_assets SET deleted_at=NOW() WHERE id=$1", [
          deleteFirstAssetId,
        ]);
        await lateWriter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        blockedWrite = insertReference(lateWriter, table, deleteFirstUserId, deleteFirstAssetId);
        await waitForBlock(deleteObserver, writerPid, deletePid);
        await deleteFirst.query("COMMIT");
        await expect(blockedWrite).rejects.toMatchObject({
          code: "55000",
          message:
            table === "support_tickets"
              ? "asset_reference_unavailable"
              : "ora_asset_reference_unavailable",
        });
        await lateWriter.query("ROLLBACK");
      } finally {
        await deleteFirst.query("ROLLBACK").catch(() => undefined);
        await lateWriter.query("ROLLBACK").catch(() => undefined);
        await blockedWrite?.catch(() => undefined);
        deleteObserver.release();
        lateWriter.release();
        deleteFirst.release();
        await cleanupUser(deleteFirstUserId);
      }
    }
  });

  it("preserves null, inactive, and live legacy references while rejecting unsafe ownership", async () => {
    const { runStartupMigrations } = await import("../startup-migrations");
    const migration = await runStartupMigrations();
    expect(migration.errors.find((error) => error.name === "migrate-brand-kits")).toBeUndefined();
    const owner = `ora-reference-compat-owner-${randomUUID()}`;
    const foreign = `ora-reference-compat-foreign-${randomUUID()}`;
    const asset = await pool.query<{ id: number }>(
      `INSERT INTO ora_assets (
         user_id, kind, file_name, mime_type, data, storage_key, size_bytes
       ) VALUES ($1,'file','legacy.bin','application/octet-stream','eA==',NULL,1)
       RETURNING id`,
      [owner],
    );
    const assetId = asset.rows[0]!.id;
    try {
      await expect(
        pool.query(
          `INSERT INTO ora_file_contexts (
             user_id, file_ref, session_id, asset_id, filename, mime_type, file_type
           ) VALUES ($1,$2,$3,NULL,'null.txt','text/plain','txt')`,
          [owner, randomUUID(), randomUUID()],
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query("INSERT INTO brand_kits (user_id, logo_asset_id) VALUES ($1,NULL)", [owner]),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO ora_file_contexts (
             user_id, file_ref, session_id, asset_id, filename, mime_type, file_type, deleted_at
           ) VALUES ($1,$2,$3,2147483647,'inactive.txt','text/plain','txt',NOW())`,
          [foreign, randomUUID(), randomUUID()],
        ),
      ).resolves.toBeDefined();
      await expect(
        pool.query(
          `INSERT INTO ora_file_contexts (
             user_id, file_ref, session_id, asset_id, filename, mime_type, file_type
           ) VALUES ($1,$2,$3,$4,'foreign.txt','text/plain','txt')`,
          [foreign, randomUUID(), randomUUID(), assetId],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "ora_asset_reference_unavailable" });
      await expect(
        pool.query("INSERT INTO brand_kits (user_id, logo_asset_id) VALUES ($1,$2)", [
          foreign,
          assetId,
        ]),
      ).rejects.toMatchObject({ code: "55000", message: "ora_asset_reference_unavailable" });
      await expect(
        pool.query(
          "UPDATE ora_file_contexts SET deleted_at=NULL WHERE user_id=$1 AND asset_id=2147483647",
          [foreign],
        ),
      ).rejects.toMatchObject({ code: "55000", message: "ora_asset_reference_unavailable" });
    } finally {
      await pool.query("DELETE FROM brand_kits WHERE user_id IN ($1,$2)", [owner, foreign]);
      await pool.query("DELETE FROM ora_file_contexts WHERE user_id IN ($1,$2)", [owner, foreign]);
      await pool.query("DELETE FROM ora_assets WHERE id=$1", [assetId]);
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
