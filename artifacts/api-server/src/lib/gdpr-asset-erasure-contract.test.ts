import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const dir = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(dir, "gdpr-erasure-worker.ts"), "utf8");
const projectRoute = fs.readFileSync(path.join(dir, "../routes/projects.ts"), "utf8");
const retirementSource = fs.readFileSync(path.join(dir, "project-retirement.ts"), "utf8");

describe("Capability 9 asset erasure", () => {
  it("collects and deletes unified R2 objects before project rows can cascade", () => {
    const collect = source.indexOf("unifiedAssetRows");
    const deleteObject = source.indexOf(
      "await deleteTrackedAssetStorageObjects(unifiedStorageObjects)",
    );
    const deleteProjects = source.indexOf("await db.delete(projectsTable)");
    expect(collect).toBeGreaterThan(0);
    expect(deleteObject).toBeGreaterThan(collect);
    expect(deleteProjects).toBeGreaterThan(deleteObject);
    expect(source).toContain("assetStorageObjectsTable.storageKey");
    expect(source).toContain("assetStorageObjectsTable.storageBackend");
  });

  it("cancels paid storage before deleting its receipt", () => {
    const providerCancel = source.indexOf("stripe.subscriptions.cancel");
    const receiptDelete = source.indexOf(".delete(storageAddonSubscriptionsTable)");
    expect(providerCancel).toBeGreaterThan(0);
    expect(receiptDelete).toBeGreaterThan(providerCancel);
    expect(source).toContain("gdpr_asset_storage_billing_unavailable");
  });

  it("retains project assets during the recoverable trash window", () => {
    const softDelete = projectRoute.slice(
      projectRoute.indexOf("// Soft delete — sets deletedAt"),
      projectRoute.indexOf("// ── GET /api/projects/:id/container-health"),
    );
    expect(softDelete).toContain("acceptProjectRetirement");
    expect(retirementSource).toContain(".update(projectsTable)");
    expect(retirementSource).toContain("deletedAt: sql`now()`");
    expect(softDelete).not.toContain("deleteAssetObject");
    expect(softDelete).not.toContain("delete(assetsTable)");
    expect(retirementSource).not.toContain("deleteAssetObject");
    expect(retirementSource).not.toContain("delete(assetsTable)");
  });
});
