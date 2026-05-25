/**
 * Public REST API v1 — stable, versioned operations.
 * Mounted at /api/v1 (no /api prefix rewrite needed — Express handles it).
 *
 * Auth: Bearer personal access token (PAT) OR Clerk session cookie.
 * The v1AuthMiddleware below tries PAT first, then falls back to the Clerk
 * session already resolved by clerkMiddleware() in app.ts.
 *
 * Routes:
 *   GET    /api/v1/projects                              — list caller's projects
 *   GET    /api/v1/projects/:id                          — get a project
 *   POST   /api/v1/projects                              — create a project
 *   GET    /api/v1/projects/:id/builds                   — list builds
 *   GET    /api/v1/projects/:id/builds/:buildId          — poll a build
 *   POST   /api/v1/projects/:id/builds                   — trigger a build
 *   POST   /api/v1/projects/:id/builds/:buildId/cancel   — cancel a build
 *   GET    /api/v1/projects/:id/files                    — list generated files
 *   GET    /api/v1/projects/:id/files/*path              — download a file
 *   GET    /api/v1/projects/:id/domains                  — list domains
 *   POST   /api/v1/projects/:id/domains                  — add domain
 *   DELETE /api/v1/projects/:id/domains/:domainId        — remove domain
 *   POST   /api/v1/projects/:id/domains/:domainId/verify — trigger verify
 *   GET    /api/v1/projects/:id/webhooks                 — list webhooks
 *   POST   /api/v1/projects/:id/webhooks                 — create a webhook
 *   DELETE /api/v1/projects/:id/webhooks/:webhookId      — delete a webhook
 *   GET    /api/v1/tokens                                — list caller's PATs (masked)
 *   POST   /api/v1/tokens                                — create a PAT
 *   DELETE /api/v1/tokens/:tokenId                       — revoke a PAT
 */

import { Router, type IRouter } from "express";
import type { Request, Response, NextFunction } from "express";
import { and, asc, eq } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { promises as dns } from "dns";
import { db, projectDomainsTable, personalAccessTokensTable } from "@workspace/db";
import { patAuthMiddleware, type PATRequest } from "../../lib/pat-auth";
import { publishDomainEvent } from "../../lib/event-bus";
import { dispatchWebhookEvent } from "../../lib/webhook-dispatcher";
import { getAuth } from "@clerk/express";
import { logger } from "../../lib/logger";
import { checkV1ProjectAccess, isPatAuth } from "./access";
import projectsRouter from "./projects";
import buildsRouter from "./builds";
import filesRouter from "./files";
import webhooksRouter from "./webhooks";

const router: IRouter = Router();

const TOKEN_PREFIX = "mfp_";
const CNAME_TARGET = process.env.PLATFORM_CNAME_TARGET ?? "hosted.mustaflow.app";

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

function normaliseHostname(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!cleaned || cleaned.length > 253) return null;
  try {
    const url = new URL(`http://${cleaned}`);
    const normalized = url.hostname;
    const hostnameRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
    if (!hostnameRe.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

// ── Combined PAT + Clerk session auth middleware ───────────────────────────────
// Tries Bearer PAT first. If no Authorization header is present, falls back to
// the Clerk session already resolved by clerkMiddleware() in app.ts.
async function v1AuthMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    // Delegate to the existing PAT middleware.
    return patAuthMiddleware(req, res, next);
  }

  // No Bearer token — check if Clerk has already resolved a session.
  try {
    const clerkAuth = getAuth(req);
    const userId =
      (clerkAuth?.sessionClaims?.["userId"] as string | undefined) ?? clerkAuth?.userId;

    if (!userId) {
      res.status(401).json({
        error: "Authentication required. Provide a Bearer PAT token or a valid session cookie.",
      });
      return;
    }

    req.userId = userId;
    // Session auth has no PAT scopes.
    req.patProjectId = undefined;
    req.patScopes = [];
    next();
  } catch (err) {
    logger.warn({ err }, "v1 auth error");
    res.status(401).json({ error: "Authentication error." });
  }
}

// ── All v1 routes require auth ────────────────────────────────────────────────
router.use(v1AuthMiddleware);

// ── Mount sub-routers for projects, builds, files, and webhooks ───────────────
router.use(projectsRouter);
router.use(buildsRouter);
router.use(filesRouter);
router.use(webhooksRouter);

// ── GET /api/v1/projects/:id/domains ─────────────────────────────────────────
router.get("/projects/:id/domains", async (req, res): Promise<void> => {
  // Scope check: PAT tokens must carry domains:read. Session auth is exempt.
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("domains:read")) {
    res.status(403).json({ error: "Token does not have domains:read scope." });
    return;
  }

  const projectId = Number(req.params.id);
  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const domains = await db
    .select()
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, projectId))
    .orderBy(asc(projectDomainsTable.createdAt));

  res.json({ domains, cnameTarget: CNAME_TARGET });
});

// ── POST /api/v1/projects/:id/domains ────────────────────────────────────────
router.post("/projects/:id/domains", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Scope check: PAT tokens must carry domains:write. Session auth is exempt.
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("domains:write")) {
    res.status(403).json({ error: "Token does not have domains:write scope." });
    return;
  }

  const { hostname: rawHostname } = req.body as { hostname?: string };
  if (!rawHostname) {
    res.status(400).json({ error: "hostname is required." });
    return;
  }

  const hostname = normaliseHostname(rawHostname);
  if (!hostname) {
    res.status(400).json({ error: "Invalid hostname." });
    return;
  }

  const labels = hostname.split(".");
  const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
  const token = `mustaflow-verify=${randomBytes(16).toString("hex")}`;

  const existing = await db
    .select({ id: projectDomainsTable.id })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, projectId));

  const isPrimary = existing.length === 0;

  try {
    const [domain] = await db
      .insert(projectDomainsTable)
      .values({ projectId, hostname, isPrimary, recordType, verificationToken: token })
      .returning();

    publishDomainEvent({ type: "added", hostname, projectId });
    dispatchWebhookEvent(projectId, "domain.attached", { hostname, domainId: domain?.id });

    res.status(201).json({
      domain,
      cnameTarget: CNAME_TARGET,
      txtName: `_mustaflow.${hostname}`,
      txtValue: token,
    });
  } catch (err: unknown) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      res.status(409).json({ error: "Domain already attached to a project." });
    } else {
      throw err;
    }
  }
});

// ── DELETE /api/v1/projects/:id/domains/:domainId ─────────────────────────────
router.delete("/projects/:id/domains/:domainId", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const domainId = Number(req.params.domainId);

  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  // Scope check: PAT tokens must carry domains:write. Session auth is exempt.
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("domains:write")) {
    res.status(403).json({ error: "Token does not have domains:write scope." });
    return;
  }

  const [domain] = await db
    .select()
    .from(projectDomainsTable)
    .where(and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)));

  if (!domain) {
    res.status(404).json({ error: "Domain not found." });
    return;
  }

  await db.delete(projectDomainsTable).where(eq(projectDomainsTable.id, domainId));
  publishDomainEvent({ type: "removed", hostname: domain.hostname, projectId });
  dispatchWebhookEvent(projectId, "domain.detached", {
    hostname: domain.hostname,
    domainId,
  });

  res.json({ deleted: true });
});

// ── POST /api/v1/projects/:id/domains/:domainId/verify ────────────────────────
router.post("/projects/:id/domains/:domainId/verify", async (req, res): Promise<void> => {
  // Scope check: PAT tokens must carry domains:write. Session auth is exempt.
  if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes("domains:write")) {
    res.status(403).json({ error: "Token does not have domains:write scope." });
    return;
  }

  const projectId = Number(req.params.id);
  const domainId = Number(req.params.domainId);

  if (!(await checkV1ProjectAccess(req, projectId))) {
    res.status(404).json({ error: "Project not found." });
    return;
  }

  const [domain] = await db
    .select()
    .from(projectDomainsTable)
    .where(and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)));

  if (!domain) {
    res.status(404).json({ error: "Domain not found." });
    return;
  }

  const { hostname, verificationToken, recordType } = domain;
  const txtLookup = `_mustaflow.${hostname}`;
  let txtVerified = false;
  let cnameVerified = false;

  try {
    const txtRecords = await dns.resolveTxt(txtLookup).catch(() => [] as string[][]);
    txtVerified = txtRecords.flat().some((v) => v.trim() === verificationToken.trim());

    if (recordType === "cname") {
      const cnameRecords = await dns.resolveCname(hostname).catch(() => [] as string[]);
      const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
      cnameVerified = cnameRecords.some((r) =>
        r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
      );
    }

    const verified = txtVerified || cnameVerified;

    if (verified) {
      await db
        .update(projectDomainsTable)
        .set({ verificationStatus: "verified", verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(projectDomainsTable.id, domainId));

      dispatchWebhookEvent(projectId, "domain.verified", { hostname, domainId });

      res.json({ verified: true, hostname });
    } else {
      res.json({
        verified: false,
        hostname,
        hints: [
          `Add TXT record "${txtLookup}" with value "${verificationToken}"`,
          `Or CNAME "${hostname}" to "${CNAME_TARGET}"`,
        ],
      });
    }
  } catch {
    res.status(500).json({ error: "DNS check failed. Try again shortly." });
  }
});

// ── PAT management routes ─────────────────────────────────────────────────────
// Token management requires session auth — PATs cannot mint, revoke, or list
// tokens because that would allow privilege escalation (a narrow-scope token
// creating a new token with broader scopes).

// GET /api/v1/tokens — list caller's tokens (masked)
router.get("/tokens", async (req, res): Promise<void> => {
  if (isPatAuth(req)) {
    res.status(403).json({ error: "Token management requires session auth, not a PAT." });
    return;
  }

  const tokens = await db
    .select({
      id: personalAccessTokensTable.id,
      name: personalAccessTokensTable.name,
      tokenPreview: personalAccessTokensTable.tokenPreview,
      scopes: personalAccessTokensTable.scopes,
      active: personalAccessTokensTable.active,
      projectId: personalAccessTokensTable.projectId,
      lastUsedAt: personalAccessTokensTable.lastUsedAt,
      expiresAt: personalAccessTokensTable.expiresAt,
      createdAt: personalAccessTokensTable.createdAt,
    })
    .from(personalAccessTokensTable)
    .where(
      and(
        eq(personalAccessTokensTable.userId, req.userId!),
        eq(personalAccessTokensTable.active, true),
      ),
    );

  res.json({ tokens });
});

// POST /api/v1/tokens — create a new PAT
router.post("/tokens", async (req, res): Promise<void> => {
  if (isPatAuth(req)) {
    res.status(403).json({ error: "Token management requires session auth, not a PAT." });
    return;
  }

  const { name, projectId, scopes, expiresInDays } = req.body as {
    name?: string;
    projectId?: number;
    scopes?: string[];
    expiresInDays?: number;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required." });
    return;
  }

  const validScopes = [
    "projects:read",
    "projects:write",
    "builds:read",
    "builds:trigger",
    "files:read",
    "files:write",
    "domains:read",
    "domains:write",
    "webhooks:read",
    "webhooks:write",
  ];
  const resolvedScopes = Array.isArray(scopes)
    ? scopes.filter((s) => validScopes.includes(s))
    : ["projects:read", "builds:read", "files:read"];

  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const tokenPreview = `${raw.slice(0, 10)}•••••••••••${raw.slice(-4)}`;

  const expiresAt =
    expiresInDays && expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 86_400_000) : null;

  const [created] = await db
    .insert(personalAccessTokensTable)
    .values({
      userId: req.userId!,
      name: name.trim().slice(0, 100),
      tokenHash,
      tokenPreview,
      projectId: projectId ?? null,
      scopes: resolvedScopes,
      active: true,
      ...(expiresAt ? { expiresAt } : {}),
    })
    .returning({
      id: personalAccessTokensTable.id,
      name: personalAccessTokensTable.name,
      tokenPreview: personalAccessTokensTable.tokenPreview,
      scopes: personalAccessTokensTable.scopes,
      active: personalAccessTokensTable.active,
      projectId: personalAccessTokensTable.projectId,
      expiresAt: personalAccessTokensTable.expiresAt,
      createdAt: personalAccessTokensTable.createdAt,
    });

  res.status(201).json({
    token: created,
    rawToken: raw,
    note: "Store the raw token now — it will not be shown again.",
  });
});

// DELETE /api/v1/tokens/:tokenId — revoke a PAT
router.delete("/tokens/:tokenId", async (req, res): Promise<void> => {
  if (isPatAuth(req)) {
    res.status(403).json({ error: "Token management requires session auth, not a PAT." });
    return;
  }

  const tokenId = Number(req.params.tokenId);

  const [existing] = await db
    .select({ id: personalAccessTokensTable.id, userId: personalAccessTokensTable.userId })
    .from(personalAccessTokensTable)
    .where(eq(personalAccessTokensTable.id, tokenId));

  if (!existing || existing.userId !== req.userId) {
    res.status(404).json({ error: "Token not found." });
    return;
  }

  await db
    .update(personalAccessTokensTable)
    .set({ active: false })
    .where(eq(personalAccessTokensTable.id, tokenId));

  res.json({ revoked: true });
});

export default router;
