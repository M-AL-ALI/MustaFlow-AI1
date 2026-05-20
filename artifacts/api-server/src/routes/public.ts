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
// Custom-domain traffic (e.g. GET / on myapp.com) is handled upstream by the
// customDomainMiddleware in app.ts — it never reaches this router.
//
// Access rules:
//   - Project must have status = "published" and a non-null published_snapshot_id.
//   - No authentication required — this is the public URL.
//   - Unpublish clears published_snapshot_id → this route returns 404.
//   - publicSlug is never cleared → republishing reuses the same URL.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { serveSnapshot } from "../lib/serveSnapshot";

const router: IRouter = Router();

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
    .where(and(eq(projectsTable.publicSlug, slug), isNull(projectsTable.deletedAt)));

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
