import { Router, type IRouter } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, projectFilesTable, projectsTable, projectVersionsTable } from "@workspace/db";
import { requireProjectAccess } from "../lib/auth";
import { guessMime } from "../lib/builder";
import { isBinaryMime } from "../lib/binary-mime";
import { injectBridge, MOCK_FLAG_SCRIPT } from "../lib/consoleBridge";
import { VISUAL_EDIT_SCRIPT } from "../lib/visualEditScript";
import { extractPageMap } from "../lib/page-map";
import { logger } from "../lib/logger";
import { writeFileToContainer } from "../lib/container";
import { runEslintFix } from "../lib/checks/eslint-runner";
import { applyProjectEslintFixes } from "../lib/eslint-fix-all";
import { readDiagnostics } from "../lib/agent-senses";
import {
  handleLivePreviewHttp,
  loadPreviewProject,
  userCanPreviewProject,
} from "../lib/livePreviewProxy";
import { serveProjectFilesPreview } from "../lib/project-files-preview";

const router: IRouter = Router();

router.get(
  "/projects/:id/files",
  requireProjectAccess("viewer"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    // Optional artifactId filter (Task #544). Omitted = return every file in the
    // project regardless of artifact, preserving legacy single-artifact behaviour.
    const artifactIdRaw = typeof req.query.artifactId === "string" ? req.query.artifactId : "";
    const artifactIdFilter = artifactIdRaw ? Number(artifactIdRaw) : null;
    const conds = [eq(projectFilesTable.projectId, projectId)];
    if (artifactIdFilter && Number.isFinite(artifactIdFilter)) {
      conds.push(eq(projectFilesTable.artifactId, artifactIdFilter));
    }
    const rows = await db
      .select({
        id: projectFilesTable.id,
        path: projectFilesTable.path,
        mimeType: projectFilesTable.mimeType,
        size: projectFilesTable.content,
        artifactId: projectFilesTable.artifactId,
        updatedAt: projectFilesTable.updatedAt,
      })
      .from(projectFilesTable)
      .where(and(...conds))
      .orderBy(asc(projectFilesTable.path));

    res.json(
      rows.map((r) => ({
        id: r.id,
        path: r.path,
        mimeType: r.mimeType,
        size: r.size.length,
        artifactId: r.artifactId,
        updatedAt: r.updatedAt,
      })),
    );
  },
);

// Returns all project files with their full content in a single request.
// Used by the WebContainer boot sequence to populate the virtual FS efficiently.
router.get(
  "/projects/:id/files/all-content",
  requireProjectAccess("viewer"),
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
  requireProjectAccess("viewer"),
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

router.post(
  "/projects/:id/files",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
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

    // Resolve artifactId first (Task #544) so the conflict check is scoped per
    // artifact — two artifacts in the same project may each own a `package.json`.
    const { resolveArtifactId } = await import("../lib/artifacts");
    const artifactIdRaw = typeof req.query.artifactId === "string" ? req.query.artifactId : "";
    const hint = artifactIdRaw ? Number(artifactIdRaw) : null;
    const resolvedArtifactId = await resolveArtifactId(projectId, hint);

    const conflictConds = [
      eq(projectFilesTable.projectId, projectId),
      eq(projectFilesTable.path, normalizedPath),
    ];
    if (resolvedArtifactId !== null) {
      conflictConds.push(eq(projectFilesTable.artifactId, resolvedArtifactId));
    }
    const existing = await db
      .select({ id: projectFilesTable.id })
      .from(projectFilesTable)
      .where(and(...conflictConds));

    if (existing.length > 0) {
      res.status(409).json({ error: "A file with that path already exists" });
      return;
    }

    const mimeType = guessMime(normalizedPath);
    const [created] = await db
      .insert(projectFilesTable)
      .values({
        projectId,
        artifactId: resolvedArtifactId,
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
  },
);

router.get(
  "/projects/:id/files/:fileId",
  requireProjectAccess("viewer"),
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
  requireProjectAccess("member"),
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

    // Emit project_files_changed so Quick Preview syncs without a full reload.
    // Also mark the testing snapshot stale since the draft changed.
    setImmediate(() => {
      void (async () => {
        try {
          const { publishProjectFilesChanged } = await import("../lib/preview-events");
          publishProjectFilesChanged(
            projectId,
            [{ path: updated.path, content: updated.content }],
            [],
            "manual-save",
          );
        } catch (err) {
          logger.warn(
            { err, projectId },
            "project_files_changed emit failed after manual save (non-fatal)",
          );
        }
        try {
          const { staleDraftCandidate } = await import("../lib/testing-invalidation");
          await staleDraftCandidate(projectId, "manual-save");
        } catch {
          // non-fatal
        }
      })();
    });

    // Sync the saved file to the live container (best-effort, non-fatal).
    setImmediate(() => {
      db.select({
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
        .from(projectsTable)
        .where(eq(projectsTable.id, projectId))
        .then(([project]) => {
          if (project?.containerId && project.containerStatus === "running") {
            void writeFileToContainer(project.containerId, updated.path, content, projectId);
          }
        })
        .catch((err: unknown) => {
          logger.warn({ err, projectId, path: updated.path }, "Failed to sync file to container");
        });
    });
  },
);

router.delete(
  "/projects/:id/files/:fileId",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
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
    await db
      .delete(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    res.json({ deleted: true });
  },
);

router.patch(
  "/projects/:id/files/:fileId/rename",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const { path: newPath } = req.body as { path?: unknown };
    if (typeof newPath !== "string" || newPath.trim() === "") {
      res.status(400).json({ error: "path must be a non-empty string" });
      return;
    }
    const normalizedPath = newPath.trim();

    const [existing] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!existing) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Conflict check is scoped to the file's own artifact (Task #544) so a
    // rename to a path that exists in a sibling artifact is allowed.
    const renameConflictConds = [
      eq(projectFilesTable.projectId, projectId),
      eq(projectFilesTable.path, normalizedPath),
    ];
    if (existing.artifactId !== null) {
      renameConflictConds.push(eq(projectFilesTable.artifactId, existing.artifactId));
    }
    const conflict = await db
      .select({ id: projectFilesTable.id })
      .from(projectFilesTable)
      .where(and(...renameConflictConds));
    if (conflict.length > 0) {
      res.status(409).json({ error: "A file with that path already exists" });
      return;
    }

    const newMimeType = guessMime(normalizedPath);
    const [updated] = await db
      .update(projectFilesTable)
      .set({ path: normalizedPath, mimeType: newMimeType, updatedAt: new Date() })
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)))
      .returning();

    res.json({
      id: updated.id,
      path: updated.path,
      mimeType: updated.mimeType,
      content: updated.content,
      updatedAt: updated.updatedAt,
    });
  },
);

// Auto-fix simple ESLint issues for a single file. Returns the fixed content
// and the list of issues that remain after fixing. Does NOT persist — the
// frontend applies the edit through Monaco so the user can save (or undo).
router.post(
  "/projects/:id/files/:fileId/eslint-fix",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const body = (req.body ?? {}) as { content?: unknown; ruleIds?: unknown };

    const [row] = await db
      .select()
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!row) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const content = typeof body.content === "string" ? body.content : row.content;
    const ruleIds = Array.isArray(body.ruleIds)
      ? body.ruleIds.filter((r): r is string => typeof r === "string")
      : undefined;

    const result = runEslintFix({ path: row.path, content, ruleIds });
    res.json(result);
  },
);

// Apply ESLint auto-fixes to every lintable file in the project in one shot.
// Before touching anything, snapshots the current file set into project_versions
// so the user can roll back from the History tab if they don't like the result.
// Returns a per-file summary so the UI can show what changed.
router.post(
  "/projects/:id/eslint-fix-all",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const body = (req.body ?? {}) as { dryRun?: unknown; fileIds?: unknown };
    const dryRun = body.dryRun === true;
    const requestedFileIds =
      Array.isArray(body.fileIds) && body.fileIds.every((v) => typeof v === "number")
        ? new Set(body.fileIds as number[])
        : null;

    const fix = await applyProjectEslintFixes(projectId, {
      dryRun,
      fileIds: requestedFileIds,
    });

    let snapshotVersionId: number | null = null;
    if (!dryRun && fix.filesFixed > 0) {
      // Snapshot the pre-fix file set so the user has a rollback target.
      const [version] = await db
        .insert(projectVersionsTable)
        .values({
          projectId,
          label: `Auto-fix (${fix.filesFixed} file${fix.filesFixed === 1 ? "" : "s"})`,
          note: "Snapshot taken before project-wide ESLint auto-fix.",
          changelogEntry: `ESLint auto-fix applied to ${fix.filesFixed} file${fix.filesFixed === 1 ? "" : "s"}`,
          filesSnapshot: fix.preFixFiles,
        })
        .returning();
      snapshotVersionId = version?.id ?? null;
    }

    res.json({
      filesScanned: fix.filesScanned,
      filesFixed: fix.filesFixed,
      fixedCount: fix.fixedCount,
      remainingCount: fix.remainingCount,
      snapshotVersionId,
      results: fix.results,
    });
  },
);

// Live diagnostics for a single file. Runs tsc / node --check / py_compile
// inside the project's container (auto-detected from the file extension) and
// returns structured diagnostics that the editor can render as Monaco markers.
// Returns ok=false with an explanation when no container is running.
router.post(
  "/projects/:id/files/:fileId/diagnostics",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const fileId = Number(req.params.fileId);
    if (!Number.isFinite(fileId)) {
      res.status(400).json({ error: "Invalid file id" });
      return;
    }
    const [file] = await db
      .select({
        id: projectFilesTable.id,
        path: projectFilesTable.path,
        content: projectFilesTable.content,
      })
      .from(projectFilesTable)
      .where(and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.id, fileId)));
    if (!file) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    const [project] = await db
      .select({
        containerId: projectsTable.containerId,
        containerStatus: projectsTable.containerStatus,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));
    const containerId =
      project?.containerId && project.containerStatus === "running" ? project.containerId : null;

    // Guarantee the container sees the same bytes the DB has before we run
    // tsc / py_compile. PATCH /files/:id only fires the container sync
    // best-effort via setImmediate, so a diagnostics call that follows a
    // save can otherwise race with the sync and lint stale content.
    if (containerId) {
      try {
        await writeFileToContainer(containerId, file.path, file.content, projectId);
      } catch {
        // Non-fatal — readDiagnostics will surface the resulting failure.
      }
    }

    const result = await readDiagnostics({
      args: { path: file.path },
      containerId,
      projectId,
      signal: new AbortController().signal,
    });
    res.json({
      ok: result.ok,
      tool: result.tool,
      diagnostics: result.diagnostics.map((d) => ({
        line: d.line,
        column: d.col,
        severity: d.severity,
        message: d.message,
        source: result.tool,
      })),
      error: result.error ?? null,
    });
  },
);

router.get(
  "/projects/:id/files/:fileId/raw",
  requireProjectAccess("viewer"),
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
//
// Task #740: for projects with builder_mode = 'agentic', requests are
// reverse-proxied to the live Fly container's dev server (HTTP + WS for
// Vite HMR). Projects with builder_mode = 'static-legacy' continue to be
// served from the project_files rows below.
router.get("/projects/:id/preview/{*splat}", async (req, res, next): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(404).type("text/plain").send("Not found");
    return;
  }

  const previewProject = await loadPreviewProject(projectId);
  if (!previewProject) {
    res
      .status(404)
      .type("text/html")
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Project not found</h1></body></html>`,
      );
    return;
  }

  // Auth: the editor preview route ALWAYS requires the caller to be the project
  // owner or an org member — even when the project is published. Published projects
  // are served publicly at /api/p/:slug/ and custom domains (serveSnapshot.ts).
  // Draft edits made after publishing must never be visible without authentication.
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const allowed = await userCanPreviewProject(previewProject, req.userId);
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // Agentic projects WITH a real container → live container proxy.
  // Agentic projects without a container (most projects) fall through to the
  // same DB-row serving as static-legacy — the generated HTML/CSS/JS files
  // are already in project_files and can be served directly.
  if (previewProject.builderMode === "agentic" && previewProject.containerId) {
    await handleLivePreviewHttp(req, res, next, previewProject);
    return;
  }

  // ─── Legacy: serve files from the project_files table ────────────────────
  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;
  await serveProjectFilesPreview(res, projectId, filePath, {
    projectStatus: previewProject.status,
    showStaticBanner: previewProject.builderMode === "agentic",
  });
});

router.post(
  "/projects/:id/files/apply-suggestion",
  requireProjectAccess("member"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const { filePath, content } = req.body as { filePath?: unknown; content?: unknown };
    if (typeof filePath !== "string" || filePath.trim() === "") {
      res.status(400).json({ error: "filePath must be a non-empty string" });
      return;
    }
    if (typeof content !== "string") {
      res.status(400).json({ error: "content must be a string" });
      return;
    }

    const normalizedPath = filePath.trim();

    const [existing] = await db
      .select({ id: projectFilesTable.id, content: projectFilesTable.content })
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, normalizedPath)),
      );

    if (existing && existing.content === content) {
      res.json({ applied: false, reason: "content unchanged", filePath: normalizedPath });
      return;
    }

    const mimeType = guessMime(normalizedPath);

    // Snapshot current state BEFORE the write so the user has a rollback target
    const currentFiles = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
      })
      .from(projectFilesTable)
      .where(eq(projectFilesTable.projectId, projectId));

    await db.insert(projectVersionsTable).values({
      projectId,
      label: `Assistant edit: ${normalizedPath}`,
      note: "Snapshot taken before applying an Assistant suggestion.",
      filesSnapshot: currentFiles,
    });

    if (existing) {
      await db
        .update(projectFilesTable)
        .set({ content, mimeType, updatedAt: sql`now()` })
        .where(eq(projectFilesTable.id, existing.id));
    } else {
      await db
        .insert(projectFilesTable)
        .values({ projectId, path: normalizedPath, content, mimeType });
    }

    res.json({ applied: true, filePath: normalizedPath });
  },
);

export default router;
