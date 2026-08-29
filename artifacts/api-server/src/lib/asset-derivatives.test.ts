import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ASSET_DERIVATIVE_PRESETS, generateAssetDerivatives } from "./asset-derivatives";

describe("asset derivative generator", () => {
  it("covers browser, iOS, Android, store, splash, social, and email outputs", () => {
    expect(Object.keys(ASSET_DERIVATIVE_PRESETS)).toEqual(
      expect.arrayContaining([
        "favicon-16",
        "favicon-32",
        "ios-180",
        "android-192",
        "android-512",
        "app-store-1024",
        "splash-phone",
        "social-preview",
        "email-header",
      ]),
    );
  });

  it("produces deterministic dimensions and strips source metadata", async () => {
    const source = await sharp({
      create: { width: 64, height: 32, channels: 4, background: "#2563eb" },
    })
      .withMetadata({ orientation: 6 })
      .png()
      .toBuffer();
    const [favicon, social] = await generateAssetDerivatives(source, [
      "favicon-32",
      "social-preview",
    ]);
    expect(await sharp(favicon!.buffer).metadata()).toMatchObject({ width: 32, height: 32 });
    expect(await sharp(social!.buffer).metadata()).toMatchObject({ width: 1200, height: 630 });
    expect((await sharp(favicon!.buffer).metadata()).orientation).toBeUndefined();
    expect((await sharp(social!.buffer).metadata()).orientation).toBeUndefined();
  });

  it("rejects unbounded work", async () => {
    await expect(generateAssetDerivatives(Buffer.from("nope"), [])).rejects.toThrow(
      "asset_derivative_count_invalid",
    );
  });
});
