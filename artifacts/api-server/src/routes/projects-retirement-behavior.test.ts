import express from "express";
import request from "supertest";
import { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

type SelectCall = { table: unknown; predicate: unknown };
type MutationCall = { table: unknown; values: Record<string, unknown>; predicate?: unknown };

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    selectResults: [] as unknown[][],
    updateReturningResults: [] as unknown[][],
    insertReturningResults: [] as unknown[][],
    selectCalls: [] as SelectCall[],
    updateCalls: [] as MutationCall[],
    insertCalls: [] as MutationCall[],
    deleteCalls: [] as MutationCall[],
    events: [] as string[],
    transaction: vi.fn(),
    execute: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    readPreflight: vi.fn(),
    retireAccess: vi.fn(),
    disableSchedules: vi.fn(),
    durableEnqueue: vi.fn(),
    cancelLocalJobs: vi.fn(),
    cancelProvisioning: vi.fn(),
    providerStatus: vi.fn(),
    providerStop: vi.fn(),
    providerDestroy: vi.fn(),
    providerDeploy: vi.fn(),
    resolveStaff: vi.fn(),
  };
});

function nextSelectResult(): unknown[] {
  return mocks.selectResults.shift() ?? [];
}

function selectQuery() {
  const call: SelectCall = { table: null, predicate: null };
  let consumed = false;
  const consume = () => {
    if (consumed) return [];
    consumed = true;
    mocks.selectCalls.push(call);
    return nextSelectResult();
  };
  const query = {
    from: vi.fn((table: unknown) => {
      call.table = table;
      return query;
    }),
    leftJoin: vi.fn(() => query),
    innerJoin: vi.fn(() => query),
    where: vi.fn((predicate: unknown) => {
      call.predicate = predicate;
      return query;
    }),
    orderBy: vi.fn(() => query),
    groupBy: vi.fn(() => query),
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

function insertQuery(table: unknown) {
  const call: MutationCall = { table, values: {} };
  const settled = Promise.resolve([] as unknown[]);
  const query = {
    values: vi.fn((values: Record<string, unknown>) => {
      call.values = values;
      mocks.insertCalls.push(call);
      mocks.events.push("insert");
      return query;
    }),
    onConflictDoNothing: vi.fn(() => query),
    returning: vi.fn(async () => mocks.insertReturningResults.shift() ?? []),
    then: settled.then.bind(settled),
  };
  return query;
}

function deleteQuery(table: unknown) {
  const call: MutationCall = { table, values: {} };
  const settled = Promise.resolve([] as unknown[]);
  const query = {
    where: vi.fn((predicate: unknown) => {
      call.predicate = predicate;
      mocks.deleteCalls.push(call);
      return query;
    }),
    returning: vi.fn(async () => []),
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
    delete: mocks.delete,
  };
  mocks.select.mockImplementation(() => selectQuery());
  mocks.update.mockImplementation((table: unknown) => updateQuery(table));
  mocks.insert.mockImplementation((table: unknown) => insertQuery(table));
  mocks.delete.mockImplementation((table: unknown) => deleteQuery(table));
  mocks.transaction.mockImplementation(async (work: (transaction: typeof tx) => unknown) =>
    work(tx),
  );
  return {
    ...actual,
    db: {
      ...tx,
      transaction: mocks.transaction,
    },
  };
});

vi.mock("../lib/project-retirement-preflight", () => ({
  readProjectRetirementPreflight: mocks.readPreflight,
}));

vi.mock("../lib/project-retirement-access", () => ({
  retireProjectAccessSurfaces: mocks.retireAccess,
}));

vi.mock("../lib/deployment-scheduler", () => ({
  disableProjectDeploymentSchedulesStatement: mocks.disableSchedules,
}));

vi.mock("../lib/durable-queue", () => ({
  QUEUE_PROJECT_RETIREMENT: "project-retirement",
  durableEnqueueRawResult: mocks.durableEnqueue,
  isDurableWorkerReady: vi.fn(() => true),
  getDurableWorkerReadiness: vi.fn(() => ({ ready: true })),
}));

vi.mock("../lib/auth", () => ({
  listAccessibleProjectIds: vi.fn(async () => []),
  requireProjectOwnership: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
  requireProjectAccess:
    () => (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
      next(),
}));

vi.mock("../lib/adminAuth", () => ({
  requireAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.staffPrincipal = {
      userId: req.userId!,
      role: "owner",
      source: "user_roles",
      grantedBy: req.userId!,
    };
    next();
  },
  requireOwner: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  isAdminUser: vi.fn(async () => true),
  resolveStaffPrincipal: mocks.resolveStaff,
}));

vi.mock("../lib/jobs", () => ({
  cancelLocalProjectJobs: mocks.cancelLocalJobs,
  resolveAgentIdentity: vi.fn(),
  enqueueJob: vi.fn(),
}));

vi.mock("../lib/provisioning", () => ({
  cancelLocalProjectProvisioning: mocks.cancelProvisioning,
  enqueueProvisionProjectJob: vi.fn(),
  provisionPreviewDb: vi.fn(),
  getRollingAverageMs: vi.fn(() => null),
}));

vi.mock("../lib/tenant-runtime", () => ({
  isContainerLayerConfigured: vi.fn(() => false),
  tenantRuntimeProvider: {
    status: mocks.providerStatus,
    stop: mocks.providerStop,
    destroy: mocks.providerDestroy,
    deploy: mocks.providerDeploy,
  },
}));

import {
  projectActivityTable,
  projectRetirementOperationsTable,
  projectsTable,
} from "@workspace/db";
import {
  initialProjectRetirementProgress,
  RESTORED_PROJECT_CONTROL_PLANE_STATE,
} from "../lib/project-retirement";
import projectsRouter from "./projects";

const NOW = new Date("2026-08-31T12:00:00.000Z");

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(projectsRouter);
  return app;
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    workspaceId: 5,
    ownerId: "owner-77",
    name: "Legacy project",
    description: null,
    kind: "web",
    status: "published",
    agentMode: "power",
    testContainerId: null,
    dbProvider: "none",
    provisioningStatus: "idle",
    previewDbStatus: "none",
    deletedAt: new Date("2026-08-30T12:00:00.000Z"),
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    updatedAt: NOW,
    ...overrides,
  };
}

function completedProgress() {
  const progress = initialProjectRetirementProgress();
  progress.route = {
    state: "verified_absent",
    failureCode: null,
    legacyHostnameKv: { state: "not_configured", failureCode: null },
    hostnames: [],
    runtimeRoutes: [],
    cache: { state: "purged" },
  };
  progress.tasks = {
    state: "canceled",
    count: 0,
    terminalized: 0,
    creditsRefunded: 0,
    telemetryFlushed: 0,
  };
  progress.access = {
    state: "revoked",
    shareLinksRevoked: 0,
    previewSessionsRevoked: 0,
    supportGrantsRevoked: 0,
    supportSessionsInterrupted: 0,
    canvasShareTokensCleared: 0,
    canvasAbTestsEnded: 0,
  };
  progress.legacyR2 = {
    state: "not_configured",
    discoveredCount: 0,
    deletedCount: 0,
    failureCode: null,
  };
  progress.runtimes = progress.runtimes.map((runtime) => ({
    ...runtime,
    state: "verified_absent",
    failureCode: null,
  }));
  return progress;
}

function assertNoProviderCall() {
  expect(mocks.providerStatus).not.toHaveBeenCalled();
  expect(mocks.providerStop).not.toHaveBeenCalled();
  expect(mocks.providerDestroy).not.toHaveBeenCalled();
  expect(mocks.providerDeploy).not.toHaveBeenCalled();
}

describe("project retirement route behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
    mocks.updateReturningResults = [];
    mocks.insertReturningResults = [];
    mocks.selectCalls = [];
    mocks.updateCalls = [];
    mocks.insertCalls = [];
    mocks.deleteCalls = [];
    mocks.events = [];
    mocks.readPreflight.mockImplementation(async () => {
      mocks.events.push("preflight");
      return { allowed: true };
    });
    mocks.retireAccess.mockImplementation(
      async (
        _tx: unknown,
        input: { progress: ReturnType<typeof initialProjectRetirementProgress> },
      ) => {
        mocks.events.push("access");
        return input.progress;
      },
    );
    mocks.disableSchedules.mockImplementation((projectId: number) => {
      mocks.events.push("disable-schedules");
      return { kind: "disable-schedules", projectId };
    });
    mocks.durableEnqueue.mockImplementation(async () => {
      mocks.events.push("enqueue");
      return { status: "enqueued", jobId: "retirement-job-77" };
    });
    mocks.cancelLocalJobs.mockReturnValue({ canceled: 0 });
    mocks.cancelProvisioning.mockReturnValue({ canceled: false });
    mocks.resolveStaff.mockImplementation(async (userId: string) => ({
      userId,
      role: "owner",
      source: "user_roles",
      grantedBy: "platform-owner",
    }));
  });

  it("denies a non-owner Operator retry override before reconciliation", async () => {
    mocks.resolveStaff.mockResolvedValueOnce({
      userId: "staff-operator",
      role: "operator",
      source: "user_roles",
      grantedBy: "platform-owner",
    });
    mocks.selectResults = [[]];

    const response = await request(appAs("staff-operator")).post("/projects/77/retirement/retry");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.durableEnqueue).not.toHaveBeenCalled();
  });

  it("allows a platform Owner to reconcile a non-owned legacy terminal receipt", async () => {
    const progress = initialProjectRetirementProgress();
    mocks.selectResults = [
      [],
      [{ id: 77 }],
      [
        {
          id: "retirement-77",
          projectId: 77,
          state: "failed",
          completedAt: NOW,
          failureCode: "project_retirement_legacy_runtime_retained",
          progress,
        },
      ],
    ];

    const response = await request(appAs("staff-owner")).post("/projects/77/retirement/retry");

    expect(response.status).toBe(202);
    expect(response.body).toEqual(
      expect.objectContaining({
        code: "project_retirement_reconciliation_accepted",
        projectId: 77,
        state: "accepted",
        cleanupScheduled: true,
        cleanupScheduleState: "enqueued",
        statusUrl: "/api/projects/77/retirement",
      }),
    );
    expect(mocks.retireAccess).toHaveBeenCalledTimes(1);
    expect(mocks.durableEnqueue).toHaveBeenCalledTimes(1);
  });

  it("preserves retry self-service for an ordinary project owner", async () => {
    mocks.resolveStaff.mockResolvedValueOnce(null);
    mocks.selectResults = [
      [{ id: 77 }],
      [{ id: 77 }],
      [
        {
          id: "retirement-77",
          projectId: 77,
          state: "failed",
          completedAt: NOW,
          failureCode: "project_retirement_attempts_exhausted",
          progress: initialProjectRetirementProgress(),
        },
      ],
    ];

    const response = await request(appAs("owner-77")).post("/projects/77/retirement/retry");

    expect(response.status).toBe(202);
    expect(response.body.code).toBe("project_retirement_reconciliation_accepted");
    expect(mocks.durableEnqueue).toHaveBeenCalledTimes(1);
  });

  it("returns reconciliation eligibility computed from the central contract", async () => {
    const progress = initialProjectRetirementProgress();
    mocks.resolveStaff.mockResolvedValueOnce({
      userId: "staff-operator",
      role: "operator",
      source: "user_roles",
      grantedBy: "platform-owner",
    });
    mocks.selectResults = [
      [],
      [
        {
          id: "retirement-77",
          projectId: 77,
          state: "failed",
          attemptCount: 4,
          completedAt: NOW,
          failureCode: "project_retirement_legacy_runtime_retained",
          failureTarget: null,
          progress,
          createdAt: NOW,
          startedAt: NOW,
        },
      ],
    ];

    const response = await request(appAs("staff-operator")).get("/projects/77/retirement");

    expect(response.status).toBe(200);
    expect(response.body.reconciliationEligible).toBe(false);
  });

  it("returns a read-only allowlisted retirement trail without raw provider metadata", async () => {
    mocks.resolveStaff.mockResolvedValueOnce(null);
    mocks.selectResults = [
      [{ id: 77 }],
      [
        {
          id: "retirement-77-generation-1",
          projectId: 77,
          state: "failed",
          attemptCount: 4,
          completedAt: NOW,
          failureCode: "project_retirement_runtime_destroy_unverified",
          failureTarget: {
            role: "production",
            slot: "green",
            providerId: "must-not-cross-the-terminal-boundary",
          },
          progress: {
            semantics: "project-retirement-v2",
            reconciliation: {
              generation: 1,
              parentOperationId: "raw-parent-operation-id",
              requestedBy: "raw-actor-user-id",
              reason: "retryable_terminal",
            },
            route: {
              state: "failed",
              failureCode: "project_retirement_route_deactivation_unverified",
              legacyHostnameKv: {
                state: "verified_absent",
                failureCode: null,
              },
              hostnames: [
                { hostname: "private.example.test", state: "absent", stage: null },
                { hostname: "other.example.test", state: "unavailable", stage: "read" },
                { hostname: "hostile.example.test", state: "raw-state", stage: "raw-stage" },
                { hostname: "bad-stage.example.test", state: "unavailable", stage: "raw-stage" },
              ],
              runtimeRoutes: [
                {
                  hostname: "route.example.test",
                  manifestRevision: "raw-manifest-revision",
                  sandboxIdentity: "raw-sandbox-identity",
                  state: "verified_absent",
                },
              ],
              cache: { state: "purged", rawProviderResponse: "raw-cache-metadata" },
            },
            tasks: {
              state: "canceled",
              count: 4,
              terminalized: 4,
              creditsRefunded: 2,
              telemetryFlushed: 4,
            },
            access: {
              state: "revoked",
              shareLinksRevoked: 1,
              previewSessionsRevoked: 2,
              supportGrantsRevoked: 3,
              supportSessionsInterrupted: 1,
              canvasShareTokensCleared: 2,
              canvasAbTestsEnded: 1,
            },
            legacyR2: {
              state: "verified_absent",
              discoveredCount: 3,
              deletedCount: 3,
              failureCode: null,
              objectKeys: ["raw/object/key"],
            },
            domains: [
              {
                domainId: 19,
                hostname: "private.example.test",
                state: "verified_absent",
                failureCode: null,
              },
            ],
            hostnameCertificates: [
              {
                cfHostnameId: "raw-cloudflare-hostname-id",
                hostnames: ["private.example.test"],
                projectDomainIds: [19],
                state: "failed",
                failureCode: "project_retirement_domain_release_unverified",
              },
            ],
            securityResources: [
              {
                providerId: "raw-security-provider-id",
                rulesetId: "raw-ruleset-id",
                ref: "raw-security-ref",
                hostname: "private.example.test",
                kind: "firewall_rule",
                state: "verified_absent",
                failureCode: null,
              },
              {
                providerId: "raw-kind-provider-id",
                kind: "raw-kind",
                state: "verified_absent",
                failureCode: null,
              },
            ],
            purchasedDomains: [
              {
                purchasedDomainId: 31,
                projectDomainId: 19,
                hostname: "private.example.test",
                state: "retained",
              },
            ],
            retainedLegacyRuntimePointers: [
              {
                pointer: "testContainerId",
                identity: "raw-legacy-runtime-identity",
                reason: "legacy_runtime_provider",
              },
            ],
            runtimes: [
              {
                role: "preview",
                slot: "primary",
                state: "verified_absent",
                attempts: 2,
                failureCode: null,
                identity: "raw-current-runtime-identity",
              },
              {
                role: "raw-role",
                slot: "primary",
                state: "verified_absent",
                attempts: 1,
                failureCode: null,
                identity: "raw-malformed-runtime-identity",
              },
            ],
          },
          createdAt: NOW,
          startedAt: NOW,
        },
      ],
    ];

    const response = await request(appAs("owner-77")).get("/projects/77/retirement");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      operationId: "retirement-77-generation-1",
      projectId: 77,
      state: "failed",
      failureCode: "project_retirement_runtime_destroy_unverified",
      failureTarget: { role: "production", slot: "green" },
      progress: {
        semantics: "project-retirement-v2",
        reconciliation: {
          generation: 1,
          reason: "retryable_terminal",
          hasParent: true,
        },
        route: {
          state: "failed",
          hostnames: {
            total: 4,
            unrecognized: 2,
            states: { absent: 1, unavailable: 2 },
            stages: { read: 1 },
          },
          runtimeRoutes: {
            total: 1,
            states: { verified_absent: 1 },
          },
          cache: { state: "purged" },
        },
        tasks: { state: "canceled", count: 4, terminalized: 4 },
        access: { state: "revoked", supportGrantsRevoked: 3 },
        legacyR2: { state: "verified_absent", discoveredCount: 3, deletedCount: 3 },
        domains: { total: 1, states: { verified_absent: 1 } },
        hostnameCertificates: {
          total: 1,
          states: { failed: 1 },
          causes: { project_retirement_domain_release_unverified: 1 },
        },
        securityResources: {
          total: 2,
          unrecognized: 1,
          states: { verified_absent: 2 },
          kinds: { firewall_rule: 1 },
        },
        purchasedDomains: { total: 1, states: { retained: 1 } },
        retainedLegacyRuntimePointers: {
          total: 1,
          pointers: { testContainerId: 1 },
          reasons: { legacy_runtime_provider: 1 },
        },
        runtimes: {
          total: 2,
          unrecognized: 1,
          receipts: [
            {
              role: "preview",
              slot: "primary",
              state: "verified_absent",
              attempts: 2,
              failureCode: null,
            },
          ],
        },
      },
    });
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      "private.example.test",
      "raw-parent-operation-id",
      "raw-actor-user-id",
      "raw-manifest-revision",
      "raw-sandbox-identity",
      "raw-cloudflare-hostname-id",
      "raw-security-provider-id",
      "raw-ruleset-id",
      "raw-security-ref",
      "raw/object/key",
      "raw-legacy-runtime-identity",
      "raw-current-runtime-identity",
      "raw-malformed-runtime-identity",
      "raw-kind-provider-id",
      "raw-kind",
      "must-not-cross-the-terminal-boundary",
      "raw-cache-metadata",
      "raw-state",
      "raw-stage",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    assertNoProviderCall();
  });

  it("fails closed instead of reflecting an unrecognized persisted operation state", async () => {
    mocks.resolveStaff.mockResolvedValueOnce(null);
    mocks.selectResults = [
      [{ id: 77 }],
      [
        {
          id: "retirement-77",
          projectId: 77,
          state: "raw-provider-state",
          attemptCount: 1,
          progress: initialProjectRetirementProgress(),
          failureCode: null,
          failureTarget: null,
          createdAt: NOW,
          startedAt: NOW,
          completedAt: null,
        },
      ],
    ];

    const response = await request(appAs("owner-77")).get("/projects/77/retirement");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "project_retirement_receipt_invalid",
      error: "The retirement receipt could not be read safely.",
    });
    expect(JSON.stringify(response.body)).not.toContain("raw-provider-state");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    assertNoProviderCall();
  });

  it("adopts an exact legacy tombstone through preflight and one v2 receipt", async () => {
    const legacy = project();
    mocks.selectResults = [[legacy], [], [legacy], []];

    const response = await request(appAs("staff-owner"))
      .post("/admin/projects/retirement/batch")
      .send({ projectIds: [77] });

    expect(response.status).toBe(202);
    expect(response.body.receipts).toEqual([
      expect.objectContaining({
        projectId: 77,
        operationId: "project-retirement:legacy:v2:77",
        state: "accepted",
        cleanupScheduled: true,
        queueJobId: "retirement-job-77",
      }),
    ]);
    expect(mocks.readPreflight).toHaveBeenCalledTimes(2);
    expect(mocks.retireAccess).toHaveBeenCalledTimes(1);
    expect(mocks.disableSchedules).toHaveBeenCalledWith(77);
    expect(
      mocks.insertCalls.filter((call) => call.table === projectRetirementOperationsTable),
    ).toEqual([
      expect.objectContaining({
        values: expect.objectContaining({
          id: "project-retirement:legacy:v2:77",
          projectId: 77,
          state: "accepted",
        }),
      }),
    ]);
    expect(mocks.insertCalls.some((call) => call.table === projectActivityTable)).toBe(false);
    expect(mocks.updateCalls.some((call) => call.table === projectsTable)).toBe(false);
    expect(mocks.events).toEqual([
      "preflight",
      "preflight",
      "access",
      "insert",
      "disable-schedules",
      "enqueue",
    ]);
  });

  it("replays a current completed legacy receipt without another insert or enqueue", async () => {
    const legacy = project();
    const operation = {
      id: "project-retirement:legacy:v2:77",
      projectId: 77,
      state: "completed",
      completedAt: NOW,
      progress: completedProgress(),
    };
    mocks.selectResults = [[legacy], [operation], [legacy], [operation]];

    const response = await request(appAs("staff-owner"))
      .post("/admin/projects/retirement/batch")
      .send({ projectIds: [77] });

    expect(response.status).toBe(202);
    expect(response.body.receipts).toEqual([
      expect.objectContaining({
        operationId: operation.id,
        state: "completed",
        cleanupScheduled: false,
        cleanupComplete: true,
      }),
    ]);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.retireAccess).not.toHaveBeenCalled();
    expect(mocks.durableEnqueue).not.toHaveBeenCalled();
  });

  it("keeps the active-project retirement path fresh and unchanged", async () => {
    const active = project({ id: 78, name: "Active project", deletedAt: null });
    mocks.selectResults = [[active], [active]];
    mocks.updateReturningResults = [[{ id: 78 }]];

    const response = await request(appAs("staff-owner"))
      .post("/admin/projects/retirement/batch")
      .send({ projectIds: [78] });

    expect(response.status).toBe(202);
    const receipt = response.body.receipts[0] as Record<string, unknown>;
    expect(receipt.state).toBe("accepted");
    expect(receipt.operationId).not.toBe("project-retirement:legacy:v2:78");
    const projectUpdate = mocks.updateCalls.find((call) => call.table === projectsTable);
    expect(projectUpdate?.values.deletedAt).toBeInstanceOf(SQL);
    expect(
      mocks.insertCalls.filter((call) => call.table === projectRetirementOperationsTable),
    ).toHaveLength(1);
    expect(mocks.insertCalls.filter((call) => call.table === projectActivityTable)).toHaveLength(1);
    expect(mocks.retireAccess).toHaveBeenCalledTimes(1);
    expect(mocks.durableEnqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "admin batch",
      (app: express.Express) =>
        request(app)
          .post("/admin/projects/retirement/batch")
          .send({ projectIds: [78] }),
      "project_retirement_batch_refused",
    ],
    [
      "owner Trash",
      (app: express.Express) => request(app).delete("/projects/78"),
      "project_retirement_managed_addon_unverified",
    ],
  ])(
    "keeps live work untouched when the locked %s preflight newly refuses",
    async (_label, invoke, responseCode) => {
      const active = project({ id: 78, name: "Active project", deletedAt: null });
      mocks.selectResults = [[active], [active]];
      mocks.readPreflight.mockResolvedValueOnce({ allowed: true }).mockResolvedValueOnce({
        allowed: false,
        code: "project_retirement_managed_addon_unverified",
      });

      const response = await invoke(appAs("owner-77"));

      expect(response.status).toBe(409);
      expect(response.body.code).toBe(responseCode);
      if (_label === "admin batch") {
        expect(response.body.receipts[0].code).toBe("project_retirement_managed_addon_unverified");
      }
      expect(mocks.cancelLocalJobs).not.toHaveBeenCalled();
      expect(mocks.cancelProvisioning).not.toHaveBeenCalled();
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.durableEnqueue).not.toHaveBeenCalled();
    },
  );

  it("reports an all-unknown admin batch as not found instead of accepted", async () => {
    mocks.selectResults = [[]];

    const response = await request(appAs("staff-owner"))
      .post("/admin/projects/retirement/batch")
      .send({ projectIds: [999] });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "project_retirement_batch_not_found",
      error: "No matching projects were found.",
      receipts: [{ projectId: 999, state: "not_found" }],
    });
    expect(mocks.cancelLocalJobs).not.toHaveBeenCalled();
    expect(mocks.cancelProvisioning).not.toHaveBeenCalled();
    expect(mocks.durableEnqueue).not.toHaveBeenCalled();
  });

  it("restores complete evidence to one unpublished draft receipt and replays safely", async () => {
    const progress = completedProgress();
    const deleted = project();
    const operation = {
      id: "retirement-77",
      projectId: 77,
      state: "completed",
      completedAt: NOW,
      progress,
    };
    const restored = project({
      ...RESTORED_PROJECT_CONTROL_PLANE_STATE,
      deletedAt: null,
      publicSlug: "retained-history-only",
      customDomain: null,
    });
    const replayOperation = {
      ...operation,
      progress: {
        ...progress,
        restore: { state: "restored", restoredAt: "2026-08-31T12:05:00.000Z" },
      },
    };
    mocks.selectResults = [[deleted], [operation], [restored], [replayOperation]];
    mocks.updateReturningResults = [[{ id: operation.id }], [restored]];

    const first = await request(appAs("owner-77")).post("/projects/77/restore");
    const updateCountAfterFirst = mocks.updateCalls.length;
    const second = await request(appAs("owner-77")).post("/projects/77/restore");

    expect(first.status).toBe(200);
    expect(first.body).toEqual(expect.objectContaining({ id: 77, status: "draft" }));
    expect(first.body.deletedAt ?? null).toBeNull();
    expect(second.status).toBe(200);
    expect(second.body).toEqual(expect.objectContaining({ id: 77, status: "draft" }));
    expect(mocks.updateCalls).toHaveLength(updateCountAfterFirst);
    const receiptUpdates = mocks.updateCalls.filter(
      (call) => call.table === projectRetirementOperationsTable,
    );
    expect(receiptUpdates).toHaveLength(1);
    const progressSql = new PgDialect().sqlToQuery(receiptUpdates[0]!.values.progress as SQL);
    expect(progressSql.sql.replace(/\s+/gu, " ")).toContain("jsonb_set");
    expect(progressSql.sql.replace(/\s+/gu, " ")).toContain("now()");
    const projectUpdates = mocks.updateCalls.filter((call) => call.table === projectsTable);
    expect(projectUpdates).toHaveLength(1);
    expect(projectUpdates[0]!.values).toEqual(
      expect.objectContaining({
        ...RESTORED_PROJECT_CONTROL_PLANE_STATE,
        deletedAt: null,
      }),
    );
    expect(mocks.delete).not.toHaveBeenCalled();
    assertNoProviderCall();
  });

  it("refuses old or incomplete completion evidence without any restore write", async () => {
    const deleted = project();
    mocks.selectResults = [
      [deleted],
      [
        {
          id: "old-retirement-77",
          projectId: 77,
          state: "completed",
          completedAt: NOW,
          progress: { semantics: "project-retirement-v1" },
        },
      ],
    ];

    const response = await request(appAs("owner-77")).post("/projects/77/restore");

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("project_retirement_cleanup_unverified");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
    assertNoProviderCall();
  });

  it.each(["another-owner", "owner-after-recovery-window"])(
    "returns a non-revealing 404 for %s",
    async (userId) => {
      mocks.selectResults = [[]];

      const response = await request(appAs(userId)).post("/projects/77/restore");

      expect(response.status).toBe(404);
      expect(response.body.error).toContain("Project not found");
      expect(mocks.selectCalls).toHaveLength(1);
      const predicate = mocks.selectCalls[0]!.predicate as SQL;
      const rendered = new PgDialect().sqlToQuery(predicate);
      expect(rendered.sql).toContain('"projects"."owner_id"');
      expect(rendered.sql).toContain('"projects"."deleted_at"');
      expect(rendered.sql).toContain("interval '30 days'");
      expect(rendered.params).toContain(userId);
      expect(mocks.update).not.toHaveBeenCalled();
      expect(mocks.delete).not.toHaveBeenCalled();
      assertNoProviderCall();
    },
  );
});
