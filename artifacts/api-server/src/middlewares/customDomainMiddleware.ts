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
//   - If the project has a running production container (prodContainerStatus=running),
//     proxy the request to the container URL (Phase E).
//   - Otherwise, serve the published DB snapshot (legacy behaviour, static-html).
//
// Requests that start with /api/ or /__clerk are always skipped.

import type { Request, Response, NextFunction } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { db, projectsTable, projectDomainsTable } from "@workspace/db";
import { serveSnapshot } from "../lib/serveSnapshot";
import { logger } from "../lib/logger";
import { subscribeDomainEvents } from "../lib/event-bus";
import { recordHostnameSighting } from "../routes/domains";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

// ── In-memory routing table ──────────────────────────────────────────────────
// Map from hostname to project row data.
interface CachedProject {
  id: number;
  prodContainerUrl: string | null;
  prodContainerStatus: string;
}

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
      })
      .from(projectDomainsTable);

    // Load project container info
    const projectRows = await db
      .select({
        id: projectsTable.id,
        customDomain: projectsTable.customDomain,
        prodContainerUrl: projectsTable.prodContainerUrl,
        prodContainerStatus: projectsTable.prodContainerStatus,
      })
      .from(projectsTable)
      .where(isNull(projectsTable.deletedAt));

    const projectMap = new Map<
      number,
      { prodContainerUrl: string | null; prodContainerStatus: string }
    >();
    for (const p of projectRows) {
      projectMap.set(p.id, {
        prodContainerUrl: p.prodContainerUrl,
        prodContainerStatus: p.prodContainerStatus,
      });
    }

    const newMap = new Map<string, CachedProject>();

    // From project_domains (verified entries)
    for (const row of domainRows) {
      if (row.verificationStatus !== "verified") continue;
      const proj = projectMap.get(row.projectId);
      if (!proj) continue;
      newMap.set(row.hostname, {
        id: row.projectId,
        prodContainerUrl: proj.prodContainerUrl,
        prodContainerStatus: proj.prodContainerStatus,
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
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (proj) {
      hostnameMap.set(hostname, {
        id: proj.id,
        prodContainerUrl: proj.prodContainerUrl,
        prodContainerStatus: proj.prodContainerStatus,
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
  if (isPlatformHost(hostname)) {
    next();
    return;
  }

  await ensureLoaded();

  const project = hostnameMap.get(hostname);
  if (!project) {
    next();
    return;
  }

  // Record sighting for diagnostic panel
  recordHostnameSighting(hostname);

  // Phase E: proxy to production container if running
  if (project.prodContainerUrl && project.prodContainerStatus === "running") {
    const proxied = await proxyToContainer(req, res, project.prodContainerUrl);
    if (proxied) return;
    // Fall through to snapshot serving on proxy failure
  }

  // Fallback: serve from DB snapshot
  const rawPath = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
  await serveSnapshot(res, project.id, rawPath);
}
