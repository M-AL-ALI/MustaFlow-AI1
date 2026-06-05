import { Router } from "express";
import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { db, oraAssetsTable } from "@workspace/db";
import { PER_USER_STORAGE_BYTES, getUserStorageBytes } from "../lib/ora-assets";
import { logger } from "../lib/logger";

const router = Router();

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

/**
 * Durable Ora asset library (Task #1278). Lists, downloads, and soft-deletes
 * assets (generated files + images) owned by the signed-in user. Mounted behind
 * the auth wall, so `req.userId` is always present. The heavy base64 `data`
 * column is never returned by the list endpoint — only the download stream.
 */

// List the user's assets, newest first. Excludes the `data` blob. Paginated via
// `?limit=&offset=`; also returns the total count, a hasMore flag, and the
// user's storage usage against the per-user cap so the UI can show both.
router.get("/ora/assets", async (req, res) => {
  const userId = req.userId!;

  const rawLimit = Number(req.query.limit);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
  const rawOffset = Number(req.query.offset);
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0;

  const ownership = and(eq(oraAssetsTable.userId, userId), isNull(oraAssetsTable.deletedAt));

  try {
    const [rows, [countRow], usedBytes] = await Promise.all([
      db
        .select({
          id: oraAssetsTable.id,
          kind: oraAssetsTable.kind,
          fileName: oraAssetsTable.fileName,
          mimeType: oraAssetsTable.mimeType,
          format: oraAssetsTable.format,
          prompt: oraAssetsTable.prompt,
          sizeBytes: oraAssetsTable.sizeBytes,
          createdAt: oraAssetsTable.createdAt,
        })
        .from(oraAssetsTable)
        .where(ownership)
        .orderBy(desc(oraAssetsTable.createdAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`COUNT(*)` })
        .from(oraAssetsTable)
        .where(ownership),
      getUserStorageBytes(userId),
    ]);

    const total = Number(countRow?.count ?? 0);

    res.json({
      assets: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        fileName: r.fileName,
        mimeType: r.mimeType,
        format: r.format,
        prompt: r.prompt,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt.toISOString(),
      })),
      total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      storage: {
        usedBytes,
        capBytes: PER_USER_STORAGE_BYTES,
      },
    });
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to list Ora assets");
    res.status(500).json({ error: "Failed to load your library" });
  }
});

// Stream the raw bytes for one asset. Owner-scoped. Defaults to inline display
// (so an <img> can render it); `?download=1` forces an attachment download.
router.get("/ora/assets/:id/download", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }
  try {
    const [row] = await db
      .select()
      .from(oraAssetsTable)
      .where(and(eq(oraAssetsTable.id, id), eq(oraAssetsTable.userId, userId)));

    if (!row || row.deletedAt) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const buf = Buffer.from(row.data, "base64");
    const disposition = req.query.download === "1" ? "attachment" : "inline";
    const safeName = row.fileName.replace(/[\r\n"]/g, "_");
    res.setHeader("Content-Type", row.mimeType);
    res.setHeader("Content-Disposition", `${disposition}; filename="${safeName}"`);
    res.setHeader("Content-Length", String(buf.length));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.end(buf);
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to download Ora asset");
    res.status(500).json({ error: "Failed to download asset" });
  }
});

// Soft-delete an asset. Owner-scoped.
router.delete("/ora/assets/:id", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }
  try {
    const result = await db
      .update(oraAssetsTable)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(oraAssetsTable.id, id),
          eq(oraAssetsTable.userId, userId),
          isNull(oraAssetsTable.deletedAt),
        ),
      )
      .returning({ id: oraAssetsTable.id });

    if (result.length === 0) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to delete Ora asset");
    res.status(500).json({ error: "Failed to delete asset" });
  }
});

export default router;
