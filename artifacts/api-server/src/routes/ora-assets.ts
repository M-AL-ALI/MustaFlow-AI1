import { Router } from "express";
import { and, eq, isNull, desc } from "drizzle-orm";
import { db, oraAssetsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router = Router();

/**
 * Durable Ora asset library (Task #1278). Lists, downloads, and soft-deletes
 * assets (generated files + images) owned by the signed-in user. Mounted behind
 * the auth wall, so `req.userId` is always present. The heavy base64 `data`
 * column is never returned by the list endpoint — only the download stream.
 */

// List the user's assets, newest first. Excludes the `data` blob.
router.get("/ora/assets", async (req, res) => {
  const userId = req.userId!;
  try {
    const rows = await db
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
      .where(and(eq(oraAssetsTable.userId, userId), isNull(oraAssetsTable.deletedAt)))
      .orderBy(desc(oraAssetsTable.createdAt));

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
