/**
 * Task #540 — Project uploads (drag-drop file uploads).
 *
 * Flow:
 *   1. Client POSTs metadata to /projects/:id/uploads/request-url → presigned PUT URL.
 *   2. Client PUTs the raw bytes directly to the signed URL (object storage).
 *   3. Client POSTs to /projects/:id/uploads with { name, contentType, sizeBytes, objectPath }
 *      to register the upload. Server fetches a text preview (first 8 KB of UTF-8) for
 *      CSV / JSON / plain text so the agent loop can read it later.
 *   4. Agent tools `list_uploads` and `read_upload` (see agent-loop.ts) consume these rows.
 *
 * Limits: 50 MB per file (enforced at registration time). ClamAV/AV scanning is out of
 *   scope for v1 — see "Known limitations" in replit.md.
 */
import { Router, type IRouter, type Request, type Response } from "express";
import { Readable } from "stream";
import { db, projectsTable, projectUploadsTable } from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { ObjectStorageService } from "../lib/objectStorage";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();
const storage = new ObjectStorageService();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
const TEXT_PREVIEW_BYTES = 8 * 1024;
const TEXTLIKE_MIMES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
  "text/javascript",
  "application/javascript",
  "application/typescript",
  "text/typescript",
  "application/x-yaml",
  "text/yaml",
]);

function isTextlike(mime: string): boolean {
  if (TEXTLIKE_MIMES.has(mime)) return true;
  return mime.startsWith("text/");
}

function isPdf(mime: string, filename: string): boolean {
  return mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

async function extractPdfPreview(buf: Buffer): Promise<string | null> {
  try {
    // pdf-parse ships as CommonJS — use a dynamic import to avoid bundling
    // its self-test "test/data/05-versions-space.pdf" path that runs at module
    // import time when called via require.main.
    const mod = (await import("pdf-parse")) as unknown as {
      default: (data: Buffer, opts?: { max?: number }) => Promise<{ text: string }>;
    };
    const parsed = await mod.default(buf, { max: 5 }); // first 5 pages
    const text = parsed.text?.trim() ?? "";
    if (!text) return null;
    return text.slice(0, TEXT_PREVIEW_BYTES);
  } catch {
    return null;
  }
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
  async (req: Request, res: Response) => {
    const body = req.body as { contentType?: string; sizeBytes?: number } | undefined;
    const contentType = body?.contentType ?? "";

    if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
      res.status(400).json({ error: "Only PNG, JPEG, and WebP image attachments are supported" });
      return;
    }

    // Server-side size gate: reject if the declared size already exceeds the cap.
    // The client may optionally omit sizeBytes (e.g. after canvas resize where the
    // final size is unknown); in that case we skip the pre-check and rely on the
    // object-storage layer to enforce quotas.
    const sizeBytes = typeof body?.sizeBytes === "number" ? body.sizeBytes : null;
    if (sizeBytes !== null && sizeBytes > MAX_ATTACHMENT_BYTES) {
      res.status(413).json({
        error: `Image too large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`,
      });
      return;
    }

    try {
      const uploadUrl = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadUrl);
      res.json({ uploadUrl, objectPath });
    } catch (err) {
      req.log.error({ err }, "attachments: failed to create signed URL");
      res.status(500).json({ error: "Failed to create upload URL" });
    }
  },
);

// POST /projects/:id/uploads/request-url — get a presigned PUT URL
router.post(
  "/projects/:id/uploads/request-url",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    const body = req.body as { name?: string; contentType?: string; size?: number } | undefined;
    if (!body?.name || typeof body.name !== "string") {
      res.status(400).json({ error: "name is required" });
      return;
    }
    if (typeof body.size === "number" && body.size > MAX_UPLOAD_BYTES) {
      res
        .status(413)
        .json({ error: `File too large. Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
      return;
    }
    try {
      const uploadURL = await storage.getObjectEntityUploadURL();
      const objectPath = storage.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error({ err }, "uploads: failed to create signed URL");
      res.status(500).json({ error: "Failed to create upload URL" });
    }
  },
);

// POST /projects/:id/uploads — register the upload after the bytes are in storage
router.post(
  "/projects/:id/uploads",
  requireProjectOwnership,
  async (req: Request, res: Response) => {
    const projectId = Number(req.params.id);
    const body = req.body as
      | { name?: string; contentType?: string; sizeBytes?: number; objectPath?: string }
      | undefined;
    if (!body?.name || !body?.objectPath) {
      res.status(400).json({ error: "name and objectPath are required" });
      return;
    }
    const mime = body.contentType ?? "application/octet-stream";

    // Verify the object exists and read its true size from storage metadata,
    // rather than trusting the client-reported sizeBytes (defence-in-depth for the 50 MB cap).
    // eslint-disable-next-line no-useless-assignment
    let actualSize = 0;
    let file: Awaited<ReturnType<typeof storage.getObjectEntityFile>>;
    try {
      file = await storage.getObjectEntityFile(body.objectPath);
      const [metadata] = await file.getMetadata();
      actualSize = Number(metadata.size ?? 0);
    } catch (err) {
      req.log.warn({ err, objectPath: body.objectPath }, "uploads: object metadata fetch failed");
      res.status(400).json({ error: "Uploaded object not found in storage" });
      return;
    }
    if (actualSize <= 0) {
      res.status(400).json({ error: "Uploaded object is empty" });
      return;
    }
    if (actualSize > MAX_UPLOAD_BYTES) {
      // Best-effort delete oversized object so we don't keep paying for it.
      try {
        await file.delete();
      } catch {
        /* ignore */
      }
      res
        .status(413)
        .json({ error: `File too large. Maximum is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
      return;
    }

    // Best-effort text preview: UTF-8 slice for textlike files,
    // pdf-parse for PDFs.
    let textPreview: string | null = null;
    if (isTextlike(mime)) {
      try {
        const [buf] = await file.download({ start: 0, end: TEXT_PREVIEW_BYTES - 1 });
        textPreview = buf.toString("utf8");
      } catch (err) {
        req.log.warn({ err, objectPath: body.objectPath }, "uploads: preview fetch failed");
      }
    } else if (isPdf(mime, body.name)) {
      try {
        const [buf] = await file.download();
        textPreview = await extractPdfPreview(buf);
      } catch (err) {
        req.log.warn({ err, objectPath: body.objectPath }, "uploads: pdf parse failed");
      }
    }

    const [row] = await db
      .insert(projectUploadsTable)
      .values({
        projectId,
        uploaderId: req.userId ?? null,
        filename: body.name,
        mimeType: mime,
        sizeBytes: actualSize,
        objectPath: body.objectPath,
        textPreview,
      })
      .returning();

    res.status(201).json({
      id: row!.id,
      filename: row!.filename,
      mimeType: row!.mimeType,
      sizeBytes: row!.sizeBytes,
      objectPath: row!.objectPath,
      hasTextPreview: !!row!.textPreview,
      createdAt: row!.createdAt,
    });
  },
);

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
      const file = await storage.getObjectEntityFile(row.objectPath);
      const response = await storage.downloadObject(file);
      res.status(response.status);
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.setHeader("Content-Disposition", `inline; filename="${row.filename}"`);
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
    await db
      .delete(projectUploadsTable)
      .where(
        and(
          eq(projectUploadsTable.id, uploadId),
          eq(projectUploadsTable.projectId, Number(req.params.id)),
        ),
      );
    res.json({ deleted: true });
  },
);

// Guard: keep multiplayer toggle from leaking by ensuring project belongs to owner.
// (We re-export this so future routes can reuse the same pattern.)
export { isTextlike };

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
