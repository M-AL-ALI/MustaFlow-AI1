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
    ...overrides,
  };
}

describe("deployment runtime schema boundary", () => {
  it("accepts a complete read-only deployment schema without issuing DDL", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql.trimStart().startsWith("SELECT")).toBe(true);
      return { rows: [observation()] };
    });

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v6",
      mode: "read-only-ready",
      violations: [],
    });
    expect(query).toHaveBeenCalledTimes(1);
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
      contractId: "deployment_runtime_schema_v6",
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
      contractId: "deployment_runtime_schema_v6",
      mode: "mutable",
      violations: [],
    });
  });

  it("treats a deployment role that can create but cannot alter existing objects as read-only", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ canCreateSchemaObjects: true })],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v6",
      mode: "read-only-ready",
      violations: [],
    });
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
      contractId: "deployment_runtime_schema_v6",
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
      contractId: "deployment_runtime_schema_v6",
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
      contractId: "deployment_runtime_schema_v6",
      mode: "read-only-incomplete",
      violations: ["asset_usage_attachment_guard_missing"],
    });

    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    expect(source).toContain("update of asset_id, project_id");
    expect(source).toContain("if current_state is distinct from ''ready'' then");
    expect(source).toContain("for share");
    expect(source).toContain("trigger_row.tgenabled = ANY");
  });

  it("fails closed when any durable asset-reference guard is absent or stale", async () => {
    const query = vi.fn(async () => ({
      rows: [observation({ durableAssetReferenceGuardsReady: false })],
    }));

    await expect(assessDeploymentRuntimeSchema({ query } as never)).resolves.toEqual({
      contractId: "deployment_runtime_schema_v6",
      mode: "read-only-incomplete",
      violations: ["durable_asset_reference_guards_missing"],
    });

    const source = readFileSync(new URL("./deployment-runtime-schema.ts", import.meta.url), "utf8");
    expect(source).toContain("SELECT COUNT(*) = 15");
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
