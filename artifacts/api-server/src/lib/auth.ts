import type { Request, Response, NextFunction, RequestHandler } from "express";
import { getAuth } from "@clerk/express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable, orgMembersTable } from "@workspace/db";
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

// ─────────────────────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
      /** Set by aiBuilderLimiter when concurrent AI slots are full. */
      forceBackground?: boolean;
      /** Queue position (1-based) set by aiBuilderLimiter when forceBackground is true. */
      queuePosition?: number;
    }
  }
}

export function attachUser(req: Request, res: Response, next: NextFunction): void {
  // E2E test bypass: only active when both E2E_TEST_ENABLED=true and NODE_ENV !== "production"
  // are set. Requiring an explicit opt-in env flag prevents the bypass from
  // being silently active in shared staging / non-prod deployments.
  if (process.env.NODE_ENV !== "production" && process.env.E2E_TEST_ENABLED === "true") {
    const testUser = req.headers["x-e2e-test-user"];
    if (typeof testUser === "string" && testUser.length > 0) {
      req.userId = testUser;
      next();
      return;
    }
  }
  void activeAdapter.attachUser(req, res, next);
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
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  if (project.ownerId !== req.userId) {
    res.status(403).json({ error: "You do not have access to this project" });
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
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    // Direct project owner always has full access — preserves solo-user behaviour.
    if (project.ownerId === req.userId) {
      next();
      return;
    }
    // Otherwise, check org membership when the project is org-scoped.
    if (project.organizationId != null) {
      const [member] = await db
        .select({ role: orgMembersTable.role })
        .from(orgMembersTable)
        .where(
          and(
            eq(orgMembersTable.organizationId, project.organizationId),
            eq(orgMembersTable.userId, req.userId),
          ),
        );
      if (member && roleMeets(member.role, minRole)) {
        next();
        return;
      }
    }
    res.status(403).json({ error: "You do not have access to this project" });
  };
}
