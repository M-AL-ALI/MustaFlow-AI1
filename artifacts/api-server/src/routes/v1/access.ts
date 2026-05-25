/**
 * Shared project-access guard for all v1 routes.
 *
 * Enforces two layers:
 * 1. Ownership: the project must be owned by req.userId.
 * 2. PAT project-scope: if the token is project-scoped (req.patProjectId is set),
 *    the requested projectId must match it exactly.
 *
 * Session-auth callers (patProjectId = undefined) pass layer 2 automatically
 * and are only bound by ownership.
 */

import type { Request } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import type { PATRequest } from "../../lib/pat-auth";

export async function checkV1ProjectAccess(req: Request, projectId: number): Promise<boolean> {
  const userId = req.userId!;

  // PAT project-scoped: the token may only access a single project.
  // Even if the user owns other projects, the token cannot reach them.
  const patReq = req as unknown as PATRequest;
  if (patReq.patProjectId !== null && patReq.patProjectId !== undefined) {
    return patReq.patProjectId === projectId;
  }

  // User-scoped PAT or session auth: verify ownership.
  const [proj] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.id, projectId),
        eq(projectsTable.ownerId, userId),
        isNull(projectsTable.deletedAt),
      ),
    );
  return Boolean(proj);
}

/**
 * True when the request was authenticated via a Bearer PAT token.
 * Used to conditionally enforce PAT-specific scope requirements
 * without affecting session-auth callers.
 */
export function isPatAuth(req: Request): boolean {
  return Boolean(req.headers["authorization"]?.startsWith("Bearer "));
}
