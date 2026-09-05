import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  projectsTable,
  projectRetirementOperationsTable,
  type ProjectRetirementProgress,
} from "@workspace/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import { initialProjectRetirementProgress } from "./project-retirement-contract";

type MutationCall = { table: unknown; values: Record<string, unknown>; predicate?: unknown };
type SelectCall = {
  table?: unknown;
  predicate?: unknown;
  joins: Array<{ table: unknown; predicate: unknown }>;
};

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "retirement-test";
  return {
    selectResults: [] as unknown[][],
    selectCalls: [] as SelectCall[],
    authorityResults: [] as unknown[][],
    pointerUpdateResults: [] as unknown[][],
    currentPointers: null as {
      containerId: string | null;
      prodContainerId: string | null;
      testContainerId: string | null;
    } | null,
    updateReturningResults: [] as unknown[][],
    updateCalls: [] as MutationCall[],
    insertCalls: [] as MutationCall[],
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
    warn: vi.fn(),
    purgeCacheForHostnames: vi.fn(),
    reconcileLegacyFlyRuntime: vi.fn(),
    preserveProjectSqliteForRetirement: vi.fn(),
    retireProjectManagedAddonBindings: vi.fn(),
  };
});

function selectQuery() {
  const call: SelectCall = { joins: [] };
  mocks.selectCalls.push(call);
  let consumed = false;
  const consume = () => {
    if (consumed) return [];
    consumed = true;
    if (call.joins.length > 0) return mocks.authorityResults.shift() ?? [];
    return mocks.selectResults.shift() ?? [];
  };
  const query = {
    from: vi.fn((table: unknown) => {
      call.table = table;
      return query;
    }),
    innerJoin: vi.fn((table: unknown, predicate: unknown) => {
      call.joins.push({ table, predicate });
      return query;
    }),
    where: vi.fn((predicate: unknown) => {
      call.predicate = predicate;
      return query;
    }),
    orderBy: vi.fn(() => query),
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
    returning: vi.fn(async () => {
      if (
        Object.prototype.hasOwnProperty.call(call.values, "activePreviewSessionId") &&
        mocks.pointerUpdateResults.length > 0
      ) {
        return mocks.pointerUpdateResults.shift()!;
      }
      if (
        Object.prototype.hasOwnProperty.call(call.values, "activePreviewSessionId") &&
        mocks.currentPointers !== null
      ) {
        const observed = new PgDialect().sqlToQuery(call.predicate as SQL).params.slice(1);
        const current = [
          mocks.currentPointers.containerId,
          mocks.currentPointers.prodContainerId,
          mocks.currentPointers.testContainerId,
        ];
        if (
          observed.length !== current.length ||
          observed.some((value, index) => value !== current[index])
        )
          return [];
      }
      return mocks.updateReturningResults.shift() ?? [];
    }),
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
    insert: mocks.insert,
  };
  mocks.select.mockImplementation(() => selectQuery());
  mocks.update.mockImplementation((table: unknown) => updateQuery(table));
  mocks.insert.mockImplementation((table: unknown) => ({
    values: vi.fn(async (values: Record<string, unknown>) => {
      mocks.insertCalls.push({ table, values });
    }),
  }));
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
  resolveCurrentCloudflareRetirementPosture: vi.fn(() => ({ state: "configured" })),
}));

vi.mock("./project-retirement-access", () => ({
  retireProjectAccessSurfaces: vi.fn(
    async (_tx: unknown, input: { progress: ProjectRetirementProgress }) => input.progress,
  ),
}));

vi.mock("./project-retirement-preflight", () => ({
  readProjectRetirementPreflight: vi.fn(),
}));

vi.mock("./project-retirement-legacy-fly", () => ({
  reconcileLegacyFlyRuntime: mocks.reconcileLegacyFlyRuntime,
}));

vi.mock("./project-retirement-owned-resources", () => ({
  preserveProjectSqliteForRetirement: mocks.preserveProjectSqliteForRetirement,
  retireProjectManagedAddonBindings: mocks.retireProjectManagedAddonBindings,
}));

vi.mock("./logger", () => ({
  logger: { warn: mocks.warn },
}));

import {
  decideProjectRetirementReconciliation,
  requestProjectRetirementReconciliation,
  runProjectRetirementOperation,
} from "./project-retirement";

describe("bounded legacy zero-volume configuration recovery", () => {
  beforeEach(() => {
    mocks.selectResults.length = 0;
    mocks.selectCalls.length = 0;
    mocks.authorityResults.length = 0;
    mocks.pointerUpdateResults.length = 0;
    mocks.currentPointers = null;
    mocks.insertCalls.length = 0;
    mocks.updateCalls.length = 0;
    mocks.execute.mockClear();
  });

  const decisionInput = {
    state: "failed",
    completedAt: new Date("2026-09-03T00:00:00.000Z"),
    failureCode: "project_retirement_legacy_runtime_retained",
    generation: 2,
    allowLegacyAdminReconciliation: true,
    allowConfigurationRecovery: true,
    currentCloudflareCachePurgeConfigured: true,
    configurationRecoveryUsed: false,
  };

  it("admits exactly the unused owner-governed generation-two recovery", () => {
    expect(decideProjectRetirementReconciliation(decisionInput)).toEqual({
      allowed: true,
      reason: "configuration_recovery",
    });
  });

  it.each([
    { configurationRecoveryUsed: true },
    { generation: 3 },
    { allowLegacyAdminReconciliation: false },
    { allowConfigurationRecovery: false },
    { currentCloudflareCachePurgeConfigured: false },
    { completedAt: null },
    { state: "running" },
  ])("does not bypass the bounded recovery gate: %j", (override) => {
    expect(decideProjectRetirementReconciliation({ ...decisionInput, ...override }).allowed).toBe(
      false,
    );
  });

  it("inserts one new generation without changing the terminal parent and refuses reuse", async () => {
    const progress = initialProjectRetirementProgress();
    progress.reconciliation = {
      generation: 2,
      parentOperationId: "legacy-parent-77",
      requestedBy: "platform-owner",
      reason: "legacy_admin_reconciliation",
      configurationRecoveryUsed: false,
    };
    const parent = {
      id: "legacy-generation-two-77",
      projectId: 77,
      state: "failed",
      completedAt: decisionInput.completedAt,
      failureCode: decisionInput.failureCode,
      progress,
    };
    const before = JSON.stringify(parent);
    mocks.selectResults.push([{ id: 77 }], [parent]);
    const input = {
      projectId: 77,
      requestedBy: "platform-owner",
      allowLegacyAdminReconciliation: true,
      allowConfigurationRecovery: true,
    };

    const result = await requestProjectRetirementReconciliation(input);
    expect(result).toMatchObject({ projectId: 77, state: "accepted" });
    expect(mocks.insertCalls).toHaveLength(1);
    const child = mocks.insertCalls[0]!.values;
    const childProgress = child.progress as ProjectRetirementProgress;
    expect(childProgress.reconciliation).toEqual({
      generation: 3,
      parentOperationId: parent.id,
      requestedBy: input.requestedBy,
      reason: "configuration_recovery",
      configurationRecoveryUsed: true,
    });
    expect(childProgress.runtimes.every((runtime) => runtime.state === "pending")).toBe(true);
    expect(childProgress.legacyRuntimeResolutions).toEqual([]);
    expect(child.id).not.toBe(parent.id);
    expect(JSON.stringify(parent)).toBe(before);
    expect(mocks.updateCalls).toEqual([]);

    mocks.selectResults.push(
      [{ id: 77 }],
      [
        {
          ...child,
          state: "failed",
          completedAt: decisionInput.completedAt,
          failureCode: decisionInput.failureCode,
        },
      ],
    );
    expect(await requestProjectRetirementReconciliation(input)).toEqual({
      code: "project_retirement_reconciliation_limit_reached",
    });
    expect(mocks.insertCalls).toHaveLength(1);
    expect(mocks.updateCalls).toEqual([]);
  });

  it("admits the one-time destroyed-tombstone verifier after the aggregate retained failure", () => {
    const progress = initialProjectRetirementProgress();
    progress.reconciliation = {
      generation: 3,
      parentOperationId: "legacy-generation-two-77",
      requestedBy: "platform-owner",
      reason: "configuration_recovery",
      configurationRecoveryUsed: true,
    };
    progress.legacyRuntimeResolutions = [
      {
        pointer: "containerId",
        state: "retained",
        reason: "absence_unverified",
        retryable: true,
      },
    ];
    progress.retainedLegacyRuntimePointers = [
      {
        pointer: "containerId",
        identity: "18551d6b7229e8",
        reason: "runtime_identity_malformed",
      },
    ];

    expect(
      decideProjectRetirementReconciliation({
        ...decisionInput,
        generation: 3,
        failureCode: "project_retirement_legacy_runtime_retained",
        configurationRecoveryUsed: true,
        progress,
      }),
    ).toEqual({ allowed: true, reason: "retryable_terminal" });
  });

  it("does not create recovery for a project outside the supplied owner scope", async () => {
    mocks.selectResults.push([]);
    expect(
      await requestProjectRetirementReconciliation({
        projectId: 77,
        requestedBy: "other-owner",
        ownerId: "other-owner",
        allowLegacyAdminReconciliation: true,
        allowConfigurationRecovery: true,
      }),
    ).toEqual({ code: "project_retirement_not_found" });
    expect(mocks.insertCalls).toEqual([]);
  });

  it("converts the exact null-progress migration sentinel into a bounded child operation", async () => {
    mocks.selectResults.push(
      [{ id: 77 }],
      [
        {
          id: "project-retirement:legacy:v1:77",
          projectId: 77,
          state: "failed",
          completedAt: decisionInput.completedAt,
          failureCode: "project_retirement_operation_unavailable",
          progress: {},
        },
      ],
    );

    const result = await requestProjectRetirementReconciliation({
      projectId: 77,
      requestedBy: "platform-owner",
      allowLegacyAdminReconciliation: true,
      allowConfigurationRecovery: true,
    });

    expect(result).toMatchObject({ projectId: 77, state: "accepted" });
    expect(mocks.insertCalls).toHaveLength(1);
    expect(
      (mocks.insertCalls[0]!.values.progress as ProjectRetirementProgress).reconciliation,
    ).toEqual({
      generation: 1,
      parentOperationId: "project-retirement:legacy:v1:77",
      requestedBy: "platform-owner",
      reason: "retryable_terminal",
      configurationRecoveryUsed: false,
    });
  });
});

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
  mocks.currentPointers = {
    containerId: pointers.containerId ?? null,
    prodContainerId: pointers.prodContainerId ?? null,
    testContainerId: pointers.testContainerId ?? null,
  };
  const claimed = {
    id: "retirement-op-77",
    projectId: 77,
    requestedBy: "owner-77",
    state: "running",
    attemptCount: 1,
    leaseVersion: 1,
    progress,
  };
  mocks.selectResults.push(
    [{ projectId: 77 }],
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
    id: "retirement-op-77",
    projectId: 77,
    requestedBy: "owner-77",
    state: "running",
    attemptCount: 4,
    leaseVersion: 1,
    progress,
  };
  mocks.selectResults.push(
    [{ projectId: 77 }],
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
    mocks.selectCalls.length = 0;
    mocks.authorityResults.length = 0;
    mocks.pointerUpdateResults.length = 0;
    mocks.currentPointers = null;
    mocks.updateReturningResults.length = 0;
    mocks.updateCalls.length = 0;
    mocks.warn.mockClear();
    mocks.purgeCacheForHostnames.mockReset();
    mocks.reconcileLegacyFlyRuntime.mockReset();
    mocks.preserveProjectSqliteForRetirement.mockReset();
    mocks.preserveProjectSqliteForRetirement.mockResolvedValue({
      ok: true,
      receipt: {
        state: "not_applicable",
        snapshotId: null,
        sizeBytes: 0,
        storage: null,
        failureCode: null,
      },
    });
    mocks.retireProjectManagedAddonBindings.mockReset();
    mocks.retireProjectManagedAddonBindings.mockResolvedValue({
      ok: true,
      receipt: {
        state: "verified_detached",
        discoveredCount: 0,
        detachedCount: 0,
        secretsRemoved: 0,
        bindingsRemaining: 0,
        failureCode: null,
      },
    });
  });

  it("completes only after the real coordinator validates complete evidence", async () => {
    const progress = completionProgress();
    prepareOperation(progress);

    await runProjectRetirementOperation("retirement-op-77");

    expect(
      mocks.updateCalls.some(
        (call) => call.values.state === "completed" && call.values.progress === progress,
      ),
    ).toBe(true);
    expect(mocks.updateCalls.some((call) => call.values.state === "failed")).toBe(false);
    expect(mocks.selectResults).toEqual([]);
    expect(mocks.preserveProjectSqliteForRetirement).toHaveBeenCalledWith({
      projectId: 77,
      operationId: "retirement-op-77",
    });
    expect(mocks.retireProjectManagedAddonBindings).toHaveBeenCalledWith(77);
  });

  it("fails retryably before runtime release when SQLite recovery cannot be earned", async () => {
    const progress = completionProgress();
    progress.sqliteRecovery = initialProjectRetirementProgress().sqliteRecovery;
    prepareOperation(progress);
    mocks.preserveProjectSqliteForRetirement.mockResolvedValue({
      ok: false,
      code: "project_retirement_sqlite_snapshot_failed",
      retryable: true,
    });

    await expect(runProjectRetirementOperation("retirement-op-77")).rejects.toThrow(
      "project_retirement_sqlite_snapshot_failed",
    );

    expect(progress.sqliteRecovery).toMatchObject({
      state: "failed",
      failureCode: "project_retirement_sqlite_snapshot_failed",
    });
    expect(mocks.retireProjectManagedAddonBindings).not.toHaveBeenCalled();
    expect(
      mocks.updateCalls.some(
        (call) =>
          call.values.state === "failed" &&
          call.values.failureCode === "project_retirement_sqlite_snapshot_failed" &&
          call.values.completedAt === null,
      ),
    ).toBe(true);
  });

  it("fails closed when managed add-on absence cannot be proven", async () => {
    const progress = completionProgress();
    progress.managedAddons = initialProjectRetirementProgress().managedAddons;
    prepareOperation(progress);
    mocks.retireProjectManagedAddonBindings.mockResolvedValue({
      ok: false,
      code: "project_retirement_managed_addon_release_unverified",
      retryable: false,
    });

    await runProjectRetirementOperation("retirement-op-77");

    expect(progress.managedAddons).toMatchObject({
      state: "failed",
      failureCode: "project_retirement_managed_addon_release_unverified",
    });
    expect(
      mocks.updateCalls.some(
        (call) =>
          call.values.state === "failed" &&
          call.values.failureCode === "project_retirement_managed_addon_release_unverified" &&
          call.values.completedAt !== null,
      ),
    ).toBe(true);
  });

  it("terminalizes incomplete evidence with the typed non-retryable failure", async () => {
    const progress = completionProgress();
    progress.route.hostnames.push({
      hostname: "still-present.example",
      state: "present",
      stage: null,
    });
    prepareOperation(progress);

    await runProjectRetirementOperation("retirement-op-77");

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
        operationId: "retirement-op-77",
        projectId: 77,
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

    await runProjectRetirementOperation("retirement-op-77");

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

    await runProjectRetirementOperation("retirement-op-77");

    expect(mocks.reconcileLegacyFlyRuntime).toHaveBeenCalledWith({
      machineId: "9080e521b67587",
      projectId: 77,
      assertAuthority: expect.any(Function),
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

    await runProjectRetirementOperation("retirement-op-77");

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

  it.each(["containerId", "testContainerId"] as const)(
    "retains an ambiguous legacy %s machine and never clears its pointer",
    async (pointer) => {
      const progress = completionProgress();
      prepareOperation(progress, { [pointer]: "9080e521b67587" });
      mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
        state: "retained",
        reason: "storage_ownership_ambiguous",
        retryable: false,
      });

      await runProjectRetirementOperation("retirement-op-77");

      expect(progress.retainedLegacyRuntimePointers).toHaveLength(1);
      expect(progress.legacyRuntimeResolutions).toEqual([
        {
          pointer,
          state: "retained",
          reason: "storage_ownership_ambiguous",
          retryable: false,
        },
      ]);
      expect(
        mocks.updateCalls.some((call) =>
          Object.prototype.hasOwnProperty.call(call.values, pointer),
        ),
      ).toBe(false);
      expect(
        mocks.updateCalls.some(
          (call) =>
            call.values.state === "failed" &&
            call.values.failureCode === "project_retirement_legacy_runtime_retained",
        ),
      ).toBe(true);
    },
  );

  it("never sends a cross-project current-runtime identity to Fly", async () => {
    const progress = completionProgress();
    const crossProjectIdentity = await deriveRuntimeIdentity({
      namespace: "retirement-test",
      projectId: 52,
      role: "preview",
      slot: "primary",
    });
    prepareOperation(progress, { containerId: crossProjectIdentity });

    await runProjectRetirementOperation("retirement-op-77");

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

  it.each(["initial_get_404", "delete_then_get_404"] as const)(
    "reconciles testContainerId after SQLite preservation and clears it with %s proof",
    async (proof) => {
      const progress = completionProgress();
      prepareOperation(progress, { testContainerId: "legacy-test-machine" });
      mocks.reconcileLegacyFlyRuntime.mockResolvedValue({ state: "verified_absent", proof });

      await runProjectRetirementOperation("retirement-op-77");

      expect(mocks.reconcileLegacyFlyRuntime).toHaveBeenCalledWith({
        machineId: "legacy-test-machine",
        projectId: 77,
        assertAuthority: expect.any(Function),
      });
      expect(mocks.preserveProjectSqliteForRetirement).toHaveBeenCalled();
      expect(mocks.preserveProjectSqliteForRetirement.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.reconcileLegacyFlyRuntime.mock.invocationCallOrder[0]!,
      );
      expect(progress.legacyRuntimeResolutions).toEqual([
        { pointer: "testContainerId", state: "verified_absent", proof },
      ]);
      expect(progress.retainedLegacyRuntimePointers).toEqual([]);
      expect(
        mocks.updateCalls.some(
          (call) =>
            call.values.testContainerId === null &&
            call.values.testContainerUrl === null &&
            call.values.testContainerStatus === "stopped",
        ),
      ).toBe(true);
      expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(true);
    },
  );

  it.each([
    [
      "prodContainerId",
      "provider_observation_unavailable",
      "project_retirement_legacy_runtime_provider_unavailable",
    ],
    [
      "prodContainerId",
      "absence_unverified",
      "project_retirement_legacy_runtime_absence_unverified",
    ],
    [
      "testContainerId",
      "provider_observation_unavailable",
      "project_retirement_legacy_runtime_provider_unavailable",
    ],
    [
      "testContainerId",
      "absence_unverified",
      "project_retirement_legacy_runtime_absence_unverified",
    ],
  ] as const)(
    "persists retryable %s legacy result %s without terminal success or pointer clearing",
    async (pointer, reason, failureCode) => {
      const progress = completionProgress();
      prepareOperation(progress, { [pointer]: "9080e521b67587" });
      mocks.reconcileLegacyFlyRuntime.mockResolvedValue({
        state: "retained",
        reason,
        retryable: true,
      });

      await expect(runProjectRetirementOperation("retirement-op-77")).rejects.toThrow(failureCode);

      expect(progress.legacyRuntimeResolutions).toEqual([
        {
          pointer,
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
          Object.prototype.hasOwnProperty.call(call.values, pointer),
        ),
      ).toBe(false);
    },
  );

  it.each(["containerId", "prodContainerId", "testContainerId"] as const)(
    "supplies current operation, tombstone, and exact %s authority",
    async (pointer) => {
      const progress = completionProgress();
      prepareOperation(progress, { [pointer]: "9080e521b67587" });
      mocks.authorityResults.push(
        [{ id: "retirement-op-77" }],
        [{ id: "retirement-op-77" }],
        [{ id: "retirement-op-77" }],
      );
      mocks.reconcileLegacyFlyRuntime.mockImplementation(
        async (input: { assertAuthority: () => Promise<void> }) => {
          await input.assertAuthority();
          await input.assertAuthority();
          await input.assertAuthority();
          return { state: "verified_absent", proof: "delete_then_get_404" };
        },
      );

      await runProjectRetirementOperation("retirement-op-77");

      const checks = mocks.selectCalls.filter((call) => call.joins.length > 0);
      expect(checks).toHaveLength(3);
      const dialect = new PgDialect();
      for (const check of checks) {
        expect(check.table).toBe(projectRetirementOperationsTable);
        expect(check.joins[0]?.table).toBe(projectsTable);
        const operation = dialect.sqlToQuery(check.predicate as SQL);
        expect(operation.params).toEqual(["retirement-op-77", 77, "running", 1]);
        expect(operation.sql).toContain('"lease_expires_at" > clock_timestamp()');
        const project = dialect.sqlToQuery(check.joins[0]!.predicate as SQL);
        expect(project.sql).toMatch(/"deleted_at" is not null/iu);
        expect(project.sql.match(/IS NOT DISTINCT FROM/gu)).toHaveLength(3);
        expect(project.params).toEqual(
          {
            containerId: ["9080e521b67587", null, null],
            prodContainerId: [null, "9080e521b67587", null],
            testContainerId: [null, null, "9080e521b67587"],
          }[pointer],
        );
      }
      expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(true);
    },
  );

  it("stops a stale worker when the native authority query returns no row", async () => {
    const progress = completionProgress();
    prepareOperation(progress, { containerId: "9080e521b67587" });
    mocks.authorityResults.push([]);
    mocks.reconcileLegacyFlyRuntime.mockImplementation(
      async (input: { assertAuthority: () => Promise<void> }) => {
        await input.assertAuthority();
        throw new Error("must not reach provider mutation");
      },
    );

    await runProjectRetirementOperation("retirement-op-77");

    expect(progress.legacyRuntimeResolutions).toEqual([]);
    expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
    expect(mocks.updateCalls.some((call) => call.values.state === "failed")).toBe(false);
    expect(
      mocks.updateCalls.some((call) =>
        Object.prototype.hasOwnProperty.call(call.values, "containerId"),
      ),
    ).toBe(false);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each(["containerId", "prodContainerId", "testContainerId"] as const)(
    "blocks completion when %s changes from observed A to replacement B before finalization",
    async (pointer) => {
      const progress = completionProgress();
      prepareOperation(progress, { [pointer]: "9080e521b67587" });
      mocks.reconcileLegacyFlyRuntime.mockImplementation(async () => {
        // Simulate a concurrent replacement after the cleanup observation.
        mocks.currentPointers![pointer] = "replacement-B";
        return { state: "verified_absent", proof: "delete_then_get_404" };
      });

      await runProjectRetirementOperation("retirement-op-77");

      const clear = mocks.updateCalls.find((call) =>
        Object.prototype.hasOwnProperty.call(call.values, "activePreviewSessionId"),
      );
      expect(clear).toBeDefined();
      const query = new PgDialect().sqlToQuery(clear!.predicate as SQL);
      expect(query.sql.match(/IS NOT DISTINCT FROM/gu)).toHaveLength(3);
      expect(query.params).toEqual(
        {
          containerId: [77, "9080e521b67587", null, null],
          prodContainerId: [77, null, "9080e521b67587", null],
          testContainerId: [77, null, null, "9080e521b67587"],
        }[pointer],
      );
      expect(query.params).not.toContain("replacement-B");
      expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
      expect(mocks.updateCalls.some((call) => call.values.state === "failed")).toBe(false);
    },
  );

  it("compares observed null pointers and rejects any zero-row project update", async () => {
    const progress = completionProgress();
    prepareOperation(progress);
    mocks.pointerUpdateResults.push([]);

    await runProjectRetirementOperation("retirement-op-77");

    const clear = mocks.updateCalls.find((call) =>
      Object.prototype.hasOwnProperty.call(call.values, "activePreviewSessionId"),
    );
    const query = new PgDialect().sqlToQuery(clear!.predicate as SQL);
    expect(query.params).toEqual([77, null, null, null]);
    expect(query.sql).toMatch(/"deleted_at" is not null/iu);
    expect(mocks.updateCalls.some((call) => call.values.state === "completed")).toBe(false);
  });

  it("requires an unexpired lease on progress renewal and terminal writes", async () => {
    prepareOperation(completionProgress());
    await runProjectRetirementOperation("retirement-op-77");
    const dialect = new PgDialect();
    const writes = mocks.updateCalls.filter(
      (call) => call.table === projectRetirementOperationsTable && call.values.state !== "running",
    );
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(dialect.sqlToQuery(write.predicate as SQL).sql).toContain(
        '"lease_expires_at" > clock_timestamp()',
      );
    }
  });
});
