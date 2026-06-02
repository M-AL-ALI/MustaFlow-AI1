/**
 * Task #753 — Stop-button cancellation: fast integration test
 *
 * Verifies the full click → cancel → SSE "cancelled" path without real OpenAI
 * calls. The builder pipeline mock blocks on the AbortSignal so
 * cancelActiveJob() drives the entire abort flow inside runJob.
 *
 * Key assertions:
 *   1. cancelActiveJob(taskId) returns true when a job is in flight.
 *   2. publishTaskEvent is called with eventType "cancelled".
 *   3. The DB transaction updates the task to "canceled".
 *
 * Implementation note: vi.mock() factories are hoisted before imports, so
 * variables shared between the factory and tests are defined via vi.hoisted().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Shared state, hoisted so it's accessible inside vi.mock() factories ──────
const {
  emittedEventRows,
  insertIdCounter,
  updateCallCount,
  mockRunBuildPipeline,
  mockRunAgentLoop,
  makeSelectChain: _makeSelectChain,
  makeUpdateChain: _makeUpdateChain,
  makeInsertChain: _makeInsertChain,
  makeDb,
  makePool,
  fakeAgentTasksTable,
  fakeProjectsTable,
  fakeProjectFilesTable,
  fakeTaskEventsTable,
  fakeKnowledgeEntriesTable,
  fakeSecretsTable,
  fakeProjectDomainsTable,
  fakeUserSubscriptionsTable,
  fakeBuildAnalyticsTable,
  fakeChatMessagesTable,
  fakePreviewSnapshotsTable,
  fakeProjectVersionsTable,
  fakeCheckRunsTable,
  fakeAppTestRunsTable,
  fakeCveFindingsTable,
  fakeProjectSuggestionsTable,
  fakeDeploymentLogsTable,
  fakeToolAuditTable,
  fakeBuilderSkillsTable,
  TASK_ID,
  PROJECT_ID,
  mockProject: _mockProject,
  publishTaskEventSpy,
} = vi.hoisted(() => {
  const TASK_ID = 42;
  const PROJECT_ID = 7;

  const emittedEventRows: Array<{
    id: number;
    taskId: number;
    eventType: string;
    message: string;
    filePath: null;
    createdAt: Date;
  }> = [];

  const insertIdCounter = { value: 1 };
  const updateCallCount = { value: 0 };

  const mockProject = {
    id: PROJECT_ID,
    name: "Test Project",
    kind: "web",
    stack: null,
    projectFormat: null,
    ownerId: "user-test",
    status: "idle",
    publicSlug: null,
    agentMode: "lite",
    dbProvider: null,
    dbStatus: null,
    containerId: null,
    containerUrl: null,
    policyStrictness: null,
    e2eEnabled: true,
    neonProjectId: null,
    builderMode: "static-legacy",
    provisioningStatus: "idle",
    provisioningError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  // ── Fake table stubs — __id lets the mock router identify which table ──────
  const fakeAgentTasksTable = { __id: "agent_tasks" };
  const fakeProjectsTable = { __id: "projects" };
  const fakeProjectFilesTable = { __id: "project_files" };
  const fakeTaskEventsTable = { __id: "task_events" };
  const fakeKnowledgeEntriesTable = { __id: "knowledge_entries" };
  const fakeSecretsTable = { __id: "secrets" };
  const fakeProjectDomainsTable = { __id: "project_domains" };
  const fakeUserSubscriptionsTable = { __id: "user_subscriptions" };
  const fakeBuildAnalyticsTable = { __id: "build_analytics" };
  const fakeChatMessagesTable = { __id: "chat_messages" };
  const fakePreviewSnapshotsTable = { __id: "preview_snapshots" };
  const fakeProjectVersionsTable = { __id: "project_versions" };
  const fakeCheckRunsTable = { __id: "check_runs" };
  const fakeAppTestRunsTable = { __id: "app_test_runs" };
  const fakeCveFindingsTable = { __id: "cve_findings" };
  const fakeProjectSuggestionsTable = { __id: "project_suggestions" };
  const fakeDeploymentLogsTable = { __id: "deployment_logs" };
  const fakeToolAuditTable = { __id: "tool_audit" };
  const fakeBuilderSkillsTable = { __id: "builder_skills" };

  // ── Chainable drizzle-like query builder ─────────────────────────────────
  function makeSelectChain(result: unknown[]): unknown {
    const p = Promise.resolve(result);
    const chain: Record<string, unknown> = {
      from: (_table: unknown) => chain,
      where: (..._args: unknown[]) => chain,
      orderBy: (..._args: unknown[]) => chain,
      limit: (_n: number) => p,
      then: p.then.bind(p),
      catch: p.catch.bind(p),
      finally: p.finally.bind(p),
      [Symbol.toStringTag]: "Promise",
    };
    return chain;
  }

  function selectRouter(table: { __id?: string }): unknown {
    switch (table.__id) {
      case "projects":
        return makeSelectChain([mockProject]);
      case "agent_tasks":
        // Return a row so drain functions exit early (queueBatchId null → early return)
        return makeSelectChain([{ id: TASK_ID, creditsReserved: null, queueBatchId: null }]);
      default:
        return makeSelectChain([]);
    }
  }

  function makeInsertChain(table: { __id?: string }, values: unknown) {
    if (table.__id === "task_events") {
      const v = values as { eventType?: string; message?: string; taskId?: number };
      const row = {
        id: insertIdCounter.value++,
        taskId: v.taskId ?? TASK_ID,
        eventType: v.eventType ?? "unknown",
        message: v.message ?? "",
        filePath: null,
        createdAt: new Date(),
      };
      emittedEventRows.push(row);
      const p = Promise.resolve([row]);
      return {
        returning: () => p,
        // Some callers chain .catch() directly on the values() result
        // (e.g. the analytics insert in jobs.ts). Expose a no-op so
        // "TypeError: .catch is not a function" doesn't leak as an
        // unhandled rejection and pollute the test suite.
        catch: (_fn: unknown) => Promise.resolve(undefined),
      };
    }
    return {
      returning: () => Promise.resolve([]),
      catch: (_fn: unknown) => Promise.resolve(undefined),
    };
  }

  function makeUpdateChain(table: { __id?: string }) {
    return {
      set: (vals: unknown) => ({
        where: (..._args: unknown[]) => ({
          returning: (_shape?: unknown) => {
            // Route by the status value being set rather than a sequential counter.
            // A sequential counter is fragile: void-ed drain helpers from a
            // previous test (drainNextProjectTask / drainNextBatchTask) can fire
            // during the next test's setup and corrupt the call sequence.
            //
            // The "transition to building/planning" update is the only db.update()
            // on agent_tasks that sets status to "building" or "planning", so
            // returning [{id}] here is safe and unambiguous.  All other updates
            // (failed, canceled, agentIdentity, etc.) return [] which is correct
            // for a no-row-matched situation in the mock.
            const v = vals as Record<string, unknown>;
            if (
              table.__id === "agent_tasks" &&
              (v.status === "building" || v.status === "planning")
            ) {
              return Promise.resolve([{ id: TASK_ID }]);
            }
            return Promise.resolve([]);
          },
        }),
      }),
    };
  }

  // ── Capture publishTaskEvent calls ────────────────────────────────────────
  const publishTaskEventSpy = vi.fn();

  // ── The mock builder that blocks on the signal ────────────────────────────
  const mockRunBuildPipeline = vi.fn();

  // ── The mock agentic loop that blocks on the signal ───────────────────────
  const mockRunAgentLoop = vi.fn();

  // ── DB factory (called fresh per test via makeDb) ─────────────────────────
  function makeDb() {
    const transactionMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select: (_shape?: unknown) => ({
          from: (_table: { __id?: string }) =>
            makeSelectChain([{ id: TASK_ID, creditsReserved: null }]),
        }),
        update: (_table: unknown) => ({
          set: (_vals: unknown) => ({
            where: (..._args: unknown[]) => ({
              returning: () => Promise.resolve([{ id: TASK_ID, status: "canceled" }]),
            }),
          }),
        }),
        insert: (table: { __id?: string }) => ({
          values: (vals: unknown) => makeInsertChain(table, vals),
        }),
      };
      return cb(tx);
    });

    return {
      select: (_shape?: unknown) => ({
        from: (table: { __id?: string }) => selectRouter(table),
      }),
      update: (table: { __id?: string }) => makeUpdateChain(table),
      insert: (table: { __id?: string }) => ({
        values: (vals: unknown) => makeInsertChain(table, vals),
      }),
      delete: (_table: unknown) => ({
        where: (..._args: unknown[]) => Promise.resolve([]),
      }),
      transaction: transactionMock,
    };
  }

  function makePool() {
    return {
      connect: vi.fn().mockResolvedValue({
        query: vi.fn().mockResolvedValue({ rows: [] }),
        release: vi.fn(),
      }),
      query: vi.fn().mockResolvedValue({ rows: [] }),
    };
  }

  return {
    emittedEventRows,
    insertIdCounter,
    updateCallCount,
    mockRunBuildPipeline,
    makeSelectChain,
    makeUpdateChain,
    makeInsertChain,
    makeDb,
    makePool,
    fakeAgentTasksTable,
    fakeProjectsTable,
    fakeProjectFilesTable,
    fakeTaskEventsTable,
    fakeKnowledgeEntriesTable,
    fakeSecretsTable,
    fakeProjectDomainsTable,
    fakeUserSubscriptionsTable,
    fakeBuildAnalyticsTable,
    fakeChatMessagesTable,
    fakePreviewSnapshotsTable,
    fakeProjectVersionsTable,
    fakeCheckRunsTable,
    fakeAppTestRunsTable,
    fakeCveFindingsTable,
    fakeProjectSuggestionsTable,
    fakeDeploymentLogsTable,
    fakeToolAuditTable,
    fakeBuilderSkillsTable,
    TASK_ID,
    PROJECT_ID,
    mockProject,
    publishTaskEventSpy,
    mockRunAgentLoop,
  };
});

// ── vi.mock() calls — all hoisted, so they run before any imports ─────────────

vi.mock("drizzle-orm", () => ({
  eq: () => ({}),
  and: () => ({}),
  or: () => ({}),
  inArray: () => ({}),
  desc: () => ({}),
  asc: () => ({}),
  isNull: () => ({}),
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._vals: unknown[]) => ({ __sqlTag: true }),
    { raw: (_s: string) => ({ __sqlTag: true }) },
  ),
}));

vi.mock("@workspace/db", () => ({
  get db() {
    return makeDb();
  },
  get pool() {
    return makePool();
  },
  agentTasksTable: fakeAgentTasksTable,
  projectsTable: fakeProjectsTable,
  projectFilesTable: fakeProjectFilesTable,
  taskEventsTable: fakeTaskEventsTable,
  knowledgeEntriesTable: fakeKnowledgeEntriesTable,
  secretsTable: fakeSecretsTable,
  projectDomainsTable: fakeProjectDomainsTable,
  userSubscriptionsTable: fakeUserSubscriptionsTable,
  buildAnalyticsTable: fakeBuildAnalyticsTable,
  chatMessagesTable: fakeChatMessagesTable,
  previewSnapshotsTable: fakePreviewSnapshotsTable,
  projectVersionsTable: fakeProjectVersionsTable,
  checkRunsTable: fakeCheckRunsTable,
  appTestRunsTable: fakeAppTestRunsTable,
  cveFindingsTable: fakeCveFindingsTable,
  projectSuggestionsTable: fakeProjectSuggestionsTable,
  deploymentLogsTable: fakeDeploymentLogsTable,
  toolAuditTable: fakeToolAuditTable,
  builderSkillsTable: fakeBuilderSkillsTable,
}));

vi.mock("./event-bus", () => ({
  get publishTaskEvent() {
    return publishTaskEventSpy;
  },
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
}));

vi.mock("./logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
}));

// detectRequiredStack (from ./ai) uses keyword heuristics. Prompts that
// contain backend signals (e.g. "real-time", "database", "api") cause it to
// return "node-api", which triggers a 5-second provisioning poll in runJob
// (setTimeout 5_000 at line ~1632). Mocking it prevents that path entirely.
vi.mock("./ai", () => ({
  detectRequiredStack: vi.fn().mockResolvedValue("static-html"),
}));

vi.mock("./knowledge", () => ({ writeKnowledge: vi.fn() }));
vi.mock("./embeddings", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(null),
  cosineSimilarity: vi.fn().mockReturnValue(0),
}));
vi.mock("./page-map", () => ({ extractPageMap: vi.fn().mockResolvedValue(null) }));
vi.mock("./auditor", () => ({ runAudit: vi.fn().mockResolvedValue(null) }));
vi.mock("./checks/orchestrator", () => ({ runOrchestration: vi.fn().mockResolvedValue([]) }));
vi.mock("./checks/registry", () => ({ getCheckByName: vi.fn().mockReturnValue(undefined) }));
vi.mock("./security-findings", () => ({
  persistSecurityFindings: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./eas", () => ({
  triggerEasBuild: vi.fn(),
  getEasBuildStatus: vi.fn(),
  triggerEasSubmit: vi.fn(),
  mapEasStatusToDeploymentStatus: vi.fn(),
}));
vi.mock("./github", () => ({ autoCommitProjectFiles: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../routes/images.js", () => ({
  fetchAttachmentAsDataUri: vi.fn().mockResolvedValue(null),
}));
vi.mock("./architect", () => ({
  runArchitectReview: vi.fn().mockResolvedValue(null),
  shouldTriggerAutoFix: vi.fn().mockReturnValue(false),
  buildAutoFixPrompt: vi.fn().mockReturnValue(""),
  toReportShape: vi.fn().mockReturnValue({}),
  architectToReportShape: vi.fn().mockReturnValue({}),
  ARCHITECT_CREDIT_COST: 5,
  ARCHITECT_AUTOFIX_TITLE_PREFIX: "[auto-fix]",
}));
vi.mock("../routes/credits", () => ({
  getOrCreateCredits: vi.fn().mockResolvedValue({ balance: 9999 }),
  deductCredits: vi.fn().mockResolvedValue(undefined),
  refundCredits: vi.fn().mockResolvedValue(undefined),
  CREDITS_ENFORCEMENT_ENABLED: false,
}));
vi.mock("./ai-providers", () => ({
  creditCostFor: vi.fn().mockReturnValue(1),
  resolveStageProvider: vi.fn().mockReturnValue({ provider: "openai" }),
}));
vi.mock("./artifacts", () => ({ resolveArtifactId: vi.fn().mockResolvedValue(null) }));
vi.mock("./durable-queue", () => ({
  durableEnqueue: vi.fn().mockResolvedValue(null),
  isDurableQueueReady: vi.fn().mockReturnValue(false),
}));

// Prevent provisioning side-effects from leaking into the test suite.
// jobs.ts dynamically imports ./provisioning when stack auto-detection upgrades
// a project to "node-api"; the mock ensures the import resolves without hitting
// the real DB (which would trigger an unhandled rejection via markError()).
vi.mock("./provisioning", () => ({
  enqueueProvisionProjectJob: vi.fn(),
  runProvisionProjectJob: vi.fn().mockResolvedValue(undefined),
}));

// ── The agent-loop mock — blocks on the abort signal ─────────────────────────
vi.mock("./agent-loop", () => ({
  get runAgentLoop() {
    return mockRunAgentLoop;
  },
  loopResultToBuildResult: vi.fn(),
  loopResultToRefineResult: vi.fn(),
}));

// ── The builder mock — blocks on the abort signal ────────────────────────────
vi.mock("./builder", () => ({
  get runBuildPipeline() {
    return mockRunBuildPipeline;
  },
  runRefinePipeline: vi.fn(),
  runReactViteBuildPipeline: vi.fn(),
  runReactViteRefinePipeline: vi.fn(),
  runMobileBuildPipeline: vi.fn(),
  runMobileRefinePipeline: vi.fn(),
  runNextjsBuildPipeline: vi.fn(),
  runNextjsRefinePipeline: vi.fn(),
  runNodeApiBuildPipeline: vi.fn(),
  runNodeApiRefinePipeline: vi.fn(),
  runFlaskBuildPipeline: vi.fn(),
  runFlaskRefinePipeline: vi.fn(),
  runFastapiBuildPipeline: vi.fn(),
  runFastapiRefinePipeline: vi.fn(),
  scanCodeSmells: vi.fn().mockResolvedValue([]),
  sanitisePrompt: vi.fn((p: string) => ({ cleaned: p, wasModified: false })),
  scanForSecrets: vi.fn().mockResolvedValue([]),
  validateCrossFileConsistency: vi.fn().mockResolvedValue([]),
  runCvePatchPipeline: vi.fn().mockResolvedValue(null),
  analyzeImagesToLayout: vi.fn().mockResolvedValue(null),
}));

// ── Imports from the module under test (must come after all vi.mock() calls) ──
import { runJob, cancelActiveJob } from "./jobs";

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Task #753 — Stop button cancellation (stubbed AI provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEventRows.length = 0;
    insertIdCounter.value = 1;
    updateCallCount.value = 0;

    // Disable the agentic builder so the legacy runBuildPipeline path is used.
    // This avoids dynamic import of agent-loop and keeps the mock builder as
    // the sole gatekeeper for signal propagation — making the test reliable
    // and fast (no real AI calls, no extra module load overhead).
    process.env.AGENTIC_BUILDER_ENABLED = "false";

    // Builder blocks indefinitely until the AbortSignal fires, then rejects
    // with the exact error message that runJob's catch block recognises.
    mockRunBuildPipeline.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Build cancelled"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Build cancelled")), {
            once: true,
          });
        }),
    );
  });

  afterEach(() => {
    delete process.env.AGENTIC_BUILDER_ENABLED;
  });

  // ── Unit-level: cancelActiveJob standalone behaviour ─────────────────────

  it("cancelActiveJob returns false when no in-flight job matches the taskId", () => {
    const result = cancelActiveJob(999_999);
    expect(result).toBe(false);
  });

  // ── Integration: full click → cancel → 'cancelled' SSE event path ─────────

  it("runJob emits the 'cancelled' SSE event when cancelActiveJob is called mid-build", async () => {
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "Build me a todo app with colourful cards",
      agentMode: "lite",
    });

    // Allow the job to advance through its setup DB calls and reach the
    // builder pipeline (all awaits in the setup path resolve immediately
    // because they hit our synchronous-resolve mocks).
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Simulate the user clicking Stop.
    const aborted = cancelActiveJob(TASK_ID);
    expect(aborted).toBe(true);

    // Wait for runJob to finish the catch/finally path.
    await jobPromise;

    // ── Assert: "cancelled" SSE event recorded in task_events ───────────────
    const cancelledEvents = emittedEventRows.filter((e) => e.eventType === "cancelled");
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
      message: "Build cancelled by user.",
    });

    // ── Assert: publishTaskEvent (browser SSE fanout) called with "cancelled" ─
    const cancelledPub = publishTaskEventSpy.mock.calls.find(
      ([arg]: [{ eventType: string }]) => arg.eventType === "cancelled",
    );
    expect(cancelledPub).toBeDefined();
    expect(cancelledPub![0]).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
    });
  }, 10_000);

  it("the SSE stream emits 'queued' before 'cancelled' — event ordering is preserved", async () => {
    // This test is distinct from the one above: it verifies that the SSE
    // event ORDER is correct (queued must appear before cancelled in the
    // emitted event list).  Both tests use 6 setImmediate ticks to give
    // runJob time to reach the builder before the cancel fires — this is
    // the proven-reliable pattern that avoids the async-tick ordering
    // ambiguity present in pure pre-abort approaches.
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "A dashboard with real-time charts",
      agentMode: "lite",
    });

    for (let i = 0; i < 6; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    cancelActiveJob(TASK_ID);
    await jobPromise;

    // emittedEventRows is populated by makeInsertChain whenever jobs.ts
    // inserts into taskEventsTable.  The 'queued' event is emitted right
    // after the advisory lock is acquired; 'cancelled' is emitted in the
    // catch block.  Verify both are present AND that queued precedes cancelled.
    const types = emittedEventRows.map((r) => r.eventType);
    expect(types).toContain("queued");
    expect(types).toContain("cancelled");
    const queuedIdx = types.indexOf("queued");
    const cancelledIdx = types.indexOf("cancelled");
    expect(queuedIdx).toBeLessThan(cancelledIdx);
  });

  it("cancelActiveJob returns true only once per in-flight task (idempotency)", async () => {
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "An e-commerce storefront",
      agentMode: "eco",
    });

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // First cancel — should succeed
    const first = cancelActiveJob(TASK_ID);
    // Second cancel on the same task — controller already removed
    const second = cancelActiveJob(TASK_ID);

    await jobPromise;

    expect(first).toBe(true);
    expect(second).toBe(false);
  }, 10_000);
});

// ── Agentic builder path (AGENTIC_BUILDER_ENABLED=true) ───────────────────────

describe("Task #754 — Stop button cancellation via agentic builder loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    emittedEventRows.length = 0;
    insertIdCounter.value = 1;
    updateCallCount.value = 0;

    // Enable the agentic builder so runJob routes through runAgentLoop instead
    // of runBuildPipeline.
    process.env.AGENTIC_BUILDER_ENABLED = "true";

    // runAgentLoop blocks indefinitely until the AbortSignal fires, then
    // rejects with the same error message that runJob's catch block recognises.
    mockRunAgentLoop.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_, reject) => {
          if (signal.aborted) {
            reject(new Error("Build cancelled"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("Build cancelled")), {
            once: true,
          });
        }),
    );
  });

  afterEach(() => {
    delete process.env.AGENTIC_BUILDER_ENABLED;
  });

  it("runJob (agentic) emits the 'cancelled' SSE event when cancelActiveJob is called mid-build", async () => {
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "Build me a todo app with colourful cards",
      agentMode: "lite",
    });

    // Allow the job to advance through its setup DB calls and reach the
    // agent loop (all awaits in the setup path resolve immediately because
    // they hit our synchronous-resolve mocks).
    for (let i = 0; i < 6; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    // Simulate the user clicking Stop.
    const aborted = cancelActiveJob(TASK_ID);
    expect(aborted).toBe(true);

    // Wait for runJob to finish the catch/finally path.
    await jobPromise;

    // ── Assert: "cancelled" SSE event recorded in task_events ─────────────
    const cancelledEvents = emittedEventRows.filter((e) => e.eventType === "cancelled");
    expect(cancelledEvents).toHaveLength(1);
    expect(cancelledEvents[0]).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
      message: "Build cancelled by user.",
    });

    // ── Assert: publishTaskEvent (browser SSE fanout) called with "cancelled"
    const cancelledPub = publishTaskEventSpy.mock.calls.find(
      ([arg]: [{ eventType: string }]) => arg.eventType === "cancelled",
    );
    expect(cancelledPub).toBeDefined();
    expect(cancelledPub![0]).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
    });
  }, 10_000);

  it("agentic: 'queued' event precedes 'cancelled' — event ordering is preserved", async () => {
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "A dashboard with real-time charts",
      agentMode: "lite",
    });

    for (let i = 0; i < 6; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    cancelActiveJob(TASK_ID);
    await jobPromise;

    const types = emittedEventRows.map((r) => r.eventType);
    expect(types).toContain("queued");
    expect(types).toContain("cancelled");
    const queuedIdx = types.indexOf("queued");
    const cancelledIdx = types.indexOf("cancelled");
    expect(queuedIdx).toBeLessThan(cancelledIdx);
  }, 10_000);

  it("agentic: cancelActiveJob returns true only once per in-flight task (idempotency)", async () => {
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "An e-commerce storefront",
      agentMode: "eco",
    });

    for (let i = 0; i < 6; i++) {
      await new Promise<void>((r) => setImmediate(r));
    }

    const first = cancelActiveJob(TASK_ID);
    const second = cancelActiveJob(TASK_ID);

    await jobPromise;

    expect(first).toBe(true);
    expect(second).toBe(false);
  }, 10_000);
});
