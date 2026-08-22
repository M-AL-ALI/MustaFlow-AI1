/**
 * Task #753 — Stop-button cancellation: HTTP integration test
 *
 * Exercises the full click → cancel → SSE "cancelled" path through the real
 * HTTP layer, without real OpenAI calls:
 *
 *   1. Start runJob with a signal-aware mock builder (blocks until abort).
 *   2. Open the SSE stream endpoint (GET /projects/:id/tasks/:taskId/events/stream).
 *   3. Call the production cancel route (POST /projects/:id/tasks/:taskId/cancel).
 *   4. Assert the HTTP 200 response carries the cancelled task payload.
 *   5. Assert the SSE stream emits a "cancelled" event (event-driven, no polling).
 *
 * The event-bus is NOT mocked — real in-process pub/sub lets events flow from
 * runJob through the cancel catch-block → publishTaskEvent → subscribeTaskEvents
 * → SSE response.
 *
 * Auth is bypassed via a vi.mock of the auth module so Clerk is not required.
 * The DB is a chainable fake that returns minimal valid shapes.
 */

import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import http from "node:http";

// ── Shared state, hoisted so it's accessible inside vi.mock() factories ──────
const {
  emittedEventRows,
  insertIdCounter,
  mutationCallCount,
  updateCallCount,
  routeTaskStatus,
  routeTaskTerminal,
  mockRunBuildPipeline,
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
  fakeNabuflowOrgSeatsTable,
  TASK_ID,
  PROJECT_ID,
  mockProject: _mockProject,
} = vi.hoisted(() => {
  const TASK_ID = 42;
  const PROJECT_ID = 7;

  const emittedEventRows: Array<{
    id: number;
    taskId: number;
    eventType: string;
    message: string;
    filePath: string | null;
    createdAt: Date;
  }> = [];

  const insertIdCounter = { value: 1 };
  const mutationCallCount = { value: 0 };
  const updateCallCount = { value: 0 };
  const routeTaskStatus = { value: "building" };
  const routeTaskTerminal = { value: null as unknown };

  const mockProject = {
    id: PROJECT_ID,
    name: "Test Project",
    kind: "web",
    stack: null,
    projectFormat: null,
    ownerId: "test-user",
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

  // Fake table stubs — __id lets the mock router identify which table
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
  const fakeNabuflowOrgSeatsTable = { __id: "nabuflow_org_seats" };

  // ── Chainable drizzle-like query builder ─────────────────────────────────
  function makeSelectChain(result: unknown[]): unknown {
    const p = Promise.resolve(result);
    const chain: Record<string, unknown> = {
      from: (_table: unknown) => chain,
      where: (..._args: unknown[]) => chain,
      innerJoin: (..._args: unknown[]) => chain,
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
        // Return a "building" task so the cancel route proceeds (not alreadyTerminal)
        return makeSelectChain([
          {
            id: TASK_ID,
            status: routeTaskStatus.value,
            terminal: routeTaskTerminal.value,
            creditsReserved: null,
            queueBatchId: null,
            kind: "main",
            intentReceiptId: 71,
          },
        ]);
      case "task_events":
        // Empty replay history — live events arrive via real event-bus subscriptions
        return makeSelectChain(emittedEventRows);
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
            // on agent_tasks that sets status to "building" or "planning".
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

  // ── DB factory — new instance per test via makeDb() ───────────────────────
  function makeDb() {
    const transactionMock = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        execute: vi.fn().mockResolvedValue([]),
        select: (shape?: unknown) => ({
          from: (table: { __id?: string }) =>
            table.__id === "task_events"
              ? makeSelectChain(
                  emittedEventRows.filter((row) =>
                    ["completed", "failed", "cancelled"].includes(row.eventType),
                  ),
                )
              : shape && typeof shape === "object" && Object.keys(shape).join(",") === "id"
                ? makeSelectChain([])
                : makeSelectChain([
                    {
                      id: TASK_ID,
                      status: routeTaskStatus.value,
                      creditsReserved: null,
                      terminal: routeTaskTerminal.value,
                    },
                  ]),
        }),
        update: (_table: unknown) => ({
          set: (vals: unknown) => ({
            where: (..._args: unknown[]) => ({
              returning: () => {
                const status = (vals as { status?: string }).status;
                if (
                  (_table as { __id?: string }).__id === "agent_tasks" &&
                  ["completed", "failed", "canceled"].includes(routeTaskStatus.value)
                ) {
                  return Promise.resolve([]);
                }
                if (status) routeTaskStatus.value = status;
                if ("terminal" in (vals as Record<string, unknown>)) {
                  routeTaskTerminal.value = (vals as Record<string, unknown>).terminal;
                }
                return Promise.resolve([
                  {
                    id: TASK_ID,
                    status: routeTaskStatus.value,
                    completedAt: new Date(),
                    creditsReserved: null,
                  },
                ]);
              },
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
      update: (table: { __id?: string }) => {
        mutationCallCount.value += 1;
        return makeUpdateChain(table);
      },
      insert: (table: { __id?: string }) => ({
        values: (vals: unknown) => {
          mutationCallCount.value += 1;
          return makeInsertChain(table, vals);
        },
      }),
      delete: (_table: unknown) => {
        mutationCallCount.value += 1;
        return {
          where: (..._args: unknown[]) => Promise.resolve([]),
        };
      },
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

  const mockRunBuildPipeline = vi.fn();

  return {
    emittedEventRows,
    insertIdCounter,
    mutationCallCount,
    updateCallCount,
    routeTaskStatus,
    routeTaskTerminal,
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
    fakeNabuflowOrgSeatsTable,
    TASK_ID,
    PROJECT_ID,
    mockProject,
  };
});

// ── vi.mock() calls — all hoisted before any import ───────────────────────────

vi.mock("drizzle-orm", () => ({
  count: () => ({}),
  eq: () => ({}),
  ne: () => ({}),
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
  nabuflowOrgSeatsTable: fakeNabuflowOrgSeatsTable,
}));

vi.mock("./parallel-build-admission", () => ({
  PARALLEL_BUILD_ADMISSION_UNAVAILABLE_MESSAGE:
    "This build did not start because capacity checks are temporarily unavailable. Try again shortly.",
  resolveParallelBuildAdmissionScope: vi.fn(async (ownerId: string) => ({
    kind: "owner",
    ownerId,
    planId: "bounded-exempt",
    limit: 12,
    lockId: 1,
  })),
  evaluateParallelBuildAdmission: vi.fn((_scope: unknown, activeBuilds: number) => ({
    allowed: true,
    limit: 12,
    activeBuilds,
  })),
}));

// Auth: requireProjectOwnership passthrough — no Clerk required
vi.mock("./auth", () => ({
  requireProjectOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireProjectAccess: (_minRole: unknown) => (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  attachUser: (_req: unknown, _res: unknown, next: () => void) => next(),
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

vi.mock("./knowledge", () => ({
  writeKnowledge: vi.fn(),
  getInstalledBlueprintKnowledge: vi.fn().mockResolvedValue(null),
  inferStyleForUser: vi.fn().mockResolvedValue({ inferred: 0 }),
}));
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
vi.mock("./github", () => ({
  autoCommitProjectFiles: vi.fn().mockResolvedValue({ ok: true, sha: null }),
}));
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
  accumulateBuildTokens: vi.fn(),
  clearBuildTokenAccumulator: vi.fn(),
  flushBuildTokenTelemetry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./artifacts", () => ({ resolveArtifactId: vi.fn().mockResolvedValue(null) }));
vi.mock("./durable-queue", () => ({
  durableEnqueue: vi.fn().mockResolvedValue(null),
  isDurableQueueReady: vi.fn().mockReturnValue(false),
}));

// Prevent provisioning side-effects from leaking into the test suite.
// jobs.ts dynamically imports ./provisioning on stack upgrades; the mock
// ensures the import resolves without hitting the real DB.
vi.mock("./provisioning", () => ({
  enqueueProvisionProjectJob: vi.fn(),
  runProvisionProjectJob: vi.fn().mockResolvedValue(undefined),
}));

// Builder mock: blocks on AbortSignal, then rejects with the cancellation error
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

// ── event-bus is NOT mocked — real in-process pub/sub for SSE propagation ────

// ── Imports from modules under test (must come after all vi.mock() calls) ─────
import express from "express";
import tasksRouter from "../routes/tasks";
import eventsRouter from "../routes/events";
import { runCancellablePlanTask, runJob } from "./jobs";

// ── Test server helpers ───────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

/**
 * Read lines from an SSE stream until the provided predicate returns true for
 * a parsed data payload, or the AbortSignal fires, or the stream closes.
 * Returns the first matching payload — deterministic, no polling.
 */
async function waitForSseEvent<T extends object>(
  url: string,
  predicate: (payload: T) => boolean,
  timeoutMs = 5_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ac = new AbortController();
    const tid = setTimeout(() => {
      ac.abort();
      reject(new Error(`SSE event matching predicate not received within ${timeoutMs}ms`));
    }, timeoutMs);

    void fetch(url, { signal: ac.signal }).then(async (response) => {
      if (!response.ok) {
        clearTimeout(tid);
        reject(new Error(`SSE stream returned ${response.status}`));
        return;
      }
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE messages are delimited by "\n\n"
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLine = part.split("\n").find((l) => l.startsWith("data: "));
            if (!dataLine) continue;
            try {
              const payload = JSON.parse(dataLine.slice(6)) as T;
              if (predicate(payload)) {
                clearTimeout(tid);
                ac.abort();
                resolve(payload);
                return;
              }
            } catch {
              // Ignore malformed JSON lines
            }
          }
        }
      } catch (err) {
        if (!ac.signal.aborted) {
          clearTimeout(tid);
          reject(err);
        }
      }
    });
  });
}

// ── Suite setup/teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  // Disable the agentic builder so the legacy runBuildPipeline path is used,
  // avoiding the dynamic import of agent-loop.ts.
  process.env.AGENTIC_BUILDER_ENABLED = "false";

  // Builder: blocks until signal fires, then rejects with the canonical error
  // message that runJob's catch block recognises as a user-initiated cancel.
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

  // Create a minimal Express app with the real production routes.
  // Auth is bypassed via vi.mock("./auth") above — requireProjectOwnership
  // calls next() immediately so test requests pass without Clerk tokens.
  const app = express();
  app.use(express.json());
  // Ensure req.userId is set for any middleware that reads it directly
  app.use((req, _res, next) => {
    req.userId = "test-user";
    next();
  });
  app.use("/api", tasksRouter);
  app.use("/api", eventsRouter);

  // Listen on an OS-assigned port so tests never collide
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}/api`;
});

afterAll(async () => {
  delete process.env.AGENTIC_BUILDER_ENABLED;
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

afterEach(() => {
  emittedEventRows.length = 0;
  insertIdCounter.value = 1;
  mutationCallCount.value = 0;
  updateCallCount.value = 0;
  routeTaskStatus.value = "building";
  routeTaskTerminal.value = null;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Task #753 — Stop button: HTTP integration (real endpoints + real SSE)", () => {
  it("POST .../cancel returns HTTP 200 and the SSE stream emits a 'cancelled' event", async () => {
    // ── 1. Start a build (no real AI — builder blocks on signal) ──────────
    const jobPromise = runJob({
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind: "build",
      userPrompt: "Build a kanban board",
      agentMode: "lite",
    });

    // Give the job enough micro-task cycles to reach the builder pipeline.
    // Resolved promises in the setup path settle immediately, so a single
    // macro-task turn (setTimeout 0) is sufficient and deterministic.
    await new Promise<void>((r) => setTimeout(r, 0));

    // ── 2. Subscribe to the SSE stream BEFORE sending cancel ─────────────
    // This mirrors the browser: the client opens the stream first so no
    // event can slip through between the cancel call and stream open.
    const sseUrl = `${baseUrl}/projects/${PROJECT_ID}` + `/tasks/${TASK_ID}/events/stream`;

    const cancelledEventPromise = waitForSseEvent<{
      eventType: string;
      taskId: number;
      terminal?: unknown;
    }>(sseUrl, (e) => e.eventType === "cancelled");

    // ── 3. Call the real production cancel endpoint via HTTP ──────────────
    const cancelResp = await fetch(`${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, {
      method: "POST",
    });

    // ── 4. Assert HTTP response semantics ─────────────────────────────────
    expect(cancelResp.status).toBe(200);
    const cancelBody = (await cancelResp.json()) as { id: number; status: string };
    expect(cancelBody).toMatchObject({ id: TASK_ID, status: "canceled" });

    // ── 5. Assert SSE stream received the "cancelled" terminal event ──────
    // waitForSseEvent resolves as soon as the matching event arrives,
    // so this is event-driven — no polling or fixed delays.
    const sseEvent = await cancelledEventPromise;
    expect(sseEvent).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
      terminal: {
        schema: "zero-terminal-v1",
        outcome: "interrupted",
        runStatus: "interrupted",
        cause: "user_stop",
      },
    });

    // Wait for runJob to finish its catch/finally path
    await jobPromise;

    // ── 6. Assert task_events DB row was inserted for "cancelled" ─────────
    const cancelledRows = emittedEventRows.filter((r) => r.eventType === "cancelled");
    expect(cancelledRows).toHaveLength(1);
    expect(cancelledRows[0]).toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
      message: "This run was interrupted.",
    });
  }, 15_000);

  it("cancels a never-started queued task with exactly one cancelled event", async () => {
    routeTaskStatus.value = "queued";
    const cancelledEventPromise = waitForSseEvent<{ eventType: string; taskId: number }>(
      `${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/events/stream`,
      (event) => event.eventType === "cancelled",
    );

    const resp = await fetch(`${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, {
      method: "POST",
    });
    expect(resp.status, await resp.clone().text()).toBe(200);
    const body = (await resp.json()) as { id: number; status: string };
    expect(body).toMatchObject({ id: TASK_ID, status: "canceled" });

    await expect(cancelledEventPromise).resolves.toMatchObject({
      taskId: TASK_ID,
      eventType: "cancelled",
    });
    expect(emittedEventRows.filter((row) => row.eventType === "cancelled")).toHaveLength(1);
  }, 5_000);

  it("lets the cancel route own one canonical plan interruption event", async () => {
    routeTaskStatus.value = "planning";
    const terminalEvents: string[] = [];
    let planStarted = false;
    const planPromise = runCancellablePlanTask({
      taskId: TASK_ID,
      run: (signal) => {
        planStarted = true;
        return new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(new Error("Plan cancelled")), {
            once: true,
          });
        });
      },
      commitCompleted: async () => false,
      commitCanceled: async () => undefined,
      commitFailed: async () => false,
      emitTerminal: async (kind) => {
        terminalEvents.push(kind);
      },
    });
    await vi.waitFor(() => expect(planStarted).toBe(true));

    const resp = await fetch(`${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, {
      method: "POST",
    });
    expect(resp.status).toBe(200);
    await expect(resp.json()).resolves.toMatchObject({ id: TASK_ID, status: "canceled" });
    await expect(planPromise).resolves.toEqual({ status: "canceled" });
    expect(terminalEvents).toEqual(["cancelled"]);
    expect(emittedEventRows.filter((row) => row.eventType === "cancelled")).toHaveLength(1);
  });

  it("does not duplicate a queued cancellation when a terminal event already exists", async () => {
    routeTaskStatus.value = "queued";
    emittedEventRows.push({
      id: insertIdCounter.value++,
      taskId: TASK_ID,
      eventType: "cancelled",
      message: "Task cancelled by user.",
      filePath: null,
      createdAt: new Date(),
    });

    const resp = await fetch(`${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/cancel`, {
      method: "POST",
    });
    expect(resp.status).toBe(409);
    expect(emittedEventRows.filter((row) => row.eventType === "cancelled")).toHaveLength(1);
  }, 5_000);
});

describe("task event replay receipts", () => {
  const persistedTerminal = {
    schema: "zero-terminal-v1",
    outcome: "interrupted",
    runStatus: "interrupted",
    taskId: TASK_ID,
    intent: "mutate",
    intentReceiptId: 71,
    completedAt: "2026-08-19T18:00:01.000Z",
    cause: "user_stop",
    evidence: { lastPhase: "agent_loop", changedPaths: [] },
  };

  function seedReplay(terminalEventType: "completed" | "failed" | "cancelled"): void {
    routeTaskTerminal.value = persistedTerminal;
    emittedEventRows.push(
      {
        id: insertIdCounter.value++,
        taskId: TASK_ID,
        eventType: "file_diff",
        message: "Saved index.html",
        filePath: "index.html",
        createdAt: new Date("2026-08-19T18:00:00.000Z"),
      },
      {
        id: insertIdCounter.value++,
        taskId: TASK_ID,
        eventType: terminalEventType,
        message: `Task ${terminalEventType}`,
        filePath: null,
        createdAt: new Date("2026-08-19T18:00:01.000Z"),
      },
    );
  }

  it("keeps the persisted event read metadata-only", async () => {
    seedReplay("completed");
    const rowsBefore = structuredClone(emittedEventRows);

    const response = await fetch(`${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/events`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Array<{ terminal?: unknown }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.terminal).toBeUndefined();
    expect(body[1]?.terminal).toEqual(persistedTerminal);
    expect(mutationCallCount.value).toBe(0);
    expect(emittedEventRows).toEqual(rowsBefore);
  });

  it.each(["completed", "failed", "cancelled"] as const)(
    "replays history before the %s receipt, returns 200, and closes without writes",
    async (terminalEventType) => {
      seedReplay(terminalEventType);
      const rowsBefore = structuredClone(emittedEventRows);

      const response = await fetch(
        `${baseUrl}/projects/${PROJECT_ID}/tasks/${TASK_ID}/events/stream`,
      );
      const body = await response.text();
      const frames = body
        .trim()
        .split("\n\n")
        .map(
          (line) =>
            JSON.parse(line.replace(/^data: /, "")) as {
              eventType: string;
              terminal?: unknown;
            },
        );

      expect(response.status).toBe(200);
      expect(response.status).not.toBe(204);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(frames.map((frame) => frame.eventType)).toEqual(["file_diff", terminalEventType]);
      expect(frames[0]?.terminal).toBeUndefined();
      expect(frames[1]?.terminal).toEqual(persistedTerminal);
      expect(mutationCallCount.value).toBe(0);
      expect(emittedEventRows).toEqual(rowsBefore);
    },
  );
});
