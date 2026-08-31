/**
 * Image storage helper — Phase 9A-1 / Phase 9A-2.
 *
 * Storage strategy (in priority order):
 *   1. Cloudflare R2 (S3-compatible) when CF_R2_* env vars are set.
 *      Uploads full-size WebP + 400px-wide thumbnail to R2.
 *      Browser delivery remains behind the authenticated image route; provider
 *      object URLs and keys are never presentation data.
 *   2. Dev fallback (NODE_ENV !== production): image written to OS temp dir;
 *      fileUrl = /api/images/<id>/file  (served by the image-gen route).
 *      storageKey = absolute temp-file path.
 *   3. Production with no R2: hard-fail — never accept silent data loss.
 *
 * ISOLATION: this file MUST NOT import from builder.ts or any pipeline module.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import {
  DeleteObjectCommand,
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import { logger } from "./logger";
import { registerAssetStorageObjects } from "./asset-registry";

export type StoredImageObject = {
  role: "primary" | "thumbnail";
  storageBackend: "r2" | "dev-file";
  storageKey: string;
  sizeBytes: number;
};

export type StoredImageAssetOwner = {
  assetId: number;
  ownerUserId: string;
  actorUserId: string;
};

export interface StorageResult {
  fileUrl: string;
  thumbnailUrl: string | null;
  storageKey: string | null;
  storageObjects: StoredImageObject[];
  sha256: string;
}

// ── R2 client ─────────────────────────────────────────────────────────────────

function getR2Config(): {
  client: S3Client;
  bucket: string;
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

  return { client, bucket };
}

// ── Upload helpers ─────────────────────────────────────────────────────────────

async function uploadToR2(
  r2: NonNullable<ReturnType<typeof getR2Config>>,
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await r2.client.send(
    new PutObjectCommand({
      Bucket: r2.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      CacheControl: "private, no-store",
      ServerSideEncryption: "AES256",
    }),
  );
}

// ── Download from provider URL or decode data URI ────────────────────────────

async function downloadBuffer(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    // data:<mime>;base64,<payload>  — proxy path returns base64 data URIs
    const commaIdx = url.indexOf(",");
    if (commaIdx === -1) {
      throw new Error("Invalid data URI: missing comma separator");
    }
    return Buffer.from(url.slice(commaIdx + 1), "base64");
  }
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

// ── Shared store helper (WebP already in hand) ───────────────────────────────

async function storeWebpBuffer(
  webpBuffer: Buffer,
  rawBufferForThumb: Buffer,
  keyPrefix: string,
  imageId: number,
  devFileUrl: string,
  asset: StoredImageAssetOwner,
): Promise<StorageResult> {
  const r2 = getR2Config();
  const sha256 = createHash("sha256").update(webpBuffer).digest("hex");

  if (r2) {
    const ownerNamespace = createHash("sha256")
      .update(asset.ownerUserId)
      .digest("hex")
      .slice(0, 24);
    const opaqueRoot = `${keyPrefix}/${ownerNamespace}/${randomUUID()}`;
    const key = `${opaqueRoot}/full.webp`;
    const thumbKey = `${opaqueRoot}/thumb.webp`;

    const thumbBuffer = await sharp(rawBufferForThumb)
      .resize({ width: 400, withoutEnlargement: true })
      .webp({ quality: 75 })
      .toBuffer();

    const storageObjects: StoredImageObject[] = [
      { role: "primary", storageBackend: "r2", storageKey: key, sizeBytes: webpBuffer.length },
      {
        role: "thumbnail",
        storageBackend: "r2",
        storageKey: thumbKey,
        sizeBytes: thumbBuffer.length,
      },
    ];
    await registerAssetStorageObjects({
      ...asset,
      objects: storageObjects,
    });
    const uploadedKeys: string[] = [];
    try {
      await uploadToR2(r2, key, webpBuffer, "image/webp");
      uploadedKeys.push(key);
      await uploadToR2(r2, thumbKey, thumbBuffer, "image/webp");
      uploadedKeys.push(thumbKey);
      return {
        fileUrl: devFileUrl,
        thumbnailUrl: `${devFileUrl}?role=thumbnail`,
        storageKey: key,
        storageObjects,
        sha256,
      };
    } catch (error) {
      await Promise.allSettled(
        uploadedKeys.map((uploadedKey) =>
          r2.client.send(new DeleteObjectCommand({ Bucket: r2.bucket, Key: uploadedKey })),
        ),
      );
      throw error;
    }
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Image storage is not configured: set CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY, " +
        "CF_R2_BUCKET, and CF_ACCOUNT_ID to enable R2 image storage in production.",
    );
  }

  const tmpBase = join(tmpdir(), `mustaflow-img-${imageId}-${Date.now()}`);
  const tmpPath = `${tmpBase}.webp`;
  const storageObjects: StoredImageObject[] = [
    {
      role: "primary",
      storageBackend: "dev-file",
      storageKey: tmpPath,
      sizeBytes: webpBuffer.length,
    },
  ];
  await registerAssetStorageObjects({ ...asset, objects: storageObjects });
  await writeFile(tmpPath, webpBuffer);
  return {
    fileUrl: devFileUrl,
    thumbnailUrl: null,
    storageKey: tmpPath,
    storageObjects,
    sha256,
  };
}

// ── Main export: generated images ─────────────────────────────────────────────

export async function storeGeneratedImage(
  openaiUrl: string,
  imageId: number,
  asset: StoredImageAssetOwner,
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
    logger.info({ imageId }, "image-storage: uploading to R2");
    const result = await storeWebpBuffer(
      webpBuffer,
      rawBuffer,
      "generated-images",
      imageId,
      `/api/images/${imageId}/file`,
      asset,
    );
    logger.info({ imageId }, "image-storage: R2 upload complete");
    return result;
  }

  logger.warn({ imageId }, "image-storage: R2 not configured — writing to OS temp dir (dev only)");
  return storeWebpBuffer(
    webpBuffer,
    rawBuffer,
    "generated-images",
    imageId,
    `/api/images/${imageId}/file`,
    asset,
  );
}

// ── Uploaded images (user-supplied, already WebP from route) ─────────────────

/**
 * Store a user-uploaded image that has already been validated and converted to WebP.
 * `rawBuffer` is the original (pre-conversion) bytes used to generate the thumbnail.
 */
export async function storeUploadedImage(
  webpBuffer: Buffer,
  rawBuffer: Buffer,
  imageId: number,
  asset: StoredImageAssetOwner,
): Promise<StorageResult> {
  logger.info({ imageId }, "image-storage: storing uploaded image");
  return storeWebpBuffer(
    webpBuffer,
    rawBuffer,
    "uploaded-images",
    imageId,
    `/api/images/${imageId}/file`,
    asset,
  );
}

// ── Edited images (result from provider edit API) ─────────────────────────────

export async function storeEditedImage(
  openaiUrl: string,
  imageId: number,
  asset: StoredImageAssetOwner,
): Promise<StorageResult> {
  logger.info({ imageId }, "image-storage: storing edited image");
  const rawBuffer = await resolveRawBuffer(openaiUrl);
  const webpBuffer = await sharp(rawBuffer).webp({ quality: 85 }).toBuffer();
  return storeWebpBuffer(
    webpBuffer,
    rawBuffer,
    "edited-images",
    imageId,
    `/api/images/${imageId}/file`,
    asset,
  );
}

/** Idempotent compensation for a stored image whose registry completion failed. */
export async function deleteStoredImageObjects(
  objects: readonly StoredImageObject[],
): Promise<void> {
  const r2 = getR2Config();
  const failures: unknown[] = [];
  for (const object of objects) {
    try {
      if (object.storageBackend === "r2") {
        if (!r2) throw new Error("image_storage_unavailable");
        await r2.client.send(
          new DeleteObjectCommand({ Bucket: r2.bucket, Key: object.storageKey }),
        );
      } else {
        await unlink(object.storageKey).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new Error("image_storage_cleanup_pending");
}

// ── Fetch image buffer from storage (for edit source) ────────────────────────

/**
 * Retrieve the raw image bytes for an existing DB image record.
 *
 * Priority order:
 *   1. Dev-mode tmpdir path (identified by the storage key)
 *   2. R2 authenticated GetObject (storageKey present + R2 configured)
 *      Works with both public and private R2 buckets.
 *   3. Public HTTPS fetch fallback (storageKey absent or R2 not configured)
 */
export async function getImageBuffer(storageKey: string | null, fileUrl: string): Promise<Buffer> {
  // 1. Dev mode is identified by the storage key itself. Production R2 rows
  // intentionally also expose only the authenticated /api/images route.
  const sysTmp = tmpdir();
  if (storageKey?.startsWith(sysTmp)) {
    return readFile(storageKey);
  }

  // 2. R2 authenticated GetObject — works with private buckets
  if (storageKey) {
    const r2 = getR2Config();
    if (r2) {
      const cmd = new GetObjectCommand({ Bucket: r2.bucket, Key: storageKey });
      const obj = await r2.client.send(cmd);
      if (!obj.Body) {
        throw new Error("R2 GetObject returned an empty body");
      }
      return Buffer.from(await obj.Body.transformToByteArray());
    }
  }

  // 3. Fallback: public HTTPS URL (dall-e-3 CDN URLs, custom public buckets)
  const res = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`Failed to fetch image from storage: HTTP ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}
