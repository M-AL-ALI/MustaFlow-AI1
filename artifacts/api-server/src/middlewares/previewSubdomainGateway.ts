/**
 * Authenticated preview-host gateway for legacy sessions and B5 project shares.
 *
 * Replit's application router owns non-/api page paths, so the Cloudflare relay
 * carries B5 requests through /api/b5-preview and preserves the public path in
 * an authenticated header. The same gateway decisions serve direct and bridged
 * requests; only the transport path differs.
 */

import type { IncomingHttpHeaders } from "node:http";
import type { Request, Response, NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, previewSessionsTable, projectsTable } from "@workspace/db";
import { handleLivePreviewHttp, loadPreviewProject } from "../lib/livePreviewProxy";
import {
  buildPreviewSessionCookie,
  hashPreviewLaunchToken,
  parsePreviewSessionCookie,
  secretsMatchConstantTime,
} from "../lib/preview-share-session";
import { logger } from "../lib/logger";

const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
const LEGACY_PREVIEW_SUFFIX = `.preview.${PLATFORM_DOMAIN}`;
const B5_PREVIEW_SUFFIX = ".preview.mustaflow.com";
const B5_FORWARDED_HOST_HEADER = "x-b5-preview-host";
const B5_FORWARDED_PATH_HEADER = "x-b5-preview-path";
const B5_RELAY_AUTH_HEADER = "x-b5-relay-auth";

const GATE_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Shared preview</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>Shared preview</h1>' +
  "<p>This preview is shared by invitation.</p></body></html>";

const ASLEEP_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview asleep</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>This preview is asleep</h1>' +
  "<p>The project owner can start it from the NabuFlow workspace, then share it again.</p></body></html>";

const NOT_FOUND_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview not found</title></head>' +
  '<body style="font-family:system-ui,sans-serif;padding:2rem"><h1>Preview not found</h1></body></html>';

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function splitHostAndPort(host: string): { hostname: string; port: number | null } | null {
  const normalized = host.trim().toLowerCase();
  if (!normalized || normalized.includes("/") || normalized.includes("@")) return null;
  const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(normalized);
  if (!match?.[1]) return null;
  if (match[2]) {
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { hostname: match[1], port };
  }
  return { hostname: match[1], port: null };
}

/**
 * Trust the Worker-carried host only when its separate relay secret matches.
 * A forged or incomplete relay header pair has exactly the same result as no pair.
 */
export function resolvePreviewRoutingHost(
  headers: IncomingHttpHeaders,
  environment: Record<string, string | undefined> = process.env,
): string | undefined {
  const directHost = firstHeader(headers.host);
  const forwardedHost = firstHeader(headers[B5_FORWARDED_HOST_HEADER]);
  const suppliedSecret = firstHeader(headers[B5_RELAY_AUTH_HEADER]);
  return secretsMatchConstantTime(environment.B5_RELAY_SECRET, suppliedSecret)
    ? (forwardedHost ?? directHost)
    : directHost;
}

export type B5PreviewRelayContext = {
  host: string;
  publicRequestUrl: string;
};

function isSafePublicRequestUrl(value: string): boolean {
  let hasControlCharacter = false;
  for (let index = 0; index < value.length; index += 1) {
    const characterCode = value.charCodeAt(index);
    if (characterCode < 0x20 || characterCode === 0x7f) {
      hasControlCharacter = true;
      break;
    }
  }

  return (
    value.startsWith("/") && !value.startsWith("//") && !value.includes("#") && !hasControlCharacter
  );
}

/** Resolve the complete Worker assertion atomically; partial assertions fail closed. */
export function resolveB5PreviewRelayContext(
  headers: IncomingHttpHeaders,
  environment: Record<string, string | undefined> = process.env,
): B5PreviewRelayContext | null {
  const forwardedHost = firstHeader(headers[B5_FORWARDED_HOST_HEADER]);
  const forwardedPath = firstHeader(headers[B5_FORWARDED_PATH_HEADER]);
  const suppliedSecret = firstHeader(headers[B5_RELAY_AUTH_HEADER]);
  if (
    !secretsMatchConstantTime(environment.B5_RELAY_SECRET, suppliedSecret) ||
    !forwardedHost ||
    !forwardedPath ||
    !isSafePublicRequestUrl(forwardedPath)
  ) {
    return null;
  }
  return { host: forwardedHost, publicRequestUrl: forwardedPath };
}

/** Return the public path only for a complete authenticated Worker assertion. */
export function resolvePreviewRoutingPath(
  headers: IncomingHttpHeaders,
  fallback: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  return resolveB5PreviewRelayContext(headers, environment)?.publicRequestUrl ?? fallback;
}

/** Parse an exact p<positive-safe-integer>.preview.mustaflow.com host. */
export function extractB5PreviewProjectId(host: string | undefined): number | null {
  if (!host) return null;
  const parsed = splitHostAndPort(host);
  if (!parsed) return null;
  const match = /^p([1-9][0-9]*)\.preview\.mustaflow\.com$/i.exec(parsed.hostname);
  if (!match?.[1]) return null;
  const projectId = Number(match[1]);
  return Number.isSafeInteger(projectId) ? projectId : null;
}

function extractLegacySessionId(host: string | undefined): string | null {
  if (!host) return null;
  const parsed = splitHostAndPort(host);
  if (!parsed || !parsed.hostname.endsWith(LEGACY_PREVIEW_SUFFIX)) return null;
  const sessionId = parsed.hostname.slice(0, -LEGACY_PREVIEW_SUFFIX.length);
  return /^[0-9a-f]{16}$/.test(sessionId) ? sessionId : null;
}

function isB5PreviewNamespace(host: string | undefined): boolean {
  if (!host) return false;
  const parsed = splitHostAndPort(host);
  return Boolean(parsed?.hostname.endsWith(B5_PREVIEW_SUFFIX));
}

function sendGate(res: Response): void {
  res.status(200).type("html").setHeader("Cache-Control", "no-store").send(GATE_HTML);
}

function sendAsleep(res: Response): void {
  res.status(503).type("html").setHeader("Cache-Control", "no-store").send(ASLEEP_HTML);
}

function sendPreviewNotFound(res: Response): void {
  res.status(404).type("html").setHeader("Cache-Control", "no-store").send(NOT_FOUND_HTML);
}

async function loadSessionForCookie(sessionId: string, projectId?: number) {
  const predicates = [
    eq(previewSessionsTable.sessionId, sessionId),
    isNull(previewSessionsTable.revokedAt),
  ];
  if (projectId !== undefined) predicates.push(eq(previewSessionsTable.projectId, projectId));
  const [session] = await db
    .select({
      id: previewSessionsTable.id,
      projectId: previewSessionsTable.projectId,
      expiresAt: previewSessionsTable.expiresAt,
    })
    .from(previewSessionsTable)
    .where(and(...predicates));
  return session && new Date() <= session.expiresAt ? session : null;
}

async function loadLegacyPreviewProject(projectId: number) {
  const [project] = await db
    .select({
      id: projectsTable.id,
      ownerId: projectsTable.ownerId,
      organizationId: projectsTable.organizationId,
      status: projectsTable.status,
      builderMode: projectsTable.builderMode,
      containerId: projectsTable.testContainerId,
      containerStatus: projectsTable.testContainerStatus,
      containerUrl: projectsTable.testContainerUrl,
      stack: projectsTable.stack,
      runtimePort: projectsTable.runtimePort,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return project ?? null;
}

async function proxyLegacyTestContainer(
  containerUrl: string,
  req: Request,
  res: Response,
): Promise<void> {
  const target = containerUrl.replace(/\/$/, "") + (req.url || "/");
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (["host", "cookie", "connection"].includes(key.toLowerCase()) || !value) continue;
    headers[key] = Array.isArray(value) ? value.join(", ") : value;
  }

  let body: Buffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
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
  for (const [key, value] of upstream.headers.entries()) {
    if (["set-cookie", "transfer-encoding", "connection"].includes(key.toLowerCase())) continue;
    res.setHeader(key, value);
  }
  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors https://${PLATFORM_DOMAIN} https://*.${PLATFORM_DOMAIN}`,
  );
  res.removeHeader("X-Frame-Options");
  if (!upstream.body) {
    res.end();
    return;
  }
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
}

async function redeemLaunchToken(input: {
  projectId?: number;
  legacySessionId?: string;
  token: string;
}): Promise<string | null> {
  const predicates = [
    eq(previewSessionsTable.launchTokenHash, hashPreviewLaunchToken(input.token)),
    eq(previewSessionsTable.launchTokenUsed, false),
    isNull(previewSessionsTable.revokedAt),
  ];
  if (input.projectId !== undefined) {
    predicates.push(eq(previewSessionsTable.projectId, input.projectId));
  }
  if (input.legacySessionId) {
    predicates.push(eq(previewSessionsTable.sessionId, input.legacySessionId));
  }
  const [session] = await db
    .select()
    .from(previewSessionsTable)
    .where(and(...predicates));
  if (!session || new Date() > session.expiresAt) return null;
  await db
    .update(previewSessionsTable)
    .set({ launchTokenUsed: true, cookieIssuedAt: new Date() })
    .where(eq(previewSessionsTable.id, session.id));
  return session.sessionId;
}

/** Validate a preview-host WebSocket without waking or provisioning anything. */
export async function validatePreviewWebSocketUpgrade(
  host: string | undefined,
  cookieHeader: string | undefined,
): Promise<{ containerUrl: string } | null> {
  const projectId = extractB5PreviewProjectId(host);
  const legacySessionId = extractLegacySessionId(host);
  if (projectId === null && legacySessionId === null) return null;

  const cookieSessionId = parsePreviewSessionCookie(cookieHeader);
  if (!cookieSessionId) return null;
  if (legacySessionId && cookieSessionId !== legacySessionId) return null;
  const session = await loadSessionForCookie(cookieSessionId, projectId ?? undefined);
  if (!session) return null;
  const project =
    projectId !== null
      ? await loadPreviewProject(session.projectId)
      : await loadLegacyPreviewProject(session.projectId);
  if (!project?.containerUrl || !project.containerId || project.containerStatus !== "running") {
    return null;
  }
  return { containerUrl: project.containerUrl };
}

export function isPreviewSubdomainHost(host: string | undefined): boolean {
  return (
    extractB5PreviewProjectId(host) !== null ||
    extractLegacySessionId(host) !== null ||
    isB5PreviewNamespace(host)
  );
}

export async function previewSubdomainGateway(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const routingHost = resolvePreviewRoutingHost(req.headers);
  const publicRequestUrl = resolvePreviewRoutingPath(
    req.headers,
    req.originalUrl || req.url || "/",
  );
  const publicUrl = new URL(publicRequestUrl, "http://preview.invalid");
  const projectId = extractB5PreviewProjectId(routingHost);
  const legacySessionId = extractLegacySessionId(routingHost);

  if (projectId === null && legacySessionId === null) {
    if (isB5PreviewNamespace(routingHost)) sendPreviewNotFound(res);
    else next();
    return;
  }

  if (publicUrl.pathname === "/__preview-launch" && req.method === "GET") {
    const token = publicUrl.searchParams.get("t") ?? "";
    if (!/^[0-9a-f]{64}$/.test(token)) {
      if (projectId !== null) sendGate(res);
      else res.status(400).send("Missing or invalid launch token.");
      return;
    }
    const sessionId = await redeemLaunchToken({
      projectId: projectId ?? undefined,
      legacySessionId: legacySessionId ?? undefined,
      token,
    });
    if (!sessionId) {
      if (projectId !== null) sendGate(res);
      else res.status(401).send("Invalid launch token.");
      return;
    }
    res.setHeader("Set-Cookie", buildPreviewSessionCookie(sessionId));
    res.redirect(302, "/");
    return;
  }

  const cookieSessionId = parsePreviewSessionCookie(req.headers.cookie);
  if (!cookieSessionId || (legacySessionId !== null && cookieSessionId !== legacySessionId)) {
    if (projectId !== null) sendGate(res);
    else res.status(401).send("Preview session required.");
    return;
  }

  const session = await loadSessionForCookie(cookieSessionId, projectId ?? undefined);
  if (!session) {
    if (projectId !== null) sendGate(res);
    else res.status(401).send("Preview session expired.");
    return;
  }

  const project =
    projectId !== null
      ? await loadPreviewProject(session.projectId)
      : await loadLegacyPreviewProject(session.projectId);
  if (
    !project ||
    project.containerStatus !== "running" ||
    (projectId !== null ? !project.containerId : !project.containerUrl)
  ) {
    sendAsleep(res);
    return;
  }

  try {
    if (projectId === null && project.containerUrl) {
      await proxyLegacyTestContainer(project.containerUrl, req, res);
      return;
    }
    await handleLivePreviewHttp(req, res, next, project, {
      publicRequestUrl,
    });
  } catch (error) {
    logger.warn({ error, projectId: session.projectId }, "Shared preview proxy failed");
    if (!res.headersSent) res.status(502).send("The shared preview could not be reached.");
  }
}

/**
 * API bridge entry point. Only a complete authenticated Worker assertion may
 * enter the shared gateway; direct or forged API calls fall through unchanged.
 */
export async function previewPathBridge(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!resolveB5PreviewRelayContext(req.headers)) {
    next();
    return;
  }
  await previewSubdomainGateway(req, res, next);
}
