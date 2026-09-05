import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { EmailDeliveryReceipt } from "./emailClient";

import {
  PROJECT_PURGE_EMAIL_LEASE_MINUTES,
  PROJECT_PURGE_CLERK_LOOKUP_TIMEOUT_MS,
  PROJECT_PURGE_EMAIL_MAX_ATTEMPTS,
  PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS,
  PROJECT_PURGE_NOTIFICATION_SEMANTICS,
  deliverProjectPurgeMilestone,
  presentProjectPurgeMilestone,
  retryProjectPurgeEmailDeliveries,
  databaseProjectPurgeNotificationStore,
  type ProjectPurgeEmailDeliveryReceipt,
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
    if (previousEmail.nextAttemptAt && Date.parse(previousEmail.nextAttemptAt) > this.nowMs)
      return null;
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
        nextAttemptAt: null,
      },
    };
    return { ...record, attempt, leaseId };
  }

  async completeEmailAttempt(
    notificationId: number,
    attempt: number,
    leaseId: string,
    status: "sent" | "skipped" | "failed",
    receipt?: ProjectPurgeEmailDeliveryReceipt,
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
      email: {
        ...record.metadata.email,
        status,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt:
          status !== "sent" && attempt < PROJECT_PURGE_EMAIL_MAX_ATTEMPTS
            ? new Date(this.nowMs + PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS[attempt - 1]!).toISOString()
            : null,
        lastDelivery: receipt ?? null,
      },
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
        return (
          email.attempts < email.maxAttempts &&
          (!email.nextAttemptAt || Date.parse(email.nextAttemptAt) <= this.nowMs)
        );
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

function providerReceipt(status: "sent" | "skipped" | "failed"): EmailDeliveryReceipt {
  return {
    status,
    acceptance: status === "sent" ? "accepted" : status === "skipped" ? "not_accepted" : "unknown",
    providerMessageId: status === "sent" ? "provider-message-1" : null,
    failureKind:
      status === "sent"
        ? null
        : status === "skipped"
          ? "provider_unconfigured"
          : "provider_failure_unclassified",
    retryable: status === "failed" ? null : false,
    providerStatusCode: null,
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
      }) => providerReceipt(status),
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
      nextAttemptAt: null,
      lastDelivery: providerReceipt("sent"),
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
        new Promise<EmailDeliveryReceipt>((resolve) => {
          releaseSend = (status) => resolve(providerReceipt(status));
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
      nextAttemptAt: null,
      lastDelivery: providerReceipt("sent"),
    });
  });

  it("prevents direct dispatch and polling from burning three attempts in one burst", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store, "failed");
    await deliverProjectPurgeMilestone(input(), dependencies);
    await deliverProjectPurgeMilestone(input(), dependencies);
    expect(await retryProjectPurgeEmailDeliveries(dependencies)).toEqual({
      inspected: 0,
      sent: 0,
      stillUnsent: 0,
    });
    expect(dependencies.sendEmail).toHaveBeenCalledTimes(1);
    store.nowMs += PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS[0];
    await retryProjectPurgeEmailDeliveries(dependencies);
    await deliverProjectPurgeMilestone(input(), dependencies);
    expect(dependencies.sendEmail).toHaveBeenCalledTimes(2);
    store.nowMs += PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS[1];
    dependencies.sendEmail.mockResolvedValue(providerReceipt("sent"));
    await retryProjectPurgeEmailDeliveries(dependencies);
    expect(store.records.get(1)?.metadata.email).toMatchObject({
      status: "sent",
      attempts: 3,
      nextAttemptAt: null,
    });
    expect(dependencies.sendEmail.mock.calls.map(([call]) => call)).toEqual([
      expect.objectContaining({ idempotencyKey: "project-purge-notification:1" }),
      expect.objectContaining({ idempotencyKey: "project-purge-notification:1" }),
      expect.objectContaining({ idempotencyKey: "project-purge-notification:1" }),
    ]);
    const payloads = dependencies.sendEmail.mock.calls.map(
      ([{ signal: _signal, ...payload }]) => payload,
    );
    expect(payloads[1]).toEqual(payloads[0]);
    expect(payloads[2]).toEqual(payloads[0]);
  });

  it.each([
    ["null lookup", null, "recipient_lookup_unavailable"],
    [
      "missing email",
      { userId: "user_owner", email: null, displayName: null, imageUrl: null },
      "recipient_email_missing",
    ],
    [
      "wrong owner",
      { userId: "another_owner", email: "other@example.com", displayName: null, imageUrl: null },
      "recipient_identity_mismatch",
    ],
  ] as const)(
    "records %s without claiming the provider rejected an email",
    async (_label, user, kind) => {
      const store = new MemoryNotificationStore();
      const dependencies = { ...deps(store), getUser: vi.fn(async () => user) };
      await deliverProjectPurgeMilestone(input(), dependencies);
      expect(dependencies.sendEmail).not.toHaveBeenCalled();
      expect(store.records.get(1)?.metadata.email.lastDelivery).toMatchObject({
        status: "failed",
        acceptance: "not_attempted",
        failureKind: kind,
        providerMessageId: null,
      });
    },
  );

  it("sanitizes thrown lookup errors and persists the stage", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);
    dependencies.getUser.mockRejectedValue(new Error("secret owner@example.com"));
    await deliverProjectPurgeMilestone(input(), dependencies);
    const diagnostic = store.records.get(1)?.metadata.email.lastDelivery;
    expect(diagnostic).toMatchObject({
      failureKind: "recipient_lookup_failed",
      acceptance: "not_attempted",
    });
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|@/u);
  });

  it("persists rate-limit evidence and does not equate it with mailbox delivery", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);
    dependencies.sendEmail.mockResolvedValue({
      status: "failed",
      acceptance: "not_accepted",
      failureKind: "provider_rate_limited",
      providerMessageId: null,
      providerStatusCode: 429,
      retryable: true,
    });
    await deliverProjectPurgeMilestone(input(), dependencies);
    expect(store.records.get(1)?.metadata.email.lastDelivery).toMatchObject({
      failureKind: "provider_rate_limited",
      providerStatusCode: 429,
      acceptance: "not_accepted",
    });
  });

  it.each(["sent", { ...providerReceipt("sent"), providerMessageId: null }])(
    "does not persist unsubstantiated success from an injected sender: %j",
    async (receipt) => {
      const store = new MemoryNotificationStore();
      const dependencies = deps(store);
      dependencies.sendEmail.mockResolvedValue(receipt as EmailDeliveryReceipt);
      expect((await deliverProjectPurgeMilestone(input(), dependencies)).emailStatus).toBe(
        "failed",
      );
      expect(store.records.get(1)?.metadata.email.lastDelivery).toMatchObject({
        acceptance: "unknown",
        failureKind: "provider_response_invalid",
        providerMessageId: null,
      });
    },
  );

  it("receipts a thrown sender error once without leaving an endlessly stale sending lease", async () => {
    const store = new MemoryNotificationStore();
    const dependencies = deps(store);
    dependencies.sendEmail.mockRejectedValue(new Error("secret-provider-body"));
    await deliverProjectPurgeMilestone(input(), dependencies);
    expect(store.records.get(1)?.metadata.email).toMatchObject({
      status: "failed",
      attempts: 1,
      leaseId: null,
      lastDelivery: { acceptance: "unknown", failureKind: "provider_transport_error" },
    });
    expect(JSON.stringify(store.records.get(1)?.metadata)).not.toContain("secret-provider-body");
  });

  it("keeps the six historical failed3/3 candidates held without resetting or resending", async () => {
    const store = new MemoryNotificationStore();
    for (const id of [160, 166, 172, 174, 176, 186]) {
      store.records.set(id, {
        id,
        recipientUserId: "user_owner",
        title: "Project moved to Trash",
        body: "Historical notice",
        metadata: {
          ...presentProjectPurgeMilestone(input()).metadata,
          email: {
            status: "failed",
            attempts: 3,
            maxAttempts: 3,
            leaseId: null,
            leaseExpiresAt: null,
          },
        },
      });
    }
    const before = JSON.stringify([...store.records.values()]);
    const dependencies = deps(store);
    expect(await retryProjectPurgeEmailDeliveries(dependencies)).toEqual({
      inspected: 0,
      sent: 0,
      stillUnsent: 0,
    });
    expect(JSON.stringify([...store.records.values()])).toBe(before);
    expect(dependencies.sendEmail).not.toHaveBeenCalled();
  });
});

const databaseMock = vi.hoisted(() => ({ execute: vi.fn(), update: vi.fn() }));
vi.mock("@workspace/db", () => ({
  notificationsTable: { id: "id" },
  db: {
    execute: databaseMock.execute,
    transaction: async (run: (tx: unknown) => Promise<unknown>) =>
      run({
        execute: databaseMock.execute,
        update: () => ({
          set: (change: unknown) => ({ where: async () => databaseMock.update(change) }),
        }),
      }),
  },
}));

describe("purge email database-clock retry fencing", () => {
  let databaseNow: number;
  let row: {
    id: number;
    recipient_id: string;
    title: string;
    body: string;
    metadata: ProjectPurgeNotificationMetadata;
  };
  beforeEach(() => {
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    databaseNow = Date.parse("2026-09-05T12:00:00.000Z");
    row = {
      id: 1,
      recipient_id: "user_owner",
      title: "Project moved to Trash",
      body: "Exact durable body",
      metadata: presentProjectPurgeMilestone(input()).metadata,
    };
    databaseMock.execute.mockReset().mockImplementation(async () => ({
      rows: [
        {
          ...row,
          database_now: new Date(databaseNow).toISOString(),
          lease_expires_at: new Date(databaseNow + 120_000).toISOString(),
        },
      ],
    }));
    databaseMock.update
      .mockReset()
      .mockImplementation((change: { metadata: ProjectPurgeNotificationMetadata }) => {
        row.metadata = change.metadata;
      });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function productionClaim() {
    const claim = await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3);
    if (!claim || "suppressed" in claim) throw new Error("Expected production claim");
    return claim;
  }

  it("enforces both 5m and 30m delays on locked direct claims using DB time despite host clock skew", async () => {
    const hostClock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2030-01-01T00:00:00Z"));
    try {
      for (const delay of PROJECT_PURGE_EMAIL_RETRY_DELAYS_MS) {
        const claim = await productionClaim();
        expect(claim).not.toBeNull();
        await databaseProjectPurgeNotificationStore.completeEmailAttempt(
          1,
          claim!.attempt,
          claim!.leaseId,
          "failed",
          providerReceipt("failed"),
        );
        expect(row.metadata.email.nextAttemptAt).toBe(new Date(databaseNow + delay).toISOString());
        databaseNow += delay - 1;
        expect(await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).toBeNull();
        databaseNow += 1;
      }
      const final = await productionClaim();
      expect(final?.attempt).toBe(3);
      await databaseProjectPurgeNotificationStore.completeEmailAttempt(
        1,
        final!.attempt,
        final!.leaseId,
        "failed",
        providerReceipt("failed"),
      );
      expect(row.metadata.email.nextAttemptAt).toBeNull();
      databaseNow += 7 * 86_400_000;
      expect(await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).toBeNull();
    } finally {
      hostClock.mockRestore();
    }
  });

  it("requires provider acceptance evidence for a new durable sent receipt", async () => {
    const claim = await productionClaim();
    await expect(
      databaseProjectPurgeNotificationStore.completeEmailAttempt(
        1,
        claim!.attempt,
        claim!.leaseId,
        "sent",
      ),
    ).rejects.toThrow("project_purge_email_delivery_receipt_invalid");
    await databaseProjectPurgeNotificationStore.completeEmailAttempt(
      1,
      claim!.attempt,
      claim!.leaseId,
      "sent",
      providerReceipt("sent"),
    );
    expect(row.metadata.email.lastDelivery?.providerMessageId).toBe("provider-message-1");
    expect(await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).toBeNull();
  });

  it("does not let an expired holder overwrite the current lease or its diagnostics", async () => {
    const old = await productionClaim();
    databaseNow += 120_001;
    const current = await productionClaim();
    await databaseProjectPurgeNotificationStore.completeEmailAttempt(
      1,
      old!.attempt,
      old!.leaseId,
      "failed",
      providerReceipt("failed"),
    );
    expect(row.metadata.email.leaseId).toBe(current!.leaseId);
    await databaseProjectPurgeNotificationStore.completeEmailAttempt(
      1,
      current!.attempt,
      current!.leaseId,
      "sent",
      providerReceipt("sent"),
    );
    expect(row.metadata.email.status).toBe("sent");
  });

  it("filters future deadlines in the bounded retry query as well as the locked claim", async () => {
    databaseMock.execute.mockResolvedValueOnce({ rows: [] });
    await databaseProjectPurgeNotificationStore.listRetryable(50);
    const query = new PgDialect().sqlToQuery(databaseMock.execute.mock.calls[0]![0]);
    expect(query.sql).toContain("nextAttemptAt");
    expect(query.sql).toContain("CURRENT_TIMESTAMP");
    expect(query.sql).toContain("leaseExpiresAt");
    expect(query.sql).toContain("suppressionReason");
    expect(query.sql).toContain("nonproduction_suppressed");
    expect(query.sql).toContain("LIMIT");
    expect(query.params).toContain(3);
    expect(query.params).toContain(50);
  });

  it.each(["not-a-time", "2026-09-05 12:05:00+00", 123])(
    "fails closed on a malformed deadline %j",
    async (deadline) => {
      row.metadata.email = {
        status: "failed",
        attempts: 1,
        maxAttempts: 3,
        leaseId: null,
        leaseExpiresAt: null,
        nextAttemptAt: deadline as string,
      };
      await expect(databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).rejects.toThrow(
        "project_purge_notification_metadata_invalid",
      );
      expect(databaseMock.update).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "0", "true", "production", " 1 "])(
    "keeps an in-app preview without contacting Clerk or email when deployment=%j",
    async (deployment) => {
      vi.stubEnv("REPLIT_DEPLOYMENT", deployment);
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CLERK_SECRET_KEY", "test-only-present");
      vi.stubEnv("RESEND_API_KEY", "test-only-present");
      const createOrGet = vi.fn(async () => ({
        id: row.id,
        recipientUserId: row.recipient_id,
        title: row.title,
        body: row.body,
        metadata: row.metadata,
      }));
      const dependencies = deps({ ...databaseProjectPurgeNotificationStore, createOrGet });
      expect(await deliverProjectPurgeMilestone(input(), dependencies)).toEqual({
        notificationId: 1,
        emailStatus: "skipped",
      });
      expect(createOrGet).toHaveBeenCalledWith(
        expect.objectContaining({
          recipientUserId: "user_owner",
          resourceId: "purge_abc:trash",
        }),
      );
      expect(row.metadata.email).toMatchObject({
        status: "skipped",
        attempts: 0,
        maxAttempts: 3,
        leaseId: null,
        leaseExpiresAt: null,
        suppressionReason: "nonproduction_suppressed",
        lastDelivery: null,
      });
      expect(dependencies.getUser).not.toHaveBeenCalled();
      expect(dependencies.sendEmail).not.toHaveBeenCalled();
    },
  );

  it("allows an actual Replit deployment through the production adapter", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const dependencies = deps(databaseProjectPurgeNotificationStore);
    expect(await retryProjectPurgeEmailDeliveries(dependencies)).toEqual({
      inspected: 1,
      sent: 1,
      stillUnsent: 0,
    });
    expect(dependencies.getUser).toHaveBeenCalledExactlyOnceWith("user_owner");
    expect(dependencies.sendEmail).toHaveBeenCalledTimes(1);
    expect(row.metadata.email).toMatchObject({
      status: "sent",
      attempts: 1,
      suppressionReason: null,
      lastDelivery: { acceptance: "accepted", providerMessageId: "provider-message-1" },
    });
  });

  it("does not release a development preview for automatic email on a later deployment", async () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", undefined);
    const dependencies = deps(databaseProjectPurgeNotificationStore);
    await retryProjectPurgeEmailDeliveries(dependencies);
    vi.stubEnv("REPLIT_DEPLOYMENT", "1");
    await retryProjectPurgeEmailDeliveries(dependencies);
    expect(row.metadata.email.attempts).toBe(0);
    expect(row.metadata.email.suppressionReason).toBe("nonproduction_suppressed");
    expect(databaseMock.update).toHaveBeenCalledTimes(1);
    expect(dependencies.getUser).not.toHaveBeenCalled();
    expect(dependencies.sendEmail).not.toHaveBeenCalled();
  });

  it("preserves an earlier uncertain provider outcome when suppressing future development sends", async () => {
    vi.stubEnv("REPLIT_DEPLOYMENT", undefined);
    row.metadata.email = {
      status: "failed",
      attempts: 1,
      maxAttempts: 3,
      leaseId: null,
      leaseExpiresAt: null,
      lastDelivery: providerReceipt("failed"),
    };
    expect(await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).toEqual({
      suppressed: true,
    });
    expect(row.metadata.email).toMatchObject({
      status: "failed",
      attempts: 1,
      suppressionReason: "nonproduction_suppressed",
      lastDelivery: { acceptance: "unknown", failureKind: "provider_failure_unclassified" },
    });
  });

  it.each(["sent", "failed"] as const)(
    "does not rewrite historical terminal %s receipts in development",
    async (status) => {
      vi.stubEnv("REPLIT_DEPLOYMENT", undefined);
      row.metadata.email = {
        status,
        attempts: 3,
        maxAttempts: 3,
        leaseId: null,
        leaseExpiresAt: null,
      };
      const before = JSON.stringify(row.metadata);
      expect(await databaseProjectPurgeNotificationStore.claimEmailAttempt(1, 3)).toBeNull();
      expect(JSON.stringify(row.metadata)).toBe(before);
      expect(databaseMock.update).not.toHaveBeenCalled();
    },
  );
});
