import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const snapshotRoute = readFileSync(
  new URL("../routes/snapshot-observe.ts", import.meta.url),
  "utf8",
);
const assetRoute = readFileSync(new URL("../routes/assets.ts", import.meta.url), "utf8");
const builder = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");
const altTextAnalysis = readFileSync(
  new URL("./asset-alt-text-analysis.ts", import.meta.url),
  "utf8",
);

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

  it("meters alt-text vision proposals behind the account spend gate", () => {
    const endpoint = assetRoute.slice(
      assetRoute.indexOf('router.post("/assets/:assetId/alt-text-proposal"'),
      assetRoute.indexOf('router.put("/assets/:assetId/content"'),
    );
    expect(endpoint).toContain("createAssetAltTextEvent");
    expect(endpoint).toContain("runAssetAltTextAnalysis");
    expect(altTextAnalysis).toContain("nabuflowGateHttpError");
    expect(altTextAnalysis).toContain('status: "started"');
    expect(altTextAnalysis).toContain('status: "completed"');
    expect(altTextAnalysis).toContain('status: "failed"');
    expect(altTextAnalysis).toContain("estimatedProviderCostMicros");
    expect(altTextAnalysis).toContain("customerCreditPrice: null");
    expect(endpoint).not.toContain("deductCreditsAtomic");
  });

  it("automatically queues every accepted image without making upload success depend on vision", () => {
    expect(assetRoute).toContain("enqueueAutomaticAssetAltText");
    expect(assetRoute).toContain('finalMimeType.startsWith("image/")');
    expect(assetRoute).toContain("upload remains ready");
    expect(altTextAnalysis).toContain("QUEUE_ASSET_ALT_TEXT");
    expect(altTextAnalysis).toContain("registerAssetAltTextWorker");
    expect(altTextAnalysis).toContain("ASSET_ALT_TEXT_SEMANTICS");
    expect(altTextAnalysis).toContain(
      "eq(assetAnalysisEventsTable.model, ASSET_ALT_TEXT_SEMANTICS)",
    );
    expect(altTextAnalysis).toContain("suggestedAltText");
    expect(altTextAnalysis).toContain("withOneCleanRetry");
    expect(altTextAnalysis).toContain("coalesce(${assetsTable.context}, '{}'::jsonb)");
  });
});
