import { describe, expect, it } from "vitest";
import {
  REFERENCE_IMAGE_IMPLEMENTATION_POLICY,
  referenceAwarePrompt,
} from "./reference-image-policy";

describe("reference image implementation policy", () => {
  it("keeps the visual build faithful while replacing only third-party branding", () => {
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain(
      "layout, structure, styling, colours, spacing, and flow",
    );
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain(
      "replace only that brand with the user's own brand",
    );
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("tell the user once");
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain(
      "map which image belongs to which page",
    );
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("ask exactly one focused question");
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain(
      "which backend or permission behaviour you inferred",
    );
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("imperfect phone photos");
  });

  it("does not allow blocking, lecturing, intent judgment, or repeated notices", () => {
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("Never block");
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("judge intent");
    expect(REFERENCE_IMAGE_IMPLEMENTATION_POLICY).toContain("repeat that note");
    const prompt = referenceAwarePrompt("Build this page.");
    expect(prompt.match(/Reproduce the attached reference faithfully/g)).toHaveLength(1);
  });
});
