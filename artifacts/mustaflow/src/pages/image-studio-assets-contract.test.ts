import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "src/pages/image-studio.tsx"), "utf8");

describe("Image Studio unified asset contract", () => {
  it("places generated and uploaded assets into a chosen project", () => {
    expect(source).toContain("const addAssetToProject = async () =>");
    expect(source).not.toContain("useAssetInProject");
    expect(source).toContain('title={image.assetId ? "Use in Project"');
    expect(source).toContain("setUsingAsset({ assetId: asset.id");
    expect(source).toContain("setUsingAsset({ assetId: image.assetId");
    expect(source).toContain(
      "`/api/projects/${useProjectId}/assets/${usingAsset.assetId}/materialize`",
    );
    expect(source).not.toContain("Use in Project — Coming soon");
  });

  it("shows storage and image-analysis accounting as separate lines", () => {
    expect(source).toContain(">Storage</p>");
    expect(source).toContain("Image analysis · separate meter");
    expect(source).toContain("estimatedProviderCostMicros");
  });

  it("keeps alt text editable and can create the complete app-size set", () => {
    expect(source).toContain("Describe this image");
    expect(source).toContain("Brand role for");
    expect(source).toContain("Save details");
    expect(source).toContain("App sizes");
    expect(source).toContain("Ask Zero for alt text");
    expect(source).toContain("/alt-text-proposal");
    expect(source).toContain("Review it, then save when it is right");
    expect(source).toContain(
      "Zero proposed this description automatically. Review it before saving.",
    );
    expect(source).toContain("Private · not malware-scanned");
    expect(source).toContain("Decoded safely before use");
    expect(source).toContain("/derivatives");
  });

  it("shows exact uses and routes bounded project-wide replacement through the registry", () => {
    expect(source).toContain("Where this asset is used");
    expect(source).toContain("/api/assets/${asset.id}/usage");
    expect(source).toContain("/assets/${usageAsset.id}/replace");
    expect(source).toContain("Replace every use in this project");
    expect(source).toContain("stays blocked until every reference is removed or replaced");
  });
});
