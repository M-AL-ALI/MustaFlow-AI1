/**
 * Preview Subdomain Gateway
 *
 * Intercepts requests for {sessionId}.preview.{PLATFORM_DOMAIN} before the
 * main /api router. Implements:
 *
 *   1. One-time launch token redemption:
 *      GET /__preview-launch?t={launchToken}
 *      → verifies token (sha256 hash match, single-use),
 *        issues HttpOnly HOST-ONLY cookie (no Domain attribute),
 *        redirects to /.
 *
 *   2. Per-request session authentication:
 *      All other requests → validates __prs cookie (HMAC + DB lookup),
 *      then reverse-proxies to the project's testContainerUrl.
 *
 * Security properties:
 *   - Cookie has no Domain= attribute → host-only (sent only to the exact
 *     {sessionId}.preview.{PLATFORM_DOMAIN} host, never to the parent domain).
 *   - CSP frame-ancestors restricts embedding to the platform origin only.
 *   - Session revoked immediately on security configuration changes.
 *   - Every request validates the DB row for revocation and expiry.
 */

import type { Request, Response, NextFunction } from "express";
import { createHmac, createHash, randomBytes, timingSafeEqual } from "crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db, projectsTable, previewSessionsTable } from "@workspace/db";
import { logger } from "../lib/logger";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
const PREVIEW_SUFFIX = `.preview.${PLATFORM_DOMAIN}`;
const COOKIE_NAME = "__prs";
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

// ENCRYPTION_KEY is used for all HMAC signing in this gateway.
// SESSION_SECRET is not used; ENCRYPTION_KEY covers all signing/HMAC needs.
function getSessionSecret(): string {
  const s = process.env.ENCRYPTION_KEY;
  if (!s) throw new Error("ENCRYPTION_KEY env var is not set");
  return s;
}

/** Sign a value with HMAC-SHA256 using ENCRYPTION_KEY. */
function hmacSign(value: string): string {
  return createHmac("sha256", getSessionSecret()).update(value).digest("hex");
}

/** Verify an HMAC signature in constant time. */
function hmacVerify(value: string, expected: string): boolean {
  const actual = Buffer.from(hmacSign(value), "hex");
  const exp = Buffer.from(expected, "hex");
  if (actual.length !== exp.length) return false;
  return timingSafeEqual(actual, exp);
}

/** Hash a launch token for DB storage. */
function hashLaunchToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Build the cookie string for a session. No Domain= → host-only. */
function buildCookieValue(sessionId: string): string {
  const sig = hmacSign(`preview:${sessionId}`);
  return `${sessionId}.${sig}`;
}

/** Build the Set-Cookie header. */
function buildSetCookieHeader(sessionId: string): string {
  const value = buildCookieValue(sessionId);
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=None; Max-Age=${SESSION_DURATION_MS / 1000}; Path=/`;
}

/** Parse and validate the __prs cookie. Returns sessionId or null. */
function parseCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;
  const raw = match[1]?.trim();
  if (!raw) return null;
  const dotIdx = raw.indexOf(".");
  if (dotIdx === -1) return null;
  const sessionId = raw.slice(0, dotIdx);
  const sig = raw.slice(dotIdx + 1);
  if (!hmacVerify(`preview:${sessionId}`, sig)) return null;
  return sessionId;
}

/** Extract the sessionId from the Host header, or null if not a preview subdomain. */
function extractPreviewSessionId(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.split(":")[0] ?? ""; // strip port
  if (!h.endsWith(PREVIEW_SUFFIX)) return null;
  const sessionId = h.slice(0, h.length - PREVIEW_SUFFIX.length);
  // Session IDs are 16-char lowercase hex
  if (!/^[0-9a-f]{16}$/.test(sessionId)) return null;
  return sessionId;
}

/**
 * Proxy a request to the test container URL.
 * Uses fetch + streams to avoid loading large responses into memory.
 */
async function proxyToContainer(containerUrl: string, req: Request, res: Response): Promise<void> {
  const targetPath = req.url || "/";
  const target = containerUrl.replace(/\/$/, "") + targetPath;

  const headers: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.headers)) {
    if (
      key.toLowerCase() === "host" ||
      key.toLowerCase() === "cookie" ||
      key.toLowerCase() === "connection"
    ) {
      continue;
    }
    if (val) {
      headers[key] = Array.isArray(val) ? val.join(", ") : val;
    }
  }

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", resolve);
      req.on("error", reject);
    });
    if (chunks.length > 0) body = Buffer.concat(chunks);
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
    duplex: "half",
  });

  res.status(upstream.status);

  // Forward safe response headers; add security headers.
  for (const [key, val] of upstream.headers.entries()) {
    const k = key.toLowerCase();
    if (k === "set-cookie" || k === "transfer-encoding" || k === "connection") continue;
    res.setHeader(key, val);
  }

  // CSP: restrict embedding to platform origin only.
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://${PLATFORM_DOMAIN} https://*.${PLATFORM_DOMAIN}`,
  );
  // Remove X-Frame-Options; CSP frame-ancestors is the modern standard.
  res.removeHeader("X-Frame-Options");

  if (upstream.body) {
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      res.end();
    }
  } else {
    res.end();
  }
}

/**
 * The preview subdomain gateway middleware.
 * Must be registered before customDomainMiddleware and the /api router.
 */
export async function previewSubdomainGateway(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionId = extractPreviewSessionId(req.headers.host);
  if (!sessionId) {
    next();
    return;
  }

  // ── Launch token redemption ─────────────────────────────────────────────
  if (req.path === "/__preview-launch" && req.method === "GET") {
    const token = String(req.query.t ?? "");
    if (!token || token.length < 32) {
      res.status(400).send("Missing or invalid launch token.");
      return;
    }

    const tokenHash = hashLaunchToken(token);
    const [session] = await db
      .select()
      .from(previewSessionsTable)
      .where(
        and(
          eq(previewSessionsTable.sessionId, sessionId),
          eq(previewSessionsTable.launchTokenHash, tokenHash),
        ),
      );

    if (!session) {
      res.status(401).send("Invalid launch token.");
      return;
    }
    if (session.launchTokenUsed) {
      res.status(401).send("Launch token already used.");
      return;
    }
    if (new Date() > session.expiresAt) {
      res.status(401).send("Session expired.");
      return;
    }
    if (session.revokedAt) {
      res.status(403).send("Preview session has been revoked.");
      return;
    }

    // Mark token used and record cookie issuance.
    await db
      .update(previewSessionsTable)
      .set({ launchTokenUsed: true, cookieIssuedAt: new Date() })
      .where(eq(previewSessionsTable.id, session.id));

    res.setHeader("Set-Cookie", buildSetCookieHeader(sessionId));
    res.redirect(302, "/");
    return;
  }

  // ── Per-request authentication ──────────────────────────────────────────
  const cookieSessionId = parseCookie(req.headers.cookie);
  if (!cookieSessionId || cookieSessionId !== sessionId) {
    res
      .status(401)
      .type("html")
      .send(
        `<!DOCTYPE html><html><head><title>Preview — Sign In Required</title></head>` +
          `<body style="font-family:sans-serif;padding:2rem">` +
          `<h2>Preview session required</h2>` +
          `<p>Open the test preview from your MustaFlow project workspace to access this preview.</p>` +
          `</body></html>`,
      );
    return;
  }

  // Validate session in the DB.
  const [session] = await db
    .select({
      id: previewSessionsTable.id,
      projectId: previewSessionsTable.projectId,
      expiresAt: previewSessionsTable.expiresAt,
      revokedAt: previewSessionsTable.revokedAt,
    })
    .from(previewSessionsTable)
    .where(eq(previewSessionsTable.sessionId, sessionId));

  if (!session) {
    res.status(401).send("Preview session not found.");
    return;
  }
  if (session.revokedAt) {
    res.status(403).send("Preview session has been revoked. Security configuration has changed.");
    return;
  }
  if (new Date() > session.expiresAt) {
    res.status(401).send("Preview session expired.");
    return;
  }

  // Fetch the project's test container URL.
  const [project] = await db
    .select({
      testContainerUrl: projectsTable.testContainerUrl,
      testContainerStatus: projectsTable.testContainerStatus,
      activePreviewSessionId: projectsTable.activePreviewSessionId,
      deletedAt: projectsTable.deletedAt,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, session.projectId), isNull(projectsTable.deletedAt)));

  if (!project || !project.testContainerUrl) {
    res
      .status(503)
      .send("Test container is not running. Start a test preview from your workspace.");
    return;
  }

  if (project.testContainerStatus !== "running") {
    res
      .status(503)
      .send(
        `Test container is ${project.testContainerStatus}. Please wait or restart the preview.`,
      );
    return;
  }

  // Proxy to the test container.
  try {
    await proxyToContainer(project.testContainerUrl, req, res);
  } catch (err) {
    logger.warn({ err, sessionId, projectId: session.projectId }, "Preview proxy error");
    if (!res.headersSent) {
      res.status(502).send("Could not reach the test container.");
    }
  }
}
