import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("public runtime provider copy", () => {
  it("describes Cloudflare rather than advertising the retired Fly runtime", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/home.tsx"), "utf8");
    expect(source).toContain("project's Cloudflare runtime");
    expect(source).not.toMatch(/Fly\.io|Fly exec|Fly runtime/iu);
  });
});
