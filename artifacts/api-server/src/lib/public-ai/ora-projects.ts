import { and, eq, isNull } from "drizzle-orm";
import { db, oraProjectsTable } from "@workspace/db";

/**
 * Ora Project Spaces — shared ownership/liveness checks.
 *
 * Project semantics: `oraProjectId = null` (or absent) means the user's
 * default "Personal" space. The Personal space is virtual — it has no
 * ora_projects row, requires no provisioning, and is always a valid target.
 *
 * A numeric project id is a valid WRITE target only when the project exists,
 * belongs to the calling user, and is not archived.
 */

export type OraProjectCheck =
  | { ok: true }
  | { ok: false; status: 404 | 400; error: string };

/**
 * Validate that `projectId` is usable as a write target for `userId`.
 *
 * - `null`/`undefined` → Personal space, always ok.
 * - Unknown or cross-user project → 404 (do not leak existence).
 * - Archived project → 400 (exists and is yours, but read-only until restored).
 */
export async function checkOraProjectWritable(
  userId: string,
  projectId: number | null | undefined,
): Promise<OraProjectCheck> {
  if (projectId == null) return { ok: true };

  const [row] = await db
    .select({ id: oraProjectsTable.id, archivedAt: oraProjectsTable.archivedAt })
    .from(oraProjectsTable)
    .where(and(eq(oraProjectsTable.id, projectId), eq(oraProjectsTable.userId, userId)))
    .limit(1);

  if (!row) return { ok: false, status: 404, error: "Project not found" };
  if (row.archivedAt != null) {
    return { ok: false, status: 400, error: "Project is archived" };
  }
  return { ok: true };
}

/**
 * True when `projectId` names an ACTIVE project owned by `userId`.
 * Personal (`null`) returns false — callers use this to decide whether a
 * project-scoped query should target the project or fall back to Personal.
 */
export async function isOwnedActiveOraProject(
  userId: string,
  projectId: number | null | undefined,
): Promise<boolean> {
  if (projectId == null) return false;
  const [row] = await db
    .select({ id: oraProjectsTable.id })
    .from(oraProjectsTable)
    .where(
      and(
        eq(oraProjectsTable.id, projectId),
        eq(oraProjectsTable.userId, userId),
        isNull(oraProjectsTable.archivedAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}
