import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/pages/admin.tsx"), "utf8");

describe("Admin asset and image-analysis health", () => {
  it("renders separate cost, performance, and accessibility signals", () => {
    expect(source).toContain('authFetch("/api/admin/asset-health")');
    expect(source).toContain("Vision provider cost");
    expect(source).toContain("Images over 2 MB");
    expect(source).toContain("Images missing alt text");
  });
});
