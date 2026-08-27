import { and, desc, eq, gt, inArray } from "drizzle-orm";
import {
  db,
  supportAccessGrantsTable,
  supportGrantEventsTable,
  supportZeroSessionsTable,
  type SupportAccessGrant,
  type SupportGrantStatus,
} from "@workspace/db";
import { getSharedAccountProfile } from "./clerk-users";
import { resolveStaffPrincipal } from "./adminAuth";

export const MAX_SUPPORT_GRANT_MS = 24 * 60 * 60 * 1000;

export type EffectiveSupportGrant = Omit<SupportAccessGrant, "status"> & {
  status: SupportGrantStatus;
};

export function effectiveSupportGrantStatus(
  grant: Pick<SupportAccessGrant, "status" | "expiresAt">,
  now = new Date(),
): SupportGrantStatus {
  if (
    grant.status === "active" &&
    (!grant.expiresAt || grant.expiresAt.getTime() <= now.getTime())
  ) {
    return "expired";
  }
  return grant.status as SupportGrantStatus;
}

export async function findLiveSupportGrant(input: {
  projectId: number;
  staffUserId: string;
  now?: Date;
}): Promise<SupportAccessGrant | null> {
  const now = input.now ?? new Date();
  const [grant] = await db
    .select()
    .from(supportAccessGrantsTable)
    .where(
      and(
        eq(supportAccessGrantsTable.projectId, input.projectId),
        eq(supportAccessGrantsTable.staffUserId, input.staffUserId),
        eq(supportAccessGrantsTable.status, "active"),
        gt(supportAccessGrantsTable.expiresAt, now),
      ),
    )
    .orderBy(desc(supportAccessGrantsTable.requestedAt))
    .limit(1);
  return grant ?? null;
}

export async function recordSupportGrantEvent(input: {
  grantId: number;
  ticketId: number;
  projectId: number;
  actorUserId: string;
  event: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const identity = await getSharedAccountProfile(input.actorUserId);
  await db.insert(supportGrantEventsTable).values({
    grantId: input.grantId,
    ticketId: input.ticketId,
    projectId: input.projectId,
    actorUserId: input.actorUserId,
    actorDisplayName: identity?.displayName ?? null,
    event: input.event,
    detail: input.detail ?? {},
  });
}

export type ApprovedSupportMutation = {
  mode: "mutation";
  sessionId: number;
  grantId: number;
  ticketId: number;
  projectId: number;
  ownerUserId: string;
  staffUserId: string;
  instruction: string;
  evidenceBundle: Record<string, unknown>;
};

export type SupportProposalRun = Omit<ApprovedSupportMutation, "mode"> & {
  mode: "proposal";
};

function supportInstruction(value: unknown, key: "instruction" | "diagnosisInstruction"): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate.trim() : "";
}

async function readBoundSupportSession(input: {
  sessionId: number;
  projectId: number;
  actorUserId: string;
  status: "diagnosing" | "approved";
  instructionKey: "diagnosisInstruction" | "instruction";
}): Promise<
  (Omit<ApprovedSupportMutation, "mode" | "instruction"> & { instruction: string }) | null
> {
  const [session] = await db
    .select()
    .from(supportZeroSessionsTable)
    .where(
      and(
        eq(supportZeroSessionsTable.id, input.sessionId),
        eq(supportZeroSessionsTable.projectId, input.projectId),
        eq(supportZeroSessionsTable.status, input.status),
      ),
    )
    .limit(1);
  if (!session || session.staffUserId !== input.actorUserId) return null;
  const principal = await resolveStaffPrincipal(input.actorUserId);
  if (!principal || !["owner", "operator", "support"].includes(principal.role)) return null;
  const grant = await findLiveSupportGrant({
    projectId: input.projectId,
    staffUserId: session.staffUserId,
  });
  if (!grant || grant.id !== session.grantId) return null;
  const instruction = supportInstruction(session.proposal, input.instructionKey);
  if (!instruction || instruction.length > 60_000) return null;
  return {
    sessionId: session.id,
    grantId: grant.id,
    ticketId: session.ticketId,
    projectId: session.projectId,
    ownerUserId: grant.ownerUserId,
    staffUserId: session.staffUserId,
    instruction,
    evidenceBundle: session.evidenceBundle,
  };
}

/**
 * Bind an approved support proposal to exactly one owner, project, staff member,
 * and still-live grant. Reads only; callers decide the state transition.
 */
export async function readApprovedSupportMutation(input: {
  sessionId: number;
  projectId: number;
  actorUserId: string;
}): Promise<ApprovedSupportMutation | null> {
  const bound = await readBoundSupportSession({
    ...input,
    status: "approved",
    instructionKey: "instruction",
  });
  return bound ? { ...bound, mode: "mutation" } : null;
}

/** Authorize the named staff member to ask Zero for a read-only proposal. */
export async function readSupportProposalRun(input: {
  sessionId: number;
  projectId: number;
  actorUserId: string;
}): Promise<SupportProposalRun | null> {
  const bound = await readBoundSupportSession({
    ...input,
    status: "diagnosing",
    instructionKey: "diagnosisInstruction",
  });
  return bound ? { ...bound, mode: "proposal" } : null;
}

/** Fail-closed liveness check used by the running Zero job's grant watcher. */
export async function supportMutationStillAuthorized(input: {
  sessionId: number;
  projectId: number;
}): Promise<boolean> {
  const [session] = await db
    .select({
      grantId: supportZeroSessionsTable.grantId,
      staffUserId: supportZeroSessionsTable.staffUserId,
    })
    .from(supportZeroSessionsTable)
    .where(
      and(
        eq(supportZeroSessionsTable.id, input.sessionId),
        eq(supportZeroSessionsTable.projectId, input.projectId),
        inArray(supportZeroSessionsTable.status, ["diagnosing", "approved", "applying"]),
      ),
    )
    .limit(1);
  if (!session) return false;
  const principal = await resolveStaffPrincipal(session.staffUserId);
  if (!principal || !["owner", "operator", "support"].includes(principal.role)) return false;
  const grant = await findLiveSupportGrant({
    projectId: input.projectId,
    staffUserId: session.staffUserId,
  });
  return grant?.id === session.grantId;
}
