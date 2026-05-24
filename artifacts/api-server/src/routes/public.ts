// ─────────────────────────────────────────────────────────────────────────────
// Public publishing routes — serves published project snapshots.
//
// Three access patterns (specific routes registered BEFORE the generic catch-all):
//   GET /api/p/:slug/staging/{*splat}      — internal staging snapshot access
//   GET /api/p/:previewSlug/preview/{*splat} — internal per-build preview access
//   GET /api/p/:slug/{*splat}              — primary (slug-based or legacy ID)
//
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
import { serveSnapshot, serveSnapshotForEnv, servePreviewSnapshot } from "../lib/serveSnapshot";

const router: IRouter = Router();

// ── Staging route: /api/p/:slug/staging/{*splat} ──────────────────────────
// MUST be registered before the generic catch-all so Express matches it first.
// Internal access to staging snapshot (useful in dev where subdomains aren't available).
router.get("/p/:slug/staging/{*splat}", async (req, res): Promise<void> => {
  const slug = req.params.slug;
  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;
  await serveSnapshotForEnv(res, slug, filePath, "staging");
});

// ── Preview route: /api/p/:previewSlug/preview/{*splat} ──────────────────
// MUST be registered before the generic catch-all so Express matches it first.
// Internal access to a per-build preview snapshot.
router.get("/p/:previewSlug/preview/{*splat}", async (req, res): Promise<void> => {
  const previewSlug = req.params.previewSlug;
  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;
  await servePreviewSnapshot(res, previewSlug, filePath);
});

// ── Primary route: slug-based (/api/p/:slug/) ─────────────────────────────
// Generic catch-all — registered LAST so staging/preview routes above win.
router.get("/p/:slug/{*splat}", async (req, res): Promise<void> => {
  const slug = req.params.slug;

  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;

  const reqMeta = {
    method: req.method,
    ip:
      (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      undefined,
    requestId: typeof req.id === "string" ? req.id : String(req.id ?? ""),
    userAgent: String(req.headers["user-agent"] ?? ""),
  };

  // If slug looks like a pure integer, treat as legacy ID lookup.
  const maybeId = Number(slug);
  if (Number.isFinite(maybeId) && String(maybeId) === slug) {
    await serveSnapshot(res, maybeId, filePath, reqMeta);
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

  await serveSnapshot(res, project.id, filePath, reqMeta);
});

export default router;
