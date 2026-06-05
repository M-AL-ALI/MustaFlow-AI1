import { db, oraAssetsTable, type OraAssetKind } from "@workspace/db";
import { logger } from "./logger";

/**
 * Largest asset we will persist to the durable Ora library. Generated files and
 * standard-quality images comfortably fit; anything larger is skipped (the
 * in-chat copy still works) rather than bloating the table.
 */
const MAX_ASSET_BYTES = 12 * 1024 * 1024; // 12 MB of decoded bytes

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
