import { and, asc, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  userCreditsTable,
  workspaceMembersTable,
  workspacesTable,
  type Workspace,
} from "@workspace/db";

type WorkspaceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface WorkspaceCreationInput {
  ownerUserId: string;
  name: string;
  description?: string;
  type: "personal" | "business" | "client" | "team";
}

export interface SignupFoundationResult {
  workspace: Workspace;
  workspaceCreated: boolean;
}

const activeWorkspace = isNull(workspacesTable.deletedAt);

/** A workspace name is display copy only; it is never used to find or deduplicate a workspace. */
export function defaultWorkspaceName(displayName: string | null | undefined): string {
  const normalized = displayName?.replace(/\s+/g, " ").trim();
  if (!normalized) return "My workspace";
  return `${normalized.slice(0, 100)}'s workspace`;
}

async function ensureOwnerMembership(
  tx: WorkspaceTransaction,
  workspace: Pick<Workspace, "id" | "ownerUserId" | "createdAt">,
): Promise<void> {
  await tx
    .insert(workspaceMembersTable)
    .values({
      workspaceId: workspace.id,
      userId: workspace.ownerUserId,
      role: "owner",
      invitedBy: workspace.ownerUserId,
      joinedAt: workspace.createdAt,
    })
    .onConflictDoUpdate({
      target: [workspaceMembersTable.workspaceId, workspaceMembersTable.userId],
      set: { role: "owner", invitedBy: workspace.ownerUserId },
    });
}

/** Create a manually named workspace and its owner membership in one transaction. */
export async function createOwnedWorkspace(input: WorkspaceCreationInput): Promise<Workspace> {
  return db.transaction(async (tx) => {
    const [workspace] = await tx.insert(workspacesTable).values(input).returning();
    if (!workspace) throw new Error("workspace_create_failed");

    await ensureOwnerMembership(tx, workspace);
    return workspace;
  });
}

/**
 * Establish the durable rows owned by a Clerk user.created event.
 * Duplicate deliveries serialize on a user-derived transaction lock. The lock, never the
 * workspace display name, is the identity that prevents duplicate signup workspaces.
 */
export async function ensureUserSignupFoundation(input: {
  userId: string;
  displayName?: string | null;
}): Promise<SignupFoundationResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${input.userId}, 0))`);

    await tx
      .insert(userCreditsTable)
      .values({ userId: input.userId, balance: 100 })
      .onConflictDoNothing();

    const [existing] = await tx
      .select()
      .from(workspacesTable)
      .where(and(eq(workspacesTable.ownerUserId, input.userId), activeWorkspace))
      .orderBy(asc(workspacesTable.createdAt))
      .limit(1);

    if (existing) {
      await ensureOwnerMembership(tx, existing);
      return { workspace: existing, workspaceCreated: false };
    }

    const [created] = await tx
      .insert(workspacesTable)
      .values({
        ownerUserId: input.userId,
        name: defaultWorkspaceName(input.displayName),
        type: "personal",
      })
      .returning();

    if (!created) throw new Error("signup_workspace_create_failed");
    await ensureOwnerMembership(tx, created);
    return { workspace: created, workspaceCreated: true };
  });
}
