import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectFilesTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { extractPageMap } from "../lib/page-map";
import { writeFileToContainer } from "../lib/container";
import { logger } from "../lib/logger";
import { parseBlocks, reorderBlocks, removeBlock, insertBlock } from "../lib/blocks";

const router: IRouter = Router();

function isHtmlFile(path: string, mime: string | null): boolean {
  if (mime === "text/html") return true;
  const p = path.toLowerCase();
  return p.endsWith(".html") || p.endsWith(".htm");
}

/**
 * After a block-level rewrite, mirror the same side effects as the regular
 * file PATCH route: re-extract the page map and forward the new contents to
 * the live container (both best-effort and non-fatal).
 */
function fireSideEffects(projectId: number, filePath: string, newContent: string): void {
  extractPageMap(projectId).catch((err: unknown) => {
    logger.warn({ err, projectId }, "page map re-extraction failed after block edit");
  });
  setImmediate(() => {
    db.select({
      containerId: projectsTable.containerId,
      containerStatus: projectsTable.containerStatus,
    })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId))
      .then(([project]) => {
        if (project?.containerId && project.containerStatus === "running") {
          void writeFileToContainer(project.containerId, filePath, newContent, projectId);
        }
      })
      .catch((err: unknown) => {
        logger.warn({ err, projectId, path: filePath }, "container sync failed after block edit");
      });
  });
}

async function loadHtmlFile(projectId: number, fileId: number) {
  const [row] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
  if (!row) return { row: null as null, error: "File not found" as const, status: 404 as const };
  if (!isHtmlFile(row.path, row.mimeType)) {
    return {
      row: null as null,
      error: "Only HTML files have blocks" as const,
      status: 400 as const,
    };
  }
  return { row, error: null as null, status: 200 as const };
}

/** GET /projects/:id/files/:fileId/blocks — list the parsed top-level blocks. */
router.get(
  "/projects/:id/files/:fileId/blocks",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const { row, error, status } = await loadHtmlFile(projectId, fileId);
    if (!row) {
      res.status(status).json({ error });
      return;
    }
    const { blocks, parseOk } = parseBlocks(row.content);
    res.json({
      fileId: row.id,
      filePath: row.path,
      parseOk,
      blocks: blocks.map((b) => ({
        id: b.id,
        tag: b.tag,
        label: b.label,
        textSnippet: b.textSnippet,
      })),
    });
  },
);

/**
 * POST /projects/:id/files/:fileId/blocks/reorder
 * Body: { order: string[] } — block IDs in the desired final order.
 */
router.post(
  "/projects/:id/files/:fileId/blocks/reorder",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const order = (req.body as { order?: unknown })?.order;
    if (!Array.isArray(order) || order.some((x) => typeof x !== "string")) {
      res.status(400).json({ error: "order must be string[]" });
      return;
    }
    const { row, error, status } = await loadHtmlFile(projectId, fileId);
    if (!row) {
      res.status(status).json({ error });
      return;
    }
    const next = reorderBlocks(row.content, order as string[]);
    if (next === row.content) {
      res.json({ changed: false, fileId: row.id });
      return;
    }
    await db
      .update(projectFilesTable)
      .set({ content: next, updatedAt: new Date() })
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    req.log.info({ projectId, fileId }, "Block reorder saved");
    fireSideEffects(projectId, row.path, next);
    const { blocks, parseOk } = parseBlocks(next);
    res.json({
      changed: true,
      fileId: row.id,
      parseOk,
      blocks: blocks.map((b) => ({
        id: b.id,
        tag: b.tag,
        label: b.label,
        textSnippet: b.textSnippet,
      })),
    });
  },
);

/**
 * POST /projects/:id/blocks/move
 * Body: { sourceFileId, blockId, targetFileId, beforeBlockId? }
 * Moves a block from one HTML file to another.
 */
router.post(
  "/projects/:id/blocks/move",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = req.body as {
      sourceFileId?: unknown;
      blockId?: unknown;
      targetFileId?: unknown;
      beforeBlockId?: unknown;
    };
    const sourceFileId = Number(body.sourceFileId);
    const targetFileId = Number(body.targetFileId);
    const blockId = body.blockId;
    const beforeBlockId =
      typeof body.beforeBlockId === "string" && body.beforeBlockId.length > 0
        ? body.beforeBlockId
        : null;
    if (
      !Number.isFinite(sourceFileId) ||
      !Number.isFinite(targetFileId) ||
      typeof blockId !== "string"
    ) {
      res.status(400).json({ error: "sourceFileId, targetFileId, blockId required" });
      return;
    }
    if (sourceFileId === targetFileId) {
      res.status(400).json({ error: "Use reorder for same-file moves" });
      return;
    }
    const src = await loadHtmlFile(projectId, sourceFileId);
    if (!src.row) {
      res.status(src.status).json({ error: src.error });
      return;
    }
    const dst = await loadHtmlFile(projectId, targetFileId);
    if (!dst.row) {
      res.status(dst.status).json({ error: dst.error });
      return;
    }
    const { html: srcAfter, removed } = removeBlock(src.row.content, blockId);
    if (!removed) {
      res.status(404).json({ error: "Block not found in source file" });
      return;
    }
    const dstAfter = insertBlock(dst.row.content, beforeBlockId, removed);
    if (dstAfter === dst.row.content) {
      res.status(409).json({
        error: "Target file has no anchorable blocks (cannot insert into empty <body>)",
      });
      return;
    }
    // Persist both updates atomically: a cross-file move must never leave the
    // source mutated without the corresponding insert into the target (that
    // would drop the user's content). The row-count assertions inside the
    // transaction also abort the move on a stale/concurrent-delete read so we
    // don't silently no-op the source while still writing the target (which
    // would duplicate the block across files).
    await db.transaction(async (tx) => {
      const srcUpdate = await tx
        .update(projectFilesTable)
        .set({ content: srcAfter, updatedAt: new Date() })
        .where(
          and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, sourceFileId)),
        )
        .returning({ id: projectFilesTable.id });
      if (srcUpdate.length !== 1) {
        throw new Error("Source file changed or was removed during move");
      }
      const dstUpdate = await tx
        .update(projectFilesTable)
        .set({ content: dstAfter, updatedAt: new Date() })
        .where(
          and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, targetFileId)),
        )
        .returning({ id: projectFilesTable.id });
      if (dstUpdate.length !== 1) {
        throw new Error("Target file changed or was removed during move");
      }
    });
    req.log.info({ projectId, sourceFileId, targetFileId, blockId }, "Cross-file block move saved");
    fireSideEffects(projectId, src.row.path, srcAfter);
    fireSideEffects(projectId, dst.row.path, dstAfter);
    res.json({
      sourceFileId,
      targetFileId,
      sourcePath: src.row.path,
      targetPath: dst.row.path,
      movedSnippet: removed,
    });
  },
);

export default router;
