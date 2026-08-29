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
    expect(sql).toContain("ON CONFLICT (storage_key) DO NOTHING");
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN)/i);
    expect(query.mock.calls.filter(([statement]) => statement === "BEGIN")).toHaveLength(2);
    expect(query.mock.calls.filter(([statement]) => statement === "COMMIT")).toHaveLength(2);
  });
});
