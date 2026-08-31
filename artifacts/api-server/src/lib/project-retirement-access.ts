import { and, eq, inArray, isNull, sql, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as DatabaseSchema from "@workspace/db/schema";
import {
  previewSessionsTable,
  shareLinksTable,
  supportAccessGrantsTable,
  supportGrantEventsTable,
  supportZeroSessionsTable,
  type ProjectRetirementProgress,
} from "@workspace/db/schema";

type ProjectRetirementTransaction = NodePgTransaction<
  typeof DatabaseSchema,
  ExtractTablesWithRelations<typeof DatabaseSchema>
>;

export const PROJECT_RETIREMENT_OPEN_GRANT_STATUSES = ["pending", "active"] as const;
export const PROJECT_RETIREMENT_NONTERMINAL_SUPPORT_SESSION_STATUSES = [
  "diagnosing",
  "proposal_ready",
  "approved",
  "applying",
] as const;

const SUPPORT_SESSION_RETIREMENT_TERMINAL = {
  contract: "support-zero-session-terminal-v1",
  outcome: "interrupted",
  code: "project_trashed",
  retryable: false,
} as const;

/**
 * Revoke every access surface that could otherwise become live again when a
 * project tombstone is cleared. The caller owns the surrounding retirement
 * transaction; this helper deliberately opens no transaction of its own.
 */
export async function retireProjectAccessSurfaces(
  tx: ProjectRetirementTransaction,
  input: {
    projectId: number;
    actorUserId: string;
    progress: ProjectRetirementProgress;
  },
): Promise<ProjectRetirementProgress> {
  const revokedShareLinks = await tx
    .update(shareLinksTable)
    .set({
      revoked: true,
      revokedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(and(eq(shareLinksTable.projectId, input.projectId), eq(shareLinksTable.revoked, false)))
    .returning({ id: shareLinksTable.id });

  const revokedPreviewSessions = await tx
    .update(previewSessionsTable)
    .set({
      revokedAt: sql`CURRENT_TIMESTAMP`,
      revokeReason: "project_trashed",
    })
    .where(
      and(
        eq(previewSessionsTable.projectId, input.projectId),
        isNull(previewSessionsTable.revokedAt),
      ),
    )
    .returning({ id: previewSessionsTable.id });

  const revokedSupportGrants = await tx
    .update(supportAccessGrantsTable)
    .set({
      status: "revoked",
      decidedAt: sql`COALESCE(${supportAccessGrantsTable.decidedAt}, CURRENT_TIMESTAMP)`,
      revokedAt: sql`CURRENT_TIMESTAMP`,
      closedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(supportAccessGrantsTable.projectId, input.projectId),
        inArray(supportAccessGrantsTable.status, PROJECT_RETIREMENT_OPEN_GRANT_STATUSES),
      ),
    )
    .returning({
      id: supportAccessGrantsTable.id,
      ticketId: supportAccessGrantsTable.ticketId,
    });

  if (revokedSupportGrants.length > 0) {
    await tx.insert(supportGrantEventsTable).values(
      revokedSupportGrants.map((grant) => ({
        grantId: grant.id,
        ticketId: grant.ticketId,
        projectId: input.projectId,
        actorUserId: input.actorUserId,
        actorDisplayName: null,
        event: "access_revoked_project_trashed",
        detail: { reason: "project_trashed" },
      })),
    );
  }

  const interruptedSupportSessions = await tx
    .update(supportZeroSessionsTable)
    .set({
      status: "interrupted",
      terminal: SUPPORT_SESSION_RETIREMENT_TERMINAL,
      completedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(
      and(
        eq(supportZeroSessionsTable.projectId, input.projectId),
        inArray(
          supportZeroSessionsTable.status,
          PROJECT_RETIREMENT_NONTERMINAL_SUPPORT_SESSION_STATUSES,
        ),
      ),
    )
    .returning({ id: supportZeroSessionsTable.id });

  return {
    ...input.progress,
    access: {
      state: "revoked",
      shareLinksRevoked: revokedShareLinks.length,
      previewSessionsRevoked: revokedPreviewSessions.length,
      supportGrantsRevoked: revokedSupportGrants.length,
      supportSessionsInterrupted: interruptedSupportSessions.length,
    },
  };
}
