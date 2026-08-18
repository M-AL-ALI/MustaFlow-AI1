/**
 * Shared project-access guard for all v1 routes.
 *
 * Enforces two layers:
 * 1. Current access: req.userId must own the project or hold a live
 *    organization membership at the required role.
 * 2. PAT project-scope: if the token is project-scoped (req.patProjectId is set),
 *    the requested projectId must match it exactly.
 *
 * Session-auth callers (patProjectId = undefined) pass layer 2 automatically;
 * both authentication modes remain bound by the canonical live-access check.
 */

import type { Request, Response, NextFunction } from "express";
import type { PATRequest } from "../../lib/pat-auth";
import { checkProjectAccess, type ProjectRole } from "../../lib/auth";

export async function checkV1ProjectAccess(
  req: Request,
  projectId: number,
  minRole: ProjectRole = "viewer",
): Promise<boolean> {
  const userId = req.userId!;

  // PAT project-scoped: the token may only access a single project.
  // The canonical access predicate still runs so a stale or invalid scope can
  // never substitute for actual owner/organization authorization.
  const patReq = req as unknown as PATRequest;
  if (patReq.patProjectId !== null && patReq.patProjectId !== undefined) {
    if (patReq.patProjectId !== projectId) return false;
  }

  return (await checkProjectAccess(userId, projectId, minRole)) === "granted";
}

/** Minimum live project role needed to mint a project-scoped PAT. */
export function projectRoleForV1Scopes(scopes: readonly string[]): ProjectRole {
  if (scopes.includes("domains:write") || scopes.includes("webhooks:write")) return "admin";
  if (
    scopes.includes("projects:write") ||
    scopes.includes("builds:trigger") ||
    scopes.includes("files:write")
  ) {
    return "member";
  }
  return "viewer";
}

/**
 * True when the request was authenticated via a Bearer PAT token.
 * Used to conditionally enforce PAT-specific scope requirements
 * without affecting session-auth callers.
 */
export function isPatAuth(req: Request): boolean {
  return Boolean(req.headers["authorization"]?.startsWith("Bearer "));
}

/**
 * Middleware factory: enforce a PAT scope only when the request was
 * authenticated via a Bearer token.  Clerk session-cookie callers are
 * unaffected and pass straight through.
 */
export function requirePatScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPatAuth(req) && !(req as unknown as PATRequest).patScopes?.includes(scope)) {
      res.status(403).json({ error: `This token does not have the '${scope}' scope.` });
      return;
    }
    next();
  };
}
