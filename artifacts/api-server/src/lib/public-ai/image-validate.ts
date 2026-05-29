/**
 * Image validation for Ora Phase 5 (PNG/JPG/WEBP).
 *
 * Two-layer check: extension guard + magic byte validation.
 * Accepted: PNG, JPG/JPEG, WEBP.
 * Blocked: GIF, SVG, HEIC/HEIF, and any file whose bytes don't match
 * the declared extension (e.g. .exe renamed to .png).
 *
 * After validation passes, call processImage() to resize (if needed) and
 * strip EXIF before storing or sending to the vision model.
 */

import sharp from "sharp";

export const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024; // 4 MB
export const MAX_IMAGE_DIMENSION = 2048;

export type AllowedImageType = "png" | "jpg" | "webp";

export type ImageValidationResult =
  | { ok: true; type: AllowedImageType; sanitizedName: string; mimeType: string }
  | { ok: false; statusCode: 413 | 415; error: string };

export interface ProcessedImage {
  base64: string;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  wasDownscaled: boolean;
}

const ALLOWED_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const BLOCKED_WITH_REASON: Record<string, string> = {
  ".gif": "GIF images are not supported. Please upload a PNG, JPG, or WEBP image.",
  ".svg": "SVG files are not accepted. Please upload a PNG, JPG, or WEBP image.",
  ".heic": "HEIC images are not supported. Please convert to JPG or PNG first.",
  ".heif": "HEIF images are not supported. Please convert to JPG or PNG first.",
  ".bmp": "BMP images are not supported. Please upload a PNG, JPG, or WEBP image.",
  ".tiff": "TIFF images are not supported. Please upload a PNG, JPG, or WEBP image.",
  ".tif": "TIFF images are not supported. Please upload a PNG, JPG, or WEBP image.",
  ".ico": "ICO files are not supported. Please upload a PNG, JPG, or WEBP image.",
};

export function isImageExtension(filename: string): boolean {
  const ext = getExtension(filename);
  return ALLOWED_IMAGE_EXTENSIONS.has(ext);
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot).toLowerCase() : "";
}

function sanitizeFilename(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9._\- ]/g, "_")
      .replace(/\.{2,}/g, "_")
      .slice(0, 100)
      .trim() || "image"
  );
}

function checkImageMagicBytes(buffer: Buffer, ext: string): boolean {
  if (buffer.length < 12) return false;
  if (ext === ".png") {
    return (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47 &&
      buffer[4] === 0x0d &&
      buffer[5] === 0x0a &&
      buffer[6] === 0x1a &&
      buffer[7] === 0x0a
    );
  }
  if (ext === ".jpg" || ext === ".jpeg") {
    return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (ext === ".webp") {
    return (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    );
  }
  return false;
}

function extToImageType(ext: string): AllowedImageType {
  if (ext === ".png") return "png";
  if (ext === ".jpg" || ext === ".jpeg") return "jpg";
  return "webp";
}

function extToMimeType(ext: string): string {
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/webp";
}

export function validateImage(buffer: Buffer, originalFilename: string): ImageValidationResult {
  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    return {
      ok: false,
      statusCode: 413,
      error: `Image exceeds the 4 MB limit (${(buffer.length / 1024 / 1024).toFixed(1)} MB). Please upload a smaller image.`,
    };
  }

  const ext = getExtension(originalFilename);

  const blockedReason = BLOCKED_WITH_REASON[ext];
  if (blockedReason) {
    return { ok: false, statusCode: 415, error: blockedReason };
  }

  if (!ALLOWED_IMAGE_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      statusCode: 415,
      error: `Unsupported file type "${ext || "(none)"}". Ora accepts PNG, JPG, and WEBP images.`,
    };
  }

  if (!checkImageMagicBytes(buffer, ext)) {
    return {
      ok: false,
      statusCode: 415,
      error: `This file does not appear to be a valid ${ext.slice(1).toUpperCase()} image. Please upload a genuine image file.`,
    };
  }

  return {
    ok: true,
    type: extToImageType(ext),
    sanitizedName: sanitizeFilename(originalFilename),
    mimeType: extToMimeType(ext),
  };
}

/**
 * Resize to fit within MAX_IMAGE_DIMENSION×MAX_IMAGE_DIMENSION (preserving
 * aspect ratio) and strip all EXIF/metadata via sharp. Returns base64.
 *
 * Sharp errors are caught and re-thrown as safe, user-facing messages so
 * raw sharp internals never reach the client.
 */
export async function processImage(buffer: Buffer, mimeType: string): Promise<ProcessedImage> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    throw new Error("This image could not be read. Please try a different image file.");
  }

  const origWidth = metadata.width ?? 0;
  const origHeight = metadata.height ?? 0;
  const wasDownscaled = origWidth > MAX_IMAGE_DIMENSION || origHeight > MAX_IMAGE_DIMENSION;

  try {
    if (wasDownscaled) {
      const result = await sharp(buffer)
        .resize(MAX_IMAGE_DIMENSION, MAX_IMAGE_DIMENSION, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .toBuffer({ resolveWithObject: true });

      return {
        base64: result.data.toString("base64"),
        mimeType,
        width: result.info.width,
        height: result.info.height,
        sizeBytes: result.data.length,
        wasDownscaled: true,
      };
    } else {
      const result = await sharp(buffer).toBuffer({ resolveWithObject: true });

      return {
        base64: result.data.toString("base64"),
        mimeType,
        width: origWidth,
        height: origHeight,
        sizeBytes: result.data.length,
        wasDownscaled: false,
      };
    }
  } catch {
    throw new Error("This image could not be processed. Please try a different image file.");
  }
}
