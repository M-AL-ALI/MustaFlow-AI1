import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pool, type ProductScope } from "@workspace/db";
import {
  assertProductScopeNamespace,
  isProductScope,
  requireProductScope,
} from "./asset-platform-scope";
import {
  ASSET_ERROR_MESSAGES,
  BASE_ASSET_ALLOWANCE_BYTES,
  quotaMessage,
  type AssetErrorCode,
} from "./asset-contract";
import { PROJECT_FILE_ASSET_HISTORY_CONSUMER } from "./project-file-asset-reference";

export class AssetAdmissionError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    readonly status: number,
    message: string = ASSET_ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = "AssetAdmissionError";
  }
}

export type AssetReservation = {
  id: number;
  storageKey: string;
  sizeBytes: number;
  mimeType: string;
  filename: string;
};

export type ReadyProjectAsset = {
  id: number;
  kind: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  scanState: string;
  textPreview: string | null;
};

export async function readReadyProjectAssets(input: {
  ownerUserId: string;
  projectId: number;
  assetIds: readonly number[];
}): Promise<ReadyProjectAsset[]> {
  const assetIds = [...new Set(input.assetIds)];
  if (assetIds.length === 0) return [];
  const result = await pool.query<{
    id: number;
    kind: string;
    filename: string;
    mime_type: string;
    size_bytes: string;
    scan_state: string;
    text_preview: string | null;
  }>(
    `SELECT id, kind, filename, mime_type, size_bytes, scan_state, text_preview FROM assets
      WHERE product_scope='nabuflow' AND state='ready' AND id = ANY($3::integer[])
        AND EXISTS (SELECT 1 FROM projects target WHERE target.id=$2 AND target.owner_id=$1 AND target.deleted_at IS NULL)
        AND (project_id=$2 OR EXISTS (
          SELECT 1 FROM asset_usage explicit_use WHERE explicit_use.asset_id=assets.id
            AND explicit_use.project_id=$2 AND explicit_use.consumer='explicit-project-use:v1'
            AND explicit_use.artifact_id IS NULL AND explicit_use.version_id IS NULL AND explicit_use.file_path IS NULL
        ))`,
    [input.ownerUserId, input.projectId, assetIds],
  );
  if (result.rows.length !== assetIds.length) {
    throw new AssetAdmissionError("asset_not_found", 404);
  }
  const byId = new Map(
    result.rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: row.kind,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: Number(row.size_bytes),
        scanState: row.scan_state,
        textPreview: row.text_preview,
      },
    ]),
  );
  return assetIds.map((assetId) => byId.get(assetId)!);
}

export async function assertReadyProjectAssets(input: {
  ownerUserId: string;
  projectId: number;
  assetIds: readonly number[];
}): Promise<void> {
  await readReadyProjectAssets(input);
}

function safeName(value: string): string {
  const cleaned = basename(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(0, 120);
  return cleaned || "upload";
}

function tenantPrefix(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

export async function reserveAsset(input: {
  productScope: ProductScope;
  ownerUserId: string;
  actorUserId: string;
  projectId: number | null;
  threadKey: string | null;
  scope: "account" | "project" | "thread";
  kind: "image" | "file" | "snapshot" | "recording" | "generated";
  source: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  versionId?: number | null;
  taskId?: number | null;
  context?: Record<string, unknown> | null;
}): Promise<AssetReservation> {
  requireProductScope(input.productScope);
  assertProductScopeNamespace(input.productScope, { projectId: input.projectId });
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AssetAdmissionError("asset_empty", 400);
  }
  const storageKey = [
    "assets",
    tenantPrefix(input.ownerUserId),
    input.projectId === null ? "account" : `project-${input.projectId}`,
    randomUUID(),
    safeName(input.filename),
  ].join("/");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Historical provider objects were adopted without trustworthy byte
    // metadata. Do not admit a new upload (or spend a generation credit) while
    // this owner's physical footprint is understated. The governed metadata
    // reconciliation is the only path that clears this predicate.
    const reconciliation = await client.query<{ required: boolean }>(
      `SELECT EXISTS (
         SELECT 1
           FROM asset_storage_objects object
           JOIN assets asset ON asset.id=object.asset_id
          WHERE asset.owner_user_id=$1
            AND asset.state='ready'
            AND object.state='ready'
            AND object.size_measured_at IS NULL
            AND object.storage_backend IN ('r2', 'legacy-object')
       ) AS required`,
      [input.ownerUserId],
    );
    if (reconciliation.rows[0]?.required === true) {
      await client.query("ROLLBACK");
      throw new AssetAdmissionError("asset_storage_reconciliation_required", 409);
    }
    await client.query(
      `INSERT INTO account_asset_quota (user_id, base_allowance_bytes)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO NOTHING`,
      [input.ownerUserId, BASE_ASSET_ALLOWANCE_BYTES],
    );
    const admitted = await client.query<{
      used_bytes: string;
      reserved_bytes: string;
      limit_bytes: string;
    }>(
      `UPDATE account_asset_quota
          SET reserved_bytes = reserved_bytes + $2,
              updated_at = NOW()
        WHERE user_id = $1
          AND used_bytes + reserved_bytes + $2 <= base_allowance_bytes + purchased_allowance_bytes
      RETURNING used_bytes, reserved_bytes,
                base_allowance_bytes + purchased_allowance_bytes AS limit_bytes`,
      [input.ownerUserId, input.sizeBytes],
    );
    if (!admitted.rowCount) {
      const current = await client.query<{
        used_bytes: string;
        reserved_bytes: string;
        limit_bytes: string;
      }>(
        `SELECT used_bytes, reserved_bytes,
                base_allowance_bytes + purchased_allowance_bytes AS limit_bytes
           FROM account_asset_quota WHERE user_id = $1`,
        [input.ownerUserId],
      );
      await client.query("ROLLBACK");
      const row = current.rows[0];
      throw new AssetAdmissionError(
        "asset_quota_exceeded",
        413,
        quotaMessage({
          usedBytes: Number(row?.used_bytes ?? 0) + Number(row?.reserved_bytes ?? 0),
          limitBytes: Number(row?.limit_bytes ?? BASE_ASSET_ALLOWANCE_BYTES),
        }),
      );
    }
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO assets (
         owner_user_id, actor_user_id, project_id, thread_key, scope, kind, source, filename,
         mime_type, size_bytes, storage_backend, storage_key, state, scan_state,
         version_id, task_id, context, product_scope
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'r2',$11,'reserved','not-scanned',$12,$13,$14,$15)
       RETURNING id`,
      [
        input.ownerUserId,
        input.actorUserId,
        input.projectId,
        input.threadKey,
        input.scope,
        input.kind,
        input.source,
        safeName(input.filename),
        input.mimeType,
        input.sizeBytes,
        storageKey,
        input.versionId ?? null,
        input.taskId ?? null,
        input.context ? JSON.stringify(input.context) : null,
        input.productScope,
      ],
    );
    await client.query(
      `INSERT INTO asset_storage_objects (
         asset_id, storage_backend, storage_key, role, size_bytes, size_measured_at, state
       ) VALUES ($1, 'r2', $2, 'primary', $3, NOW(), 'reserved')`,
      [inserted.rows[0]!.id, storageKey, input.sizeBytes],
    );
    const derivativeOfAssetId = input.context?.derivativeOfAssetId;
    if (
      derivativeOfAssetId !== undefined &&
      (!Number.isSafeInteger(derivativeOfAssetId) || Number(derivativeOfAssetId) < 1)
    ) {
      throw new AssetAdmissionError("asset_link_mismatch", 409);
    }
    if (typeof derivativeOfAssetId === "number") {
      const usage = await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         SELECT id, $2, $3 FROM assets
          WHERE id=$1 AND owner_user_id=$4 AND state='ready'
             AND product_scope=$5 AND project_id IS NOT DISTINCT FROM $2
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          derivativeOfAssetId,
          input.projectId,
          `asset-derivative:${inserted.rows[0]!.id}`,
          input.ownerUserId,
          input.productScope,
        ],
      );
      if (!usage.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    }
    await client.query("COMMIT");
    return {
      id: inserted.rows[0]!.id,
      storageKey,
      sizeBytes: input.sizeBytes,
      mimeType: input.mimeType,
      filename: safeName(input.filename),
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original typed error is more useful than a redundant rollback error.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Reserve the account's currently available aggregate allowance for one
 * provider-generated result. Exact completion reconciles this envelope to the
 * bytes actually produced. This is admission control, not a per-file limit.
 */
export async function reserveAssetAgainstAvailableQuota(
  input: Omit<Parameters<typeof reserveAsset>[0], "sizeBytes">,
): Promise<AssetReservation> {
  const quota = await getQuota(input.ownerUserId);
  const availableBytes = Math.max(0, quota.limitBytes - quota.usedBytes - quota.reservedBytes);
  // A one-byte attempt when full delegates the usage-bearing refusal to the
  // central quota predicate instead of creating a second error policy here.
  return reserveAsset({ ...input, sizeBytes: Math.max(1, availableBytes) });
}

export type AssetUploadClaim = {
  id: number;
  ownerUserId: string;
  actorUserId: string;
  projectId: number | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
};

/**
 * Atomically claim one reservation for exactly one upload attempt.  A second
 * PUT cannot stream into the same key, and the expiry sweeper can distinguish
 * an untouched reservation from an in-flight upload.
 */
export async function beginAssetUpload(input: {
  assetId: number;
  actorUserId: string;
}): Promise<AssetUploadClaim | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: number;
      owner_user_id: string;
      actor_user_id: string;
      project_id: number | null;
      filename: string;
      mime_type: string;
      size_bytes: string;
      storage_key: string;
    }>(
      `UPDATE assets
          SET state='uploading', upload_started_at=NOW()
        WHERE id=$1 AND actor_user_id=$2 AND state='reserved'
           AND product_scope IN ('nabuflow','ora')
      RETURNING id, owner_user_id, actor_user_id, project_id, filename,
                mime_type, size_bytes, storage_key`,
      [input.assetId, input.actorUserId],
    );
    if (result.rowCount) {
      await client.query(
        `UPDATE asset_storage_objects
            SET state='uploading'
          WHERE asset_id=$1 AND state='reserved'`,
        [input.assetId],
      );
    }
    await client.query("COMMIT");
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          ownerUserId: row.owner_user_id,
          actorUserId: row.actor_user_id,
          projectId: row.project_id,
          filename: row.filename,
          mimeType: row.mime_type,
          sizeBytes: Number(row.size_bytes),
          storageKey: row.storage_key,
        }
      : null;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export type PlannedAssetStorageObject = {
  role: "primary" | "thumbnail" | string;
  storageBackend: "r2" | "legacy-object" | "dev-file";
  storageKey: string;
  sizeBytes: number;
};

/** Persist every physical provider object before the first byte is uploaded. */
export async function registerAssetStorageObjects(input: {
  assetId: number;
  ownerUserId: string;
  actorUserId: string;
  objects: readonly PlannedAssetStorageObject[];
}): Promise<void> {
  if (
    input.objects.length < 1 ||
    new Set(input.objects.map((object) => object.role)).size !== input.objects.length ||
    input.objects.some(
      (object) =>
        object.storageKey.length < 1 ||
        !Number.isSafeInteger(object.sizeBytes) ||
        object.sizeBytes < 0,
    )
  ) {
    throw new AssetAdmissionError("asset_link_mismatch", 409);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const asset = await client.query<{ id: number }>(
      `SELECT id FROM assets
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='uploading'
        FOR UPDATE`,
      [input.assetId, input.ownerUserId, input.actorUserId],
    );
    if (!asset.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    for (const object of input.objects) {
      await client.query(
        `INSERT INTO asset_storage_objects (
           asset_id, storage_backend, storage_key, role, size_bytes, size_measured_at, state
         ) VALUES ($1,$2,$3,$4,$5,NOW(),'uploading')
         ON CONFLICT (asset_id, role) DO UPDATE
           SET storage_backend=EXCLUDED.storage_backend,
                storage_key=EXCLUDED.storage_key,
                size_bytes=EXCLUDED.size_bytes,
                size_measured_at=NOW(),
                state='uploading',
               ready_at=NULL,
               deleted_at=NULL`,
        [input.assetId, object.storageBackend, object.storageKey, object.role, object.sizeBytes],
      );
    }
    const primary = input.objects.find((object) => object.role === "primary");
    if (primary) {
      await client.query(`UPDATE assets SET storage_backend=$2, storage_key=$3 WHERE id=$1`, [
        input.assetId,
        primary.storageBackend,
        primary.storageKey,
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAsset(input: {
  assetId: number;
  ownerUserId: string;
  actorUserId: string;
  sha256: string;
  scanState: "not-required" | "not-scanned" | "clean";
  textPreview?: string | null;
  finalSizeBytes?: number;
  finalMimeType?: string;
  finalStorageKey?: string;
  /** Atomically grant this project history/restore access to the completed bytes. */
  projectFileHistoryProjectId?: number;
  /**
   * When the asset is the byte owner for a generated_images row, finalize both
   * records in this same transaction. This prevents a ready, billed asset from
   * surviving a later gallery-row failure.
   */
  generatedImage?: {
    imageId: number;
    fileUrl: string;
    thumbnailUrl?: string | null;
    storageKey: string;
    revisedPrompt?: string | null;
    providerName?: string | null;
    modelName?: string | null;
    quality?: string | null;
  };
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reserved = await client.query<{
      size_bytes: string;
      project_id: number | null;
      version_id: number | null;
      task_id: number | null;
      context: Record<string, unknown> | null;
      product_scope: ProductScope | null;
    }>(
      `SELECT size_bytes, project_id, version_id, task_id, context, product_scope FROM assets
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='uploading'
        FOR UPDATE`,
      [input.assetId, input.ownerUserId, input.actorUserId],
    );
    if (!reserved.rowCount || !isProductScope(reserved.rows[0]?.product_scope)) {
      throw new AssetAdmissionError("asset_not_found", 404);
    }
    if (input.generatedImage) {
      const receipt = await client.query<{ product_scope: ProductScope | null }>(
        `SELECT product_scope FROM generated_images
          WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
            AND status IN ('pending', 'generating')
            AND (asset_id IS NULL OR asset_id=$3)
          FOR UPDATE`,
        [input.generatedImage.imageId, input.ownerUserId, input.assetId],
      );
      if (
        receipt.rowCount !== 1 ||
        receipt.rows[0]?.product_scope !== reserved.rows[0]!.product_scope
      ) {
        throw new AssetAdmissionError("asset_link_mismatch", 409);
      }
    }
    if (input.finalSizeBytes !== undefined || input.finalStorageKey !== undefined) {
      await client.query(
        `UPDATE asset_storage_objects
            SET size_bytes=COALESCE($2, size_bytes),
                storage_key=COALESCE($3, storage_key),
                size_measured_at=NOW()
          WHERE asset_id=$1 AND role='primary' AND state='uploading'`,
        [input.assetId, input.finalSizeBytes ?? null, input.finalStorageKey ?? null],
      );
    }
    const storedBytes = await client.query<{ total_bytes: string }>(
      `SELECT COALESCE(SUM(size_bytes), 0)::text AS total_bytes
         FROM asset_storage_objects
        WHERE asset_id=$1 AND state='uploading'`,
      [input.assetId],
    );
    const finalSizeBytes = Number(storedBytes.rows[0]?.total_bytes ?? reserved.rows[0]!.size_bytes);
    if (!Number.isSafeInteger(finalSizeBytes) || finalSizeBytes < 0) {
      throw new AssetAdmissionError("asset_size_mismatch", 409);
    }
    const quota = await client.query<{
      used_bytes: string;
      reserved_bytes: string;
      limit_bytes: string;
    }>(
      `SELECT used_bytes, reserved_bytes,
              base_allowance_bytes + purchased_allowance_bytes AS limit_bytes
         FROM account_asset_quota WHERE user_id=$1 FOR UPDATE`,
      [input.ownerUserId],
    );
    const quotaRow = quota.rows[0];
    if (
      !quotaRow ||
      Number(quotaRow.used_bytes) +
        Number(quotaRow.reserved_bytes) -
        Number(reserved.rows[0]!.size_bytes) +
        finalSizeBytes >
        Number(quotaRow.limit_bytes)
    ) {
      throw new AssetAdmissionError("asset_quota_exceeded", 413);
    }
    const row = await client.query(
      `UPDATE assets
          SET state='ready', sha256=$4, scan_state=$5, text_preview=$6,
              size_bytes=COALESCE($7, size_bytes), mime_type=COALESCE($8, mime_type),
              storage_key=COALESCE($9, storage_key), ready_at=NOW()
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='uploading'
      RETURNING id`,
      [
        input.assetId,
        input.ownerUserId,
        input.actorUserId,
        input.sha256,
        input.scanState,
        input.textPreview ?? null,
        finalSizeBytes,
        input.finalMimeType ?? null,
        input.finalStorageKey ?? null,
      ],
    );
    if (!row.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    await client.query(
      `UPDATE asset_storage_objects
          SET state='ready', ready_at=NOW()
        WHERE asset_id=$1 AND state='uploading'`,
      [input.assetId],
    );
    const attribution = reserved.rows[0]!;
    const contextGeneratedImageId = attribution.context?.generatedImageId;
    if (input.generatedImage) {
      if (
        contextGeneratedImageId !== input.generatedImage.imageId ||
        !Number.isSafeInteger(input.generatedImage.imageId)
      ) {
        throw new AssetAdmissionError("asset_link_mismatch", 409);
      }
      // Bind the now-ready asset before publishing the self-referential image
      // URLs. The durable-reference trigger resolves /api/images/:id/file via
      // the current generated_images row, so doing both in one BEFORE UPDATE
      // would still observe the old null asset_id. Both statements remain in
      // this transaction and are invisible until the final COMMIT.
      const attached = await client.query(
        `UPDATE generated_images
            SET asset_id=$2, updated_at=NOW()
          WHERE id=$1 AND user_id=$3 AND deleted_at IS NULL
            AND status IN ('pending', 'generating')
            AND (asset_id IS NULL OR asset_id=$2)
        RETURNING id`,
        [input.generatedImage.imageId, input.assetId, input.ownerUserId],
      );
      if (!attached.rowCount) throw new AssetAdmissionError("asset_link_mismatch", 409);
      const generated = await client.query(
        `UPDATE generated_images
            SET status='completed',
                file_url=$4,
                thumbnail_url=$5,
                storage_key=$6,
                revised_prompt=COALESCE($7, revised_prompt),
                provider_name=COALESCE($8, provider_name),
                model_name=COALESCE($9, model_name),
                quality=COALESCE($10, quality),
                updated_at=NOW()
          WHERE id=$1 AND user_id=$3 AND deleted_at IS NULL
            AND status IN ('pending', 'generating')
            AND asset_id=$2
        RETURNING id`,
        [
          input.generatedImage.imageId,
          input.assetId,
          input.ownerUserId,
          input.generatedImage.fileUrl,
          input.generatedImage.thumbnailUrl ?? null,
          input.generatedImage.storageKey,
          input.generatedImage.revisedPrompt ?? null,
          input.generatedImage.providerName ?? null,
          input.generatedImage.modelName ?? null,
          input.generatedImage.quality ?? null,
        ],
      );
      if (!generated.rowCount) throw new AssetAdmissionError("asset_link_mismatch", 409);
    }
    if (attribution.version_id !== null) {
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, version_id, consumer)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [
          input.assetId,
          attribution.project_id,
          attribution.version_id,
          `asset-version:${attribution.version_id}`,
        ],
      );
    }
    if (attribution.task_id !== null) {
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [input.assetId, attribution.project_id, `asset-task:${attribution.task_id}`],
      );
    }
    if (input.projectFileHistoryProjectId !== undefined) {
      if (input.projectFileHistoryProjectId !== attribution.project_id) {
        throw new AssetAdmissionError("asset_link_mismatch", 409);
      }
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [input.assetId, input.projectFileHistoryProjectId, PROJECT_FILE_ASSET_HISTORY_CONSUMER],
      );
    }
    const generatedImageId = contextGeneratedImageId;
    if (typeof generatedImageId === "number" && Number.isSafeInteger(generatedImageId)) {
      await client.query(
        `INSERT INTO asset_usage (asset_id, project_id, consumer)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [input.assetId, attribution.project_id, `generated-image:${generatedImageId}`],
      );
    }
    await client.query(
      `UPDATE account_asset_quota
          SET reserved_bytes=GREATEST(0, reserved_bytes-$2),
              used_bytes=used_bytes+$3,
              updated_at=NOW()
        WHERE user_id=$1`,
      [input.ownerUserId, Number(reserved.rows[0]!.size_bytes), finalSizeBytes],
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function rejectReservedAsset(input: {
  assetId: number;
  ownerUserId: string;
  actorUserId: string;
  code: AssetErrorCode;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{ size_bytes: string }>(
      `UPDATE assets SET state='rejected', rejection_code=$4
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3
          AND state IN ('reserved', 'uploading')
      RETURNING size_bytes`,
      [input.assetId, input.ownerUserId, input.actorUserId, input.code],
    );
    if (row.rowCount) {
      await client.query(
        `UPDATE asset_storage_objects
            SET state='deleting'
          WHERE asset_id=$1 AND state IN ('reserved', 'uploading')`,
        [input.assetId],
      );
      await client.query(`DELETE FROM asset_usage WHERE consumer=$1`, [
        `asset-derivative:${input.assetId}`,
      ]);
      await client.query(
        `UPDATE account_asset_quota
            SET reserved_bytes=GREATEST(0, reserved_bytes-$2), updated_at=NOW()
          WHERE user_id=$1`,
        [input.ownerUserId, Number(row.rows[0]!.size_bytes)],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelReservedAsset(input: {
  assetId: number;
  actorUserId: string;
}): Promise<{ storageKey: string | null }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await client.query<{
      owner_user_id: string;
      size_bytes: string;
      storage_key: string;
    }>(
      `UPDATE assets SET state='rejected', rejection_code='asset_cancelled'
        WHERE id=$1 AND actor_user_id=$2 AND state='reserved'
      RETURNING owner_user_id, size_bytes, storage_key`,
      [input.assetId, input.actorUserId],
    );
    if (!row.rowCount) {
      await client.query("ROLLBACK");
      return { storageKey: null };
    }
    const asset = row.rows[0]!;
    await client.query(
      `UPDATE asset_storage_objects
          SET state='deleted', deleted_at=NOW()
        WHERE asset_id=$1 AND state IN ('reserved', 'uploading', 'deleting')`,
      [input.assetId],
    );
    await client.query(`DELETE FROM asset_usage WHERE consumer=$1`, [
      `asset-derivative:${input.assetId}`,
    ]);
    await client.query(
      `UPDATE account_asset_quota
          SET reserved_bytes=GREATEST(0, reserved_bytes-$2), updated_at=NOW()
        WHERE user_id=$1`,
      [asset.owner_user_id, Number(asset.size_bytes)],
    );
    await client.query("COMMIT");
    return { storageKey: asset.storage_key };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function getQuota(userId: string): Promise<{
  usedBytes: number;
  reservedBytes: number;
  limitBytes: number;
}> {
  const result = await pool.query<{
    used_bytes: string;
    reserved_bytes: string;
    limit_bytes: string;
  }>(
    `SELECT used_bytes, reserved_bytes,
            base_allowance_bytes + purchased_allowance_bytes AS limit_bytes
       FROM account_asset_quota WHERE user_id=$1`,
    [userId],
  );
  const row = result.rows[0];
  return {
    usedBytes: Number(row?.used_bytes ?? 0),
    reservedBytes: Number(row?.reserved_bytes ?? 0),
    limitBytes: Number(row?.limit_bytes ?? BASE_ASSET_ALLOWANCE_BYTES),
  };
}

export async function deleteReadyAsset(input: {
  assetId: number;
  userId: string;
  storageBackend?: "r2" | "legacy-object" | "dev-file" | "ora-db";
  /** Exact owned gallery row whose reference is being removed after this claim. */
  generatedImageIdBeingDeleted?: number;
  /** Exact legacy upload metadata removed only after provider absence is proved. */
  projectUploadIdBeingDeleted?: number;
  /** Product-facing callers bind scope; governed internal cleanup may omit it. */
  productScope?: ProductScope;
}): Promise<{
  storageKey: string;
  storageBackend: string;
  sizeBytes: number;
  storageObjects: Array<{ storageKey: string; storageBackend: string; sizeBytes: number }>;
}> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const found = await client.query<{
      storage_key: string;
      storage_backend: string;
      size_bytes: string;
      state: string;
      version_id: number | null;
      task_id: number | null;
      message_id: number | null;
      product_scope: ProductScope | null;
    }>(
      `SELECT storage_key, storage_backend, size_bytes, state, version_id, task_id, message_id, product_scope
         FROM assets
        WHERE id=$1 AND owner_user_id=$2
          AND ($3::text IS NULL OR storage_backend=$3)
          AND (
            state = 'ready'
            OR (state = 'deleting' AND ready_at IS NOT NULL)
          )
        FOR UPDATE`,
      [input.assetId, input.userId, input.storageBackend ?? null],
    );
    if (
      !found.rowCount ||
      (input.productScope !== undefined &&
        (!isProductScope(input.productScope) ||
          found.rows[0]?.product_scope !== input.productScope))
    ) {
      throw new AssetAdmissionError("asset_not_found", 404);
    }
    if (
      input.projectUploadIdBeingDeleted !== undefined &&
      (!Number.isSafeInteger(input.projectUploadIdBeingDeleted) ||
        input.projectUploadIdBeingDeleted < 1 ||
        input.projectUploadIdBeingDeleted > 2147483647)
    ) {
      throw new AssetAdmissionError("asset_not_found", 404);
    }
    const references = await client.query<{ referenced: boolean }>(
      input.projectUploadIdBeingDeleted === undefined
        ? `SELECT public.durable_asset_reference_exists($1, NULL, $2) AS referenced`
        : `SELECT public.durable_asset_reference_exists_excluding_upload($1, NULL, $2, $3) AS referenced`,
      input.projectUploadIdBeingDeleted === undefined
        ? [input.assetId, input.generatedImageIdBeingDeleted ?? null]
        : [
            input.assetId,
            input.generatedImageIdBeingDeleted ?? null,
            input.projectUploadIdBeingDeleted,
          ],
    );
    const row = found.rows[0]!;
    if (references.rows[0]?.referenced !== false) {
      if (row.state === "deleting") {
        await client.query(`UPDATE assets SET state='ready' WHERE id=$1 AND state='deleting'`, [
          input.assetId,
        ]);
        await client.query(
          `UPDATE asset_storage_objects
              SET state='ready'
            WHERE asset_id=$1 AND state='deleting'`,
          [input.assetId],
        );
      }
      throw new AssetAdmissionError("asset_referenced", 409);
    }
    const physicalObjects = await client.query<{
      storage_key: string;
      storage_backend: string;
      size_bytes: string;
    }>(
      `SELECT storage_key, storage_backend, size_bytes
         FROM asset_storage_objects
        WHERE asset_id=$1 AND state <> 'deleted'
        ORDER BY storage_key COLLATE "C"
        FOR UPDATE`,
      [input.assetId],
    );
    // Persist the non-attachable claim before provider work. Writers lock the
    // asset first and then these keys in the same order, so neither a raw key
    // nor an image alias can be attached after this transaction commits.
    const storageObjects = physicalObjects.rows.length
      ? physicalObjects.rows.map((object) => ({
          storageKey: object.storage_key,
          storageBackend: object.storage_backend,
          sizeBytes: Number(object.size_bytes),
        }))
      : row.storage_backend === "legacy-url"
        ? []
        : [
            {
              storageKey: row.storage_key,
              storageBackend: row.storage_backend,
              sizeBytes: Number(row.size_bytes),
            },
          ];
    const storageKeys = [
      ...new Set([
        ...storageObjects.map((object) => object.storageKey),
        ...(row.storage_backend === "legacy-url" ? [] : [row.storage_key]),
      ]),
    ].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    for (const storageKey of storageKeys) {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtextextended('nabuflow:durable-object:' || $1, 0)
         )`,
        [storageKey],
      );
    }
    // New READ COMMITTED statement: observe raw-key writers committed during waits.
    const finalReferences = await client.query<{ referenced: boolean }>(
      input.projectUploadIdBeingDeleted === undefined
        ? `SELECT public.durable_asset_reference_exists($1, NULL, $2) AS referenced`
        : `SELECT public.durable_asset_reference_exists_excluding_upload($1, NULL, $2, $3) AS referenced`,
      input.projectUploadIdBeingDeleted === undefined
        ? [input.assetId, input.generatedImageIdBeingDeleted ?? null]
        : [
            input.assetId,
            input.generatedImageIdBeingDeleted ?? null,
            input.projectUploadIdBeingDeleted,
          ],
    );
    if (finalReferences.rows[0]?.referenced !== false) {
      throw new AssetAdmissionError("asset_referenced", 409);
    }
    if (row.state === "ready") {
      const claimed = await client.query(
        `UPDATE assets SET state='deleting'
          WHERE id=$1 AND owner_user_id=$2
            AND ($3::text IS NULL OR storage_backend=$3) AND state='ready'`,
        [input.assetId, input.userId, input.storageBackend ?? null],
      );
      if (!claimed.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    }
    await client.query(
      `UPDATE asset_storage_objects
          SET state='deleting'
        WHERE asset_id=$1 AND state IN ('ready', 'uploading')`,
      [input.assetId],
    );
    for (const storageKey of storageKeys) {
      await client.query(
        `INSERT INTO durable_asset_deletion_claims (
           storage_key, claim_kind, retired_asset_id
         ) VALUES ($1, 'asset-delete', $2)
         ON CONFLICT (storage_key) DO NOTHING`,
        [storageKey, input.assetId],
      );
    }
    await client.query("COMMIT");
    // Historical URL-only rows have no provider object owned by NabuFlow. Their
    // deletion is a metadata transition, not an endlessly retrying provider job.
    return {
      storageKey: row.storage_key,
      storageBackend: row.storage_backend,
      sizeBytes: Number(row.size_bytes),
      storageObjects,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function recordAssetDeleted(input: {
  assetId: number;
  userId: string;
  sizeBytes: number;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const changed = await client.query(
      `UPDATE assets SET state='deleted', deleted_at=NOW()
        WHERE id=$1 AND owner_user_id=$2 AND state='deleting'`,
      [input.assetId, input.userId],
    );
    if (changed.rowCount) {
      await client.query(
        `UPDATE asset_storage_objects
            SET state='deleted', deleted_at=NOW()
          WHERE asset_id=$1 AND state='deleting'`,
        [input.assetId],
      );
      await client.query(`DELETE FROM asset_usage WHERE consumer=$1`, [
        `asset-derivative:${input.assetId}`,
      ]);
      await client.query(
        `UPDATE account_asset_quota
            SET used_bytes=GREATEST(0, used_bytes-$2), updated_at=NOW()
          WHERE user_id=$1`,
        [input.userId, input.sizeBytes],
      );
    } else {
      const existing = await client.query<{ state: string }>(
        `SELECT state FROM assets WHERE id=$1 AND owner_user_id=$2`,
        [input.assetId, input.userId],
      );
      if (existing.rows[0]?.state !== "deleted") {
        throw new AssetAdmissionError("asset_not_found", 404);
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }
    throw error;
  } finally {
    client.release();
  }
}
