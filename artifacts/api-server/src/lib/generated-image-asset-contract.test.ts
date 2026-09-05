import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./image-generation-jobs.ts", import.meta.url), "utf8");

describe("generated images share the unified asset registry", () => {
  it("requires explicit product scope instead of billing or legacy project inference", () => {
    expect(
      source.match(/const productScope = requireProductScope\(opts\.productScope\)/gu),
    ).toHaveLength(2);
    expect(source.match(/assertProductScopeNamespace\(productScope, opts\)/gu)).toHaveLength(2);
    expect(source).not.toContain("persistToOraLibrary");
    expect(source).toContain("eq(generatedImagesTable.productScope, productScope)");
    expect(source).toContain("eq(assetsTable.productScope, productScope)");
  });

  it("reserves storage before credits or provider work", () => {
    const enqueue = source.slice(
      source.indexOf("export async function enqueueImageJob"),
      source.indexOf("// ── Image edit job"),
    );
    expect(enqueue.indexOf("reserveAssetAgainstAvailableQuota({")).toBeGreaterThan(0);
    expect(enqueue.indexOf("reserveAssetAgainstAvailableQuota({")).toBeLessThan(
      enqueue.indexOf("deductCreditsAtomic"),
    );
    expect(enqueue).not.toContain("reservedSizeBytes");
    expect(enqueue).toContain('status: "failed"');
  });

  it("moves actual stored bytes into the registry and releases failed reservations", () => {
    expect(source).toContain("completeAsset({");
    expect(source).toContain("finalStorageKey: storageKey");
    expect(source).toContain("finalSizeBytes: completedBuffer.length");
    expect(source).toContain("rejectReservedAsset({");
  });

  it("links the Image Studio row to the unified asset before provider work begins", () => {
    expect(source).toContain("await bindGeneratedImageAsset({");
    expect(source).toContain("assetId: reservedAsset.id");
  });

  it("detaches every bound asset before recording a terminal job failure", () => {
    expect(source.match(/assetId: null,\s+status: "failed"/gu)).toHaveLength(6);
    expect(source.match(/try \{\s+deduction = await deductCreditsAtomic/gu)).toHaveLength(2);
    expect(source.match(/errorMessage: "Credit service unavailable"/gu)).toHaveLength(2);
  });
});
