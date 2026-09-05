import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

import { getClerkUserById } from "./clerk-users";
import {
  EMAIL_DELIVERY_FAILURE_KINDS,
  sendEmailWithReceipt,
  type EmailDeliveryReceipt,
  type EmailDeliveryStatus,
} from "./emailClient";

export const PROJECT_PURGE_NOTIFICATION_SEMANTICS = "project-purge-notification-v1" as const;
export const PROJECT_PURGE_EMAIL_MAX_ATTEMPTS = 3 as const;
export const PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS = [5 * 60_000, 30 * 60_000] as const;
export const PROJECT_PURGE_NOTIFICATION_RETRY_LIMIT = 50 as const;
export const PROJECT_PURGE_EMAIL_LEASE_MINUTES = 2 as const;
export const PROJECT_PURGE_EMAIL_SEND_TIMEOUT_MS = 90_000 as const;
export const PROJECT_PURGE_CLERK_LOOKUP_TIMEOUT_MS = 10_000 as const;

export type ProjectPurgeNotificationMilestone = "trash" | "seven_day" | "one_day" | "completed";

export type ProjectPurgeMilestoneInput = {
  operationId: string;
  recipientUserId: string;
  milestone: ProjectPurgeNotificationMilestone;
  projectId: number | null;
  projectName: string | null;
  /** Database-clock due time, serialized by the scheduler store. */
  dueAt: string | null;
};

export type ProjectPurgeEmailReceipt = {
  status: "pending" | "sending" | EmailDeliveryStatus;
  attempts: number;
  maxAttempts: typeof PROJECT_PURGE_EMAIL_MAX_ATTEMPTS;
  leaseId: string | null;
  leaseExpiresAt: string | null;
  /** Optional on historical receipts; all new deadlines use the database clock. */
  nextAttemptAt?: string | null;
  lastDelivery?: ProjectPurgeEmailDeliveryReceipt | null;
  suppressionReason?: "nonproduction_suppressed" | null;
};

const RECIPIENT_FAILURE_KINDS = [
  "recipient_lookup_timeout",
  "recipient_lookup_failed",
  "recipient_lookup_unavailable",
  "recipient_email_missing",
  "recipient_identity_mismatch",
] as const;

export type ProjectPurgeEmailDeliveryReceipt =
  | EmailDeliveryReceipt
  | {
      status: "failed";
      acceptance: "not_attempted";
      providerMessageId: null;
      failureKind: (typeof RECIPIENT_FAILURE_KINDS)[number];
      retryable: boolean | null;
      providerStatusCode: null;
    };

export type ProjectPurgeNotificationMetadata = {
  semantics: typeof PROJECT_PURGE_NOTIFICATION_SEMANTICS;
  milestone: ProjectPurgeNotificationMilestone;
  dueAt: string | null;
  email: ProjectPurgeEmailReceipt;
};

export type ProjectPurgeNotificationRecord = {
  id: number;
  recipientUserId: string;
  title: string;
  body: string;
  metadata: ProjectPurgeNotificationMetadata;
};

type CreateNotificationInput = {
  recipientUserId: string;
  type: string;
  title: string;
  body: string;
  resourceId: string;
  projectId: number | null;
  metadata: ProjectPurgeNotificationMetadata;
};

export type ProjectPurgeNotificationStore = {
  createOrGet(input: CreateNotificationInput): Promise<ProjectPurgeNotificationRecord>;
  claimEmailAttempt(
    notificationId: number,
    maxAttempts: number,
  ): Promise<
    | (ProjectPurgeNotificationRecord & { attempt: number; leaseId: string })
    | { suppressed: true }
    | null
  >;
  completeEmailAttempt(
    notificationId: number,
    attempt: number,
    leaseId: string,
    status: EmailDeliveryStatus,
    receipt?: ProjectPurgeEmailDeliveryReceipt,
  ): Promise<void>;
  listRetryable(limit: number): Promise<ProjectPurgeNotificationRecord[]>;
};

export type ProjectPurgeNotificationDependencies = {
  store: ProjectPurgeNotificationStore;
  getUser: typeof getClerkUserById;
  sendEmail: typeof sendEmailWithReceipt;
};

const defaultDependencies: Omit<ProjectPurgeNotificationDependencies, "store"> = {
  getUser: getClerkUserById,
  sendEmail: sendEmailWithReceipt,
};

function parseDeliveryReceipt(value: unknown): ProjectPurgeEmailDeliveryReceipt {
  const invalid = () => new Error("project_purge_email_delivery_receipt_invalid");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const receipt = value as Record<string, unknown>;
  const kinds: readonly string[] = [...EMAIL_DELIVERY_FAILURE_KINDS, ...RECIPIENT_FAILURE_KINDS];
  const recipientFailure = (RECIPIENT_FAILURE_KINDS as readonly unknown[]).includes(
    receipt.failureKind,
  );
  if (
    typeof receipt.status !== "string" ||
    !["sent", "skipped", "failed"].includes(receipt.status) ||
    typeof receipt.acceptance !== "string" ||
    !["accepted", "not_accepted", "unknown", "not_attempted"].includes(receipt.acceptance) ||
    (receipt.retryable !== null && typeof receipt.retryable !== "boolean") ||
    (receipt.providerStatusCode !== null &&
      (typeof receipt.providerStatusCode !== "number" ||
        !Number.isInteger(receipt.providerStatusCode) ||
        receipt.providerStatusCode < 400 ||
        receipt.providerStatusCode > 599)) ||
    (receipt.failureKind !== null &&
      (typeof receipt.failureKind !== "string" || !kinds.includes(receipt.failureKind)))
  )
    throw invalid();
  if (receipt.status === "sent") {
    if (
      receipt.acceptance !== "accepted" ||
      receipt.failureKind !== null ||
      typeof receipt.providerMessageId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(receipt.providerMessageId) ||
      receipt.providerStatusCode !== null
    )
      throw invalid();
  } else if (
    receipt.acceptance === "accepted" ||
    receipt.failureKind === null ||
    receipt.providerMessageId !== null
  ) {
    throw invalid();
  }
  if (
    recipientFailure !== (receipt.acceptance === "not_attempted") ||
    (recipientFailure && (receipt.status !== "failed" || receipt.providerStatusCode !== null)) ||
    (receipt.status === "skipped" &&
      (receipt.failureKind !== "provider_unconfigured" || receipt.acceptance !== "not_accepted"))
  ) {
    throw invalid();
  }
  // Only these bounded fields reach durable metadata, even for injected senders.
  return {
    status: receipt.status,
    acceptance: receipt.acceptance,
    providerMessageId: receipt.providerMessageId,
    failureKind: receipt.failureKind,
    retryable: receipt.retryable,
    providerStatusCode: receipt.providerStatusCode,
  } as ProjectPurgeEmailDeliveryReceipt;
}

function parseMetadata(value: unknown): ProjectPurgeNotificationMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("project_purge_notification_metadata_invalid");
  }
  const metadata = value as Partial<ProjectPurgeNotificationMetadata>;
  const email = metadata.email;
  if (
    metadata.semantics !== PROJECT_PURGE_NOTIFICATION_SEMANTICS ||
    !["trash", "seven_day", "one_day", "completed"].includes(metadata.milestone ?? "") ||
    !email ||
    !["pending", "sending", "sent", "skipped", "failed"].includes(email.status) ||
    !Number.isSafeInteger(email.attempts) ||
    email.attempts < 0 ||
    email.attempts > PROJECT_PURGE_EMAIL_MAX_ATTEMPTS ||
    email.maxAttempts !== PROJECT_PURGE_EMAIL_MAX_ATTEMPTS
  ) {
    throw new Error("project_purge_notification_metadata_invalid");
  }
  const leaseId = email.leaseId ?? null;
  const leaseExpiresAt = email.leaseExpiresAt ?? null;
  const nextAttemptAt = email.nextAttemptAt ?? null;
  const lastDelivery = email.lastDelivery == null ? null : parseDeliveryReceipt(email.lastDelivery);
  const suppressionReason = email.suppressionReason ?? null;
  if (
    (suppressionReason !== null && suppressionReason !== "nonproduction_suppressed") ||
    (nextAttemptAt !== null &&
      (typeof nextAttemptAt !== "string" ||
        !Number.isFinite(Date.parse(nextAttemptAt)) ||
        new Date(nextAttemptAt).toISOString() !== nextAttemptAt ||
        !["failed", "skipped"].includes(email.status) ||
        email.attempts >= PROJECT_PURGE_EMAIL_MAX_ATTEMPTS)) ||
    (lastDelivery !== null && email.status !== "sending" && lastDelivery.status !== email.status)
  ) {
    throw new Error("project_purge_notification_metadata_invalid");
  }
  const hasValidLease =
    typeof leaseId === "string" &&
    leaseId.length >= 1 &&
    leaseId.length <= 128 &&
    typeof leaseExpiresAt === "string" &&
    Number.isFinite(Date.parse(leaseExpiresAt));
  if (
    (email.status === "sending" && (!hasValidLease || email.attempts < 1)) ||
    (email.status !== "sending" && (leaseId !== null || leaseExpiresAt !== null))
  ) {
    throw new Error("project_purge_notification_metadata_invalid");
  }
  return {
    ...(metadata as ProjectPurgeNotificationMetadata),
    email: {
      ...email,
      leaseId,
      leaseExpiresAt,
      nextAttemptAt,
      lastDelivery,
      suppressionReason,
    } as ProjectPurgeEmailReceipt,
  };
}

function boundedRetryLimit(requested?: number): number {
  if (requested === undefined) return PROJECT_PURGE_NOTIFICATION_RETRY_LIMIT;
  if (!Number.isSafeInteger(requested) || requested < 1) {
    throw new Error("project_purge_notification_retry_limit_invalid");
  }
  return Math.min(requested, PROJECT_PURGE_NOTIFICATION_RETRY_LIMIT);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function boundedProjectName(value: string | null): string {
  const normalized = value?.trim().slice(0, 160);
  return normalized || "Your project";
}

function formatDatabaseDueAt(value: string | null): string {
  const milliseconds = value === null ? Number.NaN : Date.parse(value);
  if (!Number.isFinite(milliseconds)) return "on its scheduled deletion date";
  const date = new Date(milliseconds);
  const formatted = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(date);
  return `on ${formatted} UTC`;
}

export function presentProjectPurgeMilestone(input: ProjectPurgeMilestoneInput): {
  type: string;
  title: string;
  body: string;
  projectId: number | null;
  metadata: ProjectPurgeNotificationMetadata;
} {
  const projectName = boundedProjectName(input.projectName);
  const common = {
    metadata: {
      semantics: PROJECT_PURGE_NOTIFICATION_SEMANTICS,
      milestone: input.milestone,
      dueAt: input.milestone === "completed" ? null : input.dueAt,
      email: {
        status: "pending" as const,
        attempts: 0,
        maxAttempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
        leaseId: null,
        leaseExpiresAt: null,
      },
    },
  };
  if (input.milestone === "completed") {
    return {
      type: "project_purge_completed",
      title: "Project permanently deleted",
      body: "Your deleted project and its NabuFlow-owned resources have been permanently removed.",
      projectId: null,
      ...common,
    };
  }
  const dueDescription = formatDatabaseDueAt(input.dueAt);
  if (input.milestone === "one_day") {
    return {
      type: "project_purge_one_day_warning",
      title: "Project deletion is close",
      body: `${projectName} will be permanently deleted ${dueDescription} unless you restore it.`,
      projectId: input.projectId,
      ...common,
    };
  }
  if (input.milestone === "seven_day") {
    return {
      type: "project_purge_seven_day_warning",
      title: "Project deletion is scheduled",
      body: `${projectName} will be permanently deleted ${dueDescription} unless you restore it.`,
      projectId: input.projectId,
      ...common,
    };
  }
  return {
    type: "project_purge_trash",
    title: "Project moved to Trash",
    body: `${projectName} will be permanently deleted ${dueDescription} unless you restore it.`,
    projectId: input.projectId,
    ...common,
  };
}

function currentEmailStatus(
  record: ProjectPurgeNotificationRecord,
): ProjectPurgeEmailReceipt["status"] {
  return record.metadata.email.status;
}

async function getPurgeRecipientBounded(
  getUser: ProjectPurgeNotificationDependencies["getUser"],
  userId: string,
): Promise<
  | { kind: "user"; user: Awaited<ReturnType<ProjectPurgeNotificationDependencies["getUser"]>> }
  | { kind: "failed" | "timeout" }
> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const lookup = Promise.resolve()
    .then(() => getUser(userId))
    .then(
      (user) => ({ kind: "user" as const, user }),
      () => ({ kind: "failed" as const }),
    );
  const deadline = new Promise<{ kind: "timeout" }>((resolve) => {
    timeout = setTimeout(() => resolve({ kind: "timeout" }), PROJECT_PURGE_CLERK_LOOKUP_TIMEOUT_MS);
    if (typeof timeout === "object" && "unref" in timeout) timeout.unref();
  });
  try {
    const outcome = await Promise.race([lookup, deadline]);
    return outcome;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function attemptProjectPurgeEmail(
  dependencies: ProjectPurgeNotificationDependencies,
  notificationId: number,
): Promise<EmailDeliveryStatus | "pending"> {
  const claimed = await dependencies.store.claimEmailAttempt(
    notificationId,
    PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
  );
  if (!claimed) return "pending";
  if ("suppressed" in claimed) return "skipped";

  const lookup = await getPurgeRecipientBounded(dependencies.getUser, claimed.recipientUserId);
  const user = lookup.kind === "user" ? lookup.user : null;
  let delivery: ProjectPurgeEmailDeliveryReceipt;
  if (!user || user.userId !== claimed.recipientUserId || !user.email?.trim()) {
    delivery = {
      status: "failed",
      acceptance: "not_attempted",
      providerMessageId: null,
      failureKind:
        lookup.kind === "timeout"
          ? "recipient_lookup_timeout"
          : lookup.kind === "failed"
            ? "recipient_lookup_failed"
            : !user
              ? "recipient_lookup_unavailable"
              : user.userId !== claimed.recipientUserId
                ? "recipient_identity_mismatch"
                : "recipient_email_missing",
      // Clerk null includes configuration and transport failures; it is not
      // proof that an account is missing. No account or provider error is stored.
      retryable: lookup.kind === "timeout" || lookup.kind === "failed" ? true : null,
      providerStatusCode: null,
    };
  } else {
    const signal = AbortSignal.timeout(PROJECT_PURGE_EMAIL_SEND_TIMEOUT_MS);
    try {
      const receipt = await dependencies.sendEmail({
        to: user.email,
        subject: claimed.title,
        text: claimed.body,
        html: `<p>${escapeHtml(claimed.body)}</p>`,
        idempotencyKey: `project-purge-notification:${claimed.id}`,
        signal,
      });
      try {
        delivery = parseDeliveryReceipt(receipt);
        if (delivery.acceptance === "not_attempted") throw new Error("invalid_provider_receipt");
      } catch {
        delivery = {
          status: "failed",
          acceptance: "unknown",
          providerMessageId: null,
          failureKind: "provider_response_invalid",
          retryable: null,
          providerStatusCode: null,
        };
      }
    } catch {
      delivery = {
        status: "failed",
        acceptance: "unknown",
        providerMessageId: null,
        failureKind: signal.aborted ? "provider_timeout" : "provider_transport_error",
        retryable: true,
        providerStatusCode: null,
      };
    }
  }
  await dependencies.store.completeEmailAttempt(
    claimed.id,
    claimed.attempt,
    claimed.leaseId,
    delivery.status,
    delivery,
  );
  return delivery.status;
}

/**
 * The in-product row is durable and idempotent. Email is an independently
 * receipted best-effort channel; its failure never changes purge state.
 */
export async function deliverProjectPurgeMilestone(
  input: ProjectPurgeMilestoneInput,
  dependencies: Partial<ProjectPurgeNotificationDependencies> & {
    store: ProjectPurgeNotificationStore;
  },
): Promise<{ notificationId: number; emailStatus: EmailDeliveryStatus | "pending" }> {
  const deps: ProjectPurgeNotificationDependencies = { ...defaultDependencies, ...dependencies };
  const presentation = presentProjectPurgeMilestone(input);
  const notification = await deps.store.createOrGet({
    recipientUserId: input.recipientUserId,
    type: presentation.type,
    title: presentation.title,
    body: presentation.body,
    resourceId: `${input.operationId}:${input.milestone}`,
    projectId: presentation.projectId,
    metadata: presentation.metadata,
  });
  if (currentEmailStatus(notification) === "sent") {
    return { notificationId: notification.id, emailStatus: "sent" };
  }
  const emailStatus = await attemptProjectPurgeEmail(deps, notification.id);
  return { notificationId: notification.id, emailStatus };
}

export async function retryProjectPurgeEmailDeliveries(
  dependencies: Partial<ProjectPurgeNotificationDependencies> & {
    store: ProjectPurgeNotificationStore;
  },
  requestedLimit?: number,
): Promise<{ inspected: number; sent: number; stillUnsent: number }> {
  const deps: ProjectPurgeNotificationDependencies = { ...defaultDependencies, ...dependencies };
  const limit = boundedRetryLimit(requestedLimit);
  const retryable = await deps.store.listRetryable(limit);
  if (retryable.length > limit) throw new Error("project_purge_notification_store_unbounded");
  let sent = 0;
  let stillUnsent = 0;
  for (const notification of retryable) {
    const status = await attemptProjectPurgeEmail(deps, notification.id);
    if (status === "sent") sent++;
    else stillUnsent++;
  }
  return { inspected: retryable.length, sent, stillUnsent };
}

type NotificationRow = {
  id: number;
  recipient_id: string;
  title: string;
  body: string | null;
  metadata: unknown;
};

type NotificationClockRow = NotificationRow & {
  database_now: string;
};

type NotificationClaimRow = NotificationClockRow & {
  lease_expires_at: string;
};

function recordFromRow(row: NotificationRow): ProjectPurgeNotificationRecord {
  return {
    id: row.id,
    recipientUserId: row.recipient_id,
    title: row.title,
    body: row.body ?? "",
    metadata: parseMetadata(row.metadata),
  };
}

/** Production adapter. Its row locks make attempt counting concurrency-safe. */
export const databaseProjectPurgeNotificationStore: ProjectPurgeNotificationStore = {
  async createOrGet(input) {
    const { db, notificationsTable } = await import("@workspace/db");
    const inserted = await db
      .insert(notificationsTable)
      .values({
        recipientId: input.recipientUserId,
        type: input.type,
        title: input.title,
        body: input.body,
        resourceType: "project_purge",
        resourceId: input.resourceId,
        projectId: input.projectId,
        metadata: input.metadata,
      })
      .onConflictDoNothing()
      .returning({
        id: notificationsTable.id,
        recipientId: notificationsTable.recipientId,
        title: notificationsTable.title,
        body: notificationsTable.body,
        metadata: notificationsTable.metadata,
      });
    const created = inserted[0];
    if (created) {
      return {
        id: created.id,
        recipientUserId: created.recipientId,
        title: created.title,
        body: created.body ?? "",
        metadata: parseMetadata(created.metadata),
      };
    }
    const existing = await db
      .select({
        id: notificationsTable.id,
        recipientId: notificationsTable.recipientId,
        title: notificationsTable.title,
        body: notificationsTable.body,
        metadata: notificationsTable.metadata,
      })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.resourceType, "project_purge"),
          eq(notificationsTable.resourceId, input.resourceId),
          eq(notificationsTable.recipientId, input.recipientUserId),
        ),
      )
      .limit(1);
    const row = existing[0];
    if (!row) throw new Error("project_purge_notification_receipt_unavailable");
    return {
      id: row.id,
      recipientUserId: row.recipientId,
      title: row.title,
      body: row.body ?? "",
      metadata: parseMetadata(row.metadata),
    };
  },

  async claimEmailAttempt(notificationId, maxAttempts) {
    if (maxAttempts !== PROJECT_PURGE_EMAIL_MAX_ATTEMPTS) {
      throw new Error("project_purge_notification_attempt_limit_invalid");
    }
    const { db, notificationsTable } = await import("@workspace/db");
    return db.transaction(async (tx) => {
      const selected = await tx.execute<NotificationClaimRow>(sql`
        SELECT id, recipient_id, title, body, metadata
             , to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now
             , to_char(
                 (CURRENT_TIMESTAMP + (${PROJECT_PURGE_EMAIL_LEASE_MINUTES} * INTERVAL '1 minute'))
                   AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               ) AS lease_expires_at
        FROM notifications
        WHERE id = ${notificationId}
          AND resource_type = 'project_purge'
        FOR UPDATE
      `);
      const row = selected.rows[0];
      if (!row) return null;
      const record = recordFromRow(row);
      const previousEmail = record.metadata.email;
      if (previousEmail.status === "sent") return null;
      if (previousEmail.suppressionReason === "nonproduction_suppressed") {
        return { suppressed: true };
      }
      if (previousEmail.status === "sending") {
        if (Date.parse(previousEmail.leaseExpiresAt!) > Date.parse(row.database_now)) return null;
      } else if (previousEmail.attempts >= maxAttempts) {
        return null;
      }
      // Match the existing Replit production selector used by billing/Stripe.
      // NODE_ENV and working provider credentials do not establish deployment
      // authority. Gate before acquiring an email attempt or contacting Clerk.
      if (process.env.REPLIT_DEPLOYMENT !== "1") {
        const metadata: ProjectPurgeNotificationMetadata = {
          ...record.metadata,
          email: {
            ...previousEmail,
            // A new in-app preview has not attempted any external delivery.
            // Preserve prior uncertain/provider evidence on historical rows.
            ...(previousEmail.attempts === 0 ? { status: "skipped" as const } : {}),
            suppressionReason: "nonproduction_suppressed",
          },
        };
        await tx
          .update(notificationsTable)
          .set({ metadata })
          .where(eq(notificationsTable.id, notificationId));
        return { suppressed: true };
      }
      if (
        previousEmail.nextAttemptAt &&
        Date.parse(previousEmail.nextAttemptAt) > Date.parse(row.database_now)
      )
        return null;
      // A stale lease resumes the same provider attempt. That preserves the
      // bounded attempt count while the provider's stable idempotency key
      // makes a crash-after-send retry safe.
      const attempt =
        previousEmail.status === "sending" ? previousEmail.attempts : previousEmail.attempts + 1;
      const leaseId = randomUUID();
      const metadata: ProjectPurgeNotificationMetadata = {
        ...record.metadata,
        email: {
          ...previousEmail,
          status: "sending",
          attempts: attempt,
          leaseId,
          leaseExpiresAt: row.lease_expires_at,
          nextAttemptAt: null,
        },
      };
      await tx
        .update(notificationsTable)
        .set({ metadata })
        .where(eq(notificationsTable.id, notificationId));
      return { ...record, metadata, attempt, leaseId };
    });
  },

  async completeEmailAttempt(notificationId, attempt, leaseId, status, receipt) {
    const { db, notificationsTable } = await import("@workspace/db");
    await db.transaction(async (tx) => {
      const selected = await tx.execute<NotificationClockRow>(sql`
        SELECT id, recipient_id, title, body, metadata
             , to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS database_now
        FROM notifications
        WHERE id = ${notificationId}
          AND resource_type = 'project_purge'
        FOR UPDATE
      `);
      const row = selected.rows[0];
      if (!row) throw new Error("project_purge_notification_receipt_unavailable");
      const record = recordFromRow(row);
      if (
        record.metadata.email.status !== "sending" ||
        record.metadata.email.attempts !== attempt ||
        record.metadata.email.leaseId !== leaseId
      ) {
        return;
      }
      const lastDelivery = receipt === undefined ? null : parseDeliveryReceipt(receipt);
      if (
        (lastDelivery !== null && lastDelivery.status !== status) ||
        (status === "sent" && lastDelivery?.acceptance !== "accepted")
      ) {
        throw new Error("project_purge_email_delivery_receipt_invalid");
      }
      // Keep the three-attempt budget, but do not spend it during one burst or
      // outage. Both direct dispatch and polling enforce this DB-clock delay.
      const delay = PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS[attempt - 1];
      const nextAttemptAt =
        status !== "sent" && delay !== undefined
          ? new Date(Date.parse(row.database_now) + delay).toISOString()
          : null;
      await tx
        .update(notificationsTable)
        .set({
          metadata: {
            ...record.metadata,
            email: {
              ...record.metadata.email,
              status,
              leaseId: null,
              leaseExpiresAt: null,
              nextAttemptAt,
              lastDelivery,
            },
          },
        })
        .where(eq(notificationsTable.id, notificationId));
    });
  },

  async listRetryable(limit) {
    const { db } = await import("@workspace/db");
    const result = await db.execute<NotificationRow>(sql`
      SELECT id, recipient_id, title, body, metadata
      FROM notifications
      WHERE resource_type = 'project_purge'
        AND metadata ->> 'semantics' = ${PROJECT_PURGE_NOTIFICATION_SEMANTICS}
        AND COALESCE(metadata -> 'email' ->> 'suppressionReason', '') <> 'nonproduction_suppressed'
        AND (
          (
            metadata -> 'email' ->> 'status' IN ('pending', 'skipped', 'failed')
            AND (metadata -> 'email' ->> 'attempts')::int < ${PROJECT_PURGE_EMAIL_MAX_ATTEMPTS}
            AND (
              metadata -> 'email' ->> 'nextAttemptAt' IS NULL
              OR metadata -> 'email' ->> 'nextAttemptAt'
                <= to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
            )
          )
          OR (
            metadata -> 'email' ->> 'status' = 'sending'
            AND metadata -> 'email' ->> 'leaseExpiresAt'
              <= to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        )
      ORDER BY created_at, id
      LIMIT ${limit}
    `);
    return result.rows.map(recordFromRow);
  },
};
