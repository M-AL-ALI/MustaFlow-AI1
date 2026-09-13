import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    rows: [] as unknown[][],
    select: vi.fn(),
    cancel: vi.fn(),
    persist: vi.fn(),
    refund: vi.fn(),
  };
});
vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { select: mocks.select } };
});
vi.mock("../lib/jobs", () => ({
  cancelActiveJob: mocks.cancel,
  enqueueJob: vi.fn(),
  applyTaskAgentStaging: vi.fn(),
  discardTaskAgentStaging: vi.fn(),
  runAppTestingJob: vi.fn(),
  drainNextProjectTask: vi.fn(),
}));
vi.mock("./credits", () => ({ refundCredits: mocks.refund }));
vi.mock("../lib/zero-terminal-persistence", () => ({
  persistInterruptedZeroTerminal: mocks.persist,
}));
vi.mock("../lib/zero-intent-admission", () => ({ governIntentAdmission: vi.fn() }));
vi.mock("../lib/billing-settlement-outbox", () => ({
  taskCreditSettlementKey: (id: number) => `task-${id}-pipeline`,
}));

import signalRouter from "./task-cancellation-signal";
import tasksRouter from "./tasks";
import { projectMutationLifecycleProjectId } from "../lib/project-lifecycle";

const owner = { id: 7, ownerId: "owner" };
const active = {
  id: 42,
  projectId: 7,
  status: "building",
  kind: "main",
  intentReceiptId: 67,
  creditsReserved: 10,
  terminal: null,
};
const stopped = {
  ...active,
  status: "canceled",
  creditsReserved: null,
  terminal: {
    schema: "zero-terminal-v1",
    taskId: 42,
    intent: "mutate",
    intentReceiptId: 67,
    completedAt: "2026-09-13T00:00:00.000Z",
    outcome: "interrupted",
    runStatus: "interrupted",
    cause: "user_stop",
    evidence: { lastPhase: "agent_loop", changedPaths: [] },
  },
};
const path = "/projects/7/tasks/42/cancel";

function app() {
  const server = express();
  const fence = vi.fn();
  server.use((req, _res, next) => {
    req.userId = "owner";
    next();
  });
  server.use(signalRouter);
  server.use((req, _res, next) => {
    fence(projectMutationLifecycleProjectId({ method: req.method, path: req.path }));
    next();
  });
  server.use(tasksRouter);
  return { server, fence };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [];
  mocks.refund.mockResolvedValue(undefined);
  mocks.persist.mockResolvedValue({ persisted: false });
  mocks.select.mockImplementation(() => {
    const rows = mocks.rows.shift() ?? [];
    const query = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(async () => rows),
      then: <TResult1 = unknown[], TResult2 = never>(
        fulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        rejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(fulfilled, rejected),
    };
    query.from.mockReturnValue(query);
    query.where.mockReturnValue(query);
    return query;
  });
});

describe("Stop acknowledgement across the lifecycle fence", () => {
  it("acknowledges the worker's Stop when it finishes before the fenced handler reads", async () => {
    mocks.rows = [[owner], [active], [owner], [stopped]];
    const { server, fence } = app();
    const response = await request(server).post(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(stopped);
    expect(fence).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(42);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("acknowledges the worker winning the terminal CAS without repeating settlement", async () => {
    mocks.rows = [[owner], [active], [owner], [active], [stopped]];
    const response = await request(app().server).post(path);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(stopped);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.refund).not.toHaveBeenCalled();
  });

  it("returns the same terminal on replay without another cancellation or refund", async () => {
    mocks.rows = [[owner], [active], [owner], [active], [stopped], [owner]];
    mocks.persist.mockResolvedValue({ persisted: true });
    const { server, fence } = app();
    const first = await request(server).post(path);
    expect(first.status).toBe(200);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
    const signals = mocks.cancel.mock.calls.length;

    mocks.rows.push([owner], [stopped], [owner], [stopped]);
    const second = await request(server).post(path);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(fence).toHaveBeenCalledTimes(2);
    expect(mocks.cancel).toHaveBeenCalledTimes(signals);
    expect(mocks.persist).toHaveBeenCalledTimes(1);
    expect(mocks.refund).toHaveBeenCalledTimes(1);
  });

  it.each(["client_disconnect", "superseded"])(
    "does not relabel an unrelated %s interruption as the requested Stop",
    async (cause) => {
      mocks.rows = [
        [owner],
        [active],
        [owner],
        [active],
        [{ ...stopped, terminal: { ...stopped.terminal, cause } }],
      ];
      expect((await request(app().server).post(path)).status).toBe(409);
      expect(mocks.refund).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a completed task if completion won the race", async () => {
    mocks.rows = [[owner], [active], [owner], [{ ...active, status: "completed" }]];
    expect((await request(app().server).post(path)).status).toBe(409);
    expect(mocks.persist).not.toHaveBeenCalled();
    expect(mocks.refund).not.toHaveBeenCalled();
  });
});
