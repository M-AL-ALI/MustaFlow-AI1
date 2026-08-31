/**
 * Object storage helpers for database snapshot blobs.
 *
 * Snapshots can be large (up to several MB of SQL), so we store the raw dump
 * in GCS and keep only metadata + the object key in the `db_snapshots` row.
 * Graceful degradation: when `DEFAULT_OBJECT_STORAGE_BUCKET_ID` is not set
 * (local dev, CI), content falls back to inline `dumpContent` in the DB row.
 */

import { Storage } from "@google-cloud/storage";
import { randomUUID } from "crypto";
import { logger } from "./logger";

const REPLIT_SIDECAR_ENDPOINT = "http://127.0.0.1:1106";

function isConfigured(): boolean {
  return Boolean(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID);
}

function getClient(): Storage {
  return new Storage({
    credentials: {
      audience: "replit",
      subject_token_type: "access_token",
      token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
      type: "external_account",
      credential_source: {
        url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
        format: {
          type: "json",
          subject_token_field_name: "access_token",
        },
      },
      universe_domain: "googleapis.com",
    },
    projectId: "",
  } as ConstructorParameters<typeof Storage>[0]);
}

/**
 * Upload snapshot dump content to GCS.
 * Returns the object key to store in `db_snapshots.object_key`, or null when
 * GCS is not configured (caller should fall back to inline storage).
 */
export async function uploadSnapshotBlob(
  projectId: number,
  dumpContent: string,
): Promise<string | null> {
  if (!isConfigured()) {
    return null;
  }

  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID!;
  const objectKey = `db-snapshots/${projectId}/${randomUUID()}.sql`;

  try {
    const storage = getClient();
    const bucket = storage.bucket(bucketId);
    const file = bucket.file(objectKey);
    await file.save(dumpContent, { contentType: "text/plain; charset=utf-8", resumable: false });
    return objectKey;
  } catch (err) {
    logger.warn(
      { err, projectId, objectKey },
      "Snapshot upload to GCS failed — falling back to inline storage",
    );
    return null;
  }
}

/**
 * Download snapshot dump content from GCS.
 * Throws when the object key exists but the download fails.
 * Returns null when objectKey is not set (caller should use inline dumpContent).
 */
export async function downloadSnapshotBlob(objectKey: string | null): Promise<string | null> {
  if (!objectKey) {
    return null;
  }

  if (!isConfigured()) {
    logger.warn(
      { objectKey },
      "DEFAULT_OBJECT_STORAGE_BUCKET_ID not set — cannot download snapshot from GCS",
    );
    return null;
  }

  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID!;
  const storage = getClient();
  const bucket = storage.bucket(bucketId);
  const file = bucket.file(objectKey);

  const [content] = await file.download();
  return content.toString("utf-8");
}

/**
 * Delete a snapshot blob from GCS and report whether absence was confirmed.
 */
export async function deleteSnapshotBlob(objectKey: string | null): Promise<boolean> {
  if (!objectKey) return true;
  if (!isConfigured()) return false;

  try {
    const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID!;
    const storage = getClient();
    await storage.bucket(bucketId).file(objectKey).delete({ ignoreNotFound: true });
    return true;
  } catch (err) {
    logger.warn({ err, objectKey }, "Snapshot GCS delete could not be confirmed");
    return false;
  }
}
