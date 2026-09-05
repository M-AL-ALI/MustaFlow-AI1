import { createHash } from "node:crypto";
import { pool } from "@workspace/db";
import { readAssetBuffer } from "./asset-r2";
import { isBinaryMime } from "./binary-mime";

export const PROJECT_FILE_ASSET_REFERENCE_PREFIX = "@nabuflow/asset-ref:v1:";
export const PROJECT_FILE_ASSET_HISTORY_CONSUMER = "project-asset-history";
export const MAX_PROJECT_FILE_ASSET_BYTES = 25 * 1024 * 1024;

export type ProjectFileAssetReferenceV1 = {
  kind: "project-file-asset-v1";
  assetId: number;
  sizeBytes: number;
  sha256: string;
};

export type ProjectRuntimeFileInput = {
  path: string;
  content: string | Uint8Array;
};

/**
 * Persist only a small, non-secret identity in project_files. The private R2
 * object remains the sole byte owner. Storage keys never cross this boundary.
 */
export function encodeProjectFileAssetReference(input: {
  assetId: number;
  sizeBytes: number;
  sha256: string;
}): string {
  if (
    !Number.isSafeInteger(input.assetId) ||
    input.assetId < 1 ||
    !Number.isSafeInteger(input.sizeBytes) ||
    input.sizeBytes < 1 ||
    input.sizeBytes > MAX_PROJECT_FILE_ASSET_BYTES ||
    !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) {
    throw new Error("project_file_asset_reference_invalid");
  }
  return `${PROJECT_FILE_ASSET_REFERENCE_PREFIX}${input.assetId}:${input.sizeBytes}:${input.sha256}`;
}

export function parseProjectFileAssetReference(
  content: string,
): ProjectFileAssetReferenceV1 | null {
  if (!content.startsWith(PROJECT_FILE_ASSET_REFERENCE_PREFIX)) return null;
  if (content.length > 160) return null;
  const payload = content.slice(PROJECT_FILE_ASSET_REFERENCE_PREFIX.length);
  const match = /^(\d+):(\d+):([a-f0-9]{64})$/u.exec(payload);
  if (!match) return null;
  const assetId = Number(match[1]);
  const sizeBytes = Number(match[2]);
  if (
    !Number.isSafeInteger(assetId) ||
    assetId < 1 ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_PROJECT_FILE_ASSET_BYTES
  ) {
    return null;
  }
  return { kind: "project-file-asset-v1", assetId, sizeBytes, sha256: match[3]! };
}

/** Report the real byte count without downloading an immutable object. */
export function projectFileByteSize(input: { content: string; mimeType: string }): number {
  const reference = parseProjectFileAssetReference(input.content);
  if (reference) return reference.sizeBytes;
  return isBinaryMime(input.mimeType)
    ? Buffer.from(input.content, "base64").length
    : Buffer.byteLength(input.content, "utf8");
}

/**
 * Resolve a binary project-file reference at a trusted serving/build boundary.
 * The caller authorizes access to the current target project. Only a known
 * NabuFlow asset born in that active project or explicitly granted to it may
 * supply bytes. History usages preserve retention, not visibility. The manifest
 * size and digest still bind the exact immutable bytes expected by restore.
 */
export async function resolveProjectFileBytes(input: {
  projectId: number;
  content: string;
  mimeType: string;
  legacyEncoding?: "base64" | "utf8";
}): Promise<Buffer> {
  const reference = parseProjectFileAssetReference(input.content);
  if (!reference) {
    return input.legacyEncoding === "base64" || isBinaryMime(input.mimeType)
      ? Buffer.from(input.content, "base64")
      : Buffer.from(input.content, "utf8");
  }

  const result = await pool.query<{
    storage_key: string;
    size_bytes: string;
    sha256: string | null;
  }>(
    `SELECT asset.storage_key, asset.size_bytes, asset.sha256
       FROM assets asset
      WHERE asset.id=$1
        AND asset.state='ready'
        AND asset.product_scope='nabuflow'
        AND asset.storage_backend='r2'
        AND EXISTS (
          SELECT 1 FROM projects target
           WHERE target.id=$2 AND target.deleted_at IS NULL
        )
        AND (
          asset.project_id=$2
          OR EXISTS (
            SELECT 1 FROM asset_usage usage
             WHERE usage.asset_id=asset.id
               AND usage.project_id=$2
               AND usage.consumer=$3
               AND usage.artifact_id IS NULL
               AND usage.version_id IS NULL
               AND usage.file_path IS NULL
          )
        )`,
    [reference.assetId, input.projectId, "explicit-project-use:v1"],
  );
  const asset = result.rows[0];
  if (
    !asset ||
    Number(asset.size_bytes) !== reference.sizeBytes ||
    asset.sha256 !== reference.sha256
  ) {
    throw new Error("project_file_asset_reference_unavailable");
  }
  const bytes = await readAssetBuffer(asset.storage_key, reference.sizeBytes);
  if (
    !bytes ||
    bytes.length !== reference.sizeBytes ||
    createHash("sha256").update(bytes).digest("hex") !== reference.sha256
  ) {
    throw new Error("project_file_asset_reference_mismatch");
  }
  return bytes;
}

/**
 * Preserve the established files API contract: text is UTF-8 and binary file
 * content is base64. The private manifest itself is never exposed to a caller.
 */
export async function resolveProjectFileClientContent(input: {
  projectId: number;
  content: string;
  mimeType: string;
}): Promise<string> {
  if (!parseProjectFileAssetReference(input.content)) return input.content;
  const bytes = await resolveProjectFileBytes(input);
  return isBinaryMime(input.mimeType) ? bytes.toString("base64") : bytes.toString("utf8");
}

/**
 * Resolve every typed manifest before crossing a provider/container boundary.
 * Ordinary source remains a string; immutable binary assets become exact bytes.
 */
export async function resolveProjectRuntimeFiles(
  projectId: number,
  files: ProjectRuntimeFileInput[],
): Promise<ProjectRuntimeFileInput[]> {
  return Promise.all(
    files.map(async (file) => {
      if (typeof file.content !== "string" || !parseProjectFileAssetReference(file.content)) {
        return file;
      }
      const bytes = await resolveProjectFileBytes({
        projectId,
        content: file.content,
        mimeType: "application/octet-stream",
      });
      return { ...file, content: new Uint8Array(bytes) };
    }),
  );
}

/**
 * @dormantExport
 * Pin retention for a current-project NabuFlow asset. This automatic history
 * marker never grants another project access to the immutable object.
 */
export async function pinProjectFileAssetHistory(input: {
  assetId: number;
  projectId: number;
}): Promise<void> {
  const linked = await pool.query(
    `INSERT INTO asset_usage (asset_id, project_id, consumer)
     SELECT asset.id, $2, $3 FROM assets asset
      WHERE asset.id=$1 AND asset.project_id=$2 AND asset.state='ready'
        AND asset.product_scope='nabuflow'
        AND EXISTS (
          SELECT 1 FROM projects target
           WHERE target.id=$2 AND target.deleted_at IS NULL
        )
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [input.assetId, input.projectId, PROJECT_FILE_ASSET_HISTORY_CONSUMER],
  );
  if (!linked.rowCount) throw new Error("project_file_asset_reference_unavailable");
}
