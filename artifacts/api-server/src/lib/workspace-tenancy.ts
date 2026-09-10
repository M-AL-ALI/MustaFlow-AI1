import { and, asc, eq, inArray, isNull } from "drizzle-orm";
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
 * A requested destination is binding: never silently create in a different workspace.
 * Server-owned copy flows may instead provide a preference and fall back to an owner
 * workspace. Neither form allows viewer/billing membership to create in that workspace.
 * Omitted destinations preserve the oldest active owner-membership default.
 */
export async function resolveProjectWorkspaceId(input: {
  userId: string;
  requestedWorkspaceId?: number | null;
  preferredWorkspaceId?: number | null;
}): Promise<number> {
  const bindingDestination = input.requestedWorkspaceId != null;
  if (bindingDestination && input.preferredWorkspaceId != null) {
    throw new ProjectWorkspaceUnavailableError();
  }
  const destination = input.requestedWorkspaceId ?? input.preferredWorkspaceId;
  if (
    destination != null &&
    Number.isSafeInteger(destination) &&
    destination > 0 &&
    destination <= 2147483647
  ) {
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
        and(
          eq(workspacesTable.id, destination),
          isNull(workspacesTable.deletedAt),
          inArray(workspaceMembersTable.role, ["owner", "admin", "builder"]),
        ),
      )
      .limit(1);

    if (requested) return requested.id;
  }

  if (bindingDestination) throw new ProjectWorkspaceUnavailableError();

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
