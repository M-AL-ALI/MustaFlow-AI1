import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src/pages/projects/[id].tsx"), "utf8");

describe("project header status truth", () => {
  it("distinguishes the last build result from the live runtime state", () => {
    expect(source).toContain('project.status === "failed"');
    expect(source).toContain('"Last build failed"');
    expect(source).toContain('? "Running"');
    expect(source).not.toMatch(/>\s*\{project\.status\}\s*<\/span>/);
  });
});
