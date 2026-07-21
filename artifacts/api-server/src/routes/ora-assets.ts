import { Router } from "express";
import { and, eq, isNull, desc, asc, or, sql } from "drizzle-orm";
import { db, oraAssetsTable, type OraAssetKind } from "@workspace/db";
import {
  PER_USER_STORAGE_BYTES,
  getUserStorageBytes,
  resolveOraAssetRowBytes,
  persistOraAsset,
} from "../lib/ora-assets";
import { relinkFileContextAfterRestore } from "../lib/public-ai/file-context-store";
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

    // Resolve bytes from R2 (offloaded assets) or the DB base64 blob via the
    // shared helper (R2-first, DB fallback) so this route and the durable
    // file-context rehydration path can never drift apart.
    const buf = await resolveOraAssetRowBytes(row);
    if (!buf) {
      logger.error(
        { component: "ora-assets", id, storageKey: row.storageKey },
        "Asset bytes unavailable from both R2 and DB",
      );
      res.status(502).json({ error: "Asset temporarily unavailable" });
      return;
    }

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

/**
 * The full version chain an asset belongs to, identified by its v1 root:
 * `COALESCE(root_asset_id, id)`. Owner-scoped and metadata-only (never the
 * `data` blob). Any member of the chain can be used as the anchor `:id`.
 */
router.get("/ora/assets/:id/versions", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }
  try {
    const [anchor] = await db
      .select({
        id: oraAssetsTable.id,
        rootAssetId: oraAssetsTable.rootAssetId,
        deletedAt: oraAssetsTable.deletedAt,
      })
      .from(oraAssetsTable)
      .where(and(eq(oraAssetsTable.id, id), eq(oraAssetsTable.userId, userId)));
    if (!anchor || anchor.deletedAt) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const chainRoot = anchor.rootAssetId ?? anchor.id;
    const rows = await db
      .select({
        id: oraAssetsTable.id,
        fileName: oraAssetsTable.fileName,
        mimeType: oraAssetsTable.mimeType,
        format: oraAssetsTable.format,
        sizeBytes: oraAssetsTable.sizeBytes,
        versionNumber: oraAssetsTable.versionNumber,
        parentAssetId: oraAssetsTable.parentAssetId,
        editSummary: oraAssetsTable.editSummary,
        createdAt: oraAssetsTable.createdAt,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.userId, userId),
          isNull(oraAssetsTable.deletedAt),
          or(eq(oraAssetsTable.id, chainRoot), eq(oraAssetsTable.rootAssetId, chainRoot)),
        ),
      )
      .orderBy(asc(oraAssetsTable.versionNumber), asc(oraAssetsTable.id));

    const currentAssetId = rows.length > 0 ? rows[rows.length - 1].id : chainRoot;
    res.json({
      rootAssetId: chainRoot,
      currentAssetId,
      versions: rows.map((r) => ({
        id: r.id,
        fileName: r.fileName,
        mimeType: r.mimeType,
        format: r.format,
        sizeBytes: r.sizeBytes,
        versionNumber: r.versionNumber,
        editSummary: r.editSummary,
        createdAt: r.createdAt.toISOString(),
        isCurrent: r.id === currentAssetId,
      })),
    });
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to list Ora asset versions");
    res.status(500).json({ error: "Failed to load version history" });
  }
});

/**
 * Restore an older version as the NEW current version (append-only — history
 * is never rewritten). Copies the old version's bytes into a brand-new asset
 * row at the head of the chain (never sharing a storageKey), then AWAITS the
 * durable file-context relink so follow-up edits — in the live session and
 * after restarts — compound on the restored bytes.
 */
router.post("/ora/assets/:id/restore", async (req, res) => {
  const userId = req.userId!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid asset id" });
    return;
  }
  try {
    const [target] = await db
      .select()
      .from(oraAssetsTable)
      .where(and(eq(oraAssetsTable.id, id), eq(oraAssetsTable.userId, userId)));
    if (!target || target.deletedAt) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }

    const chainRoot = target.rootAssetId ?? target.id;
    const [head] = await db
      .select({
        id: oraAssetsTable.id,
        versionNumber: oraAssetsTable.versionNumber,
        sourceFileRef: oraAssetsTable.sourceFileRef,
      })
      .from(oraAssetsTable)
      .where(
        and(
          eq(oraAssetsTable.userId, userId),
          isNull(oraAssetsTable.deletedAt),
          or(eq(oraAssetsTable.id, chainRoot), eq(oraAssetsTable.rootAssetId, chainRoot)),
        ),
      )
      .orderBy(desc(oraAssetsTable.versionNumber), desc(oraAssetsTable.id))
      .limit(1);
    if (!head) {
      res.status(404).json({ error: "Asset not found" });
      return;
    }
    if (head.id === target.id) {
      res.status(409).json({ error: "This is already the current version" });
      return;
    }

    // Re-materialize the old version's bytes and persist them as a NEW asset.
    // persistOraAsset re-uploads to R2 under a fresh key (or stores base64),
    // so no two versions ever share a storageKey — deleting one can never
    // strand another.
    const bytes = await resolveOraAssetRowBytes(target);
    if (!bytes || bytes.length === 0) {
      logger.error(
        { component: "ora-assets", id, storageKey: target.storageKey },
        "Restore failed: version bytes unavailable from both R2 and DB",
      );
      res.status(502).json({ error: "This version's file is temporarily unavailable" });
      return;
    }

    const newAssetId = await persistOraAsset({
      userId,
      kind: target.kind as OraAssetKind,
      fileName: target.fileName,
      mimeType: target.mimeType,
      format: target.format,
      prompt: target.prompt,
      base64: bytes.toString("base64"),
      rootAssetId: chainRoot,
      parentAssetId: head.id,
      versionNumber: (head.versionNumber ?? 1) + 1,
      sourceFileRef: head.sourceFileRef ?? target.sourceFileRef ?? null,
      editSummary: `Restored version ${target.versionNumber ?? 1}`,
    });
    if (newAssetId == null) {
      // persistOraAsset returns null on failure OR storage-quota skip.
      res.status(507).json({
        error: "Could not save the restored version — your library storage may be full.",
      });
      return;
    }

    // AWAITED relink (not the fire-and-forget edit-path helper): repoint the
    // durable file context and any live in-memory entry at the restored bytes
    // before responding, so nothing compounds on the pre-restore version.
    const fileRef = head.sourceFileRef ?? target.sourceFileRef;
    let relinked = false;
    if (fileRef && target.kind === "file") {
      relinked = await relinkFileContextAfterRestore({
        userId,
        fileRef,
        assetId: newAssetId,
        bytes,
      });
    }

    res.json({
      ok: true,
      assetId: newAssetId,
      versionNumber: (head.versionNumber ?? 1) + 1,
      restoredFromVersion: target.versionNumber ?? 1,
      fileName: target.fileName,
      relinked,
    });
  } catch (err) {
    logger.error({ component: "ora-assets", err }, "Failed to restore Ora asset version");
    res.status(500).json({ error: "Failed to restore this version" });
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
