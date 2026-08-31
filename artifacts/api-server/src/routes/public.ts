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
//
// Security: staging and per-build preview routes require owner or org-member auth.
// Only the production catch-all (/p/:slug/*) is intentionally unauthenticated.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, previewSnapshotsTable } from "@workspace/db";
import { serveSnapshot, serveSnapshotForEnv, servePreviewSnapshot } from "../lib/serveSnapshot";
import { cloudflareHostnameCacheTag, r2GetObject } from "../lib/cloudflare";
import { loadPreviewProject, userCanPreviewProject } from "../lib/livePreviewProxy";

const router: IRouter = Router();
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

// ── Staging route: /api/p/:slug/staging/{*splat} ──────────────────────────
// MUST be registered before the generic catch-all so Express matches it first.
// Internal access to staging snapshot — requires owner or org-member auth.
router.get("/p/:slug/staging/{*splat}", async (req, res): Promise<void> => {
  const slug = req.params.slug;

  // Auth gate: look up the project by publicSlug and verify the caller has access.
  const [projectRow] = await db
    .select({
      id: projectsTable.id,
      ownerId: projectsTable.ownerId,
      organizationId: projectsTable.organizationId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.publicSlug, slug), isNull(projectsTable.deletedAt)));

  if (!projectRow) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const allowed = await userCanPreviewProject(projectRow, req.userId);
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;
  await serveSnapshotForEnv(res, slug, filePath, "staging");
});

// ── Preview route: /api/p/:previewSlug/preview/{*splat} ──────────────────
// MUST be registered before the generic catch-all so Express matches it first.
// Internal access to a per-build preview snapshot — requires owner or org-member auth.
router.get("/p/:previewSlug/preview/{*splat}", async (req, res): Promise<void> => {
  const previewSlug = req.params.previewSlug;

  // Auth gate: look up the project via the preview_snapshots table.
  const [snapshot] = await db
    .select({ projectId: previewSnapshotsTable.projectId })
    .from(previewSnapshotsTable)
    .where(eq(previewSnapshotsTable.previewSlug, previewSlug));

  if (!snapshot) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const previewProject = await loadPreviewProject(snapshot.projectId);
  if (!previewProject) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const allowed = await userCanPreviewProject(previewProject, req.userId);
  if (!allowed) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const splat = req.params.splat;
  const raw = Array.isArray(splat) ? splat.join("/") : (splat ?? "");
  const filePath = raw === "" ? "index.html" : raw;
  await servePreviewSnapshot(res, previewSlug, filePath);
});

// ── Primary route: slug-based (/api/p/:slug/) ─────────────────────────────
// Generic catch-all — registered LAST so staging/preview routes above win.
// Intentionally unauthenticated — this is the public production URL.
//
// When EDGE_SERVING_ENABLED=true the Cloudflare Worker is the primary path.
// Requests that reach this route indicate either:
//   a) A Worker outage / cache miss that fell back to the origin.
//   b) Development / curl access that bypasses the CF Worker.
// We tag those responses with X-Mustaflow-Origin: api-fallback.
router.get("/p/:slug/{*splat}", async (req, res): Promise<void> => {
  const slug = req.params.slug;
  if (!/^\d+$/.test(slug)) {
    res.setHeader("Cache-Tag", cloudflareHostnameCacheTag(`${slug}.${PLATFORM_DOMAIN}`)!);
  }

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
    // For EDGE_SERVING_ENABLED integer-ID requests: tag as fallback (no R2 key known without snap lookup).
    if (process.env.EDGE_SERVING_ENABLED === "true") {
      res.setHeader("X-Mustaflow-Origin", "api-fallback");
    }
    await serveSnapshot(res, maybeId, filePath, reqMeta);
    return;
  }

  // Slug-based lookup — include publishedSnapshotId so we can try R2 first when edge serving is on.
  const [project] = await db
    .select({ id: projectsTable.id, publishedSnapshotId: projectsTable.publishedSnapshotId })
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

  // When EDGE_SERVING_ENABLED=true, this request reached the API after the Worker failed or had a cache
  // miss. Tag it as api-fallback, then try R2 first (same data source as the Worker) before DB.
  if (process.env.EDGE_SERVING_ENABLED === "true") {
    // Every request that reaches /api/p/:slug/* when EDGE_SERVING_ENABLED=true
    // means the Cloudflare Worker failed to serve it. Log at warn so outage
    // monitoring can alert on API-fallback hit-rate spikes in production.
    res.setHeader("X-Mustaflow-Origin", "api-fallback");
    req.log.warn(
      { slug, projectId: project.id, filePath, method: req.method },
      "EDGE_SERVING_ENABLED: API fallback hit on public slug route — Worker may be down or had cache miss",
    );
    if (project.publishedSnapshotId) {
      const r2Key = `${project.id}/${project.publishedSnapshotId}/${filePath}`;
      const r2Result = await r2GetObject(r2Key);
      if (r2Result) {
        res.setHeader("Content-Type", r2Result.contentType);
        if (r2Result.etag) res.setHeader("ETag", r2Result.etag);
        res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
        res.setHeader("X-Served-By", "mustaflow-r2-origin");
        res.status(200).end(r2Result.body);
        return;
      }
      req.log.debug(
        { slug, projectId: project.id, filePath },
        "EDGE_SERVING_ENABLED: R2 miss — falling back to DB snapshot",
      );
    }
  }

  await serveSnapshot(res, project.id, filePath, reqMeta);
});

export default router;
