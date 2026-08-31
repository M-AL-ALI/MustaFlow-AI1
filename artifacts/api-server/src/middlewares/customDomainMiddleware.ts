// Custom-domain middleware — serves published project content for user-owned domains.
//
// Uses an in-memory routing table (hostname → projectId) that is hot-reloaded
// on domain mutations via the event-bus (no API restart required).
//
// The table is lazy-loaded on first request and then kept fresh by:
//   1. Event-bus subscriptions for add/remove/verify events (instant).
//   2. A periodic background refresh every 5 minutes (safety net).
//
// When a request arrives whose Host header matches a project's domain,
// the middleware short-circuits path routing and serves the content:
//   - If the domain is suspended (suspendedAt set), return HTTP 451 with a notice page.
//   - If the project has a running production container (prodContainerStatus=running),
//     proxy the request to the container URL (Phase E).
//   - Otherwise, serve the published DB snapshot (legacy behaviour, static-html).
//
// EDGE_SERVING_ENABLED=true: The Cloudflare Worker is the primary serving path.
//   Requests that reach the API server (custom domains or *.mustaflow.app) are
//   served as normal from the DB snapshot but tagged with
//   X-Mustaflow-Origin: api-fallback so edge-outage monitoring can detect them.
//
// Requests that start with /api/ or /__clerk are always skipped.

import type { Request, Response, NextFunction } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { db, projectsTable, projectDomainsTable } from "@workspace/db";
import {
  serveSnapshot,
  serveSnapshotForEnv,
  servePreviewSnapshot,
  serveSnapshotByProjectEnv,
} from "../lib/serveSnapshot";
import { cloudflareHostnameCacheTag, r2GetObject } from "../lib/cloudflare";
import { logger } from "../lib/logger";
import { subscribeDomainEvents } from "../lib/event-bus";
import { recordHostnameSighting } from "../routes/domains";
import { SUPPORT_EMAIL_ADDRESS } from "../lib/support-contact";
import {
  revalidateCustomDomainServingState,
  type CachedCustomDomainServingState,
} from "../lib/custom-domain-serving-state";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

// Static 451 page returned for suspended domains
const SUSPENDED_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Content Unavailable</title><style>body{font-family:system-ui,sans-serif;padding:48px;color:#9ca3af;background:#0a0f1c;max-width:600px;margin:0 auto}h1{color:#fff}a{color:#6366f1}</style></head><body><h1>Content Unavailable</h1><p>This site has been suspended for a violation of our <a href="https://mustaflow.app/terms">Terms of Service</a>.</p><p>If you believe this is an error, please contact <a href="mailto:${SUPPORT_EMAIL_ADDRESS}">${SUPPORT_EMAIL_ADDRESS}</a>.</p><p style="font-size:0.8rem;margin-top:2rem;opacity:0.5">HTTP 451 — Unavailable For Legal Reasons</p></body></html>`;

// ── In-memory routing table ──────────────────────────────────────────────────
// Map from hostname to project row data.
type CachedProject = CachedCustomDomainServingState;

let hostnameMap = new Map<string, CachedProject>();
let loaded = false;
let loadPromise: Promise<void> | null = null;

async function loadRoutingTable(): Promise<void> {
  try {
    // Load from project_domains table first (new multi-domain system)
    const domainRows = await db
      .select({
        hostname: projectDomainsTable.hostname,
        projectId: projectDomainsTable.projectId,
        verificationStatus: projectDomainsTable.verificationStatus,
        environment: projectDomainsTable.environment,
        suspendedAt: projectDomainsTable.suspendedAt,
        suspensionReason: projectDomainsTable.suspensionReason,
      })
      .from(projectDomainsTable);

    // Load project container info
    const projectRows = await db
      .select({
        id: projectsTable.id,
        customDomain: projectsTable.customDomain,
        prodContainerUrl: projectsTable.prodContainerUrl,
        prodContainerStatus: projectsTable.prodContainerStatus,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
      })
      .from(projectsTable)
      .where(isNull(projectsTable.deletedAt));

    const projectMap = new Map<
      number,
      {
        prodContainerUrl: string | null;
        prodContainerStatus: string;
        publishedSnapshotId: number | null;
      }
    >();
    for (const p of projectRows) {
      projectMap.set(p.id, {
        prodContainerUrl: p.prodContainerUrl,
        prodContainerStatus: p.prodContainerStatus,
        publishedSnapshotId: p.publishedSnapshotId ?? null,
      });
    }

    const newMap = new Map<string, CachedProject>();

    // From project_domains (verified or suspended entries)
    for (const row of domainRows) {
      // Include suspended domains (they need to serve 451) even if not verified
      const isSuspended = row.suspendedAt != null;
      if (!isSuspended && row.verificationStatus !== "verified") continue;
      const proj = projectMap.get(row.projectId);
      // For suspended domains without a project (project deleted), still track
      newMap.set(row.hostname, {
        id: row.projectId,
        prodContainerUrl: proj?.prodContainerUrl ?? null,
        prodContainerStatus: proj?.prodContainerStatus ?? "stopped",
        environment: row.environment ?? "production",
        suspendedAt: row.suspendedAt ?? null,
        suspensionReason: row.suspensionReason ?? null,
        publishedSnapshotId: proj?.publishedSnapshotId ?? null,
      });
    }

    // Also include legacy projects.custom_domain rows not already in the map
    for (const proj of projectRows) {
      if (!proj.customDomain) continue;
      if (newMap.has(proj.customDomain)) continue; // already covered
      newMap.set(proj.customDomain, {
        id: proj.id,
        prodContainerUrl: proj.prodContainerUrl,
        prodContainerStatus: proj.prodContainerStatus,
        environment: "production",
        suspendedAt: null,
        suspensionReason: null,
        publishedSnapshotId: proj.publishedSnapshotId ?? null,
      });
    }

    hostnameMap = newMap;
    loaded = true;
    logger.debug({ size: hostnameMap.size }, "Domain routing table loaded");
  } catch (err) {
    logger.warn({ err }, "Failed to load domain routing table");
  }
}

// Ensure table is loaded (lazy, deduped)
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = loadRoutingTable().finally(() => {
      loadPromise = null;
    });
  }
  await loadPromise;
}

// Refresh a single entry after a domain mutation
async function refreshEntry(hostname: string, projectId: number): Promise<void> {
  try {
    const [proj] = await db
      .select({
        id: projectsTable.id,
        prodContainerUrl: projectsTable.prodContainerUrl,
        prodContainerStatus: projectsTable.prodContainerStatus,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    const [domainRow] = await db
      .select({
        suspendedAt: projectDomainsTable.suspendedAt,
        suspensionReason: projectDomainsTable.suspensionReason,
        environment: projectDomainsTable.environment,
      })
      .from(projectDomainsTable)
      .where(eq(projectDomainsTable.hostname, hostname));

    if (proj) {
      const existing = hostnameMap.get(hostname);
      hostnameMap.set(hostname, {
        id: proj.id,
        prodContainerUrl: proj.prodContainerUrl,
        prodContainerStatus: proj.prodContainerStatus,
        environment: domainRow?.environment ?? existing?.environment ?? "production",
        suspendedAt: domainRow?.suspendedAt ?? null,
        suspensionReason: domainRow?.suspensionReason ?? null,
        publishedSnapshotId: proj.publishedSnapshotId ?? null,
      });
    } else if (domainRow?.suspendedAt) {
      // Project deleted but domain suspended — keep for 451 enforcement
      const existing = hostnameMap.get(hostname);
      hostnameMap.set(hostname, {
        id: projectId,
        prodContainerUrl: null,
        prodContainerStatus: "stopped",
        environment: domainRow.environment ?? existing?.environment ?? "production",
        suspendedAt: domainRow.suspendedAt,
        suspensionReason: domainRow.suspensionReason ?? null,
        publishedSnapshotId: null,
      });
    }
  } catch {
    /* best-effort */
  }
}

// Subscribe to domain events for instant cache invalidation
subscribeDomainEvents((event) => {
  if (event.type === "removed") {
    hostnameMap.delete(event.hostname);
    logger.debug({ hostname: event.hostname }, "Domain removed from routing table");
  } else if (event.type === "added" || event.type === "verified") {
    void refreshEntry(event.hostname, event.projectId);
    logger.debug(
      { hostname: event.hostname, type: event.type },
      "Domain routing table entry refreshed",
    );
  } else if (event.type === "updated") {
    void refreshEntry(event.hostname, event.projectId);
  }
});

// Periodic background refresh (safety net for external mutations)
setInterval(() => {
  void loadRoutingTable();
}, 5 * 60_000).unref();

// ── Platform host detection ──────────────────────────────────────────────────

function isPlatformHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost") return true;
  if (/^[\d.:[\]]+$/.test(hostname)) return true;
  if (
    hostname.includes(".replit.") ||
    hostname.includes(".repl.co") ||
    hostname.includes(".repl.dev")
  )
    return true;
  if (hostname === PLATFORM_DOMAIN || hostname.endsWith("." + PLATFORM_DOMAIN)) return true;
  return false;
}

// ── Platform environment subdomain patterns ──────────────────────────────────
// Matches {slug}-staging.{PLATFORM_DOMAIN} and {slug}-preview-{taskId}.{PLATFORM_DOMAIN}

const STAGING_SUFFIX = "-staging";

function extractStagingSlug(hostname: string): string | null {
  if (!hostname.endsWith("." + PLATFORM_DOMAIN)) return null;
  const sub = hostname.slice(0, -(PLATFORM_DOMAIN.length + 1));
  if (!sub.endsWith(STAGING_SUFFIX)) return null;
  return sub.slice(0, -STAGING_SUFFIX.length) || null;
}

function extractPreviewSlug(hostname: string): string | null {
  if (!hostname.endsWith("." + PLATFORM_DOMAIN)) return null;
  const sub = hostname.slice(0, -(PLATFORM_DOMAIN.length + 1));
  // Preview subdomains end with -preview-{number}
  if (/-preview-\d+$/.test(sub)) return sub;
  return null;
}

// ── Container proxy ──────────────────────────────────────────────────────────

async function proxyToContainer(
  req: Request,
  res: Response,
  containerUrl: string,
): Promise<boolean> {
  try {
    const targetUrl =
      containerUrl.replace(/\/$/, "") +
      req.path +
      (req.url.includes("?") ? "?" + req.url.split("?")[1] : "");
    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: {
        "x-forwarded-host": req.hostname,
        "x-forwarded-for": req.ip ?? "",
        accept: req.headers.accept ?? "*/*",
      },
      signal: AbortSignal.timeout(10000),
    });

    res.status(upstream.status);
    const contentType = upstream.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    res.setHeader("x-served-by", "mustaflow-container");

    const body = await upstream.arrayBuffer();
    res.end(Buffer.from(body));
    return true;
  } catch (err) {
    logger.warn(
      { err, containerUrl, path: req.path },
      "Container proxy failed — falling back to snapshot",
    );
    return false;
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────

export async function customDomainMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (
    req.path.startsWith("/api/") ||
    req.path === "/api" ||
    req.path.startsWith("/__clerk") ||
    req.method !== "GET"
  ) {
    next();
    return;
  }

  const hostname = req.hostname;

  // ── Platform environment subdomains (before platform host skip) ───────────
  // These ARE platform hosts, but we intercept them specifically to serve
  // staging/preview content rather than falling through to the main router.
  if (hostname.endsWith("." + PLATFORM_DOMAIN)) {
    const rawPath = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");

    const stagingSlug = extractStagingSlug(hostname);
    if (stagingSlug) {
      res.setHeader("Cache-Tag", cloudflareHostnameCacheTag(hostname)!);
      await serveSnapshotForEnv(res, stagingSlug, rawPath, "staging");
      return;
    }

    const previewSlug = extractPreviewSlug(hostname);
    if (previewSlug) {
      await servePreviewSnapshot(res, previewSlug, rawPath);
      return;
    }
  }

  if (isPlatformHost(hostname)) {
    next();
    return;
  }

  await ensureLoaded();

  const cachedProject = hostnameMap.get(hostname);
  if (!cachedProject) {
    next();
    return;
  }
  res.setHeader("Cache-Tag", cloudflareHostnameCacheTag(hostname)!);

  // The routing table is cached for five minutes. Re-check the tombstone on
  // every matched request so a retired project cannot continue through the R2
  // fallback or a running container while that cache entry is stale.
  const [activeProject] = await db
    .select({
      id: projectsTable.id,
      status: projectsTable.status,
      prodContainerUrl: projectsTable.prodContainerUrl,
      prodContainerStatus: projectsTable.prodContainerStatus,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, cachedProject.id), isNull(projectsTable.deletedAt)))
    .limit(1);
  if (!activeProject) {
    hostnameMap.delete(hostname);
    res.status(404).type("text/plain").setHeader("Cache-Control", "no-store").send("Not found");
    return;
  }

  // ── Suspension check — return 451 immediately ─────────────────────────────
  if (cachedProject.suspendedAt) {
    res
      .status(451)
      .type("text/html")
      .setHeader("X-Suspension-Reason", cachedProject.suspensionReason ?? "policy_violation")
      .send(SUSPENDED_HTML);
    return;
  }

  const project = revalidateCustomDomainServingState(cachedProject, activeProject);
  if (!project) {
    res.status(404).type("text/plain").setHeader("Cache-Control", "no-store").send("Not found");
    return;
  }

  // Record sighting for diagnostic panel
  recordHostnameSighting(hostname);

  // HTTP → HTTPS redirect (enforced at the platform level for all custom domains).
  // Detect via X-Forwarded-Proto set by the upstream proxy / Cloudflare.
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0]?.trim() ?? req.protocol;
  if (proto === "http") {
    const httpsUrl = `https://${hostname}${req.url}`;
    res.redirect(301, httpsUrl);
    return;
  }

  // Strict-Transport-Security (HSTS) — 1 year, including subdomains.
  // Applied to every response served for a verified custom domain so browsers
  // remember to always use HTTPS without a redirect round-trip.
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");

  // When edge serving is enabled, the Cloudflare Worker is the primary path.
  // Requests that reach the API server are either a Worker outage or cache miss.
  // We tag every response with X-Mustaflow-Origin: api-fallback so edge-outage
  // monitoring can detect them, then attempt to serve the file directly from R2
  // (same source the Worker uses) before falling back to the DB snapshot.
  if (process.env.EDGE_SERVING_ENABLED === "true") {
    // Every request that reaches this middleware when EDGE_SERVING_ENABLED=true
    // means the Cloudflare Worker failed to intercept it (Worker down, PoP miss,
    // or cold-start race). Log at warn level so outage monitoring can alert on
    // API-fallback hit-rate spikes.
    res.setHeader("X-Mustaflow-Origin", "api-fallback");
    logger.warn(
      { hostname, projectId: project.id, path: req.path, method: req.method },
      "EDGE_SERVING_ENABLED: API fallback hit on custom domain — Worker may be down or had cache miss",
    );
    const rawPathEdge = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
    if (project.publishedSnapshotId && project.environment !== "staging") {
      const r2Key = `${project.id}/${project.publishedSnapshotId}/${rawPathEdge}`;
      const r2Result = await r2GetObject(r2Key);
      if (r2Result) {
        res.setHeader("Content-Type", r2Result.contentType);
        if (r2Result.etag) res.setHeader("ETag", r2Result.etag);
        res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=600");
        res.setHeader("X-Served-By", "mustaflow-r2-origin");
        res.status(200).end(r2Result.body);
        return;
      }
      logger.debug(
        { hostname, projectId: project.id, rawPathEdge },
        "EDGE_SERVING_ENABLED: R2 miss — falling back to DB snapshot",
      );
    }
  }

  // Phase E: proxy to production container if running (only for production-env domains)
  if (
    project.environment === "production" &&
    project.prodContainerUrl &&
    project.prodContainerStatus === "running"
  ) {
    const proxied = await proxyToContainer(req, res, project.prodContainerUrl);
    if (proxied) return;
    // Fall through to snapshot serving on proxy failure
  }

  // Serve the snapshot for the correct environment slot
  const rawPath = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
  const incomingHostname = typeof req.headers["host"] === "string" ? req.headers["host"] : null;
  if (project.environment === "staging") {
    await serveSnapshotByProjectEnv(
      res,
      project.id,
      rawPath,
      "staging",
      incomingHostname ?? undefined,
    );
  } else {
    await serveSnapshot(res, project.id, rawPath);
  }
}
