import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, projectsTable, workspaceMembersTable, workspacesTable } from "@workspace/db";
import { ProjectWorkspaceUnavailableError } from "./workspace-tenancy";

export { ProjectWorkspaceUnavailableError as WorkspaceAdmissionError };
export type WorkspaceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The selection helper is only a preflight. Recheck and lock the exact selected
 * workspace and caller membership until the project insertion commits. Never
 * provision infrastructure or perform network requests in this callback.
 */
export async function withProjectWorkspaceAdmission<T>(
  input: { workspaceId: number; userId: string },
  insert: (transaction: WorkspaceTransaction) => Promise<T>,
): Promise<T> {
  if (
    !Number.isInteger(input.workspaceId) ||
    input.workspaceId < 1 ||
    input.workspaceId > 2147483647 ||
    !input.userId
  ) {
    throw new ProjectWorkspaceUnavailableError();
  }
  return db.transaction(
    async (tx) => {
      const [workspace] = await tx
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(and(eq(workspacesTable.id, input.workspaceId), isNull(workspacesTable.deletedAt)))
        .limit(1)
        .for("update");
      if (!workspace) throw new ProjectWorkspaceUnavailableError();

      // A concurrent role removal/demotion must either precede this check or wait
      // until the admitted creation commits. Platform Admin status is irrelevant.
      const [member] = await tx
        .select({ role: workspaceMembersTable.role })
        .from(workspaceMembersTable)
        .where(
          and(
            eq(workspaceMembersTable.workspaceId, input.workspaceId),
            eq(workspaceMembersTable.userId, input.userId),
            inArray(workspaceMembersTable.role, ["owner", "admin", "builder"]),
          ),
        )
        .limit(1)
        .for("share");
      if (!member) throw new ProjectWorkspaceUnavailableError();
      return insert(tx);
    },
    { isolationLevel: "read committed" },
  );
}

export type WorkspaceRetirementResult =
  | "retired"
  | "not-found"
  | "only-workspace"
  | "projects-remain";

/** Empty-workspace retirement is serialized with creation and sibling retirements. */
export async function retireEmptyWorkspace(input: {
  workspaceId: number;
  userId: string;
}): Promise<WorkspaceRetirementResult> {
  return db.transaction(
    async (tx) => {
      // Serialize this owner's retirements before counting their remaining workspaces.
      // Creation only needs the destination row lock, not this owner-wide lock.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${"workspace-retirement:" + input.userId}, 0))`,
      );
      const [workspace] = await tx
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(
          and(
            eq(workspacesTable.id, input.workspaceId),
            eq(workspacesTable.ownerUserId, input.userId),
            isNull(workspacesTable.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!workspace) return "not-found";

      const remaining = await tx
        .select({ id: workspacesTable.id })
        .from(workspacesTable)
        .where(
          and(eq(workspacesTable.ownerUserId, input.userId), isNull(workspacesTable.deletedAt)),
        )
        .limit(2);
      if (remaining.length <= 1) return "only-workspace";

      // Trash remains recoverable; it is still a durable workspace reference.
      const [project] = await tx
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(eq(projectsTable.workspaceId, input.workspaceId))
        .limit(1);
      if (project) return "projects-remain";

      await tx
        .update(workspacesTable)
        .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(workspacesTable.id, input.workspaceId));
      return "retired";
    },
    { isolationLevel: "read committed" },
  );
}
