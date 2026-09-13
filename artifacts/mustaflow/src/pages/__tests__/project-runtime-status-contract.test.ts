import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../projects/[id].tsx"),
  "utf8",
);

describe("project runtime status authority", () => {
  it("does not introduce a second status from cached container health", () => {
    expect(source).not.toContain("/container-health");
    expect(source).not.toContain("containerHealthStatus");
    expect(source).not.toContain("setContainerHealthStatus");
  });

  it("keeps the provider-backed status and preview-access controls", () => {
    expect(source).toContain("const data = await getContainerStatus(projectId);");
    expect(source).toContain("containerStatus={containerStatus}");
    expect(source).toContain("previewAccess={previewAccess}");
  });
});
