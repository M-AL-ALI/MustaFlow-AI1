import { createHash, randomUUID } from "node:crypto";

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

import type { ProjectPurgeMilestoneInput } from "./project-purge-notifications";
import {
  hasCurrentProjectRetirementCompletionEvidence,
  hasProjectRestoreReplayReceipt,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
} from "./project-retirement-contract";

export const PROJECT_PURGE_SCHEDULER_BATCH_LIMIT = 50 as const;

export type LegacyPurgeCandidate = {
  projectId: number;
  ownerId: string;
  projectName: string;
  deletedAt: string;
  retirementOperationId: string | null;
};

export type ScheduledPurge = {
  operationId: string;
  projectId: number;
};

export type ProjectPurgeSchedulerStore = {
  /** Reads tombstones and the database clock; it must never derive due dates in application time. */
  listLegacyCandidates(limit: number): Promise<LegacyPurgeCandidate[]>;
  /** Inserts with `due_at = now() + interval '30 days'` in the database. */
  scheduleLegacyCandidate(candidate: LegacyPurgeCandidate): Promise<ScheduledPurge | null>;
  /** Selects only scheduled rows due according to the database clock. */
  listDueScheduled(limit: number): Promise<ScheduledPurge[]>;
  /** Compare-and-set scheduled -> accepted, checking the database clock again. */
  transitionDueToAccepted(operationId: string): Promise<boolean>;
  /** Returns at most one currently relevant, not-yet-notified milestone per operation. */
  listDueNotificationMilestones(limit: number): Promise<ProjectPurgeMilestoneInput[]>;
};

export type ProjectPurgeSchedulerDependencies = {
  store: ProjectPurgeSchedulerStore;
  enqueue(operationId: string): Promise<void>;
  deliverMilestone(input: ProjectPurgeMilestoneInput): Promise<unknown>;
  onEnqueueFailure?(operationId: string, error: unknown): Promise<void> | void;
  onNotificationFailure?(input: ProjectPurgeMilestoneInput, error: unknown): Promise<void> | void;
};

export type ProjectPurgeSchedulerResult = {
  legacyInspected: number;
  legacyScheduled: string[];
  dueInspected: number;
  acceptedAndEnqueued: string[];
  enqueueFailures: string[];
  notificationInspected: number;
  notificationsDelivered: Array<{ operationId: string; milestone: string }>;
  notificationFailures: Array<{ operationId: string; milestone: string }>;
};

function boundedBatchLimit(requested?: number): number {
  if (requested === undefined) return PROJECT_PURGE_SCHEDULER_BATCH_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("project_purge_scheduler_limit_invalid");
  }
  return Math.min(requested, PROJECT_PURGE_SCHEDULER_BATCH_LIMIT);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Gives pre-feature tombstones a fresh grace period. An old `deleted_at` is
 * deliberately not reused as the due date: shipping the scheduler must never
 * immediately destroy a project that previously had no enforceable purge.
 */
export async function scheduleLegacyProjectPurges(
  store: ProjectPurgeSchedulerStore,
  requestedLimit?: number,
): Promise<{ inspected: number; scheduled: string[] }> {
  const limit = boundedBatchLimit(requestedLimit);
  const candidates = await store.listLegacyCandidates(limit);
  if (candidates.length > limit) throw new Error("project_purge_scheduler_store_unbounded");

  const scheduled: string[] = [];
  for (const candidate of candidates) {
    const receipt = await store.scheduleLegacyCandidate(candidate);
    if (receipt) scheduled.push(receipt.operationId);
  }
  return { inspected: candidates.length, scheduled };
}

/**
 * Dispatches due work without combining queue success with deletion success.
 * Once accepted, an enqueue failure remains visible and can be recovered by
 * the coordinator's accepted-operation resume path.
 */
export async function dispatchDueProjectPurges(
  dependencies: Pick<ProjectPurgeSchedulerDependencies, "store" | "enqueue" | "onEnqueueFailure">,
  requestedLimit?: number,
): Promise<{ inspected: number; enqueued: string[]; failures: string[] }> {
  const limit = boundedBatchLimit(requestedLimit);
  const due = await dependencies.store.listDueScheduled(limit);
  if (due.length > limit) throw new Error("project_purge_scheduler_store_unbounded");

  const enqueued: string[] = [];
  const failures: string[] = [];
  for (const operation of due) {
    const accepted = await dependencies.store.transitionDueToAccepted(operation.operationId);
    if (!accepted) continue;
    try {
      await dependencies.enqueue(operation.operationId);
      enqueued.push(operation.operationId);
    } catch (error) {
      failures.push(operation.operationId);
      await dependencies.onEnqueueFailure?.(operation.operationId, error);
    }
  }
  return { inspected: due.length, enqueued, failures };
}

export async function dispatchProjectPurgeMilestones(
  dependencies: Pick<
    ProjectPurgeSchedulerDependencies,
    "store" | "deliverMilestone" | "onNotificationFailure"
  >,
  requestedLimit?: number,
): Promise<{
  inspected: number;
  delivered: Array<{ operationId: string; milestone: string }>;
  failures: Array<{ operationId: string; milestone: string }>;
}> {
  const limit = boundedBatchLimit(requestedLimit);
  const candidates = await dependencies.store.listDueNotificationMilestones(limit);
  if (candidates.length > limit) throw new Error("project_purge_scheduler_store_unbounded");

  const delivered: Array<{ operationId: string; milestone: string }> = [];
  const failures: Array<{ operationId: string; milestone: string }> = [];
  for (const candidate of candidates) {
    const key = { operationId: candidate.operationId, milestone: candidate.milestone };
    try {
      await dependencies.deliverMilestone(candidate);
      delivered.push(key);
    } catch (error) {
      failures.push(key);
      await dependencies.onNotificationFailure?.(candidate, error);
    }
  }
  return { inspected: candidates.length, delivered, failures };
}

export async function runProjectPurgeScheduler(
  dependencies: ProjectPurgeSchedulerDependencies,
  requestedLimit?: number,
): Promise<ProjectPurgeSchedulerResult> {
  const legacy = await scheduleLegacyProjectPurges(dependencies.store, requestedLimit);
  const due = await dispatchDueProjectPurges(dependencies, requestedLimit);
  const notifications = await dispatchProjectPurgeMilestones(dependencies, requestedLimit);
  return {
    legacyInspected: legacy.inspected,
    legacyScheduled: legacy.scheduled,
    dueInspected: due.inspected,
    acceptedAndEnqueued: due.enqueued,
    enqueueFailures: due.failures,
    notificationInspected: notifications.inspected,
    notificationsDelivered: notifications.delivered,
    notificationFailures: notifications.failures,
  };
}

type LegacyCandidateRow = {
  project_id: number;
  owner_id: string;
  project_name: string;
  deleted_at: string;
  retirement_operation_id: string | null;
};

type MilestoneRow = {
  operation_id: string;
  recipient_user_id: string;
  project_id: number | null;
  project_name: string | null;
  due_at: string | null;
  milestone: ProjectPurgeMilestoneInput["milestone"];
};

/** Production adapter. Tests use injected stores and never touch a database. */
export const databaseProjectPurgeSchedulerStore: ProjectPurgeSchedulerStore = {
  async listLegacyCandidates(limit) {
    const { db } = await import("@workspace/db");
    const result = await db.execute<LegacyCandidateRow>(sql`
      SELECT
        p.id AS project_id,
        p.owner_id,
        p.name AS project_name,
        p.deleted_at::text,
        retirement.id AS retirement_operation_id
      FROM projects p
      LEFT JOIN LATERAL (
        SELECT operation.id
        FROM project_retirement_operations operation
        WHERE operation.project_id = p.id
        ORDER BY operation.created_at DESC
        LIMIT 1
      ) retirement ON true
      WHERE p.deleted_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM project_purge_operations purge
          WHERE purge.project_id = p.id
            AND purge.state IN ('scheduled', 'accepted', 'running', 'failed')
        )
      ORDER BY p.id
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      projectId: row.project_id,
      ownerId: row.owner_id,
      projectName: row.project_name,
      deletedAt: row.deleted_at,
      retirementOperationId: row.retirement_operation_id,
    }));
  },

  async scheduleLegacyCandidate(candidate) {
    const { db, projectPurgeOperationsTable } = await import("@workspace/db");
    const operationId = `purge_${randomUUID()}`;
    const retirementIdentity = candidate.retirementOperationId ?? `legacy:${candidate.projectId}`;
    const values = {
      id: operationId,
      projectId: candidate.projectId,
      retirementOperationIdHash: sha256(retirementIdentity),
      trigger: "expiry",
      state: "scheduled",
      stage: "verify",
      idempotencyKeyHash: sha256(`legacy-purge:${candidate.projectId}:${candidate.deletedAt}`),
      requestedByHash: sha256(`project-purge-requester-v1\u0000${candidate.ownerId}`),
      dueAt: sql`now() + interval '30 days'`,
    };
    const inserted = await db
      .insert(projectPurgeOperationsTable)
      .values(values)
      .onConflictDoNothing()
      .returning({
        operationId: projectPurgeOperationsTable.id,
        projectId: projectPurgeOperationsTable.projectId,
      });
    return inserted[0] ?? null;
  },

  async listDueScheduled(limit) {
    const { db, projectPurgeOperationsTable } = await import("@workspace/db");
    return db
      .select({
        operationId: projectPurgeOperationsTable.id,
        projectId: projectPurgeOperationsTable.projectId,
      })
      .from(projectPurgeOperationsTable)
      .where(
        and(
          eq(projectPurgeOperationsTable.state, "scheduled"),
          lte(projectPurgeOperationsTable.dueAt, sql`now()`),
          or(
            isNull(projectPurgeOperationsTable.nextAttemptAt),
            lte(projectPurgeOperationsTable.nextAttemptAt, sql`now()`),
          ),
        ),
      )
      .orderBy(projectPurgeOperationsTable.dueAt, projectPurgeOperationsTable.id)
      .limit(limit);
  },

  async transitionDueToAccepted(operationId) {
    const { db, projectPurgeOperationsTable, projectRetirementOperationsTable, projectsTable } =
      await import("@workspace/db");
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ projectId: projectPurgeOperationsTable.projectId })
        .from(projectPurgeOperationsTable)
        .where(eq(projectPurgeOperationsTable.id, operationId))
        .limit(1);
      if (!candidate) return false;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${candidate.projectId})`,
      );
      const [retirement] = await tx
        .select({
          id: projectRetirementOperationsTable.id,
          state: projectRetirementOperationsTable.state,
          completedAt: projectRetirementOperationsTable.completedAt,
          progress: projectRetirementOperationsTable.progress,
        })
        .from(projectRetirementOperationsTable)
        .where(eq(projectRetirementOperationsTable.projectId, candidate.projectId))
        .orderBy(sql`${projectRetirementOperationsTable.createdAt} DESC`)
        .limit(1);
      const [owner] = await tx
        .select({ ownerId: projectsTable.ownerId })
        .from(projectsTable)
        .where(eq(projectsTable.id, candidate.projectId))
        .limit(1);
      if (
        !owner ||
        retirement?.state !== "completed" ||
        retirement.completedAt === null ||
        !hasCurrentProjectRetirementCompletionEvidence(retirement.progress) ||
        hasProjectRestoreReplayReceipt({
          state: retirement.state,
          progress: retirement.progress,
        })
      ) {
        // Do not let an old or incomplete tombstone occupy a bounded due-page
        // forever. It remains scheduled and visible, but is deferred so a
        // subsequent scheduler pass can reach eligible projects behind it.
        await tx
          .update(projectPurgeOperationsTable)
          .set({
            nextAttemptAt: sql`now() + interval '1 day'`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(projectPurgeOperationsTable.id, operationId),
              eq(projectPurgeOperationsTable.state, "scheduled"),
            ),
          );
        return false;
      }
      const transitioned = await tx
        .update(projectPurgeOperationsTable)
        .set({
          state: "accepted",
          retirementOperationIdHash: sha256(retirement.id),
          requestedByHash: sha256(`project-purge-requester-v1\u0000${owner.ownerId}`),
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectPurgeOperationsTable.id, operationId),
            eq(projectPurgeOperationsTable.projectId, candidate.projectId),
            eq(projectPurgeOperationsTable.state, "scheduled"),
            lte(projectPurgeOperationsTable.dueAt, sql`now()`),
            or(
              isNull(projectPurgeOperationsTable.nextAttemptAt),
              lte(projectPurgeOperationsTable.nextAttemptAt, sql`now()`),
            ),
          ),
        )
        .returning({ id: projectPurgeOperationsTable.id });
      return transitioned.length === 1;
    });
  },

  async listDueNotificationMilestones(limit) {
    const { db } = await import("@workspace/db");
    const result = await db.execute<MilestoneRow>(sql`
      WITH candidate AS (
        SELECT
          operation.id AS operation_id,
          CASE
            WHEN operation.state = 'completed' THEN previous.recipient_id
            ELSE project.owner_id
          END AS recipient_user_id,
          CASE WHEN operation.state = 'completed' THEN NULL ELSE project.id END AS project_id,
          CASE WHEN operation.state = 'completed' THEN NULL ELSE project.name END AS project_name,
          operation.due_at::text,
          CASE
            WHEN operation.state = 'completed' THEN 'completed'
            WHEN trash.id IS NULL THEN 'trash'
            WHEN operation.due_at <= now() + interval '1 day' THEN 'one_day'
            WHEN operation.due_at <= now() + interval '7 days' THEN 'seven_day'
            ELSE NULL
          END AS milestone
        FROM project_purge_operations operation
        LEFT JOIN projects project ON project.id = operation.project_id
        LEFT JOIN notifications trash
          ON trash.resource_type = 'project_purge'
         AND trash.resource_id = operation.id || ':trash'
        LEFT JOIN LATERAL (
          SELECT notification.recipient_id
          FROM notifications notification
          WHERE notification.resource_type = 'project_purge'
            AND split_part(notification.resource_id, ':', 1) = operation.id
          ORDER BY notification.created_at
          LIMIT 1
        ) previous ON true
        WHERE operation.state IN ('scheduled', 'completed')
      )
      SELECT candidate.*
      FROM candidate
      WHERE candidate.milestone IS NOT NULL
        AND candidate.recipient_user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM notifications delivered
          WHERE delivered.resource_type = 'project_purge'
            AND delivered.resource_id = candidate.operation_id || ':' || candidate.milestone
            AND delivered.recipient_id = candidate.recipient_user_id
        )
      ORDER BY candidate.operation_id
      LIMIT ${limit}
    `);
    return result.rows.map((row) => ({
      operationId: row.operation_id,
      recipientUserId: row.recipient_user_id,
      milestone: row.milestone,
      projectId: row.project_id,
      projectName: row.project_name,
      dueAt: row.due_at,
    }));
  },
};
