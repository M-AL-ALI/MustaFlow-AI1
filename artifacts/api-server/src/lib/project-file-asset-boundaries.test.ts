import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("project-file asset boundary guards", () => {
  it("resolves manifests once before every provider-wide runtime write", () => {
    const facade = read("./tenant-runtime.ts");
    const provider = read("./tenant-runtime-provider.ts");
    const fly = read("./container.ts");
    const cloudflare = read("./cloudflare-runtime-provider.ts");

    expect(facade.match(/await resolveProjectRuntimeFiles\(projectId, files\)/gu)).toHaveLength(3);
    expect(provider).toContain("content: string | Uint8Array");
    expect(fly).toContain('typeof content === "string" ? Buffer.from(content, "utf8")');
    expect(fly).toContain(": Buffer.from(content)");
    expect(cloudflare).toContain("files,");
    expect(cloudflare).toContain("sealRuntimeArtifact({");
  });

  it("keeps every authenticated read project-scoped and never exposes a manifest", () => {
    const files = read("../routes/files.ts");
    for (const route of [
      "/projects/:id/files",
      "/projects/:id/files/all-content",
      "/projects/:id/files/:fileId",
      "/projects/:id/files/:fileId/raw",
    ]) {
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      expect(files).toMatch(
        new RegExp(
          `router\\.get\\(\\s*"${escaped}"\\s*,\\s*requireProjectAccess\\("viewer"\\)`,
          "u",
        ),
      );
    }
    expect(files).toContain("projectFileByteSize({ content: r.content, mimeType: r.mimeType })");
    expect(files).toContain("resolveProjectFileClientContent({");
    expect(files).toContain("resolveProjectFileBytes({");
    expect(files).toContain(
      "if (isBinaryMime(file.mimeType) || parseProjectFileAssetReference(file.content)) continue;",
    );
    expect(files).toContain("eq(projectFilesTable.projectId, projectId)");
  });
});
