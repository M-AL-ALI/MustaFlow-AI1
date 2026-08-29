import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./image-generation-jobs.ts", import.meta.url), "utf8");

describe("generated images share the unified asset registry", () => {
  it("reserves storage before credits or provider work", () => {
    const enqueue = source.slice(
      source.indexOf("export async function enqueueImageJob"),
      source.indexOf("// ── Image edit job"),
    );
    expect(enqueue.indexOf("reserveAsset({")).toBeGreaterThan(0);
    expect(enqueue.indexOf("reserveAsset({")).toBeLessThan(enqueue.indexOf("deductCreditsAtomic"));
    expect(enqueue).toContain('status: "failed"');
  });

  it("moves actual stored bytes into the registry and releases failed reservations", () => {
    expect(source).toContain("completeAsset({");
    expect(source).toContain("finalStorageKey: storageKey");
    expect(source).toContain("finalSizeBytes: completedBuffer.length");
    expect(source).toContain("rejectReservedAsset({");
  });

  it("links the Image Studio row to the unified asset before provider work begins", () => {
    expect(source).toContain(".set({ assetId: reservedAsset.id");
    expect(source).toContain("assetId: reservedAsset.id");
  });
});
