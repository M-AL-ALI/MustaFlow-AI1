// ─────────────────────────────────────────────────────────────────────────────
// Workspace (org-level) domain management routes — Task #558
//
//   GET    /api/workspaces/:id/domains               — list org-owned domains
//   POST   /api/workspaces/:id/domains               — claim a domain for the org
//   DELETE /api/workspaces/:id/domains/:domainId     — release org domain
//   POST   /api/workspaces/:id/domains/:domainId/verify — trigger DNS verification
//   GET    /api/workspaces/:id/domains/:domainId/roles  — list role grants
//   POST   /api/workspaces/:id/domains/:domainId/roles  — grant a role
//   DELETE /api/workspaces/:id/domains/:domainId/roles/:userId — revoke a role
//   GET    /api/workspaces/:id/usage                 — monthly bandwidth/request rollup
//   GET    /api/workspaces/:id/audit                 — org-wide domain audit log
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { eq, and, asc, desc, gte, lte, isNull } from "drizzle-orm";
import { promises as dns } from "dns";
import { randomBytes } from "crypto";
import {
  db,
  workspacesTable,
  workspaceDomainsTable,
  workspaceDomainRolesTable,
  workspaceUsageDailyTable,
  workspaceDomainAuditTable,
  projectDomainsTable,
  projectsTable,
} from "@workspace/db";
import type { DomainRole } from "@workspace/db";
import { DOMAIN_ROLES } from "@workspace/db";
import { enforceQuota } from "../lib/plans";
import { findClerkUserByEmail, getClerkUserSummaries } from "../lib/clerk-users";
import {
  getWorkspaceUsage,
  rollupUsage,
  reportBandwidthOverageToStripe,
} from "../lib/usage-rollup";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Safely extract a single string from an Express param (which types as string | string[]). */
function param(v: string | string[] | undefined): string {
  if (Array.isArray(v)) return v[0] ?? "";
  return v ?? "";
}

function generateVerificationToken(): string {
  return `mustaflow-org-verify=${randomBytes(16).toString("hex")}`;
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

/** Write an audit row for a workspace domain operation. Best-effort — never throws. */
async function writeAudit(opts: {
  workspaceId: number;
  workspaceDomainId?: number | null;
  userId: string;
  action: string;
  hostname?: string | null;
  payload?: unknown;
}): Promise<void> {
  try {
    await db.insert(workspaceDomainAuditTable).values({
      workspaceId: opts.workspaceId,
      workspaceDomainId: opts.workspaceDomainId ?? null,
      userId: opts.userId,
      action: opts.action,
      hostname: opts.hostname ?? null,
      payload: opts.payload ? JSON.stringify(opts.payload) : null,
    });
  } catch {
    /* best-effort */
  }
}

// ── requireWorkspaceOwner middleware ─────────────────────────────────────────
// Validates req.userId is the owner of the workspace in :id.
// Sets req.workspaceId on success.

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      workspaceId?: number;
    }
  }
}

async function requireWorkspaceOwner(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const id = parseInt(param(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid workspace id" });
    return;
  }
  const [workspace] = await db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, id), isNull(workspacesTable.deletedAt)));
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  if (workspace.ownerUserId !== userId) {
    res.status(403).json({ error: "You do not own this workspace" });
    return;
  }
  req.workspaceId = id;
  next();
}

// ── requireWorkspaceMember middleware ─────────────────────────────────────────
// Allows workspace owner OR any user who has at least one role grant on any
// domain that belongs to this workspace. Used for read-only list/usage/audit
// routes so viewers and editors can access them without being the owner.

async function requireWorkspaceMember(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const id = parseInt(param(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid workspace id" });
    return;
  }
  const [workspace] = await db
    .select({ id: workspacesTable.id, ownerUserId: workspacesTable.ownerUserId })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, id), isNull(workspacesTable.deletedAt)));
  if (!workspace) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  // Workspace owner always passes
  if (workspace.ownerUserId === userId) {
    req.workspaceId = id;
    next();
    return;
  }
  // Any explicit domain-role grant in this workspace also grants membership
  const [anyRole] = await db
    .select({ id: workspaceDomainRolesTable.id })
    .from(workspaceDomainRolesTable)
    .innerJoin(
      workspaceDomainsTable,
      eq(workspaceDomainRolesTable.workspaceDomainId, workspaceDomainsTable.id),
    )
    .where(
      and(eq(workspaceDomainsTable.workspaceId, id), eq(workspaceDomainRolesTable.userId, userId)),
    )
    .limit(1);
  if (!anyRole) {
    res.status(403).json({ error: "You do not have access to this workspace" });
    return;
  }
  req.workspaceId = id;
  next();
}

// ── requireDomainRole middleware factory ─────────────────────────────────────
// Returns middleware that requires the user to have AT LEAST the given role
// on the workspace domain. Owner of the workspace always passes.

function requireDomainRole(minRole: DomainRole) {
  const roleRank: Record<DomainRole, number> = { viewer: 1, editor: 2, owner: 3 };

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    const workspaceId = parseInt(param(req.params.id), 10);
    const domainId = parseInt(param(req.params.domainId), 10);

    if (!Number.isFinite(workspaceId) || !Number.isFinite(domainId)) {
      res.status(400).json({ error: "Invalid workspace or domain id" });
      return;
    }

    // Workspace owner always passes
    const [workspace] = await db
      .select({ ownerUserId: workspacesTable.ownerUserId })
      .from(workspacesTable)
      .where(eq(workspacesTable.id, workspaceId));
    if (workspace?.ownerUserId === userId) {
      req.workspaceId = workspaceId;
      next();
      return;
    }

    // Check explicit role grant
    const [roleRow] = await db
      .select({ role: workspaceDomainRolesTable.role })
      .from(workspaceDomainRolesTable)
      .where(
        and(
          eq(workspaceDomainRolesTable.workspaceDomainId, domainId),
          eq(workspaceDomainRolesTable.userId, userId),
        ),
      );

    if (!roleRow) {
      res.status(403).json({ error: "You do not have access to this domain" });
      return;
    }

    const userRank = roleRank[roleRow.role as DomainRole] ?? 0;
    const requiredRank = roleRank[minRole];

    if (userRank < requiredRank) {
      res.status(403).json({
        error: `This action requires '${minRole}' role or higher. You have '${roleRow.role}'.`,
      });
      return;
    }

    req.workspaceId = workspaceId;
    next();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/workspaces/:id/domains
// Accessible to workspace owner AND users with any domain role (viewer+).
router.get("/workspaces/:id/domains", requireWorkspaceMember, async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;

  const domains = await db
    .select()
    .from(workspaceDomainsTable)
    .where(eq(workspaceDomainsTable.workspaceId, workspaceId))
    .orderBy(asc(workspaceDomainsTable.createdAt));

  // Count to show quota info
  const plan = await (await import("../lib/plans")).resolveWorkspacePlan(workspaceId);
  const { PLAN_QUOTAS } = await import("../lib/plans");
  const quota = PLAN_QUOTAS[plan];

  res.json({
    domains,
    quota: {
      plan,
      maxCustomDomains: quota.maxCustomDomains,
      used: domains.length,
      remaining: Math.max(0, quota.maxCustomDomains - domains.length),
    },
  });
});

// POST /api/workspaces/:id/domains
router.post("/workspaces/:id/domains", requireWorkspaceOwner, async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const userId = req.userId!;
  const { hostname: rawHostname } = req.body as { hostname?: string };

  if (!rawHostname) {
    res.status(400).json({ error: "hostname is required" });
    return;
  }

  const hostname = normaliseHostname(rawHostname);
  if (!hostname) {
    res.status(400).json({
      error:
        "Invalid domain. Use a bare hostname like example.com — no protocol, no path, no trailing slash.",
    });
    return;
  }

  // Quota check
  const existing = await db
    .select({ id: workspaceDomainsTable.id })
    .from(workspaceDomainsTable)
    .where(eq(workspaceDomainsTable.workspaceId, workspaceId));

  const quotaResult = await enforceQuota("domain", existing.length, workspaceId);
  if (!quotaResult.allowed) {
    res.status(402).json({
      error: "Domain quota exceeded",
      quota: quotaResult,
      upgradeMessage: quotaResult.upgradeMessage,
    });
    return;
  }

  const labels = hostname.split(".");
  const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
  const token = generateVerificationToken();

  try {
    const [domain] = await db
      .insert(workspaceDomainsTable)
      .values({
        workspaceId,
        hostname,
        recordType,
        verificationToken: token,
        status: "pending_verification",
      })
      .returning();

    await writeAudit({
      workspaceId,
      workspaceDomainId: domain!.id,
      userId,
      action: "domain_claimed",
      hostname,
      payload: { recordType },
    });

    res.status(201).json({
      domain,
      verificationInstructions: {
        type: "TXT",
        name: `_mustaflow-org.${hostname}`,
        value: token,
        note: "Add this TXT record to your DNS, then call the verify endpoint.",
      },
    });
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr.code === "23505") {
      res.status(409).json({
        error:
          "This domain is already claimed by another workspace. Contact support if you believe this is an error.",
      });
      return;
    }
    throw err;
  }
});

// DELETE /api/workspaces/:id/domains/:domainId
router.delete(
  "/workspaces/:id/domains/:domainId",
  requireDomainRole("owner"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);
    const userId = req.userId!;

    const [domain] = await db
      .select()
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // Detach any project domains that reference this workspace domain
    await db
      .update(projectDomainsTable)
      .set({ workspaceDomainId: null })
      .where(eq(projectDomainsTable.workspaceDomainId, domainId));

    await db.delete(workspaceDomainsTable).where(eq(workspaceDomainsTable.id, domainId));

    await writeAudit({
      workspaceId,
      workspaceDomainId: domainId,
      userId,
      action: "domain_released",
      hostname: domain.hostname,
    });

    res.json({ deleted: true, hostname: domain.hostname });
  },
);

// POST /api/workspaces/:id/domains/:domainId/verify
router.post(
  "/workspaces/:id/domains/:domainId/verify",
  requireDomainRole("editor"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);
    const userId = req.userId!;

    const [domain] = await db
      .select()
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    if (domain.status === "verified") {
      res.json({ verified: true, status: "verified", hostname: domain.hostname });
      return;
    }

    // Look for TXT record: _mustaflow-org.<hostname> = verificationToken
    const txtName = `_mustaflow-org.${domain.hostname}`;
    let txtRecords: string[][] = [];
    try {
      txtRecords = await dns.resolveTxt(txtName);
    } catch {
      // NXDOMAIN or no record — falls through to fail
    }

    const flat = txtRecords.flat();
    const verified = flat.some(
      (v) => v === domain.verificationToken || v.includes(domain.verificationToken),
    );

    if (verified) {
      const [updated] = await db
        .update(workspaceDomainsTable)
        .set({ status: "verified", verifiedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceDomainsTable.id, domainId))
        .returning();

      await writeAudit({
        workspaceId,
        workspaceDomainId: domainId,
        userId,
        action: "domain_verified",
        hostname: domain.hostname,
      });

      res.json({ verified: true, status: "verified", domain: updated });
    } else {
      await db
        .update(workspaceDomainsTable)
        .set({ status: "failed", updatedAt: new Date() })
        .where(eq(workspaceDomainsTable.id, domainId));

      res.json({
        verified: false,
        status: "failed",
        hostname: domain.hostname,
        expectedRecord: {
          type: "TXT",
          name: txtName,
          value: domain.verificationToken,
        },
        found: flat,
        hint: "The TXT record was not found or did not match. DNS changes can take up to 48 hours to propagate.",
      });
    }
  },
);

// GET /api/workspaces/:id/domains/:domainId/roles
router.get(
  "/workspaces/:id/domains/:domainId/roles",
  requireDomainRole("viewer"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);

    const [domain] = await db
      .select()
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const roles = await db
      .select()
      .from(workspaceDomainRolesTable)
      .where(eq(workspaceDomainRolesTable.workspaceDomainId, domainId))
      .orderBy(asc(workspaceDomainRolesTable.createdAt));

    // Enrich with Clerk display info (best-effort — degrades to bare userId
    // when Clerk is unavailable or the user can't be resolved).
    const summaries = await getClerkUserSummaries(roles.map((r) => r.userId));
    const enriched = roles.map((r) => {
      const u = summaries.get(r.userId);
      return {
        ...r,
        email: u?.email ?? null,
        displayName: u?.displayName ?? null,
        imageUrl: u?.imageUrl ?? null,
      };
    });

    res.json({ roles: enriched, hostname: domain.hostname });
  },
);

// POST /api/workspaces/:id/users/lookup
// Resolve an email address to a Clerk user. Owner-only to limit account
// enumeration surface — only the person who can actually grant a role needs
// this. The POST roles endpoint resolves emails internally for everyone else.
router.post(
  "/workspaces/:id/users/lookup",
  requireWorkspaceOwner,
  async (req, res): Promise<void> => {
    const { email } = req.body as { email?: string };
    if (!email || typeof email !== "string" || !email.includes("@")) {
      res.status(400).json({ error: "A valid email address is required" });
      return;
    }
    const user = await findClerkUserByEmail(email);
    if (!user) {
      res.status(404).json({
        error: "No account found for that email address.",
        email: email.trim().toLowerCase(),
      });
      return;
    }
    res.json({ user });
  },
);

// POST /api/workspaces/:id/domains/:domainId/roles
router.post(
  "/workspaces/:id/domains/:domainId/roles",
  requireDomainRole("owner"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);
    const userId = req.userId!;
    const {
      userId: rawUserId,
      email,
      role,
    } = req.body as {
      userId?: string;
      email?: string;
      role?: string;
    };

    if (!role || !DOMAIN_ROLES.includes(role as DomainRole)) {
      res.status(400).json({ error: `role must be one of: ${DOMAIN_ROLES.join(", ")}` });
      return;
    }

    // Resolve the target user: prefer explicit userId, otherwise look up by email.
    let targetUserId = rawUserId?.trim() ?? "";
    let resolvedEmail: string | null = null;
    if (!targetUserId) {
      if (!email || typeof email !== "string" || !email.includes("@")) {
        res.status(400).json({ error: "Provide an email address or userId" });
        return;
      }
      const user = await findClerkUserByEmail(email);
      if (!user) {
        res.status(404).json({
          error:
            "No account found for that email. Ask them to sign up at this workspace's URL first, then try again.",
          email: email.trim().toLowerCase(),
        });
        return;
      }
      targetUserId = user.userId;
      resolvedEmail = user.email;
    }

    const [domain] = await db
      .select({ id: workspaceDomainsTable.id, hostname: workspaceDomainsTable.hostname })
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // Quota check for role grants — counts workspace-wide unique grantees
    // (not per-domain) so the plan limit reflects org-level grant capacity.
    // Updates to an existing grant (same domainId + userId) are exempt from
    // the quota check since they don't increase the total number of grantees.
    const [existingGrant] = await db
      .select({ id: workspaceDomainRolesTable.id })
      .from(workspaceDomainRolesTable)
      .where(
        and(
          eq(workspaceDomainRolesTable.workspaceDomainId, domainId),
          eq(workspaceDomainRolesTable.userId, targetUserId),
        ),
      );

    if (!existingGrant) {
      // New grant — enforce workspace-wide quota
      const workspaceRoles = await db
        .select({ id: workspaceDomainRolesTable.id })
        .from(workspaceDomainRolesTable)
        .innerJoin(
          workspaceDomainsTable,
          eq(workspaceDomainRolesTable.workspaceDomainId, workspaceDomainsTable.id),
        )
        .where(eq(workspaceDomainsTable.workspaceId, workspaceId));

      const quotaResult = await enforceQuota("domainRole", workspaceRoles.length, workspaceId);
      if (!quotaResult.allowed) {
        res.status(402).json({
          error: "Domain role grant quota exceeded for this workspace",
          quota: quotaResult,
          upgradeMessage: quotaResult.upgradeMessage,
        });
        return;
      }
    }

    const [grantRow] = await db
      .insert(workspaceDomainRolesTable)
      .values({
        workspaceDomainId: domainId,
        userId: targetUserId,
        role,
        grantedBy: userId,
      })
      .onConflictDoUpdate({
        target: [workspaceDomainRolesTable.workspaceDomainId, workspaceDomainRolesTable.userId],
        set: { role, grantedBy: userId, updatedAt: new Date() },
      })
      .returning();

    await writeAudit({
      workspaceId,
      workspaceDomainId: domainId,
      userId,
      action: "role_granted",
      hostname: domain.hostname,
      payload: { targetUserId, role, email: resolvedEmail },
    });

    res.status(201).json({ ...grantRow, email: resolvedEmail });
  },
);

// DELETE /api/workspaces/:id/domains/:domainId/roles/:targetUserId
router.delete(
  "/workspaces/:id/domains/:domainId/roles/:targetUserId",
  requireDomainRole("owner"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);
    const userId = req.userId!;
    const targetUserId = param(req.params.targetUserId);

    const [domain] = await db
      .select({ id: workspaceDomainsTable.id, hostname: workspaceDomainsTable.hostname })
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );
    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const deleted = await db
      .delete(workspaceDomainRolesTable)
      .where(
        and(
          eq(workspaceDomainRolesTable.workspaceDomainId, domainId),
          eq(workspaceDomainRolesTable.userId, targetUserId),
        ),
      )
      .returning();

    if (deleted.length === 0) {
      res.status(404).json({ error: "Role grant not found" });
      return;
    }

    await writeAudit({
      workspaceId,
      workspaceDomainId: domainId,
      userId,
      action: "role_revoked",
      hostname: domain.hostname,
      payload: { targetUserId },
    });

    res.json({ revoked: true, targetUserId });
  },
);

// GET /api/workspaces/:id/usage
// GET /api/workspaces/:id/usage
// Accessible to workspace owner AND users with any domain role (viewer+).
router.get("/workspaces/:id/usage", requireWorkspaceMember, async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const { month } = req.query as { month?: string };

  // Validate month format if provided
  if (month && !/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: "month must be in YYYY-MM format" });
    return;
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const targetMonth = month ?? currentMonth;

  // Trigger a lightweight rollup for the current month on-demand
  if (targetMonth === currentMonth) {
    const today = new Date().toISOString().slice(0, 10);
    const firstOfMonth = `${targetMonth}-01`;
    try {
      await rollupUsage(firstOfMonth, today);
    } catch (err) {
      logger.warn({ err, workspaceId }, "On-demand usage rollup failed (non-fatal)");
    }
    // Fire Stripe metered billing report in background (non-fatal, no-op until
    // task #645 adds byte tracking — skips when bandwidth_bytes=0).
    setImmediate(() => {
      reportBandwidthOverageToStripe(workspaceId).catch((err) =>
        logger.warn({ err, workspaceId }, "Stripe bandwidth report failed (background)"),
      );
    });
  }

  const rows = await getWorkspaceUsage(workspaceId, targetMonth);

  // Aggregate totals
  const totalRequests = rows.reduce((s, r) => s + r.requestCount, 0);
  const totalBytes = rows.reduce((s, r) => s + r.bandwidthBytes, 0);

  // Quota info
  const { resolveWorkspacePlan, PLAN_QUOTAS } = await import("../lib/plans");
  const plan = await resolveWorkspacePlan(workspaceId);
  const quota = PLAN_QUOTAS[plan];
  const usedGb = totalBytes / (1024 * 1024 * 1024);
  const limitGb = quota.maxBandwidthGbPerMonth;

  // Per-domain breakdown. hostname='' means platform traffic (no custom domain).
  const byDomain: Record<string, { requests: number; bytes: number }> = {};
  for (const row of rows) {
    const key = row.hostname === "" ? "__platform__" : row.hostname;
    if (!byDomain[key]) byDomain[key] = { requests: 0, bytes: 0 };
    byDomain[key].requests += row.requestCount;
    byDomain[key].bytes += row.bandwidthBytes;
  }

  res.json({
    workspaceId,
    month: targetMonth,
    totalRequests,
    totalBytes,
    totalGb: usedGb,
    quota: {
      plan,
      maxBandwidthGbPerMonth: limitGb,
      usedGb,
      remainingGb: limitGb === Infinity ? Infinity : Math.max(0, limitGb - usedGb),
      percentUsed: limitGb === Infinity ? 0 : Math.min(100, (usedGb / limitGb) * 100),
    },
    byDomain: Object.entries(byDomain).map(([hostname, data]) => ({
      hostname,
      requests: data.requests,
      bytes: data.bytes,
    })),
    dailyRows: rows,
  });
});

// GET /api/workspaces/:id/audit
// Accessible to workspace owner AND users with any domain role (viewer+).
router.get("/workspaces/:id/audit", requireWorkspaceMember, async (req, res): Promise<void> => {
  const workspaceId = req.workspaceId!;
  const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
  const offset = parseInt(String(req.query.offset ?? "0"), 10);

  const rows = await db
    .select()
    .from(workspaceDomainAuditTable)
    .where(eq(workspaceDomainAuditTable.workspaceId, workspaceId))
    .orderBy(desc(workspaceDomainAuditTable.createdAt))
    .limit(limit)
    .offset(offset);

  res.json({
    audit: rows.map((r) => ({
      id: r.id,
      workspaceDomainId: r.workspaceDomainId,
      userId: r.userId,
      action: r.action,
      hostname: r.hostname,
      payload: r.payload
        ? (() => {
            try {
              return JSON.parse(r.payload!);
            } catch {
              return r.payload;
            }
          })()
        : null,
      createdAt: r.createdAt,
    })),
    limit,
    offset,
  });
});

// POST /api/workspaces/:id/domains/:domainId/sub-claim
// Sub-hostname claim flow: attach a project subdomain under an org-verified apex.
// If the parent apex (e.g. acme.com) is verified by this workspace, skip TXT proof.
router.post(
  "/workspaces/:id/domains/:domainId/sub-claim",
  requireDomainRole("editor"),
  async (req, res): Promise<void> => {
    const workspaceId = req.workspaceId!;
    const domainId = parseInt(param(req.params.domainId), 10);
    const userId = req.userId!;
    const { projectId, hostname: rawHostname } = req.body as {
      projectId?: number;
      hostname?: string;
    };

    if (!projectId || !rawHostname) {
      res.status(400).json({ error: "projectId and hostname are required" });
      return;
    }

    const hostname = normaliseHostname(rawHostname);
    if (!hostname) {
      res.status(400).json({ error: "Invalid hostname" });
      return;
    }

    // Authorization: verify the target project belongs to this workspace.
    // Without this check, any domain editor could attach hostnames to arbitrary
    // projects across tenants (IDOR / cross-tenant mutation).
    const [targetProject] = await db
      .select({ id: projectsTable.id, workspaceId: projectsTable.workspaceId })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!targetProject) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (targetProject.workspaceId !== workspaceId) {
      res.status(403).json({
        error: "Project does not belong to this workspace",
      });
      return;
    }

    const [parentDomain] = await db
      .select()
      .from(workspaceDomainsTable)
      .where(
        and(
          eq(workspaceDomainsTable.id, domainId),
          eq(workspaceDomainsTable.workspaceId, workspaceId),
        ),
      );

    if (!parentDomain) {
      res.status(404).json({ error: "Parent workspace domain not found" });
      return;
    }

    if (parentDomain.status !== "verified") {
      res.status(400).json({
        error:
          "Parent workspace domain must be verified before sub-hostnames can be claimed without DNS proof.",
      });
      return;
    }

    // Verify the hostname is actually a subdomain of the parent
    if (!hostname.endsWith(`.${parentDomain.hostname}`)) {
      res.status(400).json({
        error: `${hostname} is not a subdomain of ${parentDomain.hostname}`,
      });
      return;
    }

    // Auto-verified since parent is org-verified
    const token = generateVerificationToken();

    try {
      const [projectDomain] = await db
        .insert(projectDomainsTable)
        .values({
          projectId,
          hostname,
          isPrimary: false,
          recordType: "cname",
          verificationToken: token,
          verificationStatus: "verified", // auto-verified via org ownership
          sslStatus: "pending",
          workspaceDomainId: domainId,
        })
        .returning();

      await writeAudit({
        workspaceId,
        workspaceDomainId: domainId,
        userId,
        action: "sub_hostname_claimed",
        hostname,
        payload: { projectId, parentHostname: parentDomain.hostname, autoVerified: true },
      });

      res.status(201).json({
        projectDomain,
        autoVerified: true,
        message: `${hostname} was auto-verified because ${parentDomain.hostname} is owned by this workspace.`,
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr.code === "23505") {
        res.status(409).json({ error: "This hostname is already attached to a project." });
        return;
      }
      throw err;
    }
  },
);

export default router;
