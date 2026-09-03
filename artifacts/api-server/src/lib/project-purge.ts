import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  db,
  projectPurgeOperationsTable,
  projectRetirementOperationsTable,
  projectsTable,
  type ProjectPurgeOperation,
} from "@workspace/db";
import {
  PROJECT_PURGE_SEMANTICS,
  parseProjectPurgeReceipt,
  presentProjectPurge,
  type ProjectPurgeFailureCode,
  type ProjectPurgeParseResult,
  type ProjectPurgeStage,
} from "@workspace/ora-contracts";
import {
  durableEnqueueRawResult,
  isDurableWorkerReady,
  QUEUE_PROJECT_PURGE,
} from "./durable-queue";
import {
  hasCurrentProjectRetirementCompletionEvidence,
  hasProjectRestoreReplayReceipt,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
} from "./project-retirement-contract";
import {
  applyProjectRelationalPurge,
  inventoryProjectPurgeResources,
  releaseProjectAssetStorage,
  releaseProjectSnapshotStorage,
  type ProjectPurgeAssetReleaseCursor,
  type ProjectPurgeResourceInventory,
  type ProjectPurgeSnapshotReleaseCursor,
} from "./project-purge-resources";
import { releaseProductionDatabasesForHardDelete } from "./production-database-lifecycle";
import { tenantRuntimeProvider } from "./tenant-runtime";
import { releaseNeonProjectsForHardDelete } from "./neon-project-lifecycle";
import {
  databaseProjectPurgeNotificationStore,
  deliverProjectPurgeMilestone,
  presentProjectPurgeMilestone,
} from "./project-purge-notifications";

/** @dormantExport This constant is used by governing retention scheduling and is exported for API clients after stable integration. */
export const PROJECT_PURGE_RECOVERY_DAYS = 30;
export const PROJECT_PURGE_REVERIFICATION_MAX_AGE_MINUTES = 10;
export const PROJECT_PURGE_MAX_ATTEMPTS = 5;
/** @dormantExport Kept for external reference until lease policy is inlined into a shared coordinator contract. */
export const PROJECT_PURGE_LEASE_MINUTES = 10;
export const PROJECT_PURGE_MAX_RESOURCE_BATCHES_PER_INVOCATION = 8;
export const PROJECT_PURGE_LEASE_HEARTBEAT_INTERVAL_MS = 60_000;
export const PROJECT_PURGE_LEASE_HEARTBEAT_TIMEOUT_MS = 15_000;
export const PROJECT_PURGE_PROVIDER_OPERATION_TIMEOUT_MS = 30_000;
const PROJECT_PURGE_IDEMPOTENCY_KEY_MIN = 16;
const PROJECT_PURGE_IDEMPOTENCY_KEY_MAX = 200;

type ProjectPurgeTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ProjectPurgeAdmissionCode =
  | "project_purge_not_found"
  | "project_purge_name_mismatch"
  | "project_purge_reverification_required"
  | "project_purge_retirement_incomplete"
  | "project_purge_operation_conflict"
  | "project_purge_retry_key_reused"
  | "project_purge_retry_unavailable"
  | "project_purge_attempts_exhausted"
  | "project_purge_worker_unavailable"
  | "project_purge_idempotency_key_invalid";

export type ProjectPurgeAdmission =
  | { accepted: true; operation: ProjectPurgeOperation }
  | { accepted: false; code: ProjectPurgeAdmissionCode };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashProjectPurgeRequester(userId: string): string {
  return sha256(`project-purge-requester-v1\u0000${userId}`);
}

export function hashProjectPurgeIdempotency(input: {
  userId: string;
  projectId: number;
  key: string;
}): string {
  return sha256(
    `project-purge-idempotency-v1\u0000${input.userId}\u0000${input.projectId}\u0000${input.key}`,
  );
}

export function validProjectPurgeIdempotencyKey(value: string): boolean {
  return (
    value.length >= PROJECT_PURGE_IDEMPOTENCY_KEY_MIN &&
    value.length <= PROJECT_PURGE_IDEMPOTENCY_KEY_MAX &&
    /^[A-Za-z0-9._~-]+$/u.test(value)
  );
}

function scheduledIdempotencyHash(projectId: number, retirementOperationId: string): string {
  return sha256(`project-purge-expiry-v1\u0000${projectId}\u0000${retirementOperationId}`);
}

export async function scheduleProjectPurgeAfterRetirement(
  tx: ProjectPurgeTransaction,
  input: { projectId: number; retirementOperationId: string },
): Promise<void> {
  const [owner] = await tx
    .select({ ownerId: projectsTable.ownerId })
    .from(projectsTable)
    .where(eq(projectsTable.id, input.projectId))
    .limit(1);
  if (!owner) throw new Error("project_purge_owner_missing");
  await tx
    .insert(projectPurgeOperationsTable)
    .values({
      id: randomUUID(),
      projectId: input.projectId,
      retirementOperationIdHash: sha256(input.retirementOperationId),
      trigger: "expiry",
      state: "scheduled",
      stage: "verify",
      idempotencyKeyHash: scheduledIdempotencyHash(input.projectId, input.retirementOperationId),
      requestedByHash: hashProjectPurgeRequester(owner.ownerId),
      dueAt: sql`now() + interval '30 days'`,
    })
    .onConflictDoNothing();
}

export type ProjectPurgeRestoreDecision =
  | { allowed: true }
  | { allowed: false; code: "project_purge_in_progress" };

/** Must run under the caller's project lifecycle advisory lock. */
export async function cancelScheduledProjectPurgeForRestore(
  tx: ProjectPurgeTransaction,
  projectId: number,
): Promise<ProjectPurgeRestoreDecision> {
  const [operation] = await tx
    .select()
    .from(projectPurgeOperationsTable)
    .where(eq(projectPurgeOperationsTable.projectId, projectId))
    .orderBy(desc(projectPurgeOperationsTable.createdAt))
    .limit(1);
  if (!operation || operation.state === "canceled") return { allowed: true };
  if (operation.state !== "scheduled") {
    return { allowed: false, code: "project_purge_in_progress" };
  }
  const canceled = await tx
    .update(projectPurgeOperationsTable)
    .set({
      state: "canceled",
      stage: "verify",
      failureCode: null,
      failureRetryable: null,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "canceled",
        reason: "project_restored",
      },
      terminalAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operation.id),
        eq(projectPurgeOperationsTable.state, "scheduled"),
      ),
    )
    .returning({ id: projectPurgeOperationsTable.id });
  return canceled.length === 1
    ? { allowed: true }
    : { allowed: false, code: "project_purge_in_progress" };
}

function validCompletedRetirement(
  operation: {
    state: string;
    completedAt: Date | null;
    progress: unknown;
  } | null,
): boolean {
  return (
    operation?.state === "completed" &&
    operation.completedAt !== null &&
    hasCurrentProjectRetirementCompletionEvidence(operation.progress) &&
    !hasProjectRestoreReplayReceipt({
      state: operation.state,
      progress: operation.progress,
    })
  );
}

type ProjectPurgeReadmissionAudit = {
  schema: "project-purge-readmission-audit-v1";
  cycleCount: number;
  chainDigestSha256: string;
  latest: {
    attemptCount: number;
    stage: string;
    failureCode: string | null;
    terminalAt: string | null;
    terminalEvidenceDigestSha256: string;
  };
};

export function canOwnerReadmitProjectPurge(
  operation:
    | {
        state: string;
        attemptCount: number;
        failureCode: string | null | undefined;
        failureRetryable: boolean | null | undefined;
      }
    | null
    | undefined,
): boolean {
  if (operation?.state !== "failed") return false;
  if (operation.failureRetryable === true) return true;
  // Legacy exhausted rows deliberately disabled automatic retry and discarded the
  // underlying failure classification. A fresh owner-verified cycle is still safe:
  // it resets the bounded attempt counter and repeats every absence proof.
  return (
    operation.failureCode === "project_purge_attempts_exhausted" &&
    operation.attemptCount >= PROJECT_PURGE_MAX_ATTEMPTS
  );
}

function parseProjectPurgeReadmissionAudit(
  resourceProgress: unknown,
): { ok: true; value?: ProjectPurgeReadmissionAudit } | { ok: false } {
  if (
    !resourceProgress ||
    typeof resourceProgress !== "object" ||
    Array.isArray(resourceProgress)
  ) {
    return { ok: true };
  }
  const value = (resourceProgress as Record<string, unknown>).readmissionAudit;
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  const candidate = value as Partial<ProjectPurgeReadmissionAudit>;
  const latest = candidate.latest;
  const digest = /^[0-9a-f]{64}$/u;
  if (
    candidate.schema !== "project-purge-readmission-audit-v1" ||
    !Number.isSafeInteger(candidate.cycleCount) ||
    Number(candidate.cycleCount) < 1 ||
    typeof candidate.chainDigestSha256 !== "string" ||
    !digest.test(candidate.chainDigestSha256) ||
    !latest ||
    !Number.isSafeInteger(latest.attemptCount) ||
    latest.attemptCount < 0 ||
    typeof latest.stage !== "string" ||
    latest.stage.length < 1 ||
    latest.stage.length > 100 ||
    (latest.failureCode !== null &&
      (typeof latest.failureCode !== "string" || latest.failureCode.length > 120)) ||
    (latest.terminalAt !== null &&
      (typeof latest.terminalAt !== "string" ||
        !Number.isFinite(new Date(latest.terminalAt).getTime()))) ||
    typeof latest.terminalEvidenceDigestSha256 !== "string" ||
    !digest.test(latest.terminalEvidenceDigestSha256)
  ) {
    return { ok: false };
  }
  return { ok: true, value: candidate as ProjectPurgeReadmissionAudit };
}

function nextProjectPurgeReadmissionAudit(operation: {
  attemptCount: number;
  stage: string;
  failureCode: string | null;
  terminalAt: Date | null;
  terminalEvidence: unknown;
  resourceProgress: unknown;
}): ProjectPurgeReadmissionAudit | null {
  const previous = parseProjectPurgeReadmissionAudit(operation.resourceProgress);
  if (!previous.ok) return null;
  const latest = {
    attemptCount: operation.attemptCount,
    stage: operation.stage,
    failureCode: operation.failureCode,
    terminalAt: operation.terminalAt?.toISOString() ?? null,
    terminalEvidenceDigestSha256: sha256(JSON.stringify(operation.terminalEvidence ?? null)),
  };
  const previousChain =
    previous.value?.chainDigestSha256 ?? sha256("project-purge-readmission-audit-root-v1");
  return {
    schema: "project-purge-readmission-audit-v1",
    cycleCount: (previous.value?.cycleCount ?? 0) + 1,
    chainDigestSha256: sha256(
      `project-purge-readmission-audit-v1\u0000${previousChain}\u0000${JSON.stringify(latest)}`,
    ),
    latest,
  };
}

export async function acceptManualProjectPurge(input: {
  projectId: number;
  userId: string;
  projectName: string;
  idempotencyKey: string;
  recentlyReverified: boolean;
}): Promise<ProjectPurgeAdmission> {
  if (!input.recentlyReverified) {
    return { accepted: false, code: "project_purge_reverification_required" };
  }
  if (!validProjectPurgeIdempotencyKey(input.idempotencyKey)) {
    return { accepted: false, code: "project_purge_idempotency_key_invalid" };
  }
  const workerReady = isDurableWorkerReady(QUEUE_PROJECT_PURGE);
  const idempotencyKeyHash = hashProjectPurgeIdempotency({
    userId: input.userId,
    projectId: input.projectId,
    key: input.idempotencyKey,
  });
  const requestedByHash = hashProjectPurgeRequester(input.userId);

  const decision = await db.transaction(async (tx): Promise<ProjectPurgeAdmission> => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})`,
    );
    const [idempotent] = await tx
      .select()
      .from(projectPurgeOperationsTable)
      .where(eq(projectPurgeOperationsTable.idempotencyKeyHash, idempotencyKeyHash))
      .limit(1);
    if (idempotent) {
      if (
        idempotent.projectId !== input.projectId ||
        idempotent.requestedByHash !== requestedByHash
      ) {
        return { accepted: false, code: "project_purge_operation_conflict" };
      }
      // A response-loss replay observes the same non-failed operation and
      // never creates a second destructive identity. A failed operation must
      // be re-admitted with a fresh owner-confirmed key so one captured request
      // cannot silently authorize a later destructive retry.
      if (idempotent.state === "failed") {
        return { accepted: false, code: "project_purge_retry_key_reused" };
      }
      return { accepted: true, operation: idempotent };
    }
    if (!workerReady) {
      return { accepted: false, code: "project_purge_worker_unavailable" };
    }

    const [project] = await tx
      .select({ id: projectsTable.id, ownerId: projectsTable.ownerId, name: projectsTable.name })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, input.projectId),
          eq(projectsTable.ownerId, input.userId),
          isNotNull(projectsTable.deletedAt),
        ),
      )
      .limit(1);
    if (!project) return { accepted: false, code: "project_purge_not_found" };
    if (project.name !== input.projectName) {
      return { accepted: false, code: "project_purge_name_mismatch" };
    }
    const [retirement] = await tx
      .select({
        id: projectRetirementOperationsTable.id,
        state: projectRetirementOperationsTable.state,
        completedAt: projectRetirementOperationsTable.completedAt,
        progress: projectRetirementOperationsTable.progress,
      })
      .from(projectRetirementOperationsTable)
      .where(eq(projectRetirementOperationsTable.projectId, input.projectId))
      .orderBy(desc(projectRetirementOperationsTable.createdAt))
      .limit(1);
    if (!validCompletedRetirement(retirement ?? null)) {
      return { accepted: false, code: "project_purge_retirement_incomplete" };
    }
    const [existing] = await tx
      .select()
      .from(projectPurgeOperationsTable)
      .where(eq(projectPurgeOperationsTable.projectId, input.projectId))
      .orderBy(desc(projectPurgeOperationsTable.createdAt))
      .limit(1);
    if (existing?.state === "failed") {
      if (!canOwnerReadmitProjectPurge(existing)) {
        return { accepted: false, code: "project_purge_retry_unavailable" };
      }
      const exhausted = existing.attemptCount >= PROJECT_PURGE_MAX_ATTEMPTS;
      const readmissionAudit = exhausted ? nextProjectPurgeReadmissionAudit(existing) : null;
      if (exhausted && !readmissionAudit) {
        return { accepted: false, code: "project_purge_operation_conflict" };
      }
      const [operation] = await tx
        .update(projectPurgeOperationsTable)
        .set({
          trigger: "manual",
          state: "accepted",
          stage: "verify",
          idempotencyKeyHash,
          requestedByHash,
          leaseExpiresAt: null,
          dueAt: sql`now()`,
          nextAttemptAt: null,
          failureCode: null,
          failureRetryable: null,
          terminalEvidence: null,
          terminalAt: null,
          ...(exhausted
            ? {
                attemptCount: 0,
                leaseVersion: sql`${projectPurgeOperationsTable.leaseVersion} + 1`,
                resourceProgress: { readmissionAudit },
                startedAt: null,
              }
            : {}),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectPurgeOperationsTable.id, existing.id),
            eq(projectPurgeOperationsTable.state, "failed"),
            or(
              eq(projectPurgeOperationsTable.failureRetryable, true),
              eq(projectPurgeOperationsTable.failureCode, "project_purge_attempts_exhausted"),
            ),
            exhausted
              ? eq(projectPurgeOperationsTable.attemptCount, existing.attemptCount)
              : lt(projectPurgeOperationsTable.attemptCount, PROJECT_PURGE_MAX_ATTEMPTS),
          ),
        )
        .returning();
      return operation
        ? { accepted: true, operation }
        : { accepted: false, code: "project_purge_operation_conflict" };
    }
    if (existing && existing.state !== "scheduled" && existing.state !== "canceled") {
      return { accepted: false, code: "project_purge_operation_conflict" };
    }
    if (existing?.state === "scheduled") {
      const [operation] = await tx
        .update(projectPurgeOperationsTable)
        .set({
          trigger: "manual",
          state: "accepted",
          retirementOperationIdHash: sha256(retirement!.id),
          idempotencyKeyHash,
          requestedByHash,
          dueAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectPurgeOperationsTable.id, existing.id),
            eq(projectPurgeOperationsTable.state, "scheduled"),
          ),
        )
        .returning();
      return operation
        ? { accepted: true, operation }
        : { accepted: false, code: "project_purge_operation_conflict" };
    }
    const [operation] = await tx
      .insert(projectPurgeOperationsTable)
      .values({
        id: randomUUID(),
        projectId: input.projectId,
        retirementOperationIdHash: sha256(retirement!.id),
        trigger: "manual",
        state: "accepted",
        stage: "verify",
        idempotencyKeyHash,
        requestedByHash,
        dueAt: sql`now()`,
      })
      .returning();
    return { accepted: true, operation: operation! };
  });

  if (decision.accepted && decision.operation.state === "accepted") {
    await enqueueProjectPurgeOperation(decision.operation.id);
  }
  return decision;
}

/**
 * @dormantExport Read operations may be used by future admin tooling and are retained for compatibility.
 */
export async function readProjectPurgeOperation(
  operationId: string,
): Promise<ProjectPurgeOperation | null> {
  const [operation] = await db
    .select()
    .from(projectPurgeOperationsTable)
    .where(eq(projectPurgeOperationsTable.id, operationId))
    .limit(1);
  return operation ?? null;
}

/**
 * @dormantExport Exposed for callers that need the latest purge operation without creating side-effects.
 */
export async function readLatestProjectPurgeOperation(
  projectId: number,
): Promise<ProjectPurgeOperation | null> {
  const [operation] = await db
    .select()
    .from(projectPurgeOperationsTable)
    .where(eq(projectPurgeOperationsTable.projectId, projectId))
    .orderBy(desc(projectPurgeOperationsTable.createdAt))
    .limit(1);
  return operation ?? null;
}

export function parseStoredProjectPurgeOperation(
  operation: ProjectPurgeOperation,
): ProjectPurgeParseResult {
  return parseProjectPurgeReceipt(
    {
      schema: PROJECT_PURGE_SEMANTICS,
      operationId: operation.id,
      projectId: operation.projectId,
      retirementOperationIdHash: operation.retirementOperationIdHash,
      trigger: operation.trigger,
      state: operation.state,
      stage: operation.stage,
      attemptCount: operation.attemptCount,
      dueAt: operation.dueAt.toISOString(),
      failureCode: operation.failureCode,
      failureRetryable: operation.failureRetryable,
      terminalEvidence: operation.terminalEvidence,
    },
    { operationId: operation.id, projectId: operation.projectId },
  );
}

/**
 * @dormantExport Preserves a presentable receipt shape for audit tooling and future API consumers.
 */
export function presentStoredProjectPurgeOperation(operation: ProjectPurgeOperation) {
  return presentProjectPurge(parseStoredProjectPurgeOperation(operation));
}

export async function enqueueProjectPurgeOperation(operationId: string): Promise<boolean> {
  if (!isDurableWorkerReady(QUEUE_PROJECT_PURGE)) return false;
  const outcome = await durableEnqueueRawResult(QUEUE_PROJECT_PURGE, { operationId }, operationId, {
    retryLimit: PROJECT_PURGE_MAX_ATTEMPTS - 1,
    retryDelay: 30,
    retryBackoff: true,
    dedupeMode: "active",
  });
  return outcome.status === "enqueued" || outcome.status === "duplicate";
}

export class ProjectPurgeStepError extends Error {
  constructor(
    readonly stage: ProjectPurgeStage,
    readonly code: ProjectPurgeFailureCode,
    readonly retryable: boolean,
    readonly causeCode: string | null = null,
  ) {
    super(code);
    this.name = "ProjectPurgeStepError";
  }
}

type ProjectPurgeLeaseHeartbeat = {
  readonly signal: AbortSignal;
  readonly lost: boolean;
  assertActive(stage: ProjectPurgeStage): void;
  stop(): void;
};

/**
 * Keep a claimed destructive operation fenced while provider calls are in
 * flight. A renewal that times out, errors, or no longer matches the exact
 * running lease aborts every cancellable provider request immediately.
 */
export function startProjectPurgeLeaseHeartbeat(
  operation: Pick<ProjectPurgeOperation, "id" | "leaseVersion">,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): ProjectPurgeLeaseHeartbeat {
  const intervalMs = options.intervalMs ?? PROJECT_PURGE_LEASE_HEARTBEAT_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PROJECT_PURGE_LEASE_HEARTBEAT_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 1 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new Error("project_purge_heartbeat_configuration_invalid");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let lost = false;

  const loseLease = (): void => {
    if (lost || stopped) return;
    lost = true;
    if (!controller.signal.aborted) {
      controller.abort(new Error("project_purge_lease_lost"));
    }
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const schedule = (): void => {
    if (stopped || lost) return;
    timer = setTimeout(() => {
      timer = null;
      const renewal = db
        .update(projectPurgeOperationsTable)
        .set({
          leaseExpiresAt: sql`now() + interval '10 minutes'`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectPurgeOperationsTable.id, operation.id),
            eq(projectPurgeOperationsTable.state, "running"),
            eq(projectPurgeOperationsTable.leaseVersion, operation.leaseVersion),
          ),
        )
        .returning({ id: projectPurgeOperationsTable.id });
      let renewalTimeout: ReturnType<typeof setTimeout> | null = null;
      const timed = new Promise<never>((_resolve, reject) => {
        renewalTimeout = setTimeout(
          () => reject(new Error("project_purge_heartbeat_timeout")),
          timeoutMs,
        );
        renewalTimeout.unref?.();
      });
      void Promise.race([renewal, timed])
        .then((changed) => {
          if (!Array.isArray(changed) || changed.length !== 1) loseLease();
        })
        .catch(() => loseLease())
        .finally(() => {
          if (renewalTimeout) clearTimeout(renewalTimeout);
          if (!stopped && !lost) schedule();
        });
    }, intervalMs);
    timer.unref?.();
  };

  schedule();
  return {
    signal: controller.signal,
    get lost() {
      return lost;
    },
    assertActive(stage: ProjectPurgeStage): void {
      if (lost) {
        throw new ProjectPurgeStepError(stage, "project_purge_operation_conflict", true);
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (!controller.signal.aborted) {
        controller.abort(new Error("project_purge_heartbeat_stopped"));
      }
    },
  };
}

const PROJECT_PURGE_FAILURE_CAUSE_CODE_PATTERN = /^[a-z0-9_]{1,96}$/u;

export function projectPurgeFailureCauseCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  for (const property of ["code", "message"] as const) {
    const candidate = Reflect.get(error, property);
    if (typeof candidate === "string" && PROJECT_PURGE_FAILURE_CAUSE_CODE_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function stepFailure(
  stage: ProjectPurgeStage,
  code: ProjectPurgeFailureCode,
  error: unknown,
): ProjectPurgeStepError {
  if (error instanceof ProjectPurgeStepError) return error;
  return new ProjectPurgeStepError(stage, code, true, projectPurgeFailureCauseCode(error));
}

async function setOperationStage(
  operationId: string,
  leaseVersion: number,
  stage: ProjectPurgeStage,
): Promise<void> {
  const changed = await db
    .update(projectPurgeOperationsTable)
    .set({
      stage,
      leaseExpiresAt: sql`now() + interval '10 minutes'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operationId),
        eq(projectPurgeOperationsTable.state, "running"),
        eq(projectPurgeOperationsTable.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: projectPurgeOperationsTable.id });
  if (changed.length !== 1) {
    throw new ProjectPurgeStepError(stage, "project_purge_operation_conflict", true);
  }
}

type DurableProjectPurgeResourceProgress = {
  schema: "project-purge-resource-progress-v1";
  inventoryDigestSha256: string;
  assetCursor: ProjectPurgeAssetReleaseCursor;
  snapshotCursor: ProjectPurgeSnapshotReleaseCursor;
  providerRemoved: number;
  providerDetached: number;
  databaseComplete: boolean;
  readmissionAudit?: ProjectPurgeReadmissionAudit;
};

export function parseDurableProjectPurgeResourceProgress(
  value: unknown,
  inventoryDigestSha256: string,
): DurableProjectPurgeResourceProgress {
  const readmissionAudit = parseProjectPurgeReadmissionAudit(value);
  if (!readmissionAudit.ok) {
    throw new Error("project_purge_resource_progress_invalid");
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => key === "readmissionAudit")
  ) {
    return {
      schema: "project-purge-resource-progress-v1",
      inventoryDigestSha256,
      assetCursor: { assetIndex: 0, legacyImageIndex: 0, uploadIndex: 0 },
      snapshotCursor: { snapshotIndex: 0 },
      providerRemoved: 0,
      providerDetached: 0,
      databaseComplete: false,
      ...(readmissionAudit.value ? { readmissionAudit: readmissionAudit.value } : {}),
    };
  }
  if (!value || typeof value !== "object") {
    throw new Error("project_purge_resource_progress_invalid");
  }
  const candidate = value as Partial<DurableProjectPurgeResourceProgress>;
  const asset = candidate.assetCursor;
  const snapshot = candidate.snapshotCursor;
  const validNonnegative = (entry: unknown): entry is number =>
    typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
  if (
    candidate.schema !== "project-purge-resource-progress-v1" ||
    candidate.inventoryDigestSha256 !== inventoryDigestSha256 ||
    !asset ||
    !snapshot ||
    !validNonnegative(asset.assetIndex) ||
    !validNonnegative(asset.legacyImageIndex) ||
    !validNonnegative(asset.uploadIndex) ||
    !validNonnegative(snapshot.snapshotIndex) ||
    !validNonnegative(candidate.providerRemoved) ||
    !validNonnegative(candidate.providerDetached) ||
    typeof candidate.databaseComplete !== "boolean"
  ) {
    throw new Error("project_purge_resource_progress_invalid");
  }
  return candidate as DurableProjectPurgeResourceProgress;
}

async function checkpointProjectPurgeResources(
  operation: ProjectPurgeOperation,
  stage: ProjectPurgeStage,
  progress: DurableProjectPurgeResourceProgress,
): Promise<void> {
  const changed = await db
    .update(projectPurgeOperationsTable)
    .set({
      stage,
      resourceProgress: progress,
      leaseExpiresAt: sql`now() + interval '10 minutes'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operation.id),
        eq(projectPurgeOperationsTable.state, "running"),
        eq(projectPurgeOperationsTable.leaseVersion, operation.leaseVersion),
      ),
    )
    .returning({ id: projectPurgeOperationsTable.id });
  if (changed.length !== 1) {
    throw new ProjectPurgeStepError(stage, "project_purge_operation_conflict", true);
  }
}

async function yieldProjectPurgeResourceContinuation(
  operation: ProjectPurgeOperation,
  stage: ProjectPurgeStage,
  progress: DurableProjectPurgeResourceProgress,
): Promise<void> {
  const changed = await db
    .update(projectPurgeOperationsTable)
    .set({
      state: "accepted",
      stage,
      resourceProgress: progress,
      attemptCount: sql`GREATEST(0, ${projectPurgeOperationsTable.attemptCount} - 1)`,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operation.id),
        eq(projectPurgeOperationsTable.state, "running"),
        eq(projectPurgeOperationsTable.leaseVersion, operation.leaseVersion),
      ),
    )
    .returning({ id: projectPurgeOperationsTable.id });
  if (changed.length !== 1) {
    throw new ProjectPurgeStepError(stage, "project_purge_operation_conflict", true);
  }
}

async function bindProjectPurgeToNewestRetirement(
  operation: ProjectPurgeOperation,
  retirementOperationId: string,
): Promise<void> {
  const currentHash = sha256(retirementOperationId);
  if (currentHash === operation.retirementOperationIdHash) return;
  const changed = await db
    .update(projectPurgeOperationsTable)
    .set({ retirementOperationIdHash: currentHash, updatedAt: sql`now()` })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operation.id),
        eq(projectPurgeOperationsTable.state, "running"),
        eq(projectPurgeOperationsTable.leaseVersion, operation.leaseVersion),
      ),
    )
    .returning({ id: projectPurgeOperationsTable.id });
  if (changed.length !== 1) {
    throw new ProjectPurgeStepError("verify", "project_purge_operation_conflict", true);
  }
}

async function markProjectPurgeFailed(
  operation: ProjectPurgeOperation,
  failure: ProjectPurgeStepError,
): Promise<void> {
  const exhausted = operation.attemptCount >= PROJECT_PURGE_MAX_ATTEMPTS;
  const failureCode = exhausted ? "project_purge_attempts_exhausted" : failure.code;
  const retryable = !exhausted && failure.retryable;
  await db
    .update(projectPurgeOperationsTable)
    .set({
      state: "failed",
      stage: failure.stage,
      failureCode,
      failureRetryable: retryable,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "failed",
        stage: failure.stage,
        failureCode,
        retryable,
      },
      nextAttemptAt: retryable
        ? sql`now() + make_interval(secs => LEAST(3600, 30 * power(2, ${operation.attemptCount})))`
        : null,
      leaseExpiresAt: null,
      terminalAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectPurgeOperationsTable.id, operation.id),
        eq(projectPurgeOperationsTable.state, "running"),
        eq(projectPurgeOperationsTable.leaseVersion, operation.leaseVersion),
      ),
    );
}

async function claimProjectPurgeOperation(
  operationId: string,
): Promise<ProjectPurgeOperation | null> {
  const [candidate] = await db
    .select({ projectId: projectPurgeOperationsTable.projectId })
    .from(projectPurgeOperationsTable)
    .where(eq(projectPurgeOperationsTable.id, operationId))
    .limit(1);
  if (!candidate) return null;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${candidate.projectId})`,
    );
    const [owner] = await tx
      .select({ ownerId: projectsTable.ownerId })
      .from(projectsTable)
      .where(eq(projectsTable.id, candidate.projectId))
      .limit(1);
    if (!owner) return null;
    const ownerHash = hashProjectPurgeRequester(owner.ownerId);
    const [claimed] = await tx
      .update(projectPurgeOperationsTable)
      .set({
        state: "running",
        stage: "verify",
        attemptCount: sql`${projectPurgeOperationsTable.attemptCount} + 1`,
        leaseVersion: sql`${projectPurgeOperationsTable.leaseVersion} + 1`,
        leaseExpiresAt: sql`now() + interval '10 minutes'`,
        nextAttemptAt: null,
        failureCode: null,
        failureRetryable: null,
        terminalEvidence: null,
        terminalAt: null,
        requestedByHash: sql`COALESCE(${projectPurgeOperationsTable.requestedByHash}, ${ownerHash})`,
        startedAt: sql`COALESCE(${projectPurgeOperationsTable.startedAt}, now())`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projectPurgeOperationsTable.id, operationId),
          lt(projectPurgeOperationsTable.attemptCount, PROJECT_PURGE_MAX_ATTEMPTS),
          or(
            eq(projectPurgeOperationsTable.state, "accepted"),
            and(
              eq(projectPurgeOperationsTable.state, "failed"),
              eq(projectPurgeOperationsTable.failureRetryable, true),
              or(
                isNull(projectPurgeOperationsTable.nextAttemptAt),
                lt(projectPurgeOperationsTable.nextAttemptAt, sql`now()`),
              ),
            ),
            and(
              eq(projectPurgeOperationsTable.state, "running"),
              or(
                isNull(projectPurgeOperationsTable.leaseExpiresAt),
                lt(projectPurgeOperationsTable.leaseExpiresAt, sql`now()`),
              ),
            ),
          ),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

/**
 * Preserve the recipient path before project-owned rows are removed. Email is
 * retried independently by the notification worker; this step only requires
 * the idempotent, in-product receipt to exist before destructive work starts.
 */
export async function ensureInitialProjectPurgeNotification(
  operation: ProjectPurgeOperation,
  inventory: ProjectPurgeResourceInventory,
): Promise<void> {
  const milestone = {
    operationId: operation.id,
    recipientUserId: inventory.ownerId,
    milestone: "trash" as const,
    projectId: inventory.projectId,
    projectName: inventory.projectName,
    dueAt: operation.dueAt.toISOString(),
  };
  try {
    await deliverProjectPurgeMilestone(milestone, {
      store: databaseProjectPurgeNotificationStore,
    });
  } catch {
    // Delivery resolves the durable row before contacting Clerk/email. Re-read
    // through the idempotent store after any channel failure; only a durable
    // receipt permits destructive work to continue.
    const presentation = presentProjectPurgeMilestone(milestone);
    await databaseProjectPurgeNotificationStore.createOrGet({
      recipientUserId: inventory.ownerId,
      type: presentation.type,
      title: presentation.title,
      body: presentation.body,
      resourceId: `${operation.id}:trash`,
      projectId: inventory.projectId,
      metadata: presentation.metadata,
    });
  }
}

export async function runProjectPurgeOperation(operationId: string): Promise<void> {
  const operation = await claimProjectPurgeOperation(operationId);
  if (!operation) return;
  const heartbeat = startProjectPurgeLeaseHeartbeat(operation);
  let inventory: ProjectPurgeResourceInventory | null;
  try {
    heartbeat.assertActive("verify");
    await setOperationStage(operation.id, operation.leaseVersion, "inventory");
    try {
      inventory = await inventoryProjectPurgeResources(operation.projectId);
    } catch (error) {
      throw stepFailure("inventory", "project_purge_inventory_unavailable", error);
    }
    if (!inventory) {
      throw new ProjectPurgeStepError("verify", "project_purge_project_active", false);
    }
    heartbeat.assertActive("inventory");
    if (!hasCurrentProjectRetirementCompletionEvidence(inventory.retirementProgress)) {
      throw new ProjectPurgeStepError("verify", "project_purge_retirement_incomplete", false);
    }
    await bindProjectPurgeToNewestRetirement(operation, inventory.retirementOperationId);
    try {
      await ensureInitialProjectPurgeNotification(operation, inventory);
    } catch (error) {
      throw stepFailure("verify", "project_purge_operation_unavailable", error);
    }
    // The notification row is project-scoped and therefore part of the live
    // reference count. Re-inventory after the idempotent notification write so
    // a crash/yield resumes against the same digest that was checkpointed.
    try {
      inventory = await inventoryProjectPurgeResources(operation.projectId);
    } catch (error) {
      throw stepFailure("inventory", "project_purge_inventory_unavailable", error);
    }
    if (!inventory) {
      throw new ProjectPurgeStepError("verify", "project_purge_project_active", false);
    }
    heartbeat.assertActive("inventory");

    let progress: DurableProjectPurgeResourceProgress;
    try {
      progress = parseDurableProjectPurgeResourceProgress(
        operation.resourceProgress,
        inventory.digestSha256,
      );
    } catch (error) {
      throw stepFailure("inventory", "project_purge_inventory_unavailable", error);
    }
    let resourceBatches = 0;

    await setOperationStage(operation.id, operation.leaseVersion, "assets");
    try {
      while (true) {
        heartbeat.assertActive("assets");
        const assets = await releaseProjectAssetStorage(
          inventory,
          progress.assetCursor,
          undefined,
          heartbeat.signal,
        );
        heartbeat.assertActive("assets");
        progress = {
          ...progress,
          assetCursor: assets.cursor,
          providerRemoved: progress.providerRemoved + assets.deletedObjects,
          providerDetached: progress.providerDetached + assets.detachedObjects,
        };
        await checkpointProjectPurgeResources(operation, "assets", progress);
        resourceBatches += 1;
        if (assets.complete) break;
        if (resourceBatches >= PROJECT_PURGE_MAX_RESOURCE_BATCHES_PER_INVOCATION) {
          heartbeat.assertActive("assets");
          await yieldProjectPurgeResourceContinuation(operation, "assets", progress);
          return;
        }
      }
    } catch (error) {
      throw stepFailure("assets", "project_purge_asset_release_failed", error);
    }

    await setOperationStage(operation.id, operation.leaseVersion, "snapshots");
    try {
      while (true) {
        heartbeat.assertActive("snapshots");
        const snapshots = await releaseProjectSnapshotStorage(
          inventory,
          progress.snapshotCursor,
          undefined,
          heartbeat.signal,
        );
        heartbeat.assertActive("snapshots");
        progress = {
          ...progress,
          snapshotCursor: snapshots.cursor,
          providerRemoved: progress.providerRemoved + snapshots.removed,
          providerDetached: progress.providerDetached + snapshots.detached,
        };
        await checkpointProjectPurgeResources(operation, "snapshots", progress);
        resourceBatches += 1;
        if (snapshots.complete) break;
        if (resourceBatches >= PROJECT_PURGE_MAX_RESOURCE_BATCHES_PER_INVOCATION) {
          heartbeat.assertActive("snapshots");
          await yieldProjectPurgeResourceContinuation(operation, "snapshots", progress);
          return;
        }
      }
    } catch (error) {
      throw stepFailure("snapshots", "project_purge_snapshot_release_failed", error);
    }

    await setOperationStage(operation.id, operation.leaseVersion, "database");
    try {
      if (!progress.databaseComplete) {
        heartbeat.assertActive("database");
        try {
          await releaseProductionDatabasesForHardDelete(
            tenantRuntimeProvider,
            [operation.projectId],
            {
              signal: heartbeat.signal,
              operationTimeoutMs: PROJECT_PURGE_PROVIDER_OPERATION_TIMEOUT_MS,
            },
          );
        } catch {
          heartbeat.assertActive("database");
          throw new Error("project_purge_production_database_release_failed");
        }
        heartbeat.assertActive("database");
        let neonRemoved = 0;
        try {
          const neon = await releaseNeonProjectsForHardDelete({
            projectIds: inventory.neonProjectIds,
            productionProjectName: inventory.productionNeonProjectName,
            previewProjectName: inventory.previewNeonProjectName,
            signal: heartbeat.signal,
          });
          neonRemoved = neon.removed;
        } catch {
          heartbeat.assertActive("database");
          throw new Error("project_purge_neon_database_release_failed");
        }
        heartbeat.assertActive("database");
        progress = {
          ...progress,
          providerRemoved: progress.providerRemoved + neonRemoved,
          databaseComplete: true,
        };
        await checkpointProjectPurgeResources(operation, "database", progress);
      }
    } catch (error) {
      throw stepFailure("database", "project_purge_database_release_failed", error);
    }

    await setOperationStage(operation.id, operation.leaseVersion, "addons");
    heartbeat.assertActive("addons");
    if (inventory.activeAddonCount !== 0) {
      throw new ProjectPurgeStepError("addons", "project_purge_addon_release_failed", false);
    }

    await setOperationStage(operation.id, operation.leaseVersion, "runtime");
    heartbeat.assertActive("runtime");
    if (!hasCurrentProjectRetirementCompletionEvidence(inventory.retirementProgress)) {
      throw new ProjectPurgeStepError("runtime", "project_purge_runtime_release_failed", false);
    }

    await setOperationStage(operation.id, operation.leaseVersion, "relational");
    heartbeat.assertActive("relational");
    // The relational transaction takes the lifecycle advisory lock and then a
    // FOR UPDATE lock on this exact lease. Stop the periodic writer before it
    // enters that transaction so the heartbeat cannot deadlock on the row it
    // is designed to protect.
    heartbeat.stop();
    try {
      await applyProjectRelationalPurge(operation.projectId, operation.id, {
        inventoryDigestSha256: inventory.digestSha256,
        providerRemoved: progress.providerRemoved,
        providerDetached: progress.providerDetached,
        leaseVersion: operation.leaseVersion,
      });
    } catch (error) {
      throw stepFailure("relational", "project_purge_relational_delete_failed", error);
    }
  } catch (error) {
    const failure = heartbeat.lost
      ? new ProjectPurgeStepError("verify", "project_purge_operation_conflict", true)
      : error instanceof ProjectPurgeStepError
        ? error
        : new ProjectPurgeStepError("verify", "project_purge_operation_unavailable", true);
    const leaseLost = heartbeat.lost;
    heartbeat.stop();
    if (!leaseLost) {
      await markProjectPurgeFailed(operation, failure);
    }
    throw failure;
  } finally {
    heartbeat.stop();
  }
}

export async function resumeProjectPurgeOperations(): Promise<number> {
  const candidates = await db
    .select({ id: projectPurgeOperationsTable.id })
    .from(projectPurgeOperationsTable)
    .where(
      and(
        lt(projectPurgeOperationsTable.attemptCount, PROJECT_PURGE_MAX_ATTEMPTS),
        or(
          eq(projectPurgeOperationsTable.state, "accepted"),
          and(
            eq(projectPurgeOperationsTable.state, "failed"),
            eq(projectPurgeOperationsTable.failureRetryable, true),
            or(
              isNull(projectPurgeOperationsTable.nextAttemptAt),
              lt(projectPurgeOperationsTable.nextAttemptAt, sql`now()`),
            ),
          ),
          and(
            eq(projectPurgeOperationsTable.state, "running"),
            or(
              isNull(projectPurgeOperationsTable.leaseExpiresAt),
              lt(projectPurgeOperationsTable.leaseExpiresAt, sql`now()`),
            ),
          ),
        ),
      ),
    )
    .orderBy(projectPurgeOperationsTable.createdAt)
    .limit(50);
  for (const operation of candidates) await enqueueProjectPurgeOperation(operation.id);
  return candidates.length;
}
