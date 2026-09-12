import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import * as ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentModelRequestError,
  buildAgentModelFailureReport,
  type AgentModelRequestDiagnostic,
} from "./agent-model-request";

const store = vi.hoisted(() => ({
  transaction: vi.fn(),
  update: vi.fn(),
  taskSet: vi.fn(),
  insert: vi.fn(),
  eventValues: vi.fn(),
  publish: vi.fn(),
  notifyPreview: vi.fn(),
  existingTerminal: false,
  taskAvailable: true,
  order: [] as string[],
}));

vi.mock("@workspace/db", () => ({
  db: { transaction: store.transaction },
  agentTasksTable: { id: "task.id", status: "task.status" },
  taskEventsTable: { id: "event.id", taskId: "event.taskId", eventType: "event.type" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  inArray: (...values: unknown[]) => values,
}));
vi.mock("./event-bus", () => ({ publishTaskEvent: store.publish }));
vi.mock("./automatic-preview-dispatch", () => ({
  notifyAutomaticPreviewForTask: store.notifyPreview,
}));

import { persistFailedZeroTerminal } from "./zero-terminal-persistence";

// Execute the actual narrow catch without importing the queue/worker startup module.
function loadEmptyRefineRetryHandler() {
  const source = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
  const parsed = ts.createSourceFile("jobs.ts", source, ts.ScriptTarget.Latest, true);
  const matches: ts.CatchClause[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node) && node.getText(parsed).includes("Empty-refine retry pass failed")) {
      matches.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  if (matches.length !== 1) {
    throw new Error("Expected exactly one production empty-refine retry handler");
  }
  const compiled = ts.transpileModule(
    `(function (err: unknown, logger: { warn: (...args: unknown[]) => void }) {
      const taskId = 316;
      const projectId = 61;
      try { throw err; } ${matches[0].getText(parsed)}
      return "original-result";
    })`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  );
  return new Script(compiled.outputText, {
    filename: "empty-refine-retry-handler.test.js",
  }).runInNewContext({ AgentModelRequestError }, { timeout: 1_000 }) as (
    error: unknown,
    logger: { warn: (...args: unknown[]) => void },
  ) => string;
}

const handleEmptyRefineRetryFailure = loadEmptyRefineRetryHandler();

function failureWithPartialLoop(
  code: AgentModelRequestError["code"] = "agent_model_request_timeout",
  classification: AgentModelRequestDiagnostic["classification"] = "request-timeout",
): AgentModelRequestError {
  const failure = new AgentModelRequestError(code, {
    taskId: 316,
    projectId: 61,
    stage: "refine",
    phase: "model-request",
    step: 9,
    attempt: 2,
    requestTimeoutMs: 180_000,
    elapsedMs: 394_000,
    remainingMs: 200_000,
    classification,
    recoveryAttempted: true,
    recoveryScheduled: false,
  });
  failure.attachLoopReport({
    stack: "node-api",
    steps: 2,
    stepCap: 60,
    wallClockElapsedMs: 394_000,
    wallClockBudgetMs: 600_000,
    totalToolCalls: 2,
    totalTokens: 123,
    terminationReason: "model-stopped",
    completionKind: "model_stopped",
    toolCalls: [
      {
        step: 1,
        tool: "write_file",
        args: { path: "package.json", content: "PRIVATE_PAYLOAD_MUST_NOT_LEAK" },
        ok: true,
        durationMs: 12,
        preview: "PRIVATE_PAYLOAD_MUST_NOT_LEAK",
      },
    ],
    commandsRun: [
      {
        step: 2,
        argv: ["PRIVATE_PAYLOAD_MUST_NOT_LEAK"],
        exitCode: 1,
        durationMs: 14,
        stdoutPreview: "PRIVATE_PAYLOAD_MUST_NOT_LEAK",
        stderrPreview: "PRIVATE_PAYLOAD_MUST_NOT_LEAK",
      },
    ],
    checkResults: [
      {
        id: "syntax",
        label: "PRIVATE_PAYLOAD_MUST_NOT_LEAK",
        passed: false,
        durationMs: 3,
        message: "PRIVATE_PAYLOAD_MUST_NOT_LEAK",
      },
    ],
    skillsLoaded: [],
  });
  return failure;
}

beforeEach(() => {
  vi.clearAllMocks();
  store.existingTerminal = false;
  store.taskAvailable = true;
  store.order = [];
  store.taskSet.mockImplementation(() => {
    store.order.push("task");
    return {
      where: () => ({
        returning: async () => (store.taskAvailable ? [{ id: 316 }] : []),
      }),
    };
  });
  store.update.mockImplementation(() => ({ set: store.taskSet }));
  store.eventValues.mockImplementation((value: Record<string, unknown>) => {
    store.order.push("event");
    return { returning: async () => [{ id: 9001, ...value }] };
  });
  store.insert.mockImplementation(() => ({ values: store.eventValues }));
  store.transaction.mockImplementation(
    async (callback: (tx: Record<string, unknown>) => Promise<unknown>) => {
      store.order.push("begin");
      const result = await callback({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => (store.existingTerminal ? [{ id: 9000 }] : []),
            }),
          }),
        }),
        update: store.update,
        insert: store.insert,
      });
      store.order.push("commit");
      return result;
    },
  );
  store.publish.mockImplementation(() => {
    store.order.push("publish");
  });
});

describe("agent model failure report handoff", () => {
  it.each([
    ["agent_model_request_timeout", "request-timeout"],
    ["agent_model_run_budget_exhausted", "run-budget-exhausted"],
    ["agent_model_request_aborted", "unattributed-abort"],
    ["agent_model_request_rejected", "access-rejected"],
  ] as const)(
    "does not reuse an empty result after classified retry failure %s",
    (code, classification) => {
      const failure = failureWithPartialLoop(code, classification);
      const logger = { warn: vi.fn() };
      expect(() => handleEmptyRefineRetryFailure(failure, logger)).toThrow(failure);
      expect(logger.warn).not.toHaveBeenCalled();
    },
  );

  it("preserves the existing fallback for unrelated retry errors", () => {
    const failure = new Error("Unrelated correction failed");
    const logger = { warn: vi.fn() };
    expect(handleEmptyRefineRetryFailure(failure, logger)).toBe("original-result");
    expect(logger.warn).toHaveBeenCalledWith(
      { err: failure, taskId: 316, projectId: 61 },
      expect.stringContaining("using original result"),
    );
  });

  it("does not classify an unrelated error by its name alone", () => {
    const failure = new Error("Unrelated failure");
    failure.name = "AgentModelRequestError";
    expect(handleEmptyRefineRetryFailure(failure, { warn: vi.fn() })).toBe("original-result");
  });

  it("retains primary failure and loop metadata without leaking tool payloads or claiming no edits", () => {
    const failure = failureWithPartialLoop();
    const report = buildAgentModelFailureReport(failure, "Build persistent notes.");
    expect(report.failureEvidence?.code).toBe("agent_model_request_timeout");
    expect(report.agentLoop).toMatchObject({
      terminationReason: "agent_model_request_timeout",
      totalToolCalls: 2,
      totalTokens: 123,
      toolCalls: [{ tool: "write_file", ok: true, args: {}, durationMs: 12 }],
      checkResults: [{ id: "syntax", passed: false }],
    });
    expect(report.previewUpdated).toBe(false);
    expect(report.syntaxValid).toBeUndefined();
    expect(report.validationReport).toBeUndefined();
    expect(report.warnings.join(" ")).toContain("Earlier file edits may still be present");
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_PAYLOAD_MUST_NOT_LEAK");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PAYLOAD_MUST_NOT_LEAK");
    expect(report.suggestions?.length).toBeGreaterThan(0);
  });

  it("commits the typed report with the failed terminal before publishing, without preview dispatch", async () => {
    const failure = failureWithPartialLoop();
    let propagated: unknown;
    try {
      handleEmptyRefineRetryFailure(failure, { warn: vi.fn() });
    } catch (error) {
      propagated = error;
    }
    expect(propagated).toBe(failure);
    const report = buildAgentModelFailureReport(failure, "Build persistent notes.");
    const result = await persistFailedZeroTerminal({
      taskId: 316,
      intent: "mutate",
      intentReceiptId: 77,
      completedAt: "2026-09-10T17:21:05.560Z",
      cause: { code: failure.code, stage: "mutation" },
      summary: failure.message,
      allowedStatuses: ["building", "planning", "needs_review", "needs_fix"],
      taskUpdate: {
        tokenCount: 123,
        report,
        failureReason: failure.message,
        completionKind: failure.completionKind,
      },
    });
    expect(result.persisted).toBe(true);
    expect(store.taskSet).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        report,
        failureReason: failure.message,
        completionKind: "model_stopped",
        terminal: expect.objectContaining({
          outcome: "failed",
          cause: { code: "agent_model_request_timeout", stage: "mutation" },
        }),
      }),
    );
    expect(store.eventValues).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 316,
        eventType: "failed",
        data: expect.objectContaining({ outcome: "failed" }),
      }),
    );
    expect(store.order).toEqual(["begin", "task", "event", "commit", "publish"]);
    expect(store.notifyPreview).not.toHaveBeenCalled();
  });

  it("distinguishes candidate file edits from accepted project output without storing source", () => {
    const failure = failureWithPartialLoop();
    failure.attachUncommittedWorkspace({
      changedFileCount: 6,
      removedFileCount: 0,
      unchangedFileCount: 3,
    });
    const report = buildAgentModelFailureReport(failure, "Build persistent notes.");
    expect(report.failureEvidence?.evidence?.workspace).toEqual({
      state: "not_committed",
      changedFileCount: 6,
      removedFileCount: 0,
      unchangedFileCount: 3,
    });
    expect(report.filesCreated).toEqual([]);
    expect(report.filesChanged).toEqual([]);
    expect(report.previewUpdated).toBe(false);
    expect(report.warnings.join(" ")).toContain("not committed to a saved project version");
    expect(JSON.stringify(report)).not.toContain("PRIVATE_PAYLOAD_MUST_NOT_LEAK");
  });

  it.each(["existing-terminal", "status-changed"])(
    "respects the existing terminal/status gate (%s)",
    async (condition) => {
      store.existingTerminal = condition === "existing-terminal";
      store.taskAvailable = condition !== "status-changed";
      const failure = failureWithPartialLoop();
      const result = await persistFailedZeroTerminal({
        taskId: 316,
        intent: "mutate",
        intentReceiptId: 77,
        cause: { code: failure.code, stage: "mutation" },
        summary: failure.message,
        allowedStatuses: ["building", "planning"],
        taskUpdate: { report: buildAgentModelFailureReport(failure, "Build persistent notes.") },
      });
      expect(result.persisted).toBe(false);
      if (store.existingTerminal) expect(store.update).not.toHaveBeenCalled();
      expect(store.eventValues).not.toHaveBeenCalled();
      expect(store.publish).not.toHaveBeenCalled();
      expect(store.notifyPreview).not.toHaveBeenCalled();
    },
  );
});
