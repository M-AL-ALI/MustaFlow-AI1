/**
 * Public REST API v1 — stable, versioned domain + DNS operations.
 * Mounted at /api/v1 (no /api prefix rewrite needed — Express handles it).
 *
 * Auth: Bearer personal access token (PAT).
 *
 * Routes:
 *   GET    /api/v1/projects/:id/domains         — list domains
 *   POST   /api/v1/projects/:id/domains         — add domain
 *   DELETE /api/v1/projects/:id/domains/:domainId — remove domain
 *   POST   /api/v1/projects/:id/domains/:domainId/verify — trigger verify
 *   GET    /api/v1/tokens                       — list caller's PATs (masked)
 *   POST   /api/v1/tokens                       — create a PAT
 *   DELETE /api/v1/tokens/:tokenId              — revoke a PAT
 */

import { Router, type IRouter } from "express";
import { and, asc, eq, isNull } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { promises as dns } from "dns";
import {
  db,
  projectsTable,
  projectDomainsTable,
  personalAccessTokensTable,
} from "@workspace/db";
import { patAuthMiddleware, type PATRequest } from "../../lib/pat-auth";
import { publishDomainEvent } from "../../lib/event-bus";
import { dispatchWebhookEvent } from "../../lib/webhook-dispatcher";

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

/** Check that a PAT can access the given project. */
async function checkProjectAccess(
  req: Parameters<typeof patAuthMiddleware>[0],
  projectId: number,
): Promise<boolean> {
  // If the token is scoped to a specific project, enforce it
  if (req.patProjectId !== null && req.patProjectId !== undefined) {
    return req.patProjectId === projectId;
  }
  // User-scoped token — verify ownership via DB
  const [proj] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, projectId),
        eq(projectsTable.ownerId, req.userId!),
        isNull(projectsTable.deletedAt),
      ),
    );
  return Boolean(proj);
}

// ── All v1 routes require PAT auth ────────────────────────────────────────────
router.use(patAuthMiddleware);

// ── GET /api/v1/projects/:id/domains ─────────────────────────────────────────
router.get("/v1/projects/:id/domains", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!(await checkProjectAccess(req, projectId))) {
    res.status(403).json({ error: "Access denied to this project." });
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
router.post("/v1/projects/:id/domains", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!(await checkProjectAccess(req, projectId))) {
    res.status(403).json({ error: "Access denied to this project." });
    return;
  }

  const patReq = req as unknown as PATRequest;
  if (!patReq.patScopes?.includes("domains:write")) {
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
router.delete("/v1/projects/:id/domains/:domainId", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const domainId = Number(req.params.domainId);

  if (!(await checkProjectAccess(req, projectId))) {
    res.status(403).json({ error: "Access denied to this project." });
    return;
  }

  const patReq2 = req as unknown as PATRequest;
  if (!patReq2.patScopes?.includes("domains:write")) {
    res.status(403).json({ error: "Token does not have domains:write scope." });
    return;
  }

  const [domain] = await db
    .select()
    .from(projectDomainsTable)
    .where(
      and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
    );

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
router.post("/v1/projects/:id/domains/:domainId/verify", async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const domainId = Number(req.params.domainId);

  if (!(await checkProjectAccess(req, projectId))) {
    res.status(403).json({ error: "Access denied to this project." });
    return;
  }

  const [domain] = await db
    .select()
    .from(projectDomainsTable)
    .where(
      and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
    );

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

// GET /api/v1/tokens — list caller's tokens (masked)
router.get("/v1/tokens", async (req, res): Promise<void> => {
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
router.post("/v1/tokens", async (req, res): Promise<void> => {
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

  const validScopes = ["domains:read", "domains:write", "webhooks:read", "webhooks:write"];
  const resolvedScopes = Array.isArray(scopes)
    ? scopes.filter((s) => validScopes.includes(s))
    : ["domains:read", "domains:write"];

  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const tokenPreview = `${raw.slice(0, 10)}•••••••••••${raw.slice(-4)}`;

  const expiresAt =
    expiresInDays && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;

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
router.delete("/v1/tokens/:tokenId", async (req, res): Promise<void> => {
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
