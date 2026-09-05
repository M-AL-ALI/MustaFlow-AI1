import { createHash } from "node:crypto";
import {
  assetsTable,
  db,
  oraAssetsTable,
  oraFileContextsTable,
  pool,
  type OraAssetKind,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { readAssetBuffer, putAssetBuffer } from "./asset-r2";
import {
  AssetAdmissionError,
  beginAssetUpload,
  completeAsset,
  deleteReadyAsset,
  getQuota,
  recordAssetDeleted,
  rejectReservedAsset,
  reserveAsset,
  reserveAssetAgainstAvailableQuota,
  type AssetReservation,
} from "./asset-registry";
import { deleteTrackedAssetStorageObjects } from "./asset-storage-cleanup";
import { isOwnedReadyAssetForProduct } from "./asset-platform-scope";

// Ora membership is a metadata alias, not proof of where bytes originated.
// This predicate is for access only; retention queries must remain global.
export function oraAssetProductScopePredicate() {
  return sql`EXISTS (
    SELECT 1 FROM ${assetsTable}
     WHERE ${assetsTable.id} = ${oraAssetsTable.assetId}
       AND ${assetsTable.ownerUserId} = ${oraAssetsTable.userId}
       AND ${assetsTable.productScope} = 'ora'
       AND ${assetsTable.state} = 'ready'
       AND ${assetsTable.deletedAt} IS NULL
  )`;
}

/** Compatibility export for the existing Library UI. The real limit is the
 * unified account quota (base plus purchased storage), not an Ora-only cap. */
export const PER_USER_STORAGE_BYTES = 500 * 1024 * 1024;

/** Kept for old callers/tests. New Ora bytes always use the unified R2 path. */
export function oraR2OffloadEnabled(): boolean {
  return true;
}

/**
 * Sum the decoded bytes of a user's live (non-deleted) library assets.
 */
export async function getUserStorageBytes(userId: string): Promise<number> {
  return (await getQuota(userId)).usedBytes;
}

/**
 * Resolve bytes only through a known, owner-matching Ora canonical asset.
 * Unknown legacy blobs/keys remain retained but cannot authorize delivery.
 */
export async function resolveOraAssetRowBytes(row: {
  userId?: string;
  assetId?: number | null;
  storageKey: string | null;
  data: string | null;
  sizeBytes?: number;
}): Promise<Buffer | null> {
  if (!row.userId || !Number.isSafeInteger(row.assetId) || !row.assetId || row.assetId <= 0) {
    return null;
  }
  const [asset] = await db
    .select({
      ownerUserId: assetsTable.ownerUserId,
      productScope: assetsTable.productScope,
      state: assetsTable.state,
      storageKey: assetsTable.storageKey,
      sizeBytes: assetsTable.sizeBytes,
    })
    .from(assetsTable)
    .where(and(eq(assetsTable.id, row.assetId), isNull(assetsTable.deletedAt)))
    .limit(1);
  if (!isOwnedReadyAssetForProduct(asset, row.userId, "ora")) return null;
  return readAssetBuffer(asset.storageKey, Math.max(1, Number(asset.sizeBytes)));
}

/**
 * Load the raw bytes of one owner-scoped, non-deleted library asset. Used by
 * the durable file-context rehydration path so layout-preserving Office edits
 * keep working after the in-memory upload entry expires or the server
 * restarts. Returns null when the asset is missing, deleted, foreign, or its
 * bytes are unavailable from both R2 and the DB.
 */
export async function getOraAssetBytes(assetId: number, userId: string): Promise<Buffer | null> {
  try {
    const [row] = await db
      .select({
        userId: oraAssetsTable.userId,
        assetId: oraAssetsTable.assetId,
        storageKey: oraAssetsTable.storageKey,
        data: oraAssetsTable.data,
        sizeBytes: oraAssetsTable.sizeBytes,
        deletedAt: oraAssetsTable.deletedAt,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.id, assetId),
          eq(oraAssetsTable.userId, userId),
          oraAssetProductScopePredicate(),
        ),
      );
    if (!row || row.deletedAt) return null;
    return await resolveOraAssetRowBytes(row);
  } catch (err) {
    logger.error({ component: "ora-assets", err, assetId }, "Failed to load Ora asset bytes");
    return null;
  }
}

export interface PersistOraAssetInput {
  userId: string;
  /**
   * Ora project this asset belongs to. Null/omitted = the user's Personal
   * space. Revisions of an existing chain should inherit the parent's project
   * (see getNextVersionLineage) so a version chain never splits across
   * projects.
   */
  oraProjectId?: number | null;
  kind: OraAssetKind;
  fileName: string;
  mimeType: string;
  /** Short format tag (e.g. "xlsx", "png"). Optional. */
  format?: string | null;
  /** The originating prompt / description, for the library list. Optional. */
  prompt?: string | null;
  /** Raw base64 (NO `data:` prefix). Required unless unifiedAssetId is set. */
  base64?: string;
  /**
   * A ready account-wide asset that already owns these exact bytes. This is
   * used by Ora image generation so Library metadata never uploads a duplicate
   * physical object.
   */
  unifiedAssetId?: number;
  // ── File revision lineage (all optional; omitted = standalone v1) ────────
  /** The v1 root asset of this version chain (null/omitted for v1 itself). */
  rootAssetId?: number | null;
  /** The immediately-previous version's asset id (null/omitted for v1). */
  parentAssetId?: number | null;
  /** 1-based position within the chain. Defaults to 1. */
  versionNumber?: number | null;
  /** Upload fileRef this chain originated from, when applicable. */
  sourceFileRef?: string | null;
  /** Short human-readable description of what this version changed. */
  editSummary?: string | null;
}

export type OraGeneratedAssetReservation = AssetReservation;

/**
 * Claim the caller's entire currently-available account allowance before a
 * paid generation call. This is deliberately not a per-file cap: the exact
 * output size replaces the reservation at completion, and the only refusal is
 * the account's real aggregate quota. Holding the available balance prevents a
 * concurrent upload from turning an admitted generation into an unstoreable
 * response after provider spend.
 */
export async function reserveOraGeneratedAsset(input: {
  userId: string;
  oraProjectId?: number | null;
  kind: "file" | "image" | "generated";
  source: string;
  fileName: string;
  mimeType: string;
}): Promise<OraGeneratedAssetReservation> {
  const reservation = await reserveAssetAgainstAvailableQuota({
    ownerUserId: input.userId,
    productScope: "ora",
    actorUserId: input.userId,
    projectId: null,
    threadKey: input.oraProjectId ? `ora-project:${input.oraProjectId}` : null,
    scope: "account",
    kind: input.kind,
    source: input.source,
    filename: input.fileName,
    mimeType: input.mimeType,
    context: { oraProjectId: input.oraProjectId ?? null },
  });
  try {
    const claim = await beginAssetUpload({ assetId: reservation.id, actorUserId: input.userId });
    if (!claim) throw new AssetAdmissionError("asset_storage_unavailable", 503);
    return reservation;
  } catch (error) {
    await rejectReservedAsset({
      assetId: reservation.id,
      ownerUserId: input.userId,
      actorUserId: input.userId,
      code: "asset_storage_unavailable",
    }).catch(() => undefined);
    throw error;
  }
}

/** Release a pre-provider generation reservation after a provider/build failure. */
export async function cancelOraGeneratedAsset(
  reservation: OraGeneratedAssetReservation,
  userId: string,
): Promise<void> {
  const readCanonicalReservation = async () => {
    const [asset] = await db
      .select({
        ownerUserId: assetsTable.ownerUserId,
        actorUserId: assetsTable.actorUserId,
        productScope: assetsTable.productScope,
        state: assetsTable.state,
        storageBackend: assetsTable.storageBackend,
        storageKey: assetsTable.storageKey,
        deletedAt: assetsTable.deletedAt,
      })
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.id, reservation.id),
          eq(assetsTable.ownerUserId, userId),
          eq(assetsTable.actorUserId, userId),
          eq(assetsTable.productScope, "ora"),
          eq(assetsTable.storageBackend, "r2"),
          eq(assetsTable.storageKey, reservation.storageKey),
        ),
      )
      .limit(1);
    return asset;
  };
  const matchesReservation = (
    asset: Awaited<ReturnType<typeof readCanonicalReservation>> | undefined,
  ): boolean =>
    asset !== undefined &&
    asset.ownerUserId === userId &&
    asset.actorUserId === userId &&
    asset.productScope === "ora" &&
    asset.storageBackend === "r2" &&
    asset.storageKey.length > 0 &&
    asset.storageKey === reservation.storageKey;

  try {
    const before = await readCanonicalReservation();
    if (!before || !matchesReservation(before)) return;
    if (before.state !== "rejected") {
      if (
        (before.state !== "reserved" && before.state !== "uploading") ||
        before.deletedAt !== null
      )
        return;
      await rejectReservedAsset({
        assetId: reservation.id,
        ownerUserId: userId,
        actorUserId: userId,
        code: "asset_storage_unavailable",
      });
    }

    // The registry owns the transition and its locks. Do not hold another
    // connection's row lock across it, or mistake a ready winner for rejection.
    const after = await readCanonicalReservation();
    if (!after || !matchesReservation(after) || after.state !== "rejected") return;
    await deleteTrackedAssetStorageObjects([
      { storageBackend: "r2", storageKey: after.storageKey },
    ]);
  } catch {
    // Cancellation is best-effort. Uncertain admission/transition/cleanup
    // retains bytes rather than treating completion denial as delete authority.
  }
}

/**
 * Lineage fields for persisting the NEXT version of an edited uploaded file.
 * Resolves the durable file-context row for (userId, fileRef) to find the
 * current head asset of the chain, then derives parent/root/version for the
 * row about to be inserted. Returns null when there is no linked asset yet —
 * the new asset then starts its own chain as v1. Best-effort: any failure
 * returns null rather than blocking persistence.
 */
export async function getNextVersionLineage(
  userId: string,
  fileRef: string,
): Promise<{
  parentAssetId: number;
  rootAssetId: number;
  versionNumber: number;
  /** Parent's project — new versions must inherit this so chains never split. */
  oraProjectId: number | null;
} | null> {
  try {
    const [ctx] = await db
      .select({ assetId: oraFileContextsTable.assetId })
      .from(oraFileContextsTable)
      .where(
        and(
          eq(oraFileContextsTable.userId, userId),
          eq(oraFileContextsTable.fileRef, fileRef),
          isNull(oraFileContextsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!ctx?.assetId) return null;
    const [head] = await db
      .select({
        id: oraAssetsTable.id,
        rootAssetId: oraAssetsTable.rootAssetId,
        versionNumber: oraAssetsTable.versionNumber,
        oraProjectId: oraAssetsTable.oraProjectId,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.id, ctx.assetId),
          eq(oraAssetsTable.userId, userId),
          oraAssetProductScopePredicate(),
          isNull(oraAssetsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!head) return null;
    return {
      parentAssetId: head.id,
      rootAssetId: head.rootAssetId ?? head.id,
      versionNumber: (head.versionNumber ?? 1) + 1,
      oraProjectId: head.oraProjectId ?? null,
    };
  } catch (err) {
    logger.warn(
      { component: "ora-assets", err, fileRef },
      "Failed to resolve version lineage; persisting as standalone v1",
    );
    return null;
  }
}

/**
 * Lightweight metadata snapshot for one owner-scoped, non-deleted asset.
 * Used to resolve the file name, format, and project when the caller already
 * has an assetId (e.g. the active-artifact revision path).
 */
export async function getOraAssetMeta(
  assetId: number,
  userId: string,
): Promise<{
  fileName: string;
  mimeType: string;
  format: string | null;
  oraProjectId: number | null;
} | null> {
  try {
    const [row] = await db
      .select({
        fileName: oraAssetsTable.fileName,
        mimeType: oraAssetsTable.mimeType,
        format: oraAssetsTable.format,
        oraProjectId: oraAssetsTable.oraProjectId,
        deletedAt: oraAssetsTable.deletedAt,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.id, assetId),
          eq(oraAssetsTable.userId, userId),
          oraAssetProductScopePredicate(),
        ),
      );
    if (!row || row.deletedAt) return null;
    return {
      fileName: row.fileName,
      mimeType: row.mimeType,
      format: row.format,
      oraProjectId: row.oraProjectId,
    };
  } catch (err) {
    logger.error({ component: "ora-assets", err, assetId }, "Failed to load Ora asset metadata");
    return null;
  }
}

/**
 * Lineage fields for persisting the NEXT version of an asset when the caller
 * already has the parent assetId (e.g. generated-file revisions where no
 * upload fileRef exists). Unlike getNextVersionLineage this skips the
 * oraFileContexts lookup and queries the asset row directly. Best-effort:
 * failures return null so persistence falls back to standalone v1.
 */
export async function getNextVersionLineageFromAssetId(
  userId: string,
  parentAssetId: number,
): Promise<{
  parentAssetId: number;
  rootAssetId: number;
  versionNumber: number;
  oraProjectId: number | null;
} | null> {
  try {
    const [head] = await db
      .select({
        id: oraAssetsTable.id,
        rootAssetId: oraAssetsTable.rootAssetId,
        versionNumber: oraAssetsTable.versionNumber,
        oraProjectId: oraAssetsTable.oraProjectId,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.id, parentAssetId),
          eq(oraAssetsTable.userId, userId),
          oraAssetProductScopePredicate(),
          isNull(oraAssetsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!head) return null;
    return {
      parentAssetId: head.id,
      rootAssetId: head.rootAssetId ?? head.id,
      versionNumber: (head.versionNumber ?? 1) + 1,
      oraProjectId: head.oraProjectId ?? null,
    };
  } catch (err) {
    logger.warn(
      { component: "ora-assets", err, parentAssetId },
      "Failed to resolve version lineage from assetId; persisting as standalone v1",
    );
    return null;
  }
}

/**
 * Strip an optional `data:<mime>;base64,` prefix and return the raw base64 plus
 * the embedded mime type (if present). Image generation may hand us either a
 * data URI or a remote URL; only data URIs are persistable here.
 */
export function parseDataUri(src: string): { base64: string; mimeType?: string } | null {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(src);
  if (!match) return null;
  const isBase64 = /;base64,/.test(src.slice(0, src.indexOf(",") + 8));
  if (!isBase64) return null;
  return { base64: match[2] ?? "", mimeType: match[1] || undefined };
}

async function insertOraLibraryMetadata(
  input: PersistOraAssetInput,
  unifiedAssetId: number,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const asset = await client.query<{
      id: number;
      owner_user_id: string;
      storage_key: string;
      size_bytes: string;
      state: string;
    }>(
      `SELECT id, owner_user_id, storage_key, size_bytes, state
         FROM assets
        WHERE id=$1 AND owner_user_id=$2 AND state='ready'
          AND product_scope='ora' AND deleted_at IS NULL
        FOR SHARE`,
      [unifiedAssetId, input.userId],
    );
    const ready = asset.rows[0];
    if (!ready) throw new AssetAdmissionError("asset_not_found", 404);
    const inserted = await client.query<{ id: number }>(
      `INSERT INTO ora_assets (
         user_id, ora_project_id, kind, file_name, mime_type, format, prompt,
         data, storage_key, asset_id, size_bytes, root_asset_id, parent_asset_id,
         version_number, source_file_ref, edit_summary
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12,$13,$14,$15)
        ON CONFLICT (asset_id) WHERE asset_id IS NOT NULL
        DO UPDATE SET asset_id=EXCLUDED.asset_id
        WHERE ora_assets.user_id=EXCLUDED.user_id
          AND ora_assets.ora_project_id IS NOT DISTINCT FROM EXCLUDED.ora_project_id
        RETURNING id`,
      [
        input.userId,
        input.oraProjectId ?? null,
        input.kind,
        input.fileName,
        input.mimeType,
        input.format ?? null,
        input.prompt ?? null,
        ready.storage_key,
        unifiedAssetId,
        Number(ready.size_bytes),
        input.rootAssetId ?? null,
        input.parentAssetId ?? null,
        input.versionNumber ?? 1,
        input.sourceFileRef ?? null,
        input.editSummary ?? null,
      ],
    );
    const oraAssetId = inserted.rows[0]?.id;
    if (oraAssetId === undefined) throw new AssetAdmissionError("asset_not_found", 404);
    await client.query(
      `INSERT INTO asset_usage (asset_id, consumer)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [unifiedAssetId, `ora-library:${oraAssetId}`],
    );
    await client.query("COMMIT");
    return oraAssetId;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the typed admission/storage failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Commit bytes into a pre-provider reservation, reconcile it to exact size,
 * and create the Ora Library metadata link without a second object write.
 */
export async function completeOraGeneratedAsset(input: {
  reservation: OraGeneratedAssetReservation;
  asset: Omit<PersistOraAssetInput, "base64" | "unifiedAssetId">;
  base64: string;
}): Promise<number> {
  const [reserved] = await db
    .select({ id: assetsTable.id, storageKey: assetsTable.storageKey })
    .from(assetsTable)
    .where(
      and(
        eq(assetsTable.id, input.reservation.id),
        eq(assetsTable.ownerUserId, input.asset.userId),
        eq(assetsTable.productScope, "ora"),
        eq(assetsTable.state, "uploading"),
        isNull(assetsTable.deletedAt),
      ),
    )
    .limit(1);
  if (!reserved || reserved.storageKey !== input.reservation.storageKey) {
    throw new AssetAdmissionError("asset_not_found", 404);
  }
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.length === 0) {
    await cancelOraGeneratedAsset(input.reservation, input.asset.userId);
    throw new AssetAdmissionError("asset_empty", 400);
  }
  let completed = false;
  try {
    await putAssetBuffer({
      key: input.reservation.storageKey,
      body: bytes,
      contentType: input.asset.mimeType,
    });
    await completeAsset({
      assetId: input.reservation.id,
      ownerUserId: input.asset.userId,
      actorUserId: input.asset.userId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      scanState: "not-required",
      finalSizeBytes: bytes.length,
      finalMimeType: input.asset.mimeType,
    });
    completed = true;
    return await insertOraLibraryMetadata(input.asset, input.reservation.id);
  } catch (error) {
    if (completed) {
      try {
        const pending = await deleteReadyAsset({
          assetId: input.reservation.id,
          userId: input.asset.userId,
        });
        await deleteTrackedAssetStorageObjects(pending.storageObjects);
        await recordAssetDeleted({
          assetId: input.reservation.id,
          userId: input.asset.userId,
          sizeBytes: pending.sizeBytes,
        });
      } catch (cleanupError) {
        logger.error(
          {
            component: "ora-assets",
            errorClass: cleanupError instanceof Error ? cleanupError.name : "unknown",
          },
          "Generated Ora asset cleanup remains pending",
        );
      }
    } else {
      await cancelOraGeneratedAsset(input.reservation, input.asset.userId);
    }
    throw error;
  }
}

/**
 * Strict Ora persistence used by request paths that must tell the truth about
 * quota or storage failure. New bytes are admitted to the account-wide 500 MB
 * registry before any R2 write. When a caller already owns a ready unified
 * asset, this function creates only Ora Library metadata: zero duplicate R2
 * writes and zero duplicate quota.
 */
export async function persistOraAssetStrict(input: PersistOraAssetInput): Promise<number> {
  if (input.unifiedAssetId !== undefined) {
    return insertOraLibraryMetadata(input, input.unifiedAssetId);
  }
  if (!input.base64) throw new AssetAdmissionError("asset_empty", 400);
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.length === 0) throw new AssetAdmissionError("asset_empty", 400);

  const reservation = await reserveAsset({
    ownerUserId: input.userId,
    productScope: "ora",
    actorUserId: input.userId,
    projectId: null,
    threadKey: input.oraProjectId ? `ora-project:${input.oraProjectId}` : null,
    scope: "account",
    kind: input.kind,
    source: "ora-library",
    filename: input.fileName,
    mimeType: input.mimeType,
    sizeBytes: bytes.length,
    context: { oraProjectId: input.oraProjectId ?? null },
  });
  let completed = false;
  try {
    const claim = await beginAssetUpload({ assetId: reservation.id, actorUserId: input.userId });
    if (!claim) throw new AssetAdmissionError("asset_storage_unavailable", 503);
    await putAssetBuffer({ key: reservation.storageKey, body: bytes, contentType: input.mimeType });
    await completeAsset({
      assetId: reservation.id,
      ownerUserId: input.userId,
      actorUserId: input.userId,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      scanState: "not-required",
      finalSizeBytes: bytes.length,
      finalMimeType: input.mimeType,
    });
    completed = true;
    return await insertOraLibraryMetadata(input, reservation.id);
  } catch (error) {
    if (completed) {
      try {
        const pending = await deleteReadyAsset({ assetId: reservation.id, userId: input.userId });
        await deleteTrackedAssetStorageObjects(pending.storageObjects);
        await recordAssetDeleted({
          assetId: reservation.id,
          userId: input.userId,
          sizeBytes: pending.sizeBytes,
        });
      } catch (cleanupError) {
        logger.error(
          {
            component: "ora-assets",
            errorClass: cleanupError instanceof Error ? cleanupError.name : "unknown",
          },
          "Ora metadata failure left a durable asset cleanup pending",
        );
      }
    } else {
      await rejectReservedAsset({
        assetId: reservation.id,
        ownerUserId: input.userId,
        actorUserId: input.userId,
        code: "asset_storage_unavailable",
      }).catch(() => undefined);
      await deleteTrackedAssetStorageObjects([
        { storageBackend: "r2", storageKey: reservation.storageKey },
      ]).catch(() => undefined);
    }
    throw error;
  }
}

/** Best-effort compatibility wrapper for non-blocking generation surfaces. */
export async function persistOraAsset(input: PersistOraAssetInput): Promise<number | null> {
  try {
    return await persistOraAssetStrict(input);
  } catch (err) {
    logger.error(
      { component: "ora-assets", errorClass: err instanceof Error ? err.name : "unknown" },
      "Failed to persist Ora asset",
    );
    return null;
  }
}

export type DeleteOraAssetResult =
  | "deleted"
  | "retained"
  | "cleanup-pending"
  | "referenced"
  | "not-found";

/**
 * Remove one Ora Library entry without hiding billed bytes. Direct Ora
 * references block the delete; other registry references retain the physical
 * object. Unreferenced objects enter the shared durable deletion state machine
 * and release account quota only after provider deletion succeeds.
 */
export async function deleteOraAsset(input: {
  oraAssetId: number;
  userId: string;
}): Promise<DeleteOraAssetResult> {
  const client = await pool.connect();
  let unifiedAssetId: number | null;
  let legacyStorageKey: string | null;
  try {
    await client.query("BEGIN");
    const selected = await client.query<{
      asset_id: number | null;
      storage_key: string | null;
      referenced: boolean;
    }>(
      `SELECT ora.asset_id,
              ora.storage_key,
              (
                EXISTS (
                  SELECT 1 FROM ora_file_contexts ctx
                   WHERE ctx.asset_id=ora.id AND ctx.deleted_at IS NULL
                )
                OR EXISTS (SELECT 1 FROM brand_kits kit WHERE kit.logo_asset_id=ora.id)
                OR EXISTS (
                   SELECT 1 FROM support_tickets ticket
                    WHERE ticket.user_id=ora.user_id
                      AND (
                        ticket.attachments::text LIKE
                          '%/api/ora/assets/' || ora.id::text || '/download%'
                        OR ticket.transcript::text LIKE
                          '%/api/ora/assets/' || ora.id::text || '/download%'
                      )
                 )
              ) AS referenced
         FROM ora_assets ora
         WHERE ora.id=$1 AND ora.user_id=$2 AND ora.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM assets owned
              WHERE owned.id=ora.asset_id AND owned.owner_user_id=ora.user_id
                AND owned.product_scope='ora'
           )
         FOR UPDATE`,
      [input.oraAssetId, input.userId],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return "not-found";
    }
    if (row.referenced) {
      await client.query("ROLLBACK");
      return "referenced";
    }
    unifiedAssetId = row.asset_id;
    legacyStorageKey = row.storage_key;
    await client.query(`UPDATE ora_assets SET deleted_at=NOW() WHERE id=$1`, [input.oraAssetId]);
    if (unifiedAssetId !== null) {
      await client.query(`DELETE FROM asset_usage WHERE asset_id=$1 AND consumer=$2`, [
        unifiedAssetId,
        `ora-library:${input.oraAssetId}`,
      ]);
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

  if (unifiedAssetId === null) {
    if (legacyStorageKey) {
      try {
        await deleteTrackedAssetStorageObjects([
          { storageBackend: "r2", storageKey: legacyStorageKey },
        ]);
      } catch {
        return "cleanup-pending";
      }
    }
    return "deleted";
  }

  try {
    const pending = await deleteReadyAsset({ assetId: unifiedAssetId, userId: input.userId });
    await deleteTrackedAssetStorageObjects(pending.storageObjects);
    await recordAssetDeleted({
      assetId: unifiedAssetId,
      userId: input.userId,
      sizeBytes: pending.sizeBytes,
    });
    return "deleted";
  } catch (error) {
    if (error instanceof AssetAdmissionError && error.code === "asset_referenced") {
      return "retained";
    }
    return "cleanup-pending";
  }
}
