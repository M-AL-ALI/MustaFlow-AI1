import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("unified asset hardening contracts", () => {
  it("adopts quota rows insert-only and keeps runtime counters authoritative", () => {
    const migrations = source("./startup-migrations.ts");
    const adoption = migrations.match(
      /INSERT INTO account_asset_quota \(user_id, used_bytes, reserved_bytes\)[\s\S]*?ON CONFLICT \(user_id\) DO NOTHING/u,
    );
    expect(adoption).not.toBeNull();
    expect(adoption?.[0]).not.toContain("DO UPDATE");
    expect(migrations).not.toContain("ON CONFLICT (user_id) DO UPDATE");
    expect(migrations).toContain("WITH adopted AS (");
    expect(migrations).toContain("RETURNING owner_user_id, size_bytes, state");
    expect(migrations).toContain("used_bytes = quota.used_bytes + adoption_delta.used_bytes");
  });

  it("binds project-file usage to artifact identity in schema and migration", () => {
    const schema = source("../../../../lib/db/src/schema/assets.ts");
    const migrations = source("./startup-migrations.ts");
    const reconciliation = source("./project-file-asset-usage.ts");

    expect(schema).toContain('artifactId: integer("artifact_id")');
    expect(schema).toContain("sql`COALESCE(${table.artifactId}, -1)`");
    expect(migrations).toContain("COALESCE(artifact_id, -1)");
    expect(migrations).toContain("SELECT indexdef");
    expect(migrations).toContain("position('coalesce(artifact_id,' IN normalized_definition) = 0");
    expect(migrations).toContain(
      "INSERT INTO asset_usage (asset_id, project_id, artifact_id, file_path, consumer)",
    );
    expect(reconciliation).toContain("artifactId: number | null");
    expect(reconciliation).toContain("artifactId: input.artifactId");
  });

  it("makes generated-image completion part of the asset transaction", () => {
    const registry = source("./asset-registry.ts");
    const jobs = source("./image-generation-jobs.ts");
    const uploadRoute = source("../routes/image-gen.ts");
    const oraChat = source("../routes/public-ai/chat.ts");

    expect(registry).toContain("UPDATE generated_images");
    expect(registry).toContain("AND (asset_id IS NULL OR asset_id=$2)");
    expect(registry.indexOf("UPDATE generated_images")).toBeLessThan(
      registry.indexOf('await client.query("COMMIT")', registry.indexOf("UPDATE generated_images")),
    );
    for (const consumer of [jobs, uploadRoute, oraChat]) {
      expect(consumer).toContain("generatedImage: {");
      expect(consumer).toMatch(/completionCommitted|editableCompletionCommitted/u);
    }
  });

  it("tracks trusted duplicates and refuses unsafe private template copies", () => {
    const duplicate = source("../routes/duplicate.ts");
    const templates = source("../routes/templates.ts");

    expect(duplicate).toContain("referenceProjectId: original.id");
    expect(duplicate).toContain("reconcileProjectFileAssetUsage(tx,");
    expect(templates.match(/template_private_asset_copy_unsupported/gu)).toHaveLength(2);
  });

  it("stores new image objects behind opaque private keys and authenticated routes", () => {
    const storage = source("./image-storage.ts");
    const presentation = source("./image-presentation.ts");
    const route = source("../routes/image-gen.ts");

    expect(storage).toContain("randomUUID()");
    expect(storage).toContain('CacheControl: "private, no-store"');
    expect(storage).not.toContain('CacheControl: "public');
    expect(storage).not.toContain("CF_R2_PUBLIC_URL");
    expect(presentation).toContain('from "./asset-platform-scope"');
    expect(presentation).toContain("!isProductScope(row.productScope)");
    expect(presentation).toContain("canonicalAssetContentUrl(row.assetId, row.productScope)");
    expect(presentation).toContain("Number.isSafeInteger(row.assetId)");
    expect(presentation).not.toContain("/api/images/${row.id}/file");
    expect(route).toContain('res.set("Cache-Control", "private, no-store")');
  });

  it("gives governed storage reconciliation a durable identity and bounded global lock", () => {
    const migrations = source("./startup-migrations.ts");
    const reconciliation = source("./asset-storage-reconciliation.ts");
    const admin = source("../routes/admin.ts");

    expect(migrations).toContain("CREATE TABLE IF NOT EXISTS asset_storage_reconciliation_runs");
    expect(reconciliation).toContain("pg_try_advisory_lock");
    expect(reconciliation).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(reconciliation).toContain("state='completed', receipt=$2::jsonb");
    expect(reconciliation).toContain("state='failed', terminal=$2::jsonb");
    expect(admin).toContain("requestId");
    expect(admin).toContain("runDurableAssetStorageReconciliation");
  });

  it("blocks admission until every adopted physical object has measured bytes", () => {
    const registry = source("./asset-registry.ts");
    const reconciliation = source("./asset-storage-reconciliation.ts");
    const migrations = source("./startup-migrations.ts");

    expect(registry).toContain("asset_storage_reconciliation_required");
    expect(registry).toContain("object.storage_backend IN ('r2', 'legacy-object')");
    expect(registry).toContain("object.size_measured_at IS NULL");
    expect(registry).not.toContain("object.size_bytes=0");
    expect(registry.indexOf("asset_storage_reconciliation_required")).toBeLessThan(
      registry.indexOf("INSERT INTO account_asset_quota"),
    );
    expect(reconciliation).toContain("remainingUnmeasured");
    expect(reconciliation).toContain("admissionUnlocked = receipt.remainingUnmeasured === 0");
    expect(reconciliation).toContain("size_measured_at=NOW()");
    expect(migrations).toContain("Generated image byte sizes are unknown in the legacy table");
    expect(migrations).toContain("ADD COLUMN IF NOT EXISTS size_measured_at TIMESTAMPTZ");
  });
});
