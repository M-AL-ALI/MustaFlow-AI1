import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
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
    const userId =
      (auth?.sessionClaims?.["userId"] as string | undefined) ?? auth?.userId;
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
    req.userId = "demo-user";
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
    }
  }
}

export function attachUser(req: Request, res: Response, next: NextFunction): void {
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
