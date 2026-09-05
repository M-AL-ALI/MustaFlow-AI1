import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
});

import { applyUnifiedAssetRegistryMigration } from "./startup-migrations";

describe("unified asset registry migration", () => {
  it("is additive and safe to run twice", async () => {
    const query = vi.fn(async (statement: unknown) =>
      String(statement).includes("AS guard_ready")
        ? { rows: [{ guard_ready: true }], rowCount: 1 }
        : { rows: [], rowCount: 0 },
    );
    const client = { query };
    await applyUnifiedAssetRegistryMigration(client as never);
    await applyUnifiedAssetRegistryMigration(client as never);

    const sql = query.mock.calls.map(([statement]) => String(statement)).join("\n");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS assets");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS account_asset_quota");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS visual_edit_sessions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS visual_edit_changes");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS asset_analysis_events");
    expect(sql).toContain("require_attachable_asset_for_usage");
    expect(sql).toContain("asset_usage_requires_ready_asset");
    expect(sql).toContain("extract_durable_asset_ids");
    expect(sql).toContain("resolve_durable_asset_ids");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS durable_asset_deletion_claims");
    expect(sql).toContain("resolve_durable_storage_keys");
    expect(sql).toContain("pg_advisory_xact_lock_shared");
    expect(sql).toContain("FROM public.durable_asset_deletion_claims");
    expect(sql).toContain("nabuflow:durable-object:");
    expect(sql).toContain("PERFORM 1 FROM public.generated_images image");
    expect(sql).toContain("FOR KEY SHARE");
    expect(sql).toContain("IF NOT FOUND THEN");
    expect(sql).toContain("row_json - 'deleted_at' - 'updated_at'");
    expect(sql).toContain("durable_asset_reference_exists");
    expect(sql).toContain("SELECT tool_call.project_id, NULL::integer, to_jsonb(tool_call)");
    expect(sql).toContain("SELECT image.project_id, image.id, to_jsonb(image)");
    expect(sql).toContain("AND image.deleted_at IS NULL");
    expect(sql).toContain("/api/images/([1-9][0-9]{0,9})/file");
    expect(sql).toContain("/api/projects/([1-9][0-9]{0,9})/uploads/");
    expect(sql).toContain("require_attachable_assets_in_durable_reference");
    expect(sql).toContain("durable_asset_reference_guard_");
    expect(sql).toContain("('agent_tasks', 'project_id, attachments, report, staging_snapshot')");
    expect(sql).toContain("('task_events', 'task_id, message, data')");
    expect(sql).toContain(
      "('generated_images', 'project_id, user_id, asset_id, storage_key, file_url, thumbnail_url, deleted_at, status')",
    );
    expect(sql).toContain("('support_tickets', 'user_id, project_id, transcript, attachments')");
    expect(sql).toContain("JOIN public.asset_storage_objects storage_row");
    expect(sql).toContain("storage_row.storage_key = matched.storage_match[1]");
    expect(sql).toContain("storage_row.state <> 'deleted'");
    expect(sql).toContain("legacy_object_reference_unavailable");
    expect(sql).toContain("asset_reference_forbidden");
    expect(sql).toContain("'lax $.**.asset_ids[*]'");
    expect(sql).toContain("trigger_row.tgtype = 23");
    expect(sql).toContain("trigger_row.tgqual IS NULL");
    expect(sql).toContain("current_state IS DISTINCT FROM 'ready'");
    expect(sql).toContain("NULLIF(to_jsonb(OLD) ->> 'asset_id', '') IS NULL");
    expect(sql).toContain("current_state = 'reserved'");
    expect(sql).toContain("asset_kind = 'generated'");
    expect(sql).toContain("asset_owner_user_id IS NOT DISTINCT FROM reference_user_id");
    expect(sql).toContain("asset_project_id IS NOT DISTINCT FROM reference_project_id");
    expect(sql).toContain("asset_context ->> 'generatedImageId' = row_json ->> 'id'");
    expect(sql).toContain("row_json ->> 'status' = 'pending'");
    expect(sql).toContain(
      "(row_json - 'asset_id' - 'updated_at') =\n                       (to_jsonb(OLD) - 'asset_id' - 'updated_at')",
    );
    expect(sql).toContain("current_state = 'uploading'");
    expect(sql).toContain("to_jsonb(OLD) ->> 'status' = 'pending'");
    expect(sql).toContain("row_json ->> 'status' = 'generating'");
    expect(sql).toContain(
      "(row_json - 'status' - 'updated_at') =\n                       (to_jsonb(OLD) - 'status' - 'updated_at')",
    );
    expect(sql).toContain("NULLIF(row_json ->> 'storage_key', '') IS NULL");
    expect(sql).toContain("NULLIF(row_json ->> 'file_url', '') IS NULL");
    expect(sql).toContain("NULLIF(row_json ->> 'thumbnail_url', '') IS NULL");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS artifact_id");
    expect(sql).toContain("COALESCE(artifact_id, -1)");
    expect(sql).toContain("SELECT indexdef");
    expect(sql).toContain("IF current_definition IS NULL");
    expect(sql).toContain("position('coalesce(artifact_id,' IN normalized_definition) = 0");
    expect(sql).toContain("generated-image:");
    expect(sql).toContain("UPDATE generated_images image");
    expect(sql).toContain("image.product_scope IS NOT NULL");
    expect(sql).toContain("asset.product_scope IS NOT DISTINCT FROM image.product_scope");
    expect(sql).toContain("asset.project_id IS NOT DISTINCT FROM image.project_id");
    expect(sql).toContain("asset.state = 'ready'");
    expect(sql).toContain("asset.storage_backend = 'r2'");
    expect(sql).toMatch(
      /INSERT INTO account_asset_quota \(user_id, used_bytes, reserved_bytes\)[\s\S]*?ON CONFLICT \(user_id\) DO NOTHING/u,
    );
    expect(sql).not.toContain("ON CONFLICT (user_id) DO UPDATE");
    expect(sql).toContain("WITH adopted AS (");
    expect(sql).toContain("used_bytes = quota.used_bytes + adoption_delta.used_bytes");
    expect(sql).toContain("COALESCE(image.storage_key, 'legacy-generated/'");
    expect(sql).toContain("chat-message:");
    expect(sql).toContain("agent-task:");
    expect(sql).toContain("brand-profile:");
    expect(sql).toContain("asset-derivative:");
    expect(sql).toContain("queue-provenance:");
    expect(sql).toContain("ON CONFLICT (storage_key) DO NOTHING");
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(query.mock.calls.filter(([statement]) => statement === "BEGIN")).toHaveLength(2);
    expect(query.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(2);
  });
});
