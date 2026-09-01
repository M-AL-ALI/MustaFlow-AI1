import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRetirementProgress } from "@workspace/db";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import { initialProjectRetirementProgress } from "./project-retirement-contract";

type MutationCall = { table: unknown; values: Record<string, unknown>; predicate?: unknown };

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "retirement-test";
  return {
    selectResults: [] as unknown[][],
    updateReturningResults: [] as unknown[][],
    updateCalls: [] as MutationCall[],
    select: vi.fn(),
    update: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    warn: vi.fn(),
    purgeCacheForHostnames: vi.fn(),
    reconcileLegacyFlyRuntime: vi.fn(),
  };
});

function selectQuery() {
  let consumed = false;
  const consume = () => {
    if (consumed) return [];
    consumed = true;
    return mocks.selectResults.shift() ?? [];
  };
  const query = {
    from: vi.fn(() => query),
    where: vi.fn(() => query),
    limit: vi.fn(async () => consume()),
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(consume()).then(onfulfilled, onrejected),
  };
  return query;
}

function updateQuery(table: unknown) {
  const call: MutationCall = { table, values: {} };
  const settled = Promise.resolve([] as unknown[]);
  const query = {
    set: vi.fn((values: Record<string, unknown>) => {
      call.values = values;
      mocks.updateCalls.push(call);
      return query;
    }),
    where: vi.fn((predicate: unknown) => {
      call.predicate = predicate;
      return query;
    }),
    returning: vi.fn(async () => mocks.updateReturningResults.shift() ?? []),
    then: settled.then.bind(settled),
  };
  return query;
}

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  const tx = {
    execute: mocks.execute,
    select: mocks.select,
    update: mocks.update,
  };
  mocks.select.mockImplementation(() => selectQuery());
  mocks.update.mockImplementation((table: unknown) => updateQuery(table));
  mocks.transaction.mockImplementation(async (work: (transaction: typeof tx) => unknown) =>
    work(tx),
  );
  return {
    ...actual,
    db: { ...tx, transaction: mocks.transaction },
  };
});

vi.mock("./cloudflare", () => ({
  discoverCloudflareSecurityResources: vi.fn(async () => ({ resources: [] })),
  inventoryCustomHostnamesByHostname: vi.fn(async () => ({ state: "complete", matches: [] })),
  inventoryHostnameKVRoutesByProject: vi.fn(),
  purgeCacheForHostnames: mocks.purgeCacheForHostnames,
  retireCloudflareSecurityResource: vi.fn(),
  retireCustomHostname: vi.fn(),
  retireHostnameKV: vi.fn(),
  retireLegacyR2ProjectPrefix: vi.fn(),
  retireObservedHostnameKV: vi.fn(),
}));

vi.mock("./cloudflare-runtime-provider", () => ({
  CloudflareRuntimeControlError: class CloudflareRuntimeControlError extends Error {
    code = "runtime_not_found";
  },
}));

vi.mock("./tenant-runtime", () => ({
  tenantRuntimeProvider: { destroy: vi.fn(), status: vi.fn() },
}));

vi.mock("./tenant-runtime-provider", () => ({
  supportsProductionArtifactPromotion: vi.fn(() => false),
  supportsProductionRouteInventory: vi.fn(() => false),
}));

vi.mock("./durable-queue", () => ({
  QUEUE_PROJECT_RETIREMENT: "project-retirement",
  durableEnqueueRawResult: vi.fn(),
  isDurableWorkerReady: vi.fn(() => true),
}));

vi.mock("./project-retirement-activation", () => ({
  resolveLegacyHostnameKvPosture: vi.fn(() => ({ state: "not_configured" })),
}));

vi.mock("./project-retirement-access", () => ({
  retireProjectAccessSurfaces: vi.fn(),
}));

vi.mock("./project-retirement-preflight", () => ({
  readProjectRetirementPreflight: vi.fn(),
}));

vi.mock("./project-retirement-legacy-fly", () => ({
  reconcileLegacyFlyRuntime: mocks.reconcileLegacyFlyRuntime,
}));

vi.mock("./logger", () => ({
  logger: { warn: mocks.warn },
}));

import { runProjectRetirementOperation } from "./project-retirement";

function completionProgress(): ProjectRetirementProgress {
  const progress = initialProjectRetirementProgress();
  progress.route = {
    state: "verified_absent",
    failureCode: null,
    legacyHostnameKv: { state: "not_configured", failureCode: null },
    hostnames: [],
    runtimeRoutes: [],
    cache: { state: "purged" },
  };
  progress.tasks.state = "canceled";
  progress.access.state = "revoked";
  progress.legacyR2.state = "not_configured";
  progress.runtimes = progress.runtimes.map((runtime) => ({
    ...runtime,
    state: "verified_absent",
  }));
  return progress;
}

function prepareOperation(
  progress: ProjectRetirementProgress,
  pointers: {
    containerId?: string | null;
    prodContainerId?: string | null;
    testContainerId?: string | null;
  } = {},
): void {
  const claimed = {
    id: "retirement-op-51",
    projectId: 51,
    requestedBy: "owner-51",
    state: "running",
    attemptCount: 1,
    leaseVersion: 1,
    progress,
  };
  mocks.selectResults.push(
    [{ projectId: 51 }],
    [{ deletedAt: new Date("2026-01-01T00:00:00.000Z") }],
    [],
    [],
    [{ hostname: null, cfHostnameId: null }],
    [{ customDomain: null, cfHostnameId: null }],
    [],
    [],
    [],
    [
      {
        containerId: pointers.containerId ?? null,
        prodContainerId: pointers.prodContainerId ?? null,
        testContainerId: pointers.testContainerId ?? null,
      },
    ],
  );
  mocks.updateReturningResults.push(
    [claimed],
    ...Array.from({ length: 12 }, () => [{ id: claimed.id }]),
  );
}

function prepareRouteOperation(progress: ProjectRetirementProgress): void {
  const claimed = {
    id: "retirement-op-51",
    projectId: 51,
    requestedBy: "owner-51",
    state: "running",
    attemptCount: 4,
    leaseVersion: 1,
    progress,
  };
  mocks.selectResults.push(
    [{ projectId: 51 }],
    [{ deletedAt: new Date("2026-01-01T00:00:00.000Z") }],
    [
      {
        publicSlug: "retirement-cache-test",
        customDomain: null,
        publishedSnapshotId: null,
        builderMode: "agentic",
      },
    ],
    [],
    [],
  );
  mocks.updateReturningResults.push(
    [claimed],
    [{ id: claimed.id }],
    [{ id: claimed.id }],
    [{ id: claimed.id }],
    [{ id: claimed.id }],
  );
}

describe("runProjectRetirementOperation terminal behavior", () => {
  beforeEach(() => {
    mocks.selectResults.length = 0;
    mocks.updateReturningResults.length = 0;
    mocks.updateCalls.length = 0;
    mocks.warn.mockClear();
    mocks.purgeCacheForHostnames.mockReset();
    mocks.reconcileLegacyFlyRuntime.mockReset();
  });

  it("completes only after the real coordinator validates complete evidence", async () => {
    const progress = completionProgress();
    prepareOperation(progress);

    await runProjectRetirementOperation("retirement-op-51");

    expect(
      mocks.updateCalls.some(
        (call) => call.values.state === "completed" && call.values.progress === progress,
      ),
    ).toBe(true);
    expect(mocks.updateCalls.some((call) => call.values.state === "failed")).toBe(false);
    expect(mocks.selectResults).toEqual([]);
  });

  it("terminalizes incomplete evidence with the typed non-retryable failure", async () => {
    const progress = completionProgress();
    progress.route.hostnames.push({
      hostname: "still-present.example",
      state: "present",
      stage: null,
    });
    prepareOperation(progress);

    await runProjectRetirementOperation("retirement-op-51");

    const failure = mocks.updateCalls.find(
      (call) =>
        call.values.state === "failed" &&
        call.values.failureCode === "project_retirement_completion_evidence_incomplete",
    );
    expect(failure).toBeDefined();
    expect(failure?.values.completedAt).toBeTruthy();
    expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "retirement-op-51",
        projectId: 51,
        code: "project_retirement_completion_evidence_incomplete",
        retryable: false,
      }),
      "Project retirement attempt failed",
    );
  });

  it("does not call a published route absent when its cache purge is unverified", async () => {
    const progress = completionProgress();
    progress.route = {
      state: "pending",
      failureCode: null,
      hostnames: [],
      runtimeRoutes: [],
      cache: { state: "pending" },
    };
    mocks.purgeCacheForHostnames.mockResolvedValue(false);
    prepareRouteOperation(progress);

    await runProjectRetirementOperation("retirement-op-51");

    expect(mocks.purgeCacheForHostnames).toHaveBeenCalledWith([
      "retirement-cache-test.mustaflow.app",
      "retirement-cache-test-staging.mustaflow.app",
    ]);
    expect(progress.route).toMatchObject({
      state: "failed",
      failureCode: "project_retirement_route_deactivation_unverified",
      cache: { state: "failed" },
    });
    expect(
      mocks.updateCalls.some(
        (call) =>
          call.values.state === "failed" &&
          call.values.failureCode === "project_retirement_route_deactivation_unverified",
      ),
    ).toBe(true);
    expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
  });

  it("clears a malformed container pointer after an exact initial Fly GET 404 proof", async () => {
    const progress = completionProgress();
    prepareOperation(progress, { containerId: "9080e521b67587" });
    mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
      state: "verified_absent",
      proof: "initial_get_404",
    });

    await runProjectRetirementOperation("retirement-op-51");

    expect(mocks.reconcileLegacyFlyRuntime).toHaveBeenCalledWith({
      machineId: "9080e521b67587",
      projectId: 51,
    });
    expect(progress.legacyRuntimeResolutions).toEqual([
      { pointer: "containerId", state: "verified_absent", proof: "initial_get_404" },
    ]);
    expect(progress.retainedLegacyRuntimePointers).toEqual([]);
    expect(
      mocks.updateCalls.some(
        (call) =>
          Object.prototype.hasOwnProperty.call(call.values, "containerId") &&
          call.values.containerId === null,
      ),
    ).toBe(true);
  });

  it("clears a malformed production pointer after an exact delete and second GET 404 proof", async () => {
    const progress = completionProgress();
    prepareOperation(progress, { prodContainerId: "9080e521b67587" });
    mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
      state: "verified_absent",
      proof: "delete_then_get_404",
    });

    await runProjectRetirementOperation("retirement-op-51");

    expect(progress.legacyRuntimeResolutions).toEqual([
      { pointer: "prodContainerId", state: "verified_absent", proof: "delete_then_get_404" },
    ]);
    expect(
      mocks.updateCalls.some(
        (call) =>
          Object.prototype.hasOwnProperty.call(call.values, "prodContainerId") &&
          call.values.prodContainerId === null,
      ),
    ).toBe(true);
  });

  it("retains an ambiguous legacy machine and never clears its pointer", async () => {
    const progress = completionProgress();
    prepareOperation(progress, { containerId: "9080e521b67587" });
    mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
      state: "retained",
      reason: "storage_ownership_ambiguous",
      retryable: false,
    });

    await runProjectRetirementOperation("retirement-op-51");

    expect(progress.retainedLegacyRuntimePointers).toHaveLength(1);
    expect(progress.legacyRuntimeResolutions).toEqual([
      {
        pointer: "containerId",
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      },
    ]);
    expect(
      mocks.updateCalls.some((call) =>
        Object.prototype.hasOwnProperty.call(call.values, "containerId"),
      ),
    ).toBe(false);
    expect(
      mocks.updateCalls.some(
        (call) =>
          call.values.state === "failed" &&
          call.values.failureCode === "project_retirement_legacy_runtime_retained",
      ),
    ).toBe(true);
  });

  it("never sends a cross-project current-runtime identity to Fly", async () => {
    const progress = completionProgress();
    const crossProjectIdentity = await deriveRuntimeIdentity({
      namespace: "retirement-test",
      projectId: 52,
      role: "preview",
      slot: "primary",
    });
    prepareOperation(progress, { containerId: crossProjectIdentity });

    await runProjectRetirementOperation("retirement-op-51");

    expect(mocks.reconcileLegacyFlyRuntime).not.toHaveBeenCalled();
    expect(progress.retainedLegacyRuntimePointers).toEqual([
      {
        pointer: "containerId",
        identity: crossProjectIdentity,
        reason: "runtime_project_mismatch",
      },
    ]);
    expect(
      mocks.updateCalls.some((call) =>
        Object.prototype.hasOwnProperty.call(call.values, "containerId"),
      ),
    ).toBe(false);
  });

  it("keeps testContainerId behind the SQLite preservation boundary without invoking Fly", async () => {
    const progress = completionProgress();
    prepareOperation(progress, { testContainerId: "legacy-test-machine" });

    await runProjectRetirementOperation("retirement-op-51");

    expect(mocks.reconcileLegacyFlyRuntime).not.toHaveBeenCalled();
    expect(progress.retainedLegacyRuntimePointers).toEqual([
      {
        pointer: "testContainerId",
        identity: "legacy-test-machine",
        reason: "legacy_runtime_provider",
      },
    ]);
    expect(
      mocks.updateCalls.some((call) =>
        Object.prototype.hasOwnProperty.call(call.values, "testContainerId"),
      ),
    ).toBe(false);
  });

  it.each([
    ["provider_observation_unavailable", "project_retirement_legacy_runtime_provider_unavailable"],
    ["absence_unverified", "project_retirement_legacy_runtime_absence_unverified"],
  ])(
    "persists retryable legacy result %s without terminal success or pointer clearing",
    async (reason, failureCode) => {
      const progress = completionProgress();
      prepareOperation(progress, { prodContainerId: "9080e521b67587" });
      mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
        state: "retained",
        reason,
        retryable: true,
      });

      await expect(runProjectRetirementOperation("retirement-op-51")).rejects.toThrow(failureCode);

      expect(progress.legacyRuntimeResolutions).toEqual([
        {
          pointer: "prodContainerId",
          state: "retained",
          reason,
          retryable: true,
        },
      ]);
      expect(
        mocks.updateCalls.some(
          (call) =>
            call.values.state === "failed" &&
            call.values.failureCode === failureCode &&
            call.values.completedAt === null,
        ),
      ).toBe(true);
      expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
      expect(
        mocks.updateCalls.some((call) =>
          Object.prototype.hasOwnProperty.call(call.values, "prodContainerId"),
        ),
      ).toBe(false);
    },
  );
});
