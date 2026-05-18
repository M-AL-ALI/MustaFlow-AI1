// ─────────────────────────────────────────────────────────────────────────────
// Public publishing routes — serves published project snapshots.
//
// Two access patterns:
//   GET /api/p/:slug/{*splat}  — primary (slug-based, safe for sharing)
//   GET /api/p/:id/{*splat}    — legacy (integer project ID, backward compat)
//
// Both patterns look up the project and serve the frozen published snapshot.
// The slug is generated on first publish and preserved on republish/unpublish.
//
// Access rules:
//   - Project must have status = "published" and a non-null published_snapshot_id.
//   - No authentication required — this is the public URL.
//   - Unpublish clears published_snapshot_id → this route returns 404.
//   - publicSlug is never cleared → republishing reuses the same URL.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectVersionsTable } from "@workspace/db";
import { guessMime } from "../lib/builder";

const router: IRouter = Router();

type SnapshotFile = { path: string; content: string; mimeType?: string };

async function serveSnapshot(
  res: import("express").Response,
  projectId: number,
  filePath: string,
): Promise<void> {
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

  const snapshot = version.filesSnapshot as SnapshotFile[];
  let file = snapshot.find((f) => f.path === filePath);
  if (!file) {
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
}

// ── Primary route: slug-based (/api/p/:slug/) ─────────────────────────────
router.get("/p/:slug/{*splat}", async (req, res): Promise<void> => {
  const slug = req.params.slug;

  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;

  // If slug looks like a pure integer, treat as legacy ID lookup.
  const maybeId = Number(slug);
  if (Number.isFinite(maybeId) && String(maybeId) === slug) {
    await serveSnapshot(res, maybeId, filePath);
    return;
  }

  // Slug-based lookup
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.publicSlug, slug),
        isNull(projectsTable.deletedAt),
      ),
    );

  if (!project) {
    res
      .status(404)
      .type("text/html")
      .send(
        `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not found</h1><p>No published site found at this URL.</p></body></html>`,
      );
    return;
  }

  await serveSnapshot(res, project.id, filePath);
});

export default router;
