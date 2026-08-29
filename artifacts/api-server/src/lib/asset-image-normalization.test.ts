import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_NORMALIZED_IMAGE_EDGE, normalizeUploadedImage } from "./asset-image-normalization";

describe("uploaded image normalization", () => {
  it("removes metadata, bounds dimensions, and produces a modern format", async () => {
    const source = await sharp({
      create: { width: 5000, height: 40, channels: 3, background: "#336699" },
    })
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 1, exif: { IFD0: { Artist: "private location owner" } } })
      .toBuffer();

    const result = await normalizeUploadedImage({ buffer: source, mimeType: "image/jpeg" });
    const metadata = await sharp(result.buffer).metadata();
    expect(result.mimeType).toBe("image/webp");
    expect(metadata.width).toBeLessThanOrEqual(MAX_NORMALIZED_IMAGE_EDGE);
    expect(metadata.exif).toBeUndefined();
  });
});
