import { describe, expect, it } from "vitest";
import { analyzeAssetBuffer } from "./asset-analysis";

describe("unified asset analysis", () => {
  it("stores readable text for Zero without changing the bytes", async () => {
    await expect(
      analyzeAssetBuffer({
        buffer: Buffer.from("Roadmap\n- Launch\n- Measure"),
        filename: "roadmap.md",
        mimeType: "text/markdown",
      }),
    ).resolves.toEqual({
      valid: true,
      textPreview: "Roadmap\n- Launch\n- Measure",
      extractionUnavailable: false,
    });
  });

  it("rejects a renamed binary instead of feeding it to Zero", async () => {
    await expect(
      analyzeAssetBuffer({
        buffer: Buffer.from([0, 1, 2, 3]),
        filename: "notes.txt",
        mimeType: "text/plain",
      }),
    ).resolves.toEqual({
      valid: false,
      textPreview: null,
      extractionUnavailable: false,
    });
  });
});
