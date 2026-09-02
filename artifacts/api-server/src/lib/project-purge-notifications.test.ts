import { describe, expect, it, vi } from "vitest";

import {
  PROJECT_PURGE_EMAIL_LEASE_MINUTES,
  PROJECT_PURGE_CLERK_LOOKUP_TIMEOUT_MS,
  PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
  PROJECT_PURGE_NOTIFICATION_SEMANTICS,
  deliverProjectPurgeMilestone,
  presentProjectPurgeMilestone,
  retryProjectPurgeEmailDeliveries,
  type ProjectPurgeMilestoneInput,
  type ProjectPurgeNotificationMetadata,
  type ProjectPurgeNotificationRecord,
  type ProjectPurgeNotificationStore,
} from "./project-purge-notifications";

type CreateInput = Parameters<ProjectPurgeNotificationStore["createOrGet"]>[0];

class MemoryNotificationStore implements ProjectPurgeNotificationStore {
  nextId = 1;
  nowMs = Date.parse("2026-09-01T12:00:00.000Z");
  leaseSequence = 0;
  records = new Map<number, ProjectPurgeNotificationRecord>();
  keys = new Map<string, number>();

  async createOrGet(input: CreateInput): Promise<ProjectPurgeNotificationRecord> {
    const key = `${input.resourceId}:${input.recipientUserId}`;
    const existingId = this.keys.get(key);
    if (existingId) return this.records.get(existingId)!;
    const record: ProjectPurgeNotificationRecord = {
      id: this.nextId++,
      recipientUserId: input.recipientUserId,
      title: input.title,
      body: input.body,
      metadata: input.metadata,
    };
    this.keys.set(key, record.id);
    this.records.set(record.id, record);
    return record;
  }

  async claimEmailAttempt(
    notificationId: number,
    maxAttempts: number,
  ): Promise<(ProjectPurgeNotificationRecord & { attempt: number; leaseId: string }) | null> {
    const record = this.records.get(notificationId);
    if (!record || record.metadata.email.status === "sent") return null;
    const previousEmail = record.metadata.email;
    if (previousEmail.status === "sending") {
      if (Date.parse(previousEmail.leaseExpiresAt!) > this.nowMs) return null;
    } else if (previousEmail.attempts >= maxAttempts) {
      return null;
    }
    const attempt =
      previousEmail.status === "sending" ? previousEmail.attempts : previousEmail.attempts + 1;
    const leaseId = `lease-${++this.leaseSequence}`;
    record.metadata = {
      ...record.metadata,
      email: {
        ...previousEmail,
        attempts: attempt,
        status: "sending",
        leaseId,
        leaseExpiresAt: new Date(
          this.nowMs + PROJECT_PURGE_EMAIL_LEASE_MINUTES * 60_000,
        ).toISOString(),
      },
    };
    return { ...record, attempt, leaseId };
  }

  async completeEmailAttempt(
    notificationId: number,
    attempt: number,
    leaseId: string,
    status: "sent" | "skipped" | "failed",
  ): Promise<void> {
    const record = this.records.get(notificationId);
    if (
      !record ||
      record.metadata.email.status !== "sending" ||
      record.metadata.email.attempts !== attempt ||
      record.metadata.email.leaseId !== leaseId
    ) {
      return;
    }
    record.metadata = {
      ...record.metadata,
      email: { ...record.metadata.email, status, leaseId: null, leaseExpiresAt: null },
    };
  }

  async listRetryable(limit: number): Promise<ProjectPurgeNotificationRecord[]> {
    return [...this.records.values()]
      .filter((record) => {
        const email = record.metadata.email;
        if (email.status === "sent") return false;
        if (email.status === "sending") {
          return Date.parse(email.leaseExpiresAt!) <= this.nowMs;
        }
        return email.attempts < email.maxAttempts;
      })
      .slice(0, limit);
  }
}

function input(
  milestone: ProjectPurgeMilestoneInput["milestone"] = "trash",
): ProjectPurgeMilestoneInput {
  return {
    operationId: "purge_abc",
    recipientUserId: "user_owner",
    milestone,
    projectId: milestone === "completed" ? null : 42,
    projectName: milestone === "completed" ? null : "Weather desk",
    dueAt: milestone === "completed" ? null : "2026-10-01T00:00:00.000Z",
  };
}

function deps(
  store: ProjectPurgeNotificationStore,
  status: "sent" | "skipped" | "failed" = "sent",
) {
  return {
    store,
    getUser: vi.fn(
      async (
        _userId: string,
      ): Promise<{
        userId: string;
        email: string;
        displayName: string;
        imageUrl: null;
      } | null> => ({
        userId: "user_owner",
        email: "owner@example.com",
        displayName: "Owner",
        imageUrl: null,
      }),
    ),
    sendEmail: vi.fn(
      async (_input: {
        to: string;
        subject: string;
        html: string;
        text?: string;
        signal?: AbortSignal;
        idempotencyKey?: string;
      }) => status,
    ),
  };
}

describe("project purge notifications", () => {
  it("presents all four milestones in plain language", () => {
    expect(presentProjectPurgeMilestone(input("trash")).body).toContain(
      "October 1, 2026 at 00:00 UTC",
    );
    expect(presentProjectPurgeMilestone(input("seven_day")).body).toContain(
      "October 1, 2026 at 00:00 UTC",
    );
    expect(presentProjectPurgeMilestone(input("one_day")).body).toContain(
      "October 1, 2026 at 00:00 UTC",
    );
    expect(presentProjectPurgeMilestone(input("completed")).title).toBe(
      "Project permanently deleted",
    );
  });

  it("never turns delayed delivery into a false relative countdown", () => {
    const delayed = presentProjectPurgeMilestone({
      ...input("one_day"),
      dueAt: "2026-09-01T12:05:00.000Z",
    });

    expect(delayed.body).toContain("September 1, 2026 at 12:05 UTC");
    expect(delayed.body).not.toContain("tomorrow");
    expect(delayed.body).not.toContain("in 1 day");
  });

  it("strips project identity from the durable completed message", () => {
    const completed = presentProjectPurgeMilestone({
      ...input("completed"),
      projectId: 9182,
      projectName: "Secret project name",
      dueAt: "2026-10-01T00:00:00Z",
    });
    const serialized = JSON.stringify(completed);

    expect(completed.projectId).toBeNull();
    expect(completed.metadata.dueAt).toBeNull();
    expect(serialized).not.toContain("9182");
    expect(serialized).not.toContain("Secret project name");
  });

  it("persists the notification before emailing and records the send separately", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);

    const result = await deliverProjectPurgeMilestone(input(), dependencies);

    expect(result).toEqual({ notificationId: 1, emailStatus: "sent" });
    expect(dependencies.getUser).toHaveBeenCalledWith("user_owner");
    expect(dependencies.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner@example.com",
        idempotencyKey: "project-purge-notification:1",
      }),
    );
    expect(store.records.get(1)?.metadata.email).toEqual({
      status: "sent",
      attempts: 1,
      maxAttempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
      leaseId: null,
      leaseExpiresAt: null,
    });
  });

  it("does not send the same milestone twice", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);

    await deliverProjectPurgeMilestone(input(), dependencies);
    await deliverProjectPurgeMilestone(input(), dependencies);

    expect(store.records).toHaveLength(1);
    expect(dependencies.sendEmail).toHaveBeenCalledOnce();
  });

  it("records a provider failure without changing or overstating the notification", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store, "failed");

    const result = await deliverProjectPurgeMilestone(input("seven_day"), dependencies);

    expect(result.emailStatus).toBe("failed");
    expect(store.records.get(1)?.title).toBe("Project deletion is scheduled");
    expect(store.records.get(1)?.metadata.email.status).toBe("failed");
  });

  it("records a missing account email as a bounded failure", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);
    dependencies.getUser.mockResolvedValue(null);

    const result = await deliverProjectPurgeMilestone(input("one_day"), dependencies);

    expect(result.emailStatus).toBe("failed");
    expect(dependencies.sendEmail).not.toHaveBeenCalled();
    expect(store.records.get(1)?.metadata.email.attempts).toBe(1);
  });

  it("times out a stalled Clerk lookup and continues to the next notification", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryNotificationStore();
      for (const [index, milestone] of ["seven_day", "one_day"].entries()) {
        const presentation = presentProjectPurgeMilestone(
          input(milestone as ProjectPurgeMilestoneInput["milestone"]),
        );
        await store.createOrGet({
          recipientUserId: "user_owner",
          type: presentation.type,
          title: presentation.title,
          body: presentation.body,
          resourceId: `purge_abc:${milestone}:${index}`,
          projectId: presentation.projectId,
          metadata: presentation.metadata,
        });
      }
      const dependencies = deps(store);
      dependencies.getUser
        .mockImplementationOnce(() => new Promise(() => undefined))
        .mockResolvedValueOnce({
          userId: "user_owner",
          email: "owner@example.com",
          displayName: "Owner",
          imageUrl: null,
        });

      const retry = retryProjectPurgeEmailDeliveries(dependencies);
      await vi.advanceTimersByTimeAsync(PROJECT_PURGE_CLERK_LOOKUP_TIMEOUT_MS);

      await expect(retry).resolves.toEqual({ inspected: 2, sent: 1, stillUnsent: 1 });
      expect(dependencies.sendEmail).toHaveBeenCalledOnce();
      expect(store.records.get(1)?.metadata.email.status).toBe("failed");
      expect(store.records.get(2)?.metadata.email.status).toBe("sent");
    } finally {
      vi.useRealTimers();
    }
  });

  it("escapes the project name before it reaches email HTML", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);

    await deliverProjectPurgeMilestone(
      { ...input(), projectName: '<img src=x onerror="alert(1)">' },
      dependencies,
    );

    const html = dependencies.sendEmail.mock.calls[0]?.[0].html;
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("retries skipped or failed delivery no more than three total attempts", async () => {
    const store = new MemoryNotificationStore();
    const metadata: ProjectPurgeNotificationMetadata = {
      semantics: PROJECT_PURGE_NOTIFICATION_SEMANTICS,
      milestone: "trash",
      dueAt: "2026-10-01T00:00:00Z",
      email: {
        status: "failed",
        attempts: 2,
        maxAttempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
        leaseId: null,
        leaseExpiresAt: null,
      },
    };
    store.records.set(1, {
      id: 1,
      recipientUserId: "user_owner",
      title: "Project moved to Trash",
      body: "A project will be deleted.",
      metadata,
    });
    const dependencies = deps(store, "failed");

    const first = await retryProjectPurgeEmailDeliveries(dependencies, 50);
    const second = await retryProjectPurgeEmailDeliveries(dependencies, 50);

    expect(first).toEqual({ inspected: 1, sent: 0, stillUnsent: 1 });
    expect(second).toEqual({ inspected: 0, sent: 0, stillUnsent: 0 });
    expect(dependencies.sendEmail).toHaveBeenCalledOnce();
    expect(store.records.get(1)?.metadata.email.attempts).toBe(3);
  });

  it("caps retry scans at fifty", async () => {
    const store = new MemoryNotificationStore();
    const listRetryable = vi.spyOn(store, "listRetryable");

    await retryProjectPurgeEmailDeliveries(deps(store), 500);

    expect(listRetryable).toHaveBeenCalledWith(50);
  });

  it("leases one sender across parallel milestone dispatch and periodic retry", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);
    let releaseSend!: (status: "sent") => void;
    dependencies.sendEmail.mockImplementation(
      () =>
        new Promise<"sent">((resolve) => {
          releaseSend = resolve;
        }),
    );

    const first = deliverProjectPurgeMilestone(input(), dependencies);
    await vi.waitFor(() => expect(dependencies.sendEmail).toHaveBeenCalledOnce());
    const [second, retry] = await Promise.all([
      deliverProjectPurgeMilestone(input(), dependencies),
      retryProjectPurgeEmailDeliveries(dependencies),
    ]);

    expect(second).toEqual({ notificationId: 1, emailStatus: "pending" });
    expect(retry).toEqual({ inspected: 0, sent: 0, stillUnsent: 0 });
    expect(store.records.get(1)?.metadata.email).toMatchObject({
      status: "sending",
      attempts: 1,
    });
    releaseSend("sent");
    await expect(first).resolves.toEqual({ notificationId: 1, emailStatus: "sent" });
    expect(dependencies.sendEmail).toHaveBeenCalledOnce();
  });

  it("recovers a stale final-attempt lease without allowing its old holder to overwrite", async () => {
    const store = new MemoryNotificationStore();
    store.records.set(1, {
      id: 1,
      recipientUserId: "user_owner",
      title: "Project permanently deleted",
      body: "Your deleted project has been permanently removed.",
      metadata: {
        semantics: PROJECT_PURGE_NOTIFICATION_SEMANTICS,
        milestone: "completed",
        dueAt: null,
        email: {
          status: "sending",
          attempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
          maxAttempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
          leaseId: "expired-lease",
          leaseExpiresAt: "2026-09-01T11:59:59.000Z",
        },
      },
    });
    const dependencies = deps(store);

    const result = await retryProjectPurgeEmailDeliveries(dependencies);
    await store.completeEmailAttempt(
      1,
      PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
      "expired-lease",
      "failed",
    );

    expect(result).toEqual({ inspected: 1, sent: 1, stillUnsent: 0 });
    expect(dependencies.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: "project-purge-notification:1" }),
    );
    expect(store.records.get(1)?.metadata.email).toEqual({
      status: "sent",
      attempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
      maxAttempts: PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
      leaseId: null,
      leaseExpiresAt: null,
    });
  });
});
