import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { creativeChargeFields } from "./creative-charge-honesty";

describe("creative charge honesty", () => {
  it("keeps the configured estimate separate from an exempt actual charge", () => {
    expect(creativeChargeFields(3, 0)).toEqual({
      estimatedCredits: 3,
      creditsCharged: 0,
    });
  });

  it("reports the returned actual charge for a non-exempt call", () => {
    expect(creativeChargeFields(3, 3)).toEqual({
      estimatedCredits: 3,
      creditsCharged: 3,
    });
  });

  it("awaits the billing result before constructing the agent observation", () => {
    const source = readFileSync(new URL("./agent-loop.ts", import.meta.url), "utf8");
    expect(source).toContain("creditsCharged = await input.onBillableCreativeCall(credits, tool)");
    expect(source).toContain("...creativeChargeFields(credits, creditsCharged)");
    expect(source).not.toContain("creditsCharged: credits");
  });
});
