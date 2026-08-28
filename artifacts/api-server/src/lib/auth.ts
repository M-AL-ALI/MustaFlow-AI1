import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectCollaboratorsTable,
  orgMembersTable,
  organizationsTable,
  oraxDesktopSessionsTable,
} from "@workspace/db";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Auth Adapter Interface
//
// SWAP POINT: To enable real authentication, implement this interface and replace
// `activeAdapter` below. Options:
//   • ClerkAuthAdapter   — verify Clerk session JWT from cookie/header, set req.userId
//   • ReplitAuthAdapter  — verify Replit OIDC token, set req.userId
//
// The adapter must either call next() with req.userId set, or respond with
// 401 {"error":"Unauthenticated"} if no valid credential is present.
// ─────────────────────────────────────────────────────────────────────────────
export interface AuthAdapter {
  attachUser(req: Request, res: Response, next: NextFunction): void | Promise<void>;
}

// ─── Clerk adapter (production-ready) ────────────────────────────────────────
// Reads the Clerk session that clerkMiddleware() has already resolved.
// Requires @clerk/express clerkMiddleware to be mounted in app.ts first.
class ClerkAuthAdapter implements AuthAdapter {
  attachUser(req: Request, res: Response, next: NextFunction): void {
    const auth = getAuth(req);
    // sessionClaims.userId handles legacy migrated sessions; auth.userId covers new ones.
    const userId = (auth?.sessionClaims?.["userId"] as string | undefined) ?? auth?.userId;
    if (!userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    req.userId = userId;
    next();
  }
}

// ─── Development-only fallback ────────────────────────────────────────────────
// Every request is treated as the same demo user.
// Hard-fails in production — can never be accidentally shipped.
// Activate by swapping activeAdapter below when running without Clerk.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
class DevOnlyAuthAdapter implements AuthAdapter {
  private static warned = false;

  attachUser(req: Request, res: Response, next: NextFunction): void {
    if (process.env.NODE_ENV === "production") {
      res.status(500).json({
        error:
          "Authentication is not configured. Replace DevOnlyAuthAdapter with ClerkAuthAdapter.",
      });
      return;
    }
    if (!DevOnlyAuthAdapter.warned) {
      DevOnlyAuthAdapter.warned = true;
      logger.warn(
        "⚠ DEV-ONLY AUTH: all requests served as 'demo-user'. " +
          "Replace DevOnlyAuthAdapter in auth.ts before production launch.",
      );
    }
    req.userId = "user_3EHZxIQGGhfh2Du5O2KlQ6s7rug";
    next();
  }
}

// ─── Active adapter ───────────────────────────────────────────────────────────
// SWAP POINT: change to DevOnlyAuthAdapter for local testing without Clerk.
const activeAdapter: AuthAdapter = new ClerkAuthAdapter();
const ORAX_DESKTOP_TOKEN_PREFIX = "oraxdt_";

// ─────────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** Set when an Orax Desktop session token authenticates an /orax request. */
      oraxDesktopSessionId?: string;
      /** Set by aiBuilderLimiter when concurrent AI slots are full. */
      forceBackground?: boolean;
      /** Queue position (1-based) set by aiBuilderLimiter when forceBackground is true. */
      queuePosition?: number;
    }
  }
}

/**
 * True only when the explicit, non-production end-to-end test auth bypass is
 * active. Requires BOTH NODE_ENV !== "production" AND E2E_TEST_ENABLED === "true"
 * so the bypass can never be silently enabled in production or shared staging.
 *
 * Shared so any pre-auth-wall route (e.g. the public Ora chat endpoint, which
 * reads the Clerk session directly and never runs attachUser) can honour the
 * same `x-e2e-test-user` header under identical guard conditions.
 */
export function isE2ETestAuthEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_TEST_ENABLED === "true";
}

export function attachUser(req: Request, res: Response, next: NextFunction): void {
  // E2E test bypass: only active when both E2E_TEST_ENABLED=true and NODE_ENV !== "production"
  // are set. Requiring an explicit opt-in env flag prevents the bypass from
  // being silently active in shared staging / non-prod deployments.
  if (isE2ETestAuthEnabled()) {
    const testUser = req.headers["x-e2e-test-user"];
    if (typeof testUser === "string" && testUser.length > 0) {
      req.userId = testUser;
      next();
      return;
    }
  }

  void attachOraxDesktopUser(req)
    .then((attached) => {
      if (attached) {
        next();
        return;
      }
      void activeAdapter.attachUser(req, res, next);
    })
    .catch((err) => {
      logger.warn({ err }, "Orax Desktop token auth failed; falling back to Clerk auth");
      void activeAdapter.attachUser(req, res, next);
    });
}

function extractBearerToken(req: Request): string | null {
  const value = req.get("authorization");
  if (!value) return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function isOraxPath(req: Request): boolean {
  return req.path === "/orax" || req.path.startsWith("/orax/");
}

function hashDesktopToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function attachOraxDesktopUser(req: Request): Promise<boolean> {
  if (!isOraxPath(req)) return false;
  const token = extractBearerToken(req);
  if (!token?.startsWith(ORAX_DESKTOP_TOKEN_PREFIX)) return false;

  const [session] = await db
    .select()
    .from(oraxDesktopSessionsTable)
    .where(
      and(
        eq(oraxDesktopSessionsTable.tokenHash, hashDesktopToken(token)),
        isNull(oraxDesktopSessionsTable.revokedAt),
        gt(oraxDesktopSessionsTable.expiresAt, new Date()),
      ),
    );

  if (!session) return false;

  req.userId = session.userId;
  req.oraxDesktopSessionId = session.id;
  void db
    .update(oraxDesktopSessionsTable)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(eq(oraxDesktopSessionsTable.id, session.id));
  return true;
}

export async function requireProjectOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const projectId = parseInt(rawId ?? "", 10);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  const projectOwnerId = project?.ownerId ?? null;
  if (projectOwnerId !== req.userId) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  next();
}

// ─────────────────────────────────────────────────────────────────────────────
// requireProjectAccess(minRole)
//
// Grants access when the requester is either:
//   1. The direct project owner (legacy solo-user case — fully preserved), OR
//   2. A member of the project's organization with role >= minRole.
//
// Role hierarchy (ascending): viewer < member < admin < owner.
//
// Use "viewer" for read-only GETs, "member" for content mutations, "admin"
// for sensitive settings, and the legacy `requireProjectOwnership` (or
// "owner") for destructive/ownership-transfer routes.
// ─────────────────────────────────────────────────────────────────────────────
export type ProjectRole = "viewer" | "member" | "admin" | "owner";

const ROLE_RANK: Record<ProjectRole, number> = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

function roleMeets(actual: string, minimum: ProjectRole): boolean {
  const actualRank = ROLE_RANK[actual as ProjectRole] ?? 0;
  return actualRank >= ROLE_RANK[minimum];
}

const COLLABORATOR_ROLE_RANK: Record<string, number> = {
  viewer: ROLE_RANK.viewer,
  editor: ROLE_RANK.member,
  publisher: ROLE_RANK.admin,
  owner: ROLE_RANK.owner,
};

function collaboratorRoleMeets(actual: string, minimum: ProjectRole): boolean {
  return (COLLABORATOR_ROLE_RANK[actual] ?? 0) >= ROLE_RANK[minimum];
}

export type ProjectAccessDecision = "granted" | "not_found" | "not_member" | "insufficient_role";

/**
 * Canonical project-access predicate for routes whose project id is not named
 * `req.params.id` (for example body/query ids and project-owned child rows).
 * This is the same owner-or-organization policy used by requireProjectAccess.
 */
export async function checkProjectAccess(
  userId: string,
  projectId: number,
  minRole: ProjectRole = "viewer",
): Promise<ProjectAccessDecision> {
  const [project] = await db
    .select({
      ownerId: projectsTable.ownerId,
      organizationId: projectsTable.organizationId,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (project?.ownerId === userId) return "granted";

  if (!project) return "not_found";

  const [collaborator] = await db
    .select({ role: projectCollaboratorsTable.role })
    .from(projectCollaboratorsTable)
    .where(
      and(
        eq(projectCollaboratorsTable.projectId, projectId),
        eq(projectCollaboratorsTable.userId, userId),
      ),
    );
  if (collaborator) {
    return collaboratorRoleMeets(collaborator.role, minRole) ? "granted" : "insufficient_role";
  }

  const organizationId = project.organizationId ?? -1;
  const [member] = await db
    .select({ role: orgMembersTable.role })
    .from(orgMembersTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, orgMembersTable.organizationId))
    .where(
      and(
        eq(orgMembersTable.organizationId, organizationId),
        eq(orgMembersTable.userId, userId),
        isNull(organizationsTable.deletedAt),
      ),
    );

  if (!member) return "not_member";
  return roleMeets(member.role, minRole) ? "granted" : "insufficient_role";
}

/** Return every active project the user may access at the requested role. */
export async function listAccessibleProjectIds(
  userId: string,
  minRole: ProjectRole = "viewer",
): Promise<number[]> {
  const memberships = await db
    .select({ organizationId: orgMembersTable.organizationId, role: orgMembersTable.role })
    .from(orgMembersTable)
    .innerJoin(organizationsTable, eq(organizationsTable.id, orgMembersTable.organizationId))
    .where(and(eq(orgMembersTable.userId, userId), isNull(organizationsTable.deletedAt)));
  const organizationIds = memberships
    .filter((membership) => roleMeets(membership.role, minRole))
    .map((membership) => membership.organizationId);

  const accessCondition =
    organizationIds.length > 0
      ? or(
          eq(projectsTable.ownerId, userId),
          inArray(projectsTable.organizationId, organizationIds),
        )
      : eq(projectsTable.ownerId, userId);
  const [rows, collaboratorRows] = await Promise.all([
    db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(accessCondition!, isNull(projectsTable.deletedAt))),
    db
      .select({ id: projectCollaboratorsTable.projectId, role: projectCollaboratorsTable.role })
      .from(projectCollaboratorsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, projectCollaboratorsTable.projectId))
      .where(and(eq(projectCollaboratorsTable.userId, userId), isNull(projectsTable.deletedAt))),
  ]);
  return Array.from(
    new Set([
      ...rows.map((row) => row.id),
      ...collaboratorRows
        .filter((row) => collaboratorRoleMeets(row.role, minRole))
        .map((row) => row.id),
    ]),
  );
}

export function requireProjectAccess(minRole: ProjectRole = "viewer"): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const projectId = parseInt(rawId ?? "", 10);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const decision = await checkProjectAccess(req.userId, projectId, minRole);
    if (decision === "not_found" || decision === "not_member") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (decision === "granted") {
      next();
      return;
    }
    res
      .status(403)
      .json({ error: "Your role does not allow this action. Ask a project admin for access." });
  };
}
