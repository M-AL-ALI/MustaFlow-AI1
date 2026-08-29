import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");

describe("unified asset delivery contract", () => {
  it("marks structurally accepted private formats as scan-not-required", () => {
    expect(routeSource).toContain('scanState: "not-required"');
    expect(routeSource).not.toContain(
      'scanState: detected.startsWith("image/") ? "not-scanned" : "not-scanned"',
    );
  });

  it("materializes a project file and its usage receipt in one transaction", () => {
    const method = routeSource.slice(
      routeSource.indexOf("async function materializeProjectAsset"),
      routeSource.indexOf("function respondError"),
    );
    expect(method).toContain("await db.transaction(async (tx)");
    expect(method).toMatch(/tx\s*\.insert\(projectFilesTable\)/);
    expect(method).toMatch(/tx\s*\.insert\(assetUsageTable\)/);
  });

  it("replaces every supported reference atomically and refuses unsupported references", () => {
    const endpoint = routeSource.slice(
      routeSource.indexOf('"/projects/:id/assets/:assetId/replace"'),
      routeSource.indexOf('router.delete("/assets/:assetId"'),
    );
    expect(endpoint).toContain("usages.some((usage) => !usage.filePath)");
    expect(endpoint).toContain("await db.transaction(async (tx)");
    expect(endpoint).toMatch(/tx\s*\.insert\(projectFilesTable\)/);
    expect(endpoint).toMatch(/tx\s*\.insert\(assetUsageTable\)/);
    expect(endpoint).toMatch(/tx\s*\.delete\(assetUsageTable\)/);
    expect(endpoint).not.toContain("await materializeProjectAsset(");
  });

  it("keeps asset metadata private and bounds derivative creation", () => {
    expect(routeSource).toContain('router.patch("/assets/:assetId"');
    expect(routeSource).toContain("eq(assetsTable.ownerUserId, req.userId)");
    expect(routeSource).toContain('router.post("/assets/:assetId/derivatives"');
    expect(routeSource).toContain("presets.length > 20");
    expect(routeSource).toContain("generateAssetDerivatives(bytes, presets)");
  });

  it("lets staff read project assets only through a live project-scoped support grant", () => {
    expect(routeSource).toContain("findLiveSupportGrant({ projectId, staffUserId: userId })");
    expect(routeSource).toContain("mayReadProjectAssets(req.userId, projectId)");
    expect(routeSource).toContain("mayReadProjectAssets(req.userId, asset.projectId)");
    expect(routeSource).not.toContain("findLiveSupportGrant({ staffUserId: userId })");
  });
});
