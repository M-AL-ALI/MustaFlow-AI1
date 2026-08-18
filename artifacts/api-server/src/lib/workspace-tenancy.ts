import { and, asc, eq, isNull } from "drizzle-orm";
import { db, workspaceMembersTable, workspacesTable } from "@workspace/db";

export class ProjectWorkspaceUnavailableError extends Error {
  readonly code = "project_workspace_unavailable";

  constructor() {
    super("No active owner workspace is available for this project");
    this.name = "ProjectWorkspaceUnavailableError";
  }
}

/**
 * Resolve the workspace assigned to a newly-created project.
 *
 * A requested workspace is only a hint: live membership must be proven server-side.
 * An absent or unauthorized hint falls back without revealing whether the hinted row exists.
 * The deterministic default is the caller's oldest active owner-membership workspace.
 */
export async function resolveProjectWorkspaceId(input: {
  userId: string;
  requestedWorkspaceId?: number | null;
}): Promise<number> {
  if (input.requestedWorkspaceId != null) {
    const [requested] = await db
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .innerJoin(
        workspaceMembersTable,
        and(
          eq(workspaceMembersTable.workspaceId, workspacesTable.id),
          eq(workspaceMembersTable.userId, input.userId),
        ),
      )
      .where(
        and(eq(workspacesTable.id, input.requestedWorkspaceId), isNull(workspacesTable.deletedAt)),
      )
      .limit(1);

    if (requested) return requested.id;
  }

  const [fallback] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .innerJoin(
      workspaceMembersTable,
      and(
        eq(workspaceMembersTable.workspaceId, workspacesTable.id),
        eq(workspaceMembersTable.userId, input.userId),
        eq(workspaceMembersTable.role, "owner"),
      ),
    )
    .where(isNull(workspacesTable.deletedAt))
    .orderBy(
      asc(workspacesTable.createdAt),
      asc(workspaceMembersTable.joinedAt),
      asc(workspacesTable.id),
    )
    .limit(1);

  if (!fallback) throw new ProjectWorkspaceUnavailableError();
  return fallback.id;
}
