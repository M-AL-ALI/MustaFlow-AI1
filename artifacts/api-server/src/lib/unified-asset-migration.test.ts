import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:5432/test";
});

import { applyUnifiedAssetRegistryMigration } from "./startup-migrations";

describe("unified asset registry migration", () => {
  it("is additive and safe to run twice", async () => {
    const query = vi.fn(async (_statement: unknown) => ({ rows: [], rowCount: 0 }));
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
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS artifact_id");
    expect(sql).toContain("COALESCE(artifact_id, -1)");
    expect(sql).toContain("SELECT indexdef");
    expect(sql).toContain("IF current_definition IS NULL");
    expect(sql).toContain("position('coalesce(artifact_id,' IN normalized_definition) = 0");
    expect(sql).toContain("generated-image:");
    expect(sql).toContain("UPDATE generated_images image");
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
