import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { assessDeploymentRuntimeSchema } from "./deployment-runtime-schema";

function observation(overrides: Record<string, boolean> = {}) {
  return {
    canCreateSchemaObjects: false,
    canMutateExistingObjects: false,
    adminAuthorityReady: true,
    workspaceMembershipReady: true,
    supportDeliveryReady: true,
    supportDeliveryConstraintsReady: true,
    supportDeliveryIndexesReady: true,
    promptQueueReady: true,
    projectCollaborationReady: true,
    projectRetirementOperationsReady: true,
    projectRetirementOperationsColumnsReady: true,
    projectRetirementOperationsConstraintsReady: true,
    projectRetirementOperationsIndexesReady: true,
    projectPurgeOperationsReady: true,
    projectPurgeOperationsColumnsReady: true,
    projectPurgeOperationsConstraintsReady: true,
    projectPurgeOperationsIndexesReady: true,
    projectPurgeNotificationIndexReady: true,
    assetUsageAttachmentGuardReady: true,
    durableAssetReferenceGuardsReady: true,
    previewDatabaseAllocationReady: true,
    productionDatabaseAdmissionTablesReady: true,
    productionDatabaseAdmissionColumnsReady: true,
    productionDatabaseAdmissionConstraintsReady: true,
    productionDatabaseAdmissionIndexesReady: true,
    productionDatabaseAdmissionTriggersReady: true,
    ...overrides,
  };
}

describe("deployment runtime schema boundary", () => {
  it("accepts a complete read-only deployment schema without issuing DDL", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql.trimStart().startsWith("SELECT")).toBe(true);
      if (sql.includes('AS "oraAssetReferenceRowsReady"')) {
        return { rows: [{ oraAssetReferenceRowsReady: true }] };
      }
      return { rows: [observation()] };
    });

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-ready",
      violations: [],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed with allowlisted evidence when the deployed schema is incomplete", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          supportDeliveryConstraintsReady: false,
          promptQueueReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: ["support_delivery_constraints_missing", "prompt_queue_missing"],
    });
  });

  it("preserves the existing idempotent migration path for mutable database roles", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          canCreateSchemaObjects: true,
          canMutateExistingObjects: true,
          supportDeliveryReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "mutable",
      violations: [],
    });
  });

  it("treats a deployment role that can create but cannot alter existing objects as read-only", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('AS "oraAssetReferenceRowsReady"')
        ? { rows: [{ oraAssetReferenceRowsReady: true }] }
        : { rows: [observation({ canCreateSchemaObjects: true })] },
    );

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-ready",
      violations: [],
    });
  });

  it("rejects read-only readiness when historical Ora pointers are invalid", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes('AS "oraAssetReferenceRowsReady"')
        ? { rows: [{ oraAssetReferenceRowsReady: false }] }
        : { rows: [observation()] },
    );

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: ["durable_asset_reference_guards_missing"],
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the retirement table exists with an incomplete shape", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          projectRetirementOperationsColumnsReady: false,
          projectRetirementOperationsConstraintsReady: false,
          projectRetirementOperationsIndexesReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toMatchObject({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: [
        "project_retirement_operations_columns_missing",
        "project_retirement_operations_constraints_missing",
        "project_retirement_operations_indexes_missing",
      ],
    });
  });

  it("fails closed when the purge receipt or its milestone idempotency index is incomplete", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          projectPurgeOperationsColumnsReady: false,
          projectPurgeOperationsConstraintsReady: false,
          projectPurgeOperationsIndexesReady: false,
          projectPurgeNotificationIndexReady: false,
        }),
      ],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: [
        "project_purge_operations_columns_missing",
        "project_purge_operations_constraints_missing",
        "project_purge_operations_indexes_missing",
        "project_purge_notification_index_missing",
      ],
    });
  });

  it("requires the resumable purge resource progress column before declaring readiness", () => {
    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    const purgeColumns = source.slice(
      source.indexOf('AS "projectPurgeOperationsReady"'),
      source.indexOf('AS "projectPurgeOperationsColumnsReady"') +
        'AS "projectPurgeOperationsColumnsReady"'.length,
    );

    expect(purgeColumns).toContain("SELECT COUNT(*) = 21");
    expect(purgeColumns).toContain("('resource_progress', 'jsonb', 'NO')");
  });

  it("fails closed when the deletion-safe asset attachment trigger is stale or missing", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ assetUsageAttachmentGuardReady: false })],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: ["asset_usage_attachment_guard_missing"],
    });

    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    expect(source).toContain("update of asset_id, project_id");
    expect(source).toContain("IF current_state IS DISTINCT FROM ''ready'' AND NOT (");
    expect(source).toContain("for share");
    expect(source).toContain("trigger_row.tgenabled = ANY");
  });

  it("fails closed when any durable asset-reference guard is absent or stale", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ durableAssetReferenceGuardsReady: false })],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: ["durable_asset_reference_guards_missing"],
    });

    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    expect(source).toContain("SELECT COUNT(*) = 16");
    expect(source).toContain("require_attachable_assets_in_durable_reference");
    expect(source).toContain("legacy_object_reference_unavailable");
    expect(source).toContain("durable_asset_reference_guard_");
    expect(source).toContain(
      "('agent_tasks', 'project_id, attachments, report, staging_snapshot')",
    );
    expect(source).toContain("('task_events', 'task_id, message, data')");
    expect(source).toContain(
      "('generated_images', 'project_id, user_id, asset_id, storage_key, file_url, thumbnail_url, deleted_at, status')",
    );
    expect(source).toContain("('support_tickets', 'user_id, project_id, transcript, attachments')");
    expect(source).toContain("extract_durable_asset_ids");
    expect(source).toContain("resolve_durable_asset_ids");
    expect(source).toContain("durable_asset_deletion_claims");
    expect(source).toContain("resolve_durable_storage_keys");
    expect(source).toContain("pg_advisory_xact_lock_shared");
    expect(source).toContain("durable_asset_reference_exists");
    expect(source).toContain("select tool_call.project_id, null::integer, to_jsonb(tool_call)");
    expect(source).toContain("select image.project_id, image.id, to_jsonb(image)");
    expect(source).toContain("and image.deleted_at is null");
    expect(source).toContain("join public.asset_storage_objects storage_row");
    expect(source).toContain("storage_row.storage_key = matched.storage_match[1]");
    expect(source).toContain("LIKE '%?#<>(){},;%' ".trim());
    expect(source).toContain("from public.asset_storage_objects storage_row");
    expect(source).toContain("project-purge-preserved-direct:");
    expect(source).toContain("trigger_row.tgtype = 23");
    expect(source).toContain("trigger_row.tgqual IS NULL");
    expect(source).toContain("trigger_row.tgattr::smallint[]");
    expect(source).toContain("trigger_row.tgnargs = expected.argument_count");
    expect(source).toContain("encode(trigger_row.tgargs, 'escape') = expected.argument_bytes");
    expect(source).toContain("require_live_owned_ora_asset_reference");
    expect(source).toContain("ora_asset_reference_guard_ora_file_contexts");
    expect(source).toContain("ora_asset_reference_guard_brand_kits");
    expect(source).toContain("user_id, asset_id, deleted_at");
    expect(source).toContain("user_id, logo_asset_id");
    expect(source).toContain("candidate_ora_asset_id := nullif(row_json ->> tg_argv[0]");
    expect(source).toContain("ora.id = candidate_ora_asset_id");
    expect(source).toContain("ora_asset_reference_unavailable");
    expect(source).toContain('AS "oraAssetReferenceRowsReady"');
    expect(source).toContain("LEFT JOIN public.ora_assets ora");
  });

  it("rejects a read-only deployment without the nullable JSONB preview receipt", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ previewDatabaseAllocationReady: false })],
    }));
    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: ["preview_database_allocation_missing"],
    });
  });

  it.each([
    ["productionDatabaseAdmissionTablesReady", "production_database_admission_tables_missing"],
    ["productionDatabaseAdmissionColumnsReady", "production_database_admission_columns_missing"],
    [
      "productionDatabaseAdmissionConstraintsReady",
      "production_database_admission_constraints_missing",
    ],
    ["productionDatabaseAdmissionIndexesReady", "production_database_admission_indexes_missing"],
    ["productionDatabaseAdmissionTriggersReady", "production_database_admission_triggers_missing"],
  ])("fails closed when admission schema evidence is missing: %s", async (flag, violation) => {
    const query = vi.fn(async () => ({ rows: [observation({ [flag]: false })] }));
    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-incomplete",
      violations: [violation],
    });
  });

  it("pins admission columns, retained-receipt FKs, indexes, and enabled row triggers", () => {
    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    expect(source).toContain("SELECT COUNT(*) = 18");
    expect(source).toContain("production_database_admission_epoch_active_uq");
    expect(source).toContain("constraint_row.confdeltype = 'a'");
    expect(source).toContain("constraint_row.confupdtype = 'a'");
    expect(source).toContain("constraint_row.conkey = ARRAY[receipt_column.attnum]::smallint[]");
    expect(source).toContain("'register_production_database_project_birth', 7");
    expect(source).toContain("'guard_production_database_admission_receipt', 27");
    expect(source).toContain("trigger_row.tgenabled IN ('O', 'A')");
    expect(source).toContain("trigger_row.tgqual IS NULL");
    expect(source).toContain("production_database_admission_receipt_immutable");
    expect(source).toContain("production_database_birth_identity_untrusted");
  });

  it("wires the read-only decision before any migration step can execute", () => {
    const source = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const assessment = source.indexOf("assessDeploymentRuntimeSchema");
    const migrationLoop = source.indexOf("for (const step of MIGRATION_STEPS)");

    expect(assessment).toBeGreaterThan(-1);
    expect(migrationLoop).toBeGreaterThan(assessment);
    expect(source).toContain('mode === "read-only-ready"');
    expect(source).toContain('name: "verify-deployment-runtime-schema"');
  });
});

describe("typed durable-reference read-only catalog contract", () => {
  async function catalogSql() {
    const query = vi.fn(async (sql: string) => {
      expect(sql.trimStart().startsWith("SELECT")).toBe(true);
      return sql.includes('AS "oraAssetReferenceRowsReady"')
        ? { rows: [{ oraAssetReferenceRowsReady: true }] }
        : { rows: [observation()] };
    });
    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toMatchObject({
      contractId: "deployment_runtime_schema_v11",
      mode: "read-only-ready",
    });
    expect(query).toHaveBeenCalledTimes(2);
    return query.mock.calls[0]![0];
  }

  it("keeps the retirement column count aligned with its typed and nullable field list", async () => {
    const sql = await catalogSql();
    const columns = sql.slice(
      sql.indexOf('AS "projectRetirementOperationsReady"'),
      sql.indexOf('AS "projectRetirementOperationsColumnsReady"'),
    );
    const fields = [...columns.matchAll(/\('([^']+)', '([^']+)', '(YES|NO)'\)/g)];
    expect(fields.map((field) => field[1])).toEqual([
      "id",
      "project_id",
      "requested_by",
      "state",
      "attempt_count",
      "lease_version",
      "lease_expires_at",
      "progress",
      "failure_code",
      "failure_target",
      "created_at",
      "started_at",
      "completed_at",
      "updated_at",
    ]);
    expect(columns).toContain(
      "(column_row.column_name, column_row.data_type, column_row.is_nullable) IN (",
    );
    const count = columns.match(/SELECT COUNT\(\*\) = (\d+)/);
    expect(Number(count?.[1])).toBe(fields.length);
  });

  it("fails closed when the retirement column evidence is missing", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ projectRetirementOperationsColumnsReady: false })],
    }));
    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toMatchObject({
      mode: "read-only-incomplete",
      violations: ["project_retirement_operations_columns_missing"],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires the strict immutable invoker BIGINT helper and decoded whole-string bounds", async () => {
    const sql = await catalogSql();
    for (const fragment of [
      "to_regprocedure('public.extract_typed_durable_asset_ids(jsonb)')",
      "typed_function.proretset",
      "typed_function.prorettype = 'pg_catalog.int8'::regtype",
      "typed_function.proisstrict",
      "typed_function.provolatile = 'i'",
      "NOT typed_function.prosecdef",
      "typed_function.proconfig",
      "search_path=pg_catalog,public",
      "with typed_strings as materialized (",
      "select value #>> ''{}'' as content",
      "jsonb_path_query(row_json, ''strict $.**'') value",
      "jsonb_typeof(value) = ''string''",
      "char_length(value #>> ''{}'') <= 160",
      "where parts is not null",
      "content = ''@nabuflow/asset-ref:v1:'' || (parts)[1] || '':'' || (parts)[2] || '':'' || (parts)[3]",
      "select distinct asset_id::bigint",
      "asset_id between 1 and 9007199254740991",
      "size_bytes between 1 and 26214400",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it("pins the anchored lowercase-only matcher without lowercasing its definition", async () => {
    const sql = await catalogSql();
    expect(sql).toContain(
      "regexp_replace(typed_function.prosrc, '[[:space:]]+', ' ', 'g') AS typed_raw",
    );
    expect(sql).not.toContain(
      "regexp_replace(lower(typed_function.prosrc), '[[:space:]]+', ' ', 'g') AS typed_raw",
    );
    expect(sql).toContain(
      "bodies.typed_raw LIKE '%regexp_match(content, ''^@nabuflow/asset-ref:v1:([0-9]+):([0-9]+):([a-f0-9]{64})$'')%'",
    );
  });

  it("pins shared extraction, ordered overflow rejection, key expansion and NEW-row scope checks", async () => {
    const sql = await catalogSql();
    for (const fragment of [
      "select public.extract_typed_durable_asset_ids(row_json) as asset_id",
      "asset_id between 1 and 2147483647",
      "if exists ( select 1 from public.extract_typed_durable_asset_ids(row_json) typed(asset_id) where typed.asset_id > 2147483647 ) then raise exception ''asset_reference_unavailable'' using errcode = ''55000''; end if; for candidate_id in select public.extract_durable_asset_ids(row_json)",
      "from public.extract_durable_asset_ids(row_json) reference(asset_id) join public.assets asset on asset.id = reference.asset_id",
      "from public.extract_durable_asset_ids(row_json) reference(asset_id) join public.asset_storage_objects storage_row on storage_row.asset_id = reference.asset_id and storage_row.state <> ''deleted''",
      "select storage_key from asset_keys union",
      "row_json := to_jsonb(new)",
      "existing_reference := false; if tg_op = ''update'' then",
      "and candidate_id not in ( select public.extract_typed_durable_asset_ids(row_json) )",
      "from public.resolve_durable_storage_keys(durable.row_json) resolved(storage_key) join candidate_keys candidate_key on candidate_key.storage_key = resolved.storage_key",
    ]) {
      expect(sql).toContain(fragment);
    }
  });

  it("pins the exact guarded image transitions instead of the obsolete ready-only predicate", async () => {
    const sql = await catalogSql();
    for (const fragment of [
      "position(",
      "IF current_state IS DISTINCT FROM ''ready'' AND NOT (",
      "TG_TABLE_NAME = ''generated_images'' AND TG_OP = ''UPDATE''",
      "asset_kind = ''generated''",
      "asset_owner_user_id IS NOT DISTINCT FROM reference_user_id",
      "asset_project_id IS NOT DISTINCT FROM reference_project_id",
      "asset_context ->> ''generatedImageId'' = row_json ->> ''id''",
      "current_state = ''reserved''",
      "current_state = ''uploading''",
      "row_json - ''asset_id'' - ''updated_at''",
      "row_json - ''status'' - ''updated_at''",
      "RAISE EXCEPTION ''asset_not_ready'' USING ERRCODE = ''55000'';",
      "regexp_replace(pg_get_functiondef(procedure_row.oid), '[[:space:]]+', ' ', 'g')",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).not.toContain("LIKE '%if current_state is distinct from ''ready'' then%'");
  });

  it("preserves all sixteen guards and follows the non-excluding retention wrapper", async () => {
    const sql = await catalogSql();
    const guard = sql.slice(
      sql.indexOf('AS "assetUsageAttachmentGuardReady"'),
      sql.indexOf('AS "durableAssetReferenceGuardsReady"'),
    );
    expect(guard).toContain("SELECT COUNT(*) = 16");
    expect(guard).not.toContain("SELECT COUNT(*) = 15");
    expect(guard).toContain("('support_tickets', 'user_id, project_id, transcript, attachments')");
    expect(guard).toContain("/api/(?:assets|ora/canonical-assets)/([1-9][0-9]{0,9})/content");
    expect(guard).toContain(
      "public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)",
    );
    expect(guard).toContain("public.durable_asset_reference_exists(integer,integer,integer)");
    expect(guard).toContain(
      "select public.durable_asset_reference_exists_excluding_upload( candidate_asset_id, excluded_project_id, excluded_generated_image_id, null )",
    );
    expect(guard).toContain("from public.canvas_variant_library");
    expect(guard).toContain("from public.gallery_templates");
    expect(guard).toContain("project-purge-preserved-direct:");
    expect(guard).toContain("NOT retention_wrapper.prosecdef");
    expect(guard).toContain("retention_wrapper.proconfig");
  });

  it.each([false, null, undefined])(
    "fails closed without historical reads when typed/legacy catalog evidence is %s",
    async (evidence) => {
      const query = vi.fn(async () => ({
        rows: [{ ...observation(), durableAssetReferenceGuardsReady: evidence }],
      }));
      await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
        contractId: "deployment_runtime_schema_v11",
        mode: "read-only-incomplete",
        violations: ["durable_asset_reference_guards_missing"],
      });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it("still delegates stale-schema repair to the mutable migration path", async () => {
    const query = vi.fn(async () => ({
      rows: [
        observation({
          canCreateSchemaObjects: true,
          canMutateExistingObjects: true,
          durableAssetReferenceGuardsReady: false,
        }),
      ],
    }));
    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v11",
      mode: "mutable",
      violations: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
