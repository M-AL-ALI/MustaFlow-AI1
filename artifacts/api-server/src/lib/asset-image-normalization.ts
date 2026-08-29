import sharp from "sharp";

export const MAX_NORMALIZED_IMAGE_EDGE = 4096;

export async function normalizeUploadedImage(input: {
  buffer: Buffer;
  mimeType: string;
}): Promise<{ buffer: Buffer; mimeType: string; changed: boolean }> {
  const normalized = await sharp(input.buffer, { failOn: "error", limitInputPixels: 80_000_000 })
    .rotate()
    .resize({
      width: MAX_NORMALIZED_IMAGE_EDGE,
      height: MAX_NORMALIZED_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: 84, effort: 4, smartSubsample: true })
    .toBuffer();
  // Normalisation is for privacy and performance, not expansion. A pathological
  // source that encodes smaller remains byte-for-byte intact.
  if (normalized.length >= input.buffer.length) {
    return { buffer: input.buffer, mimeType: input.mimeType, changed: false };
  }
  return { buffer: normalized, mimeType: "image/webp", changed: true };
}
