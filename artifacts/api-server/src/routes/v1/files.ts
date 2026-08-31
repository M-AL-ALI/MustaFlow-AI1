/**
 * /api/v1/projects/:id/files — list, download, and write generated project files.
 *
 * Auth: Bearer PAT token OR Clerk session cookie (handled by v1AuthMiddleware).
 *
 * Routes:
 *   GET /api/v1/projects/:id/files           — list all files (path, mimeType, size)
 *   GET /api/v1/projects/:id/files/*path     — download a file by path
 *   PUT /api/v1/projects/:id/files/*path     — create or update a file by path
 */

import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectFilesTable, projectArtifactsTable } from "@workspace/db";
import { checkV1ProjectAccess, requirePatScope } from "./access";
import { reconcileProjectFileAssetUsage } from "../../lib/project-file-asset-usage";

const router: IRouter = Router();

// ── GET /api/v1/projects/:id/files ────────────────────────────────────────────
router.get(
  "/projects/:id/files",
  requirePatScope("files:read"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
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
      .where(eq(projectFilesTable.projectId, projectId))
      .orderBy(asc(projectFilesTable.path));

    res.json({
      files: rows.map((r) => ({
        id: r.id,
        path: r.path,
        mimeType: r.mimeType,
        size: r.size.length,
        artifactId: r.artifactId,
        updatedAt: r.updatedAt,
      })),
      total: rows.length,
    });
  },
);

// ── GET /api/v1/projects/:id/files/*path ──────────────────────────────────────
router.get(
  "/projects/:id/files/*path",
  requirePatScope("files:read"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    // Express 5 stores wildcard segments as an array; join to reconstruct path.
    const pathParam = req.params["path"];
    const filePath = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam ?? "");

    if (!filePath) {
      res.status(400).json({ error: "File path is required." });
      return;
    }

    // Normalise — strip leading slash if the caller included one.
    const normalisedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

    const [file] = await db
      .select({
        path: projectFilesTable.path,
        content: projectFilesTable.content,
        mimeType: projectFilesTable.mimeType,
        updatedAt: projectFilesTable.updatedAt,
      })
      .from(projectFilesTable)
      .where(
        and(eq(projectFilesTable.projectId, projectId), eq(projectFilesTable.path, normalisedPath)),
      );

    if (!file) {
      res.status(404).json({ error: `File not found: ${normalisedPath}` });
      return;
    }

    res
      .set("Content-Type", file.mimeType || "text/plain")
      .set("Content-Disposition", `attachment; filename="${normalisedPath.split("/").pop()}"`)
      .send(file.content);
  },
);

// ── PUT /api/v1/projects/:id/files/*path ──────────────────────────────────────
// Create or replace a project file. Body: { content: string, mimeType?: string }
router.put(
  "/projects/:id/files/*path",
  requirePatScope("files:write"),
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id." });
      return;
    }

    if (!(await checkV1ProjectAccess(req, projectId, "member"))) {
      res.status(404).json({ error: "Project not found." });
      return;
    }

    const pathParam = req.params["path"];
    const filePath = Array.isArray(pathParam) ? pathParam.join("/") : (pathParam ?? "");

    if (!filePath) {
      res.status(400).json({ error: "File path is required." });
      return;
    }

    const normalisedPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;

    const { content, mimeType } = req.body as { content?: unknown; mimeType?: unknown };

    if (content === undefined || content === null) {
      res.status(400).json({ error: "content is required." });
      return;
    }

    const contentStr = typeof content === "string" ? content : JSON.stringify(content);

    // Detect MIME type from extension if not provided.
    const ext = normalisedPath.split(".").pop()?.toLowerCase() ?? "";
    const mimeMap: Record<string, string> = {
      html: "text/html",
      css: "text/css",
      js: "text/javascript",
      ts: "text/typescript",
      tsx: "text/typescript",
      jsx: "text/javascript",
      json: "application/json",
      svg: "image/svg+xml",
      md: "text/markdown",
      txt: "text/plain",
    };
    const resolvedMime =
      typeof mimeType === "string" && mimeType.trim()
        ? mimeType.trim()
        : (mimeMap[ext] ?? "text/plain");

    // Find the primary artifact for this project to attach the file to.
    const [primaryArtifact] = await db
      .select({ id: projectArtifactsTable.id })
      .from(projectArtifactsTable)
      .where(
        and(
          eq(projectArtifactsTable.projectId, projectId),
          eq(projectArtifactsTable.isPrimary, true),
        ),
      );

    const artifactId = primaryArtifact?.id ?? null;

    // Keep the file upsert and its asset-reference ledger in one transaction.
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: projectFilesTable.id })
        .from(projectFilesTable)
        .where(
          and(
            eq(projectFilesTable.projectId, projectId),
            eq(projectFilesTable.path, normalisedPath),
          ),
        );

      if (existing) {
        await tx
          .update(projectFilesTable)
          .set({ content: contentStr, mimeType: resolvedMime, updatedAt: new Date() })
          .where(eq(projectFilesTable.id, existing.id));
        await reconcileProjectFileAssetUsage(tx, {
          projectId,
          artifactId,
          filePath: normalisedPath,
          nextContent: contentStr,
        });
        return { updated: true, id: existing.id };
      }

      const [created] = await tx
        .insert(projectFilesTable)
        .values({
          projectId,
          artifactId,
          path: normalisedPath,
          content: contentStr,
          mimeType: resolvedMime,
        })
        .returning({ id: projectFilesTable.id });
      await reconcileProjectFileAssetUsage(tx, {
        projectId,
        artifactId,
        filePath: normalisedPath,
        nextContent: contentStr,
      });
      return { updated: false, id: created?.id };
    });

    if (result.updated) {
      res.json({
        file: {
          path: normalisedPath,
          mimeType: resolvedMime,
          size: contentStr.length,
          updated: true,
        },
      });
    } else {
      res.status(201).json({
        file: {
          id: result.id,
          path: normalisedPath,
          mimeType: resolvedMime,
          size: contentStr.length,
          updated: false,
        },
      });
    }
  },
);

export default router;
