import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./projects/[id].tsx", import.meta.url), "utf8");

describe("project header status truth", () => {
  it("distinguishes the last build result from the live runtime state", () => {
    expect(source).toContain('project.status === "failed"');
    expect(source).toContain('"Last build failed"');
    expect(source).toContain('? "Running"');
    expect(source).not.toMatch(/>\s*\{project\.status\}\s*<\/span>/);
  });
});
