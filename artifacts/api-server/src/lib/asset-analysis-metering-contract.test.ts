import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snapshotRoute = readFileSync(
  new URL("../routes/snapshot-observe.ts", import.meta.url),
  "utf8",
);
const assetRoute = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");
const builder = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");

describe("image analysis metering contract", () => {
  it("records started, failed, and completed analysis without charging credits", () => {
    expect(snapshotRoute).toContain('status: "started"');
    expect(snapshotRoute).toContain('status: "failed"');
    expect(snapshotRoute).toContain('status: "completed"');
    expect(snapshotRoute).toContain("customerCreditPrice: null");
    expect(snapshotRoute).not.toContain("deductCreditsAtomic");
  });

  it("records the provider, model, tokens, and estimated provider cost", () => {
    expect(builder).toContain("computeModelUsdCost");
    expect(snapshotRoute).toContain("converse.usage?.provider");
    expect(snapshotRoute).toContain("converse.usage?.model");
    expect(snapshotRoute).toContain("converse.usage?.inputTokens");
    expect(snapshotRoute).toContain("converse.usage?.outputTokens");
    expect(snapshotRoute).toContain("converse.usage?.estimatedProviderCostUsd");
  });

  it("keeps analysis as a separate meter-only line item", () => {
    expect(assetRoute).toContain('pricing: "meter-only"');
    expect(assetRoute).toContain("customerCreditPrice: null");
    expect(assetRoute).toContain("Image analysis is metered separately");
  });
});
