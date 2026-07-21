import { randomUUID } from "node:crypto";
import { db, oraAssetsTable, oraFileContextsTable, type OraAssetKind } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";
import { r2Enabled, r2GetObject, r2PutObject } from "./cloudflare";

/**
 * R2 offload is opt-in via `ORA_ASSETS_R2_ENABLED=true` AND configured R2
 * credentials (`r2Enabled()`). The flag is intentional: CF R2 credentials may
 * already be present for snapshot serving, but offloading Ora bytes is a
 * separate, additive decision. When the flag is off, bytes stay base64 in the
 * DB exactly as before — preserving prior behavior in dev and existing tests.
 */
export function oraR2OffloadEnabled(): boolean {
  return process.env.ORA_ASSETS_R2_ENABLED === "true" && r2Enabled();
}

/**
 * Largest asset we will persist to the durable Ora library. Generated files and
 * standard-quality images comfortably fit; anything larger is skipped (the
 * in-chat copy still works) rather than bloating the table.
 */
const MAX_ASSET_BYTES = 100 * 1024 * 1024; // 100 MB of decoded bytes (matches the upload cap)

/**
 * Per-user total storage cap for the durable Ora library. The base64 `data`
 * blobs live in Postgres, so an unbounded library would grow the table without
 * limit. When a user is at/over this cap we skip persisting (the in-chat copy
 * still works) and surface a clear reason via the returned result.
 */
export const PER_USER_STORAGE_BYTES = 200 * 1024 * 1024; // 200 MB of decoded bytes per user

/**
 * Sum the decoded bytes of a user's live (non-deleted) library assets.
 */
export async function getUserStorageBytes(userId: string): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${oraAssetsTable.sizeBytes}), 0)`,
    })
    .from(oraAssetsTable)
    .where(and(eq(oraAssetsTable.userId, userId), isNull(oraAssetsTable.deletedAt)));
  return Number(row?.total ?? 0);
}

/**
 * Resolve the raw bytes for an already-loaded Ora asset row. R2 is tried first
 * when a storage key is present; on a miss we fall back to the DB `data` blob
 * if it exists so a partial migration can never strand an asset. Returns null
 * when neither source yields bytes.
 */
export async function resolveOraAssetRowBytes(row: {
  storageKey: string | null;
  data: string | null;
}): Promise<Buffer | null> {
  let buf: Buffer | null = null;
  if (row.storageKey) {
    const obj = await r2GetObject(row.storageKey);
    if (obj) buf = obj.body;
  }
  if (!buf && row.data) buf = Buffer.from(row.data, "base64");
  return buf;
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
        storageKey: oraAssetsTable.storageKey,
        data: oraAssetsTable.data,
        deletedAt: oraAssetsTable.deletedAt,
      })
      .from(oraAssetsTable)
      .where(and(eq(oraAssetsTable.id, assetId), eq(oraAssetsTable.userId, userId)));
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
  /** Raw base64 (NO `data:` prefix). */
  base64: string;
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

/**
 * Persist a generated asset to the durable Ora library. Best-effort: this never
 * throws into the request path — a failure to save to the library must not break
 * the user's in-chat generation. Returns the new asset id, or null on skip/fail.
 */
export async function persistOraAsset(input: PersistOraAssetInput): Promise<number | null> {
  try {
    const sizeBytes = Buffer.byteLength(input.base64, "base64");
    if (sizeBytes === 0) return null;
    if (sizeBytes > MAX_ASSET_BYTES) {
      logger.warn(
        { component: "ora-assets", sizeBytes, fileName: input.fileName },
        "Skipping oversized Ora asset",
      );
      return null;
    }
    const usedBytes = await getUserStorageBytes(input.userId);
    if (usedBytes + sizeBytes > PER_USER_STORAGE_BYTES) {
      logger.warn(
        {
          component: "ora-assets",
          userId: input.userId,
          usedBytes,
          sizeBytes,
          capBytes: PER_USER_STORAGE_BYTES,
        },
        "Skipping Ora asset: per-user storage quota exceeded",
      );
      return null;
    }
    // R2 offload (opt-in). On success, bytes live in R2 and `data` is null. On
    // any failure we fall back to the DB path so persistence never silently
    // drops the asset.
    let storageKey: string | null = null;
    let data: string | null = input.base64;
    if (oraR2OffloadEnabled()) {
      // Guard the upload so a thrown r2PutObject can never drop the asset — any
      // failure (returned false OR exception) leaves data=base64 (DB fallback).
      try {
        const ext = (input.format ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
        const key = `ora-assets/${input.userId}/${randomUUID()}${ext ? `.${ext}` : ""}`;
        const uploaded = await r2PutObject(
          key,
          Buffer.from(input.base64, "base64"),
          input.mimeType,
          "private, max-age=300",
        );
        if (uploaded) {
          storageKey = key;
          data = null;
        } else {
          logger.warn(
            { component: "ora-assets", userId: input.userId, fileName: input.fileName },
            "R2 offload failed; falling back to DB storage for Ora asset",
          );
        }
      } catch (err) {
        logger.warn(
          { component: "ora-assets", err, userId: input.userId, fileName: input.fileName },
          "R2 offload threw; falling back to DB storage for Ora asset",
        );
      }
    }

    const [row] = await db
      .insert(oraAssetsTable)
      .values({
        userId: input.userId,
        oraProjectId: input.oraProjectId ?? null,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        format: input.format ?? null,
        prompt: input.prompt ?? null,
        data,
        storageKey,
        sizeBytes,
        rootAssetId: input.rootAssetId ?? null,
        parentAssetId: input.parentAssetId ?? null,
        versionNumber: input.versionNumber ?? 1,
        sourceFileRef: input.sourceFileRef ?? null,
        editSummary: input.editSummary ?? null,
      })
      .returning({ id: oraAssetsTable.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to persist Ora asset");
    return null;
  }
}
