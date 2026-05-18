// ─────────────────────────────────────────────────────────────────────────────
// Public publishing route — GET /api/p/:projectId/{*splat}
//
// Serves published project files from the deployment snapshot stored in
// project_versions.files_snapshot. The snapshot is a frozen copy of files
// at the time of the last Publish — draft changes are invisible until the
// owner publishes again.
//
// Access rules:
//   - Project must have status = "published" and a non-null published_snapshot_id.
//   - No authentication required — this is the public URL.
//   - Unpublish clears published_snapshot_id → this route returns 404.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, projectsTable, projectVersionsTable } from "@workspace/db";
import { guessMime } from "../lib/builder";

const router: IRouter = Router();

router.get(
  "/p/:projectId/{*splat}",
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.projectId);
    if (!Number.isFinite(projectId)) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }

    const [project] = await db
      .select({
        id: projectsTable.id,
        status: projectsTable.status,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
        deletedAt: projectsTable.deletedAt,
      })
      .from(projectsTable)
      .where(eq(projectsTable.id, projectId));

    if (!project || project.deletedAt || project.status !== "published" || !project.publishedSnapshotId) {
      res
        .status(404)
        .type("text/html")
        .send(
          `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not published</h1><p>This project is not currently published.</p></body></html>`,
        );
      return;
    }

    // Load the deployment snapshot
    const [version] = await db
      .select({ filesSnapshot: projectVersionsTable.filesSnapshot })
      .from(projectVersionsTable)
      .where(
        and(
          eq(projectVersionsTable.id, project.publishedSnapshotId),
          eq(projectVersionsTable.projectId, projectId),
        ),
      );

    if (!version || !Array.isArray(version.filesSnapshot)) {
      res.status(404).type("text/html").send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Snapshot missing</h1><p>Deployment snapshot not found. Please republish.</p></body></html>`,
      );
      return;
    }

    const splat = req.params.splat;
    const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
    const filePath = raw === "" ? "index.html" : raw;

    type SnapshotFile = { path: string; content: string; mimeType?: string };
    const snapshot = version.filesSnapshot as SnapshotFile[];

    let file = snapshot.find((f) => f.path === filePath);
    if (!file) {
      // SPA fallback — serve index.html for unmatched paths
      file = snapshot.find((f) => f.path === "index.html");
    }

    if (!file) {
      res
        .status(404)
        .type("text/html")
        .send(
          `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Page not found</h1></body></html>`,
        );
      return;
    }

    const mime = file.mimeType || guessMime(file.path);
    res
      .type(mime)
      .setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
      .send(file.content);
  },
);

export default router;
