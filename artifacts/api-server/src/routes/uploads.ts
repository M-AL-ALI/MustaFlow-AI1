/**
 * Task #540 — Project uploads (drag-drop file uploads).
 *
 * Legacy project uploads remain readable and safely deletable. New uploads use
 * the unified R2 asset registry; the former presigned PUT handoff is closed so
 * no upload can outlive its project lifecycle or bypass account quota/scanning.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { assetsTable, db, pool, projectsTable, projectUploadsTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireProjectOwnership } from "../lib/auth";
import { AssetAdmissionError, deleteReadyAsset, recordAssetDeleted } from "../lib/asset-registry";
import { deleteTrackedAssetStorageObjects } from "../lib/asset-storage-cleanup";
import { isCanonicalProjectUploadContentRequest } from "../lib/asset-contract";
import { openAsset } from "../lib/asset-r2";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
async function legacyUploadIsReferenced(projectId: number, objectPath: string): Promise<boolean> {
  const result = await pool.query<{ referenced: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM chat_messages
        WHERE project_id = $1 AND position($2 in coalesce(attachments::text, '')) > 0
       UNION ALL
       SELECT 1 FROM agent_tasks
        WHERE project_id = $1 AND (
          position($2 in coalesce(attachments::text, '')) > 0
          OR position($2 in coalesce(report::text, '')) > 0
          OR position($2 in coalesce(staging_snapshot::text, '')) > 0
        )
       UNION ALL
       SELECT 1 FROM agent_tool_calls
        WHERE project_id = $1 AND (
          position($2 in coalesce(stdout_preview, '')) > 0
          OR position($2 in coalesce(args_summary, '')) > 0
        )
       UNION ALL
       SELECT 1 FROM project_files
        WHERE project_id = $1 AND position($2 in content) > 0
       UNION ALL
       SELECT 1 FROM project_versions
        WHERE project_id = $1 AND position($2 in coalesce(files_snapshot::text, '')) > 0
       UNION ALL
       SELECT 1 FROM canvas_variants
        WHERE project_id = $1 AND position($2 in coalesce(files::text, '')) > 0
       UNION ALL
       SELECT 1 FROM canvas_variant_library
        WHERE source_project_id = $1 AND position($2 in coalesce(files::text, '')) > 0
       UNION ALL
       SELECT 1 FROM gallery_templates
        WHERE source_project_id = $1 AND position($2 in coalesce(files_snapshot::text, '')) > 0
       UNION ALL
       SELECT 1 FROM agent_inbox
        WHERE project_id = $1 AND position($2 in coalesce(screenshot_url, '')) > 0
       UNION ALL
       SELECT 1 FROM task_events event
        JOIN agent_tasks task ON task.id=event.task_id
        WHERE task.project_id = $1 AND (
          position($2 in event.message) > 0
          OR position($2 in coalesce(event.data::text, '')) > 0
        )
       UNION ALL
       SELECT 1 FROM project_activity
        WHERE project_id = $1 AND position($2 in coalesce(metadata::text, '')) > 0
       UNION ALL
       SELECT 1 FROM visual_edit_changes
        WHERE project_id = $1 AND (
          position($2 in before_content) > 0
          OR position($2 in after_content) > 0
        )
     ) AS referenced`,
    [projectId, objectPath],
  );
  return result.rows[0]?.referenced === true;
}

// POST /projects/:id/attachments/upload-url — get a signed PUT URL for image attachments
// Used by the screenshot-to-code flow. Returns { uploadUrl, objectPath } using the
// existing getObjectEntityUploadURL helper so vision-capable routes can fetch the image
// back via fetchAttachmentAsDataUri(objectPath).
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB (matches client-side gate)
const ALLOWED_ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

router.post(
  "/projects/:id/attachments/upload-url",
  requireProjectOwnership,
  (req: Request, res: Response) => {
    const body = req.body as { contentType?: string; sizeBytes?: number } | undefined;
    const contentType = body?.contentType ?? "";

    if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
      res.status(400).json({ error: "Only PNG, JPEG, and WebP image attachments are supported" });
      return;
    }

    // A declared size is mandatory because the durable reservation is the cost
    // and provenance boundary. No signed URL may exist without a database owner.
    const sizeBytes = typeof body?.sizeBytes === "number" ? body.sizeBytes : null;
    if (sizeBytes === null || !Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
      res.status(400).json({ error: "Image size is required before upload." });
      return;
    }
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({
        error: `Image too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      });
      return;
    }

    // The former direct signer could not enforce the declared byte limit and
    // outlived the request lifecycle. All product callers now use the unified
    // project asset reservation + authenticated content upload instead.
    res.status(410).json({
      error: "Upload this image from the project chat so NabuFlow can verify and protect it.",
    });
  },
);

// POST /projects/:id/uploads/request-url — get a presigned PUT URL
router.post(
  "/projects/:id/uploads/request-url",
  requireProjectOwnership,
  (req: Request, res: Response) => {
    const body = req.body as { name?: string; contentType?: string; size?: number } | undefined;
    if (!body?.name || typeof body.name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (!Number.isSafeInteger(body.size) || Number(body.size) < 1) {
      res.status(400).json({ error: "size is required" });
      return;
    }
    if (Number(body.size) > MAX_UPLOAD_BYTES) {
      res
        .status(413)
        .json({ error: `File too large. Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
      return;
    }
    res.status(410).json({
      error: "Upload this file from the project storage panel so NabuFlow can verify it safely.",
    });
  },
);

// POST /projects/:id/uploads — register the upload after the bytes are in storage
router.post("/projects/:id/uploads", requireProjectOwnership, (_req: Request, res: Response) => {
  res.status(410).json({
    error: "Upload this file from the project storage panel so NabuFlow can verify it safely.",
  });
});

// GET /projects/:id/uploads — list uploads
router.get(
  "/projects/:id/uploads",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select()
      .from(projectUploadsTable)
      .where(eq(projectUploadsTable.projectId, projectId))
      .orderBy(desc(projectUploadsTable.createdAt));
    res.json({
      uploads: rows.map((r) => ({
        id: r.id,
        filename: r.filename,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        hasTextPreview: !!r.textPreview,
        createdAt: r.createdAt,
      })),
    });
  },
);

// GET /projects/:id/uploads/:uploadId/content — stream the bytes back to the owner
router.get(
  "/projects/:id/uploads/:uploadId/content",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    if (
      !isCanonicalProjectUploadContentRequest(req.originalUrl, req.params.id, req.params.uploadId)
    ) {
      res.status(400).json({ error: "Invalid upload id" });
      return;
    }
    const uploadId = Number(req.params.uploadId);
    const [row] = await db
      .select()
      .from(projectUploadsTable)
      .where(
        and(
          eq(projectUploadsTable.id, uploadId),
          eq(projectUploadsTable.projectId, Number(req.params.id)),
        ),
      );
    if (!row) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }
    try {
      const inlineFilename = row.filename.replace(/[\r\n"]/gu, "_");
      if (row.objectPath.startsWith("assets/")) {
        const registered = await pool.query<{ id: number }>(
          `SELECT asset.id
             FROM assets asset
            WHERE asset.storage_key=$1
              AND asset.owner_user_id=$2
              AND asset.product_scope='nabuflow'
              AND asset.state='ready'
              AND EXISTS (
                SELECT 1 FROM project_uploads upload
                 WHERE upload.id=$3 AND upload.project_id=$4
                   AND upload.object_path=asset.storage_key
              )`,
          [row.objectPath, req.userId!, uploadId, Number(req.params.id)],
        );
        if (registered.rowCount !== 1) {
          res.status(404).json({ error: "Upload not found" });
          return;
        }
        const opened = await openAsset(row.objectPath);
        if (!opened) {
          res.status(404).json({ error: "Upload not found" });
          return;
        }
        res.status(200);
        res.setHeader("Content-Type", opened.contentType);
        res.setHeader("Content-Length", String(opened.sizeBytes));
        res.setHeader("Cache-Control", "private, no-store");
        res.setHeader("Content-Disposition", 'inline; filename="' + inlineFilename + '"');
        opened.body.pipe(res);
        return;
      }
      const file = await storage.getObjectEntityFile(row.objectPath);
      const response = await storage.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.setHeader("Content-Disposition", 'inline; filename="' + inlineFilename + '"');
      if (response.body) {
        const node = Readable.fromWeb(response.body as ReadableStream<Uint8Array>);
        node.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      req.log.error({ err, uploadId }, "uploads: download failed");
      res.status(500).json({ error: "Failed to download upload" });
    }
  },
);

// DELETE /projects/:id/uploads/:uploadId
router.delete(
  "/projects/:id/uploads/:uploadId",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    const uploadId = Number(req.params.uploadId);
    if (!Number.isSafeInteger(uploadId) || uploadId < 1 || uploadId > 2147483647) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }
    const [row] = await db
      .select({ id: projectUploadsTable.id, objectPath: projectUploadsTable.objectPath })
      .from(projectUploadsTable)
      .where(
        and(
          eq(projectUploadsTable.id, uploadId),
          eq(projectUploadsTable.projectId, Number(req.params.id)),
        ),
      )
      .limit(1);
    if (!row) {
      res.status(404).json({ error: "Upload not found" });
      return;
    }
    if (await legacyUploadIsReferenced(Number(req.params.id), row.objectPath)) {
      res.status(409).json({
        error: "This upload is still used by your project. Remove those uses before deleting it.",
      });
      return;
    }
    const [mirror] = await db
      .select({
        id: assetsTable.id,
        state: assetsTable.state,
        storageBackend: assetsTable.storageBackend,
      })
      .from(assetsTable)
      .where(
        and(
          eq(assetsTable.storageKey, row.objectPath),
          eq(assetsTable.source, "legacy-project-upload"),
          eq(assetsTable.productScope, "nabuflow"),
          eq(assetsTable.ownerUserId, req.userId!),
        ),
      )
      .limit(1);
    if (!mirror) {
      res.status(409).json({ error: "This older upload is still being migrated." });
      return;
    }
    if (mirror.storageBackend !== "legacy-object" && mirror.storageBackend !== "r2") {
      res.status(409).json({ error: "This older upload is still being migrated." });
      return;
    }
    if (mirror.state === "ready" || mirror.state === "deleting") {
      let pending: Awaited<ReturnType<typeof deleteReadyAsset>>;
      try {
        pending = await deleteReadyAsset({
          assetId: mirror.id,
          userId: req.userId!,
          storageBackend: mirror.storageBackend,
          productScope: "nabuflow",
          projectUploadIdBeingDeleted: row.id,
        });
      } catch (error) {
        if (error instanceof AssetAdmissionError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        throw error;
      }
      if (
        pending.storageBackend !== mirror.storageBackend ||
        pending.storageKey !== row.objectPath ||
        pending.storageObjects.some(
          (object) =>
            object.storageBackend !== mirror.storageBackend || object.storageKey !== row.objectPath,
        )
      ) {
        res.status(409).json({ error: "This older upload is still being migrated." });
        return;
      }
      // Provider absence is proved before either durable reference is removed.
      // A transient storage failure leaves both rows recoverable.
      try {
        await deleteTrackedAssetStorageObjects(pending.storageObjects);
      } catch (error) {
        req.log.warn({ err: error, uploadId }, "uploads: storage delete did not conclude");
        res.status(503).json({ error: "That upload could not be deleted right now. Try again." });
        return;
      }
      await recordAssetDeleted({
        assetId: mirror.id,
        userId: req.userId!,
        sizeBytes: pending.sizeBytes,
      });
    } else if (mirror.state !== "deleted") {
      res.status(409).json({ error: "This older upload is still being migrated." });
      return;
    }
    await db
      .delete(projectUploadsTable)
      .where(
        and(
          eq(projectUploadsTable.id, row.id),
          eq(projectUploadsTable.projectId, Number(req.params.id)),
          eq(projectUploadsTable.objectPath, row.objectPath),
        ),
      );
    res.json({ deleted: true });
  },
);

// Lightweight helper used by Manage tab middleware: confirm the project exists
// before tossing 404s — kept here for symmetry with the rest of the router.
router.get(
  "/projects/:id/uploads/_meta",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    const projectId = Number(req.params.id);
    const [project] = await db
      .select({ multiplayerEnabled: projectsTable.multiplayerEnabled })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    res.json({ multiplayerEnabled: project?.multiplayerEnabled ?? false });
  },
);

export default router;
