import { createHash, randomUUID } from "node:crypto";
import { basename } from "node:path";
import { pool } from "@workspace/db";
import {
  ASSET_ERROR_MESSAGES,
  BASE_ASSET_ALLOWANCE_BYTES,
  quotaMessage,
  type AssetErrorCode,
} from "./asset-contract";

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

export async function assertReadyProjectAssets(input: {
  ownerUserId: string;
  projectId: number;
  assetIds: readonly number[];
}): Promise<void> {
  const assetIds = [...new Set(input.assetIds)];
  if (assetIds.length === 0) return;
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM assets
      WHERE owner_user_id=$1 AND project_id=$2 AND state='ready' AND id = ANY($3::integer[])`,
    [input.ownerUserId, input.projectId, assetIds],
  );
  if (result.rows.length !== assetIds.length) {
    throw new AssetAdmissionError("asset_not_found", 404);
  }
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
         version_id, task_id, context
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'r2',$11,'reserved','not-scanned',$12,$13,$14)
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
      ],
    );
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
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reserved = await client.query<{ size_bytes: string }>(
      `SELECT size_bytes FROM assets
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='reserved'
        FOR UPDATE`,
      [input.assetId, input.ownerUserId, input.actorUserId],
    );
    if (!reserved.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    const finalSizeBytes = input.finalSizeBytes ?? Number(reserved.rows[0]!.size_bytes);
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
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='reserved'
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
        WHERE id=$1 AND owner_user_id=$2 AND actor_user_id=$3 AND state='reserved'
      RETURNING size_bytes`,
      [input.assetId, input.ownerUserId, input.actorUserId, input.code],
    );
    if (row.rowCount) {
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
}): Promise<{ storageKey: string; sizeBytes: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ storage_key: string; size_bytes: string }>(
      `SELECT storage_key, size_bytes FROM assets
        WHERE id=$1 AND owner_user_id=$2 AND state='ready'
        FOR UPDATE`,
      [input.assetId, input.userId],
    );
    if (!found.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    const references = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM asset_usage WHERE asset_id=$1`,
      [input.assetId],
    );
    if (Number(references.rows[0]?.count ?? 0) > 0) {
      throw new AssetAdmissionError("asset_referenced", 409);
    }
    const row = found.rows[0]!;
    await client.query("COMMIT");
    return { storageKey: row.storage_key, sizeBytes: Number(row.size_bytes) };
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
        WHERE id=$1 AND owner_user_id=$2 AND state='ready'`,
      [input.assetId, input.userId],
    );
    if (!changed.rowCount) throw new AssetAdmissionError("asset_not_found", 404);
    await client.query(
      `UPDATE account_asset_quota
          SET used_bytes=GREATEST(0, used_bytes-$2), updated_at=NOW()
        WHERE user_id=$1`,
      [input.userId, input.sizeBytes],
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
