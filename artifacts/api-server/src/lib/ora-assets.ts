import { db, oraAssetsTable, type OraAssetKind } from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { logger } from "./logger";

/**
 * Largest asset we will persist to the durable Ora library. Generated files and
 * standard-quality images comfortably fit; anything larger is skipped (the
 * in-chat copy still works) rather than bloating the table.
 */
const MAX_ASSET_BYTES = 12 * 1024 * 1024; // 12 MB of decoded bytes

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

export interface PersistOraAssetInput {
  userId: string;
  kind: OraAssetKind;
  fileName: string;
  mimeType: string;
  /** Short format tag (e.g. "xlsx", "png"). Optional. */
  format?: string | null;
  /** The originating prompt / description, for the library list. Optional. */
  prompt?: string | null;
  /** Raw base64 (NO `data:` prefix). */
  base64: string;
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
    const [row] = await db
      .insert(oraAssetsTable)
      .values({
        userId: input.userId,
        kind: input.kind,
        fileName: input.fileName,
        mimeType: input.mimeType,
        format: input.format ?? null,
        prompt: input.prompt ?? null,
        data: input.base64,
        sizeBytes,
      })
      .returning({ id: oraAssetsTable.id });
    return row?.id ?? null;
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to persist Ora asset");
    return null;
  }
}
