// Shared helper: serve a published project snapshot for a given project ID + file path.
// Used by both the /api/p/:slug/ public route and the custom-domain middleware.

import type { Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, projectVersionsTable } from "@workspace/db";
import { guessMime } from "./builder";

type SnapshotFile = { path: string; content: string; mimeType?: string };

const NOT_PUBLISHED_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Not published</h1><p>This project is not currently published.</p></body></html>`;
const SNAPSHOT_MISSING_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Snapshot missing</h1><p>Deployment snapshot not found. Please republish.</p></body></html>`;
const NOT_FOUND_HTML = `<!doctype html><html><body style="font-family:system-ui;padding:48px;color:#9ca3af;background:#0a0f1c"><h1 style="color:#fff">Page not found</h1></body></html>`;

export async function serveSnapshot(
  res: Response,
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
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project || project.status !== "published" || !project.publishedSnapshotId) {
    res.status(404).type("text/html").send(NOT_PUBLISHED_HTML);
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
    res.status(404).type("text/html").send(SNAPSHOT_MISSING_HTML);
    return;
  }

  const snapshot = version.filesSnapshot as SnapshotFile[];
  let file = snapshot.find((f) => f.path === filePath);
  if (!file) file = snapshot.find((f) => f.path === "index.html");

  if (!file) {
    res.status(404).type("text/html").send(NOT_FOUND_HTML);
    return;
  }

  const mime = file.mimeType || guessMime(file.path);
  res
    .type(mime)
    .setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=300")
    .send(file.content);
}
