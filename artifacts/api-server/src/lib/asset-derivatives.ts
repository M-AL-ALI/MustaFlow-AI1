import sharp from "sharp";

export const ASSET_DERIVATIVE_PRESETS = {
  "favicon-16": { width: 16, height: 16, format: "png" },
  "favicon-32": { width: 32, height: 32, format: "png" },
  "favicon-48": { width: 48, height: 48, format: "png" },
  "ios-40": { width: 40, height: 40, format: "png" },
  "ios-58": { width: 58, height: 58, format: "png" },
  "ios-60": { width: 60, height: 60, format: "png" },
  "ios-76": { width: 76, height: 76, format: "png" },
  "ios-80": { width: 80, height: 80, format: "png" },
  "ios-87": { width: 87, height: 87, format: "png" },
  "ios-120": { width: 120, height: 120, format: "png" },
  "ios-152": { width: 152, height: 152, format: "png" },
  "ios-167": { width: 167, height: 167, format: "png" },
  "ios-180": { width: 180, height: 180, format: "png" },
  "android-192": { width: 192, height: 192, format: "png" },
  "android-512": { width: 512, height: 512, format: "png" },
  "app-store-1024": { width: 1024, height: 1024, format: "png" },
  "splash-phone": { width: 1290, height: 2796, format: "png" },
  "social-preview": { width: 1200, height: 630, format: "webp" },
  "email-header": { width: 600, height: 200, format: "webp" },
} as const;

export type AssetDerivativePreset = keyof typeof ASSET_DERIVATIVE_PRESETS;

export type AssetDerivative = {
  preset: AssetDerivativePreset;
  filename: string;
  mimeType: "image/png" | "image/webp";
  buffer: Buffer;
};

export async function generateAssetDerivatives(
  source: Buffer,
  presets: readonly AssetDerivativePreset[],
): Promise<AssetDerivative[]> {
  const unique = [...new Set(presets)];
  if (unique.length < 1 || unique.length > 20) {
    throw new Error("asset_derivative_count_invalid");
  }
  const metadata = await sharp(source, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("asset_derivative_source_invalid");

  return Promise.all(
    unique.map(async (preset) => {
      const spec = ASSET_DERIVATIVE_PRESETS[preset];
      let pipeline = sharp(source, { failOn: "error" })
        .rotate()
        .resize(spec.width, spec.height, {
          fit: "contain",
          background: { r: 0, g: 0, b: 0, alpha: 0 },
          withoutEnlargement: false,
        });
      const buffer =
        spec.format === "png"
          ? await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer()
          : await pipeline.webp({ quality: 86, effort: 5 }).toBuffer();
      const extension = spec.format;
      return {
        preset,
        filename: `${preset}.${extension}`,
        mimeType: spec.format === "png" ? "image/png" : "image/webp",
        buffer,
      };
    }),
  );
}
