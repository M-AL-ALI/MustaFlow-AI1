// Custom-domain middleware — serves published project content for user-owned domains.
//
// When a request arrives whose Host header matches a project's `custom_domain`,
// the middleware short-circuits path routing and serves the content:
//   - If the project has a running production container (prodContainerStatus=running),
//     proxy the request to the container URL (Phase E).
//   - Otherwise, serve the published DB snapshot (legacy behaviour, static-html projects).
//
// Requests that start with /api/ or /__clerk are always skipped so the normal
// API router continues to function on the same server.
//
// In the Replit dev environment the proxy always presents the Replit hostname, so
// this middleware is effectively a no-op during development. It activates when the
// server is reached directly via a custom domain (production DNS setup).

import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { serveSnapshot } from "../lib/serveSnapshot";
import { logger } from "../lib/logger";

/** Hostnames that belong to the platform itself — never treated as custom domains. */
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

function isPlatformHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost") return true;
  // IPv4 / IPv6 literals
  if (/^[\d.:[\]]+$/.test(hostname)) return true;
  // Replit internal hosts
  if (
    hostname.includes(".replit.") ||
    hostname.includes(".repl.co") ||
    hostname.includes(".repl.dev")
  )
    return true;
  // Platform subdomains (e.g. xyz.mustaflow.app)
  if (hostname === PLATFORM_DOMAIN || hostname.endsWith("." + PLATFORM_DOMAIN)) return true;
  return false;
}

/**
 * Forward a request to a production container URL and stream the response back.
 * Returns true if the proxy succeeded, false if it failed (caller falls back to snapshot).
 */
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

export async function customDomainMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Always pass through API paths, Clerk proxy paths, and health endpoint.
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

  // Look up a project whose custom_domain matches the incoming hostname.
  const [project] = await db
    .select({
      id: projectsTable.id,
      prodContainerUrl: projectsTable.prodContainerUrl,
      prodContainerStatus: projectsTable.prodContainerStatus,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.customDomain, hostname), isNull(projectsTable.deletedAt)));

  if (!project) {
    next();
    return;
  }

  // Phase E: if a running production container exists, proxy to it.
  if (project.prodContainerUrl && project.prodContainerStatus === "running") {
    const proxied = await proxyToContainer(req, res, project.prodContainerUrl);
    if (proxied) return;
    // Fall through to snapshot serving on proxy failure
  }

  // Fallback: serve from the DB snapshot (static-html projects, or when container is down).
  const rawPath = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
  await serveSnapshot(res, project.id, rawPath);
}
