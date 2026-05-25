/**
 * /api/v1/projects/:id/files — list and download generated project files.
 *
 * Auth: Bearer PAT token OR Clerk session cookie (handled by v1AuthMiddleware).
 *
 * Routes:
 *   GET /api/v1/projects/:id/files           — list all files (path, mimeType, size)
 *   GET /api/v1/projects/:id/files/*path     — download a file by path
 */

import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, projectFilesTable } from "@workspace/db";
import { checkV1ProjectAccess, requirePatScope } from "./access";

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

export default router;
