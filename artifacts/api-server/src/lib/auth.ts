import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
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

// ─── Development-only adapter ─────────────────────────────────────────────────
// Every request is treated as the same demo user.
// This adapter HARD FAILS in production so it can never be shipped unnoticed.
class DevOnlyAuthAdapter implements AuthAdapter {
  private static warned = false;

  attachUser(req: Request, res: Response, next: NextFunction): void {
    if (process.env.NODE_ENV === "production") {
      // Safety net: refuse to run with the stub adapter in production.
      res.status(500).json({
        error:
          "Authentication is not configured. Swap DevOnlyAuthAdapter for a real provider before deploying.",
      });
      return;
    }
    if (!DevOnlyAuthAdapter.warned) {
      DevOnlyAuthAdapter.warned = true;
      logger.warn(
        "⚠ DEV-ONLY AUTH: all requests are served as 'demo-user'. " +
        "Replace DevOnlyAuthAdapter in auth.ts before production launch.",
      );
    }
    req.userId = "demo-user";
    next();
  }
}

// ─── Active adapter ───────────────────────────────────────────────────────────
// SWAP THIS to enable real auth:
//   const activeAdapter: AuthAdapter = new ClerkAuthAdapter();
const activeAdapter: AuthAdapter = new DevOnlyAuthAdapter();

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
    .where(eq(projectsTable.id, projectId));
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
