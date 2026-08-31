import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("project upload cost boundary", () => {
  it("keeps every legacy direct project signer closed", () => {
    const source = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    for (const next of [
      "// POST /projects/:id/uploads/request-url",
      "// POST /projects/:id/uploads — register",
    ]) {
      const comment = source.indexOf(next);
      const start = source.indexOf("router.post(", comment);
      const end = source.indexOf("\n// ", start);
      const route = source.slice(start, end < 0 ? undefined : end);
      expect(comment).toBeGreaterThan(-1);
      expect(start).toBeGreaterThan(comment);
      expect(route).toContain("res.status(410)");
      expect(route).not.toContain("getObjectEntityUploadURL(");
    }
  });

  it("proves provider deletion before removing the durable upload row", () => {
    const source = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    const route = source.slice(source.indexOf("// DELETE /projects/:id/uploads/:uploadId"));
    const providerDelete = route.indexOf(
      "deleteTrackedAssetStorageObjects(pending.storageObjects)",
    );
    expect(providerDelete).toBeGreaterThan(-1);
    expect(providerDelete).toBeLessThan(route.indexOf("db.delete(projectUploadsTable)"));
    expect(route).toContain("storage delete did not conclude");
    expect(route).toContain("legacyUploadIsReferenced");
    expect(route).toContain('eq(assetsTable.source, "legacy-project-upload")');
    expect(route).toContain('pending.storageBackend !== "legacy-object"');
    expect(route).toContain("recordAssetDeleted");
    expect(route.indexOf("legacyUploadIsReferenced")).toBeLessThan(providerDelete);
  });

  it("keeps the unowned legacy signer closed", () => {
    const source = fs.readFileSync(path.join(root, "routes", "storage.ts"), "utf8");
    const route = source.slice(
      source.indexOf('router.post("/storage/uploads/request-url"'),
      source.indexOf("/**\n * GET /storage/public-objects"),
    );
    expect(route).toContain("res.status(410)");
    expect(route).not.toContain("getObjectEntityUploadURL()");
  });

  it("keeps the legacy attachment signer closed in favor of governed assets", () => {
    const api = fs.readFileSync(path.join(root, "routes", "uploads.ts"), "utf8");
    const web = fs.readFileSync(
      path.resolve(
        root,
        "..",
        "..",
        "mustaflow",
        "src",
        "pages",
        "dev-workspace",
        "components",
        "dev-chat-panel.tsx",
      ),
      "utf8",
    );
    const route = api.slice(
      api.indexOf('"/projects/:id/attachments/upload-url"'),
      api.indexOf("// POST /projects/:id/uploads/request-url"),
    );
    expect(route).toContain("res.status(410)");
    expect(route).not.toContain("getObjectEntityUploadURL()");
    expect(web).toContain("uploadProjectAsset({ projectId, file, source:");
    expect(web).not.toContain("/attachments/upload-url");
  });

  it("moves the developer storage panel onto the unified governed asset path", () => {
    const panel = fs.readFileSync(
      path.resolve(
        root,
        "..",
        "..",
        "mustaflow",
        "src",
        "pages",
        "dev-workspace",
        "components",
        "object-storage-panel.tsx",
      ),
      "utf8",
    );
    expect(panel).toContain('uploadProjectAsset({ projectId, file, source: "picker" })');
    expect(panel).toContain("/api/assets?projectId=");
    expect(panel).toContain('asset.source !== "legacy-project-upload"');
    expect(panel).not.toContain("/uploads/request-url");
    expect(panel).not.toContain("/api/storage/public-objects/{objectPath}");
  });
});
