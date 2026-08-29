import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const memoryPage = readFileSync(resolve(process.cwd(), "src/pages/memory.tsx"), "utf8");
const brandPill = readFileSync(
  resolve(process.cwd(), "src/pages/projects/components/brand-pill.tsx"),
  "utf8",
);

describe("brand kit unified asset UI", () => {
  it("uploads the logo through the shared account asset pipeline and marks its role", () => {
    expect(memoryPage).toContain('import { uploadAccountAsset } from "@/lib/asset-upload"');
    expect(memoryPage).toContain('await uploadAccountAsset({ file, source: "picker" })');
    expect(memoryPage).toContain('JSON.stringify({ brandRole: "logo", altText: "Brand logo" })');
  });

  it("renders the saved private logo from the authenticated content route", () => {
    expect(memoryPage).toContain('alt="Current brand logo"');
    expect(brandPill).toContain("profile.logoContentUrl");
  });
});
