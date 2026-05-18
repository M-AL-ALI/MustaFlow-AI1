// Custom-domain middleware — serves published project snapshots for user-owned domains.
//
// When a request arrives whose Host header matches a project's `custom_domain`,
// the middleware short-circuits path routing and serves the published snapshot
// directly at the root path (e.g. GET / → index.html, GET /about → about.html).
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

/** Hostnames that belong to the platform itself — never treated as custom domains. */
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

function isPlatformHost(hostname: string): boolean {
  if (!hostname) return true;
  if (hostname === "localhost") return true;
  // IPv4 / IPv6 literals
  if (/^[\d.:[\]]+$/.test(hostname)) return true;
  // Replit internal hosts
  if (hostname.includes(".replit.") || hostname.includes(".repl.co") || hostname.includes(".repl.dev")) return true;
  // Platform subdomains (e.g. xyz.mustaflow.app)
  if (hostname === PLATFORM_DOMAIN || hostname.endsWith("." + PLATFORM_DOMAIN)) return true;
  return false;
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
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.customDomain, hostname),
        isNull(projectsTable.deletedAt),
      ),
    );

  if (!project) {
    next();
    return;
  }

  // Derive file path from URL: "/" → "index.html", "/about" → "about", etc.
  const rawPath = req.path === "/" ? "index.html" : req.path.replace(/^\//, "");
  await serveSnapshot(res, project.id, rawPath);
}
