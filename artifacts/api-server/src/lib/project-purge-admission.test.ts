import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workerReady: true,
  selectResults: [] as unknown[][],
  updateResults: [] as unknown[][],
  insertResults: [] as unknown[][],
  updateCalls: [] as Record<string, unknown>[],
  enqueue: vi.fn(),
  deliverMilestone: vi.fn(),
  createNotification: vi.fn(),
  presentMilestone: vi.fn(),
  execute: vi.fn(),
  transaction: vi.fn(),
  dbSelect: vi.fn(),
  dbUpdate: vi.fn(),
  inventory: vi.fn(),
  releaseAssets: vi.fn(),
  releaseSnapshots: vi.fn(),
  relationalPurge: vi.fn(),
}));

function selectable(result: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => result,
  };
  return chain;
}

const tx = {
  execute: mocks.execute,
  select: vi.fn(() => selectable(mocks.selectResults.shift() ?? [])),
  update: vi.fn(() => ({
    set: (values: Record<string, unknown>) => {
      mocks.updateCalls.push(values);
      return { where: () => ({ returning: async () => mocks.updateResults.shift() ?? [] }) };
    },
  })),
  insert: vi.fn(() => ({
    values: () => ({
      returning: async () => mocks.insertResults.shift() ?? [],
      onConflictDoNothing: () => ({ returning: async () => mocks.insertResults.shift() ?? [] }),
    }),
  })),
};

vi.mock("drizzle-orm", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values });
  return {
    and: (...values: unknown[]) => values,
    desc: (value: unknown) => value,
    eq: (...values: unknown[]) => values,
    isNotNull: (value: unknown) => value,
    isNull: (value: unknown) => value,
    lt: (...values: unknown[]) => values,
    or: (...values: unknown[]) => values,
    sql,
  };
});

vi.mock("@workspace/db", () => {
  const columns = new Proxy({}, { get: (_target, property) => String(property) });
  return {
    db: {
      transaction: mocks.transaction,
      select: mocks.dbSelect,
      update: mocks.dbUpdate,
    },
    projectPurgeOperationsTable: columns,
    projectRetirementOperationsTable: columns,
    projectsTable: columns,
  };
});

vi.mock("./durable-queue", () => ({
  QUEUE_PROJECT_PURGE: "project-purge",
  isDurableWorkerReady: vi.fn(() => mocks.workerReady),
  durableEnqueueRawResult: mocks.enqueue,
}));
vi.mock("./project-retirement-contract", () => ({
  PROJECT_LIFECYCLE_LOCK_NAMESPACE: 913210,
  hasProjectRestoreReplayReceipt: vi.fn(() => false),
  hasCurrentProjectRetirementCompletionEvidence: vi.fn(
    (progress: unknown) => (progress as { current?: boolean } | null)?.current === true,
  ),
}));
vi.mock("./project-purge-resources", () => ({
  applyProjectRelationalPurge: mocks.relationalPurge,
  inventoryProjectPurgeResources: mocks.inventory,
  releaseProjectAssetStorage: mocks.releaseAssets,
  releaseProjectSnapshotStorage: mocks.releaseSnapshots,
}));
vi.mock("./production-database-lifecycle", () => ({
  releaseProductionDatabasesForHardDelete: vi.fn(),
}));
vi.mock("./tenant-runtime", () => ({ tenantRuntimeProvider: {} }));
vi.mock("./neon-project-lifecycle", () => ({
  releaseNeonProjectsForHardDelete: vi.fn(),
}));
vi.mock("./project-purge-notifications", () => ({
  databaseProjectPurgeNotificationStore: { createOrGet: mocks.createNotification },
  deliverProjectPurgeMilestone: mocks.deliverMilestone,
  presentProjectPurgeMilestone: mocks.presentMilestone,
}));

import {
  acceptManualProjectPurge,
  canOwnerReadmitProjectPurge,
  ensureInitialProjectPurgeNotification,
  hashProjectPurgeIdempotency,
  hashProjectPurgeRequester,
  parseDurableProjectPurgeResourceProgress,
  runProjectPurgeOperation,
  startProjectPurgeLeaseHeartbeat,
  validProjectPurgeIdempotencyKey,
} from "./project-purge";

const dueAt = new Date("2026-10-01T00:00:00.000Z");
const createdAt = new Date("2026-09-01T00:00:00.000Z");
const operation = {
  id: "purge-51",
  projectId: 51,
  retirementOperationIdHash: "a".repeat(64),
  trigger: "manual",
  state: "accepted",
  stage: "verify",
  idempotencyKeyHash: "b".repeat(64),
  requestedByHash: "c".repeat(64),
  attemptCount: 0,
  leaseVersion: 0,
  leaseExpiresAt: null,
  dueAt,
  nextAttemptAt: null,
  failureCode: null,
  failureRetryable: null,
  resourceProgress: {},
  terminalEvidence: null,
  createdAt,
  updatedAt: createdAt,
  startedAt: null,
  terminalAt: null,
};

const request = {
  projectId: 51,
  userId: "owner-user",
  projectName: "Project 51",
  idempotencyKey: "delete-project-51-once",
  recentlyReverified: true,
};

describe("owner-governed project purge admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workerReady = true;
    mocks.selectResults.length = 0;
    mocks.updateResults.length = 0;
    mocks.insertResults.length = 0;
    mocks.updateCalls.length = 0;
    mocks.enqueue.mockResolvedValue({
      status: "enqueued",
      code: "durable_queue_enqueued",
      jobId: "job-51",
    });
    mocks.deliverMilestone.mockResolvedValue({ notificationId: 1, emailStatus: "sent" });
    mocks.createNotification.mockResolvedValue({ id: 1 });
    mocks.presentMilestone.mockReturnValue({
      type: "project_purge_trash",
      title: "Project moved to Trash",
      body: "Project 51 will be permanently deleted in 30 days unless you restore it.",
      projectId: 51,
      metadata: {
        semantics: "project-purge-notification-v1",
        milestone: "trash",
        dueAt: dueAt.toISOString(),
        email: { status: "pending", attempts: 0, maxAttempts: 3 },
      },
    });
    mocks.transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) =>
      callback(tx),
    );
  });

  it("rejects missing reverification and malformed keys before any database read", async () => {
    await expect(
      acceptManualProjectPurge({ ...request, recentlyReverified: false }),
    ).resolves.toEqual({
      accepted: false,
      code: "project_purge_reverification_required",
    });
    await expect(
      acceptManualProjectPurge({ ...request, idempotencyKey: "short" }),
    ).resolves.toEqual({
      accepted: false,
      code: "project_purge_idempotency_key_invalid",
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("denies a collaborator or hostile project id without revealing the project", async () => {
    mocks.selectResults.push([], []);
    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_not_found",
    });
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("requires the exact current project name", async () => {
    mocks.selectResults.push([], [{ id: 51, ownerId: "owner-user", name: "Exact Project" }]);
    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_name_mismatch",
    });
  });

  it("returns the same durable operation for an idempotent replay even during worker weather", async () => {
    mocks.workerReady = false;
    const idempotentOperation = {
      ...operation,
      requestedByHash: hashProjectPurgeRequester(request.userId),
      idempotencyKeyHash: hashProjectPurgeIdempotency({
        userId: request.userId,
        projectId: request.projectId,
        key: request.idempotencyKey,
      }),
    };
    mocks.selectResults.push([idempotentOperation]);
    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: true,
      operation: idempotentOperation,
    });
    expect(tx.select).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("refuses new destructive work when the durable worker is unavailable", async () => {
    mocks.workerReady = false;
    mocks.selectResults.push([]);
    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_worker_unavailable",
    });
    expect(tx.select).toHaveBeenCalledTimes(1);
  });

  it("atomically promotes the scheduled operation and enqueues only after admission", async () => {
    const scheduled = { ...operation, trigger: "expiry", state: "scheduled" };
    const accepted = { ...operation, trigger: "manual", state: "accepted" };
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [scheduled],
    );
    mocks.updateResults.push([accepted]);

    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: true,
      operation: accepted,
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "project-purge",
      { operationId: "purge-51" },
      "purge-51",
      expect.any(Object),
    );
  });

  it("reports a concurrent compare-and-set loss instead of creating a second operation", async () => {
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [{ ...operation, trigger: "expiry", state: "scheduled" }],
    );
    mocks.updateResults.push([]);

    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_operation_conflict",
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("re-admits a retryable failed operation under a fresh owner key without changing its identity", async () => {
    const failed = {
      ...operation,
      trigger: "expiry",
      state: "failed",
      attemptCount: 2,
      failureCode: "project_purge_runtime_release_failed",
      failureRetryable: true,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "failed",
        stage: "runtime",
        failureCode: "project_purge_runtime_release_failed",
        retryable: true,
      },
      terminalAt: createdAt,
    };
    const readmitted = {
      ...failed,
      trigger: "manual",
      state: "accepted",
      stage: "verify",
      idempotencyKeyHash: hashProjectPurgeIdempotency({
        userId: request.userId,
        projectId: request.projectId,
        key: request.idempotencyKey,
      }),
      requestedByHash: hashProjectPurgeRequester(request.userId),
      failureCode: null,
      failureRetryable: null,
      terminalEvidence: null,
      terminalAt: null,
    };
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [failed],
    );
    mocks.updateResults.push([readmitted]);

    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: true,
      operation: readmitted,
    });
    expect(readmitted.id).toBe(failed.id);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        state: "accepted",
        stage: "verify",
        idempotencyKeyHash: readmitted.idempotencyKeyHash,
        requestedByHash: readmitted.requestedByHash,
        failureCode: null,
        terminalEvidence: null,
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "project-purge",
      { operationId: failed.id },
      failed.id,
      expect.any(Object),
    );
  });

  it("requires a fresh idempotency key before a failed operation can be re-admitted", async () => {
    const failedReplay = {
      ...operation,
      state: "failed",
      attemptCount: 1,
      failureCode: "project_purge_runtime_release_failed",
      failureRetryable: true,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "failed",
        stage: "runtime",
        failureCode: "project_purge_runtime_release_failed",
        retryable: true,
      },
      terminalAt: createdAt,
      requestedByHash: hashProjectPurgeRequester(request.userId),
      idempotencyKeyHash: hashProjectPurgeIdempotency({
        userId: request.userId,
        projectId: request.projectId,
        key: request.idempotencyKey,
      }),
    };
    mocks.selectResults.push([failedReplay]);

    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_retry_key_reused",
    });
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(tx.update).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a non-retryable failed operation without mutating or enqueueing", async () => {
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [{ ...operation, state: "failed", failureRetryable: false, attemptCount: 1 }],
    );
    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_retry_unavailable",
    });
    expect(tx.update).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("re-admits an exhausted retryable operation with a fresh bounded cycle and audit chain", async () => {
    const failed = {
      ...operation,
      state: "failed",
      stage: "inventory",
      failureCode: "project_purge_attempts_exhausted",
      failureRetryable: true,
      attemptCount: 5,
      terminalEvidence: {
        schema: "project-purge-terminal-v1",
        outcome: "failed",
        stage: "inventory",
        failureCode: "project_purge_attempts_exhausted",
        retryable: true,
      },
      terminalAt: createdAt,
      resourceProgress: {},
    };
    const readmitted = {
      ...failed,
      trigger: "manual",
      state: "accepted",
      stage: "verify",
      attemptCount: 0,
      failureCode: null,
      failureRetryable: null,
      terminalEvidence: null,
      terminalAt: null,
      startedAt: null,
    };
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [failed],
    );
    mocks.updateResults.push([readmitted]);
    await expect(
      acceptManualProjectPurge({ ...request, idempotencyKey: "another-delete-key-51" }),
    ).resolves.toEqual({
      accepted: true,
      operation: readmitted,
    });
    expect(canOwnerReadmitProjectPurge(failed)).toBe(true);
    expect(mocks.updateCalls).toContainEqual(
      expect.objectContaining({
        state: "accepted",
        stage: "verify",
        attemptCount: 0,
        startedAt: null,
        resourceProgress: {
          readmissionAudit: expect.objectContaining({
            schema: "project-purge-readmission-audit-v1",
            cycleCount: 1,
            chainDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            latest: expect.objectContaining({
              attemptCount: 5,
              stage: "inventory",
              failureCode: "project_purge_attempts_exhausted",
              terminalAt: createdAt.toISOString(),
              terminalEvidenceDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
            }),
          }),
        },
      }),
    );
    expect(mocks.enqueue).toHaveBeenCalledWith(
      "project-purge",
      { operationId: failed.id },
      failed.id,
      expect.any(Object),
    );
  });

  it("reports a retry compare-and-set race instead of admitting duplicate work", async () => {
    mocks.selectResults.push(
      [],
      [{ id: 51, ownerId: "owner-user", name: "Project 51" }],
      [
        {
          id: "retirement-51",
          state: "completed",
          completedAt: createdAt,
          progress: { current: true },
        },
      ],
      [
        {
          ...operation,
          state: "failed",
          attemptCount: 2,
          failureRetryable: true,
        },
      ],
    );
    mocks.updateResults.push([]);

    await expect(acceptManualProjectPurge(request)).resolves.toEqual({
      accepted: false,
      code: "project_purge_operation_conflict",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("stores only one-way requester and idempotency digests", () => {
    expect(validProjectPurgeIdempotencyKey(request.idempotencyKey)).toBe(true);
    const requester = hashProjectPurgeRequester(request.userId);
    const idempotency = hashProjectPurgeIdempotency({
      userId: request.userId,
      projectId: request.projectId,
      key: request.idempotencyKey,
    });
    expect(requester).toMatch(/^[0-9a-f]{64}$/u);
    expect(idempotency).toMatch(/^[0-9a-f]{64}$/u);
    expect(`${requester}${idempotency}`).not.toContain(request.userId);
    expect(`${requester}${idempotency}`).not.toContain(request.idempotencyKey);
  });

  it("accepts only digest-bound, privacy-minimal resource checkpoints", () => {
    const digest = "d".repeat(64);
    const initial = parseDurableProjectPurgeResourceProgress({}, digest);
    expect(initial).toEqual({
      schema: "project-purge-resource-progress-v1",
      inventoryDigestSha256: digest,
      assetCursor: { assetIndex: 0, legacyImageIndex: 0, uploadIndex: 0 },
      snapshotCursor: { snapshotIndex: 0 },
      providerRemoved: 0,
      providerDetached: 0,
      databaseComplete: false,
    });
    expect(() =>
      parseDurableProjectPurgeResourceProgress(
        { ...initial, inventoryDigestSha256: "e".repeat(64) },
        digest,
      ),
    ).toThrow("project_purge_resource_progress_invalid");
    expect(JSON.stringify(initial)).not.toContain("storageKey");
    expect(JSON.stringify(initial)).not.toContain("projectName");
  });

  it("proves a durable trash recipient after a Clerk or email channel failure", async () => {
    mocks.deliverMilestone.mockRejectedValueOnce(new Error("channel unavailable"));
    await expect(
      ensureInitialProjectPurgeNotification(operation as never, {
        projectId: 51,
        ownerId: "owner-user",
        projectName: "Project 51",
        deletedAt: createdAt,
        retirementOperationId: "retirement-51",
        retirementProgress: {},
        neonProjectIds: [],
        productionNeonProjectName: "mf-project-51",
        previewNeonProjectName: "mf-preview-51",
        assetTargets: [],
        legacyGeneratedImageTargets: [],
        uploadTargets: [],
        snapshotObjectKeys: [],
        tableCounts: [],
        activeAddonCount: 0,
        digestSha256: "a".repeat(64),
      }),
    ).resolves.toBeUndefined();
    expect(mocks.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: "owner-user",
        resourceId: "purge-51:trash",
        projectId: 51,
      }),
    );
  });

  it("refuses destructive work when neither delivery nor the durable fallback can write", async () => {
    mocks.deliverMilestone.mockRejectedValueOnce(new Error("channel unavailable"));
    mocks.createNotification.mockRejectedValueOnce(new Error("receipt unavailable"));
    await expect(
      ensureInitialProjectPurgeNotification(operation as never, {
        projectId: 51,
        ownerId: "owner-user",
        projectName: "Project 51",
        deletedAt: createdAt,
        retirementOperationId: "retirement-51",
        retirementProgress: {},
        neonProjectIds: [],
        productionNeonProjectName: "mf-project-51",
        previewNeonProjectName: "mf-preview-51",
        assetTargets: [],
        legacyGeneratedImageTargets: [],
        uploadTargets: [],
        snapshotObjectKeys: [],
        tableCounts: [],
        activeAddonCount: 0,
        digestSha256: "a".repeat(64),
      }),
    ).rejects.toThrow("receipt unavailable");
  });

  it("heartbeats every bounded resource checkpoint and durably yields without spending a retry", async () => {
    const claimed = {
      ...operation,
      state: "running",
      attemptCount: 1,
      leaseVersion: 3,
      resourceProgress: {},
    };
    mocks.dbSelect.mockReturnValueOnce(selectable([{ projectId: 51 }]));
    mocks.selectResults.push([{ ownerId: "owner-user" }]);
    mocks.transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) => {
      mocks.updateResults.push([claimed]);
      return callback(tx);
    });
    mocks.dbUpdate.mockImplementation(() => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateCalls.push(values);
        return { where: () => ({ returning: async () => [{ id: operation.id }] }) };
      },
    }));
    mocks.inventory.mockResolvedValue({
      projectId: 51,
      ownerId: "owner-user",
      projectName: "Project 51",
      deletedAt: createdAt,
      retirementOperationId: "retirement-51",
      retirementProgress: { current: true },
      neonProjectIds: [],
      productionNeonProjectName: "mf-project-51",
      previewNeonProjectName: "mf-preview-51",
      assetTargets: [],
      legacyGeneratedImageTargets: [],
      uploadTargets: [],
      snapshotObjectKeys: [],
      tableCounts: [],
      activeAddonCount: 0,
      digestSha256: "a".repeat(64),
    });
    mocks.deliverMilestone.mockResolvedValue(undefined);
    for (let index = 1; index <= 8; index += 1) {
      mocks.releaseAssets.mockResolvedValueOnce({
        deletedObjects: 1,
        detachedObjects: 0,
        cursor: { assetIndex: index * 25, legacyImageIndex: 0, uploadIndex: 0 },
        complete: false,
      });
    }

    await expect(runProjectPurgeOperation(operation.id)).resolves.toBeUndefined();
    expect(mocks.releaseAssets).toHaveBeenCalledTimes(8);
    expect(mocks.releaseSnapshots).not.toHaveBeenCalled();
    expect(mocks.relationalPurge).not.toHaveBeenCalled();
    const checkpoints = mocks.updateCalls.filter(
      (values) =>
        (values.resourceProgress as { schema?: string } | undefined)?.schema ===
        "project-purge-resource-progress-v1",
    );
    expect(checkpoints).toHaveLength(9);
    expect(checkpoints.at(-1)).toMatchObject({
      state: "accepted",
      leaseExpiresAt: null,
      resourceProgress: {
        providerRemoved: 8,
        assetCursor: { assetIndex: 200 },
      },
    });
    expect(checkpoints.slice(0, -1).every((entry) => entry.leaseExpiresAt !== null)).toBe(true);
  });

  it("aborts the lease signal when a fenced heartbeat no longer owns the operation", async () => {
    vi.useFakeTimers();
    try {
      mocks.dbUpdate.mockImplementationOnce(() => ({
        set: () => ({ where: () => ({ returning: async () => [] }) }),
      }));
      const heartbeat = startProjectPurgeLeaseHeartbeat(
        { id: operation.id, leaseVersion: 3 },
        { intervalMs: 10, timeoutMs: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(heartbeat.lost).toBe(true);
      expect(heartbeat.signal.aborted).toBe(true);
      expect(() => heartbeat.assertActive("assets")).toThrow("project_purge_operation_conflict");
      heartbeat.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews the same fenced lease periodically and stops scheduling on command", async () => {
    vi.useFakeTimers();
    try {
      mocks.dbUpdate.mockImplementation(() => ({
        set: () => ({
          where: () => ({ returning: async () => [{ id: operation.id }] }),
        }),
      }));
      const heartbeat = startProjectPurgeLeaseHeartbeat(
        { id: operation.id, leaseVersion: 3 },
        { intervalMs: 10, timeoutMs: 5 },
      );
      await vi.advanceTimersByTimeAsync(30);
      expect(mocks.dbUpdate.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(heartbeat.lost).toBe(false);
      const renewalCount = mocks.dbUpdate.mock.calls.length;
      heartbeat.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.dbUpdate).toHaveBeenCalledTimes(renewalCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a stuck renewal and never schedules another heartbeat after stop", async () => {
    vi.useFakeTimers();
    try {
      mocks.dbUpdate.mockImplementationOnce(() => ({
        set: () => ({
          where: () => ({ returning: () => new Promise<never>(() => undefined) }),
        }),
      }));
      const heartbeat = startProjectPurgeLeaseHeartbeat(
        { id: operation.id, leaseVersion: 3 },
        { intervalMs: 10, timeoutMs: 5 },
      );
      await vi.advanceTimersByTimeAsync(15);
      expect(heartbeat.lost).toBe(true);
      expect(heartbeat.signal.aborted).toBe(true);
      heartbeat.stop();
      await vi.advanceTimersByTimeAsync(100);
      expect(mocks.dbUpdate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an in-flight provider batch and performs no checkpoint or relational work after lease loss", async () => {
    vi.useFakeTimers();
    try {
      const claimed = {
        ...operation,
        state: "running",
        attemptCount: 1,
        leaseVersion: 3,
        resourceProgress: {},
      };
      mocks.dbSelect.mockReturnValueOnce(selectable([{ projectId: 51 }]));
      mocks.selectResults.push([{ ownerId: "owner-user" }]);
      mocks.transaction.mockImplementationOnce(async (callback: (value: typeof tx) => unknown) => {
        mocks.updateResults.push([claimed]);
        return callback(tx);
      });
      mocks.dbUpdate.mockImplementation(() => ({
        set: (values: Record<string, unknown>) => {
          mocks.updateCalls.push(values);
          const heartbeatOnly =
            "leaseExpiresAt" in values && !("stage" in values) && !("resourceProgress" in values);
          return {
            where: () => ({ returning: async () => (heartbeatOnly ? [] : [{ id: operation.id }]) }),
          };
        },
      }));
      mocks.inventory.mockResolvedValue({
        projectId: 51,
        ownerId: "owner-user",
        projectName: "Project 51",
        deletedAt: createdAt,
        retirementOperationId: "retirement-51",
        retirementProgress: { current: true },
        neonProjectIds: [],
        productionNeonProjectName: "mf-project-51",
        previewNeonProjectName: "mf-preview-51",
        assetTargets: [],
        legacyGeneratedImageTargets: [],
        uploadTargets: [],
        snapshotObjectKeys: [],
        tableCounts: [],
        activeAddonCount: 0,
        digestSha256: "a".repeat(64),
      });
      mocks.deliverMilestone.mockResolvedValue(undefined);
      mocks.releaseAssets.mockImplementationOnce(
        (_inventory: unknown, _cursor: unknown, _limit: unknown, signal: AbortSignal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );

      const running = runProjectPurgeOperation(operation.id);
      const rejected = expect(running).rejects.toThrow("project_purge_operation_conflict");
      for (let turn = 0; turn < 20 && mocks.releaseAssets.mock.calls.length === 0; turn += 1) {
        await Promise.resolve();
      }
      expect(mocks.releaseAssets).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(60_000);
      await rejected;
      expect(mocks.releaseSnapshots).not.toHaveBeenCalled();
      expect(mocks.relationalPurge).not.toHaveBeenCalled();
      expect(mocks.updateCalls.some((values) => "resourceProgress" in values)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
