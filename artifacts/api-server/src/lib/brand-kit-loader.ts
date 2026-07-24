/**
 * Loads a user's brand kit from the database and resolves the logo asset bytes
 * so the file builders receive a self-contained BrandKit object.
 *
 * This module IS allowed to import DB — it lives in lib/, not lib/public-ai/,
 * so it stays off the AI-free import boundary used by file-builder.ts itself.
 */
import { db, brandKitsTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import type { BrandKit } from "./public-ai/brand-kit-apply";

/**
 * Returns the resolved BrandKit (with logo bytes, if present) for a user,
 * scoped to their personal space or a specific Ora project. Returns null when
 * no kit exists — callers must generate files exactly as before in that case.
 */
export async function loadBrandKit(
  userId: string,
  oraProjectId: number | null,
): Promise<BrandKit | null> {
  const [row] = await db
    .select()
    .from(brandKitsTable)
    .where(
      oraProjectId != null
        ? and(eq(brandKitsTable.userId, userId), eq(brandKitsTable.oraProjectId, oraProjectId))
        : and(eq(brandKitsTable.userId, userId), isNull(brandKitsTable.oraProjectId)),
    )
    .limit(1);

  if (!row) return null;

  let logoBuf: Buffer | null = null;
  let logoMimeType: string | null = null;

  if (row.logoAssetId != null) {
    try {
      const { getOraAssetBytes, getOraAssetMeta } = await import("./ora-assets");
      const [bytes, meta] = await Promise.all([
        getOraAssetBytes(row.logoAssetId, userId),
        getOraAssetMeta(row.logoAssetId, userId),
      ]);
      logoBuf = bytes;
      logoMimeType = meta?.mimeType ?? null;
    } catch {
      // Logo resolution is best-effort; never block file generation.
    }
  }

  return {
    primaryColor: row.primaryColor,
    secondaryColor: row.secondaryColor,
    accentColor: row.accentColor,
    headingFont: row.headingFont,
    bodyFont: row.bodyFont,
    logoBuf,
    logoMimeType,
  };
}
