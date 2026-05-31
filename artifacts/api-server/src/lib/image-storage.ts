/**
 * Image storage helper — Phase 9A-1.
 *
 * Storage strategy (in priority order):
 *   1. Cloudflare R2 (S3-compatible) when CF_R2_* env vars are set.
 *      Uploads full-size WebP + 400px-wide thumbnail to R2.
 *      fileUrl = CF_R2_PUBLIC_URL/<key>  (or a constructed URL).
 *   2. Dev fallback (NODE_ENV !== production): image written to OS temp dir;
 *      fileUrl = /api/images/<id>/file  (served by the image-gen route).
 *      storageKey = absolute temp-file path.
 *   3. Production with no R2: hard-fail — never accept silent data loss.
 *
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { logger } from "./logger";

export interface StorageResult {
  fileUrl: string;
  thumbnailUrl: string | null;
  storageKey: string | null;
}

// ── R2 client ─────────────────────────────────────────────────────────────────

function getR2Config(): {
  client: S3Client;
  bucket: string;
  publicBaseUrl: string;
} | null {
  const accountId = process.env.CF_ACCOUNT_ID;
  const accessKey = process.env.CF_R2_ACCESS_KEY_ID;
  const secretKey = process.env.CF_R2_SECRET_ACCESS_KEY;
  const bucket = process.env.CF_R2_BUCKET;

  if (!accountId || !accessKey || !secretKey || !bucket) return null;

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  // CF_R2_PUBLIC_URL must be set to the public-facing base URL for the bucket,
  // e.g. https://images.yourdomain.com  (no trailing slash).
  // If absent, we attempt to construct an r2.dev URL — but that requires the
  // bucket to have public-access enabled in the Cloudflare dashboard.
  const publicBaseUrl =
    process.env.CF_R2_PUBLIC_URL?.replace(/\/$/, "") ??
    `https://${bucket}.${accountId}.r2.cloudflarestorage.com`;

  return { client, bucket, publicBaseUrl };
}

// ── Upload helpers ─────────────────────────────────────────────────────────────

async function uploadToR2(
  r2: NonNullable<ReturnType<typeof getR2Config>>,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<string> {
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );
  return `${r2.publicBaseUrl}/${key}`;
}

// ── Download from provider URL or decode data URI ────────────────────────────

async function downloadBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Failed to download image: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Resolve the raw image buffer from either:
 *   - An HTTPS/HTTP URL  (dall-e-3 default response)
 *   - A data URI         (gpt-image-1 / proxy responses that return b64_json)
 */
async function resolveRawBuffer(openaiUrlOrData: string): Promise<Buffer> {
  if (openaiUrlOrData.startsWith("data:")) {
    // data:<mime>;base64,<data>
    const commaIdx = openaiUrlOrData.indexOf(",");
    if (commaIdx === -1) throw new Error("Malformed data URI from image provider");
    const b64 = openaiUrlOrData.slice(commaIdx + 1);
    return Buffer.from(b64, "base64");
  }
  return downloadBuffer(openaiUrlOrData);
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function storeGeneratedImage(
  openaiUrl: string,
  imageId: number,
): Promise<StorageResult> {
  const isDataUri = openaiUrl.startsWith("data:");
  logger.info(
    { imageId, source: isDataUri ? "base64-data-uri" : "remote-url" },
    "image-storage: resolving image from provider",
  );

  const rawBuffer = await resolveRawBuffer(openaiUrl);

  logger.info({ imageId, rawBytes: rawBuffer.length }, "image-storage: converting to WebP");

  const webpBuffer = await sharp(rawBuffer).webp({ quality: 85 }).toBuffer();

  const r2 = getR2Config();

  if (r2) {
    // ── R2 upload path ──────────────────────────────────────────────────────
    logger.info({ imageId }, "image-storage: uploading to R2");

    const key = `generated-images/${imageId}/full.webp`;
    const thumbKey = `generated-images/${imageId}/thumb.webp`;

    const thumbBuffer = await sharp(rawBuffer)
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();

    const [fileUrl, thumbnailUrl] = await Promise.all([
      uploadToR2(r2, key, webpBuffer, "image/webp"),
      uploadToR2(r2, thumbKey, thumbBuffer, "image/webp"),
    ]);

    logger.info({ imageId, key }, "image-storage: R2 upload complete");

    return { fileUrl, thumbnailUrl, storageKey: key };
  }

  // ── No R2 ──────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Image storage is not configured: set CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY, " +
        "CF_R2_BUCKET, and CF_ACCOUNT_ID to enable R2 image storage in production.",
    );
  }

  // Dev fallback: write to OS temp dir; return an API URL (not a base64 data URI)
  // so the DB stores only a small URL, not megabytes of encoded image data.
  // The file is served by GET /api/images/:id/file in image-gen.ts.
  logger.warn({ imageId }, "image-storage: R2 not configured — writing to OS temp dir (dev only)");

  const tmpBase = join(tmpdir(), `mustaflow-img-${imageId}-${Date.now()}`);
  const tmpPath = `${tmpBase}.webp`;
  await writeFile(tmpPath, webpBuffer);

  logger.debug({ imageId, tmpPath }, "image-storage: temp file written");

  return {
    fileUrl: `/api/images/${imageId}/file`,
    thumbnailUrl: null,
    storageKey: tmpPath,
  };
}
