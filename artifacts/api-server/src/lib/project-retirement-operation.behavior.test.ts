import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRetirementProgress } from "@workspace/db";
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
  purgeCacheForHostnames: vi.fn(),
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

function prepareOperation(progress: ProjectRetirementProgress): void {
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
    [{ containerId: null, prodContainerId: null, testContainerId: null }],
  );
  mocks.updateReturningResults.push(
    [claimed],
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
});
