import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectFilesTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { guessMime } from "../lib/builder";
import { isBinaryMime } from "../lib/binary-mime";
import { injectBridge, MOCK_FLAG_SCRIPT } from "../lib/consoleBridge";
import { extractPageMap } from "../lib/page-map";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/projects/:id/files", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select({
      id: projectFilesTable.id,
      path: projectFilesTable.path,
      mimeType: projectFilesTable.mimeType,
      size: projectFilesTable.content,
      updatedAt: projectFilesTable.updatedAt,
    })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId))
    .orderBy(asc(projectFilesTable.path));

  res.json(
    rows.map((r) => ({
      id: r.id,
      path: r.path,
      mimeType: r.mimeType,
      size: r.size.length,
      updatedAt: r.updatedAt,
    })),
  );
});

// Returns all project files with their full content in a single request.
// Used by the WebContainer boot sequence to populate the virtual FS efficiently.
router.get(
  "/projects/:id/files/all-content",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const rows = await db
      .select({
        id: projectFilesTable.id,
        path: projectFilesTable.path,
        mimeType: projectFilesTable.mimeType,
        content: projectFilesTable.content,
        updatedAt: projectFilesTable.updatedAt,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId))
      .orderBy(asc(projectFilesTable.path));

    res.json(rows);
  },
);

router.get(
  "/projects/:id/files/search",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "q is required" });
      return;
    }

    const files = await db
      .select({
        id: projectFilesTable.id,
        path: projectFilesTable.path,
        content: projectFilesTable.content,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId))
      .orderBy(asc(projectFilesTable.path));

    const results: Array<{
      fileId: number;
      file: string;
      lineNumber: number;
      lineContent: string;
    }> = [];
    const lowerQ = q.toLowerCase();

    for (const file of files) {
      if (results.length >= 50) break;
      const lines = file.content.split("\n");
      for (let i = 0; i < lines.length && results.length < 50; i++) {
        if (lines[i]!.toLowerCase().includes(lowerQ)) {
          results.push({
            fileId: file.id,
            file: file.path,
            lineNumber: i + 1,
            lineContent: lines[i]!.trim().slice(0, 200),
          });
        }
      }
    }

    res.json(results);
  },
);

router.post("/projects/:id/files", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const { path: filePath, content = "" } = req.body as {
    path?: unknown;
    content?: unknown;
  };

  if (typeof filePath !== "string" || filePath.trim() === "") {
    res.status(400).json({ error: "path must be a non-empty string" });
    return;
  }
  if (typeof content !== "string") {
    res.status(400).json({ error: "content must be a string" });
    return;
  }

  const normalizedPath = filePath.trim();

  const existing = await db
    .select({ id: projectFilesTable.id })
    .from(projectFilesTable)
    .where(
      and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, normalizedPath)),
    );

  if (existing.length > 0) {
    res.status(409).json({ error: "A file with that path already exists" });
    return;
  }

  const mimeType = guessMime(normalizedPath);
  const [created] = await db
    .insert(projectFilesTable)
    .values({
      projectId,
      path: normalizedPath,
      content,
      mimeType,
    })
    .returning();

  res.status(201).json({
    id: created.id,
    path: created.path,
    mimeType: created.mimeType,
    content: created.content,
    updatedAt: created.updatedAt,
  });

  const isHtml =
    created.mimeType === "text/html" ||
    created.path.toLowerCase().endsWith(".html") ||
    created.path.toLowerCase().endsWith(".htm");
  if (isHtml) {
    extractPageMap(projectId).catch((err: unknown) => {
      logger.warn({ err, projectId }, "page map re-extraction failed after new file created");
    });
  }
});

router.get(
  "/projects/:id/files/:fileId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const [row] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.json({
      id: row.id,
      path: row.path,
      mimeType: row.mimeType,
      content: row.content,
      updatedAt: row.updatedAt,
    });
  },
);

router.patch(
  "/projects/:id/files/:fileId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const { content } = req.body as { content?: unknown };
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }
    const [existing] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!existing) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const [updated] = await db
      .update(projectFilesTable)
      .set({ content, updatedAt: new Date() })
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)))
      .returning();
    res.json({
      id: updated.id,
      path: updated.path,
      mimeType: updated.mimeType,
      content: updated.content,
      updatedAt: updated.updatedAt,
    });

    const isHtml =
      updated.mimeType === "text/html" ||
      updated.path.toLowerCase().endsWith(".html") ||
      updated.path.toLowerCase().endsWith(".htm");
    if (isHtml) {
      extractPageMap(projectId).catch((err: unknown) => {
        logger.warn({ err, projectId }, "page map re-extraction failed after manual file save");
      });
    }
  },
);

router.get(
  "/projects/:id/files/:fileId/raw",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const [row] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    res.type("text/plain").setHeader("Cache-Control", "no-store").send(row.content);
  },
);

// Serves generated project files as the preview.
// PUBLISHED projects are publicly accessible without authentication — anyone
// with the URL can open the generated app.
// UNPUBLISHED projects require the requesting user to be the project owner.
router.get("/projects/:id/preview/{*splat}", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  // Resolve the project so we can check its publish status and ownership
  const [project] = await db
    .select({ id: projectsTable.id, status: projectsTable.status, ownerId: projectsTable.ownerId })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) {
    res
      .status(404)
      .type("text/html")
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Project not found</h1></body></html>`,
      );
    return;
  }

  // Only published projects are publicly accessible.
  // All other statuses require the caller to own the project.
  if (project.status !== "published") {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (project.ownerId !== req.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
  }

  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;

  const [row] = await db
    .select()
    .from(projectFilesTable)
    .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, filePath)));

  if (!row) {
    // Fallback to index.html so single-page-app routes resolve correctly
    const [fallback] = await db
      .select()
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, "index.html")),
      );
    if (!fallback) {
      res
        .status(404)
        .type("text/html")
        .send(
          `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">No preview yet</h1><p>Generate your app from the chat to see it here.</p></body></html>`,
        );
      return;
    }
    // Inject mock flag for owner preview (never for published apps)
    const isOwnerPreview = project.status !== "published";
    res
      .type("text/html")
      .setHeader("Cache-Control", "no-store, must-revalidate")
      .send(injectBridge(fallback.content, isOwnerPreview ? MOCK_FLAG_SCRIPT : ""));
    return;
  }

  const mime = row.mimeType || guessMime(row.path);
  const isHtml = mime === "text/html" || row.path.endsWith(".html");
  const isOwnerPreview = project.status !== "published";
  res.type(mime).setHeader("Cache-Control", "no-store, must-revalidate");
  if (isBinaryMime(mime)) {
    res.end(Buffer.from(row.content, "base64"));
  } else {
    res.send(
      isHtml ? injectBridge(row.content, isOwnerPreview ? MOCK_FLAG_SCRIPT : "") : row.content,
    );
  }
});

export default router;
