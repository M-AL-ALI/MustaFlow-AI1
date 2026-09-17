import express from "express";
import request from "supertest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { SubmitTaskFeedbackResponse } from "@workspace/api-zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    select: vi.fn(),
    update: vi.fn(),
    projects: [] as Row[],
    tasks: [] as Row[],
    writes: [] as number[],
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { select: mocks.select, update: mocks.update } };
});
vi.mock("../lib/jobs", () => ({
  enqueueJob: vi.fn(),
  applyTaskAgentStaging: vi.fn(),
  discardTaskAgentStaging: vi.fn(),
  runAppTestingJob: vi.fn(),
  cancelActiveJob: vi.fn(),
  drainNextProjectTask: vi.fn(),
}));
vi.mock("./credits", () => ({ refundCredits: vi.fn() }));
vi.mock("../lib/zero-terminal-persistence", () => ({
  persistInterruptedZeroTerminal: vi.fn(),
}));
vi.mock("../lib/zero-intent-admission", () => ({ governIntentAdmission: vi.fn() }));
vi.mock("../lib/billing-settlement-outbox", () => ({
  taskCreditSettlementKey: (id: number) => "task-" + id + "-pipeline",
}));

import { projectsTable, agentTasksTable } from "@workspace/db";
import tasksRouter from "./tasks";

const dialect = new PgDialect();
const privateMarker = "SYNTHETIC_PRIVATE_REJECTED_DRAFT_JRN227";
const toProperty = (name: string) =>
  name.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

// Evaluate actual Drizzle predicates instead of returning preselected rows:
// an omitted project condition must cause the foreign-task tests to fail.
function matches(row: Row, predicate: SQL): boolean {
  const query = dialect.sqlToQuery(predicate);
  const terms = query.sql.replace(/[()]/g, "").split(" and ");
  return terms.every((term) => {
    const equal = /^"[^"]+"\."([^"]+)" = \$(\d+)$/.exec(term.trim());
    if (equal) {
      return row[toProperty(equal[1]!)] === query.params[Number(equal[2]) - 1];
    }
    const absent = /^"[^"]+"\."([^"]+)" is null$/.exec(term.trim());
    if (absent) return row[toProperty(absent[1]!)] === null;
    throw new Error("Unsupported test predicate: " + term);
  });
}

function application(userId = "owner-a") {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  server.use(tasksRouter);
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects = [
    { id: 1001, ownerId: "owner-a", deletedAt: null },
    { id: 1002, ownerId: "owner-b", deletedAt: null },
    { id: 1003, ownerId: "owner-a", deletedAt: null },
    { id: 1004, ownerId: "owner-a", deletedAt: new Date("2026-09-01") },
  ];
  mocks.tasks = [1001, 1002, 1003, 1004].map((projectId, index) => ({
    id: 2001 + index,
    projectId,
    title: "Synthetic recovery task",
    kind: "main",
    status: "failed",
    createdAt: new Date("2026-09-17T00:00:00Z"),
    userFeedback: null,
    stagingSnapshot: { files: [{ path: "src/private.ts", content: privateMarker }] },
    report: { userRequest: privateMarker },
    prompt: privateMarker,
    result: privateMarker,
    internalOnly: privateMarker,
  }));
  mocks.writes = [];
  mocks.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async (predicate: SQL) => {
        expect(table).toBe(projectsTable);
        return structuredClone(mocks.projects.filter((row) => matches(row, predicate)));
      },
    }),
  }));
  mocks.update.mockImplementation((table: unknown) => {
    expect(table).toBe(agentTasksTable);
    return {
      set: (values: Row) => ({
        where: (predicate: SQL) => ({
          returning: async (selection?: Record<string, { name: string }>) =>
            mocks.tasks
              .filter((row) => matches(row, predicate))
              .map((row) => {
                Object.assign(row, values);
                mocks.writes.push(Number(row.id));
                return selection
                  ? Object.fromEntries(
                      Object.entries(selection).map(([key, column]) => [
                        key,
                        row[toProperty(column.name)],
                      ]),
                    )
                  : structuredClone(row);
              }),
        }),
      }),
    };
  });
});

describe("task feedback project isolation", () => {
  it.each(["positive", "negative"])(
    "accepts owner %s feedback without source",
    async (feedback) => {
      const snapshot = structuredClone(mocks.tasks[0]!.stagingSnapshot);
      const response = await request(application())
        .patch("/projects/1001/tasks/2001/feedback")
        .send({ feedback });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ id: 2001, projectId: 1001, userFeedback: feedback });
      expect(SubmitTaskFeedbackResponse.safeParse(response.body).success).toBe(true);
      expect(Object.keys(response.body).sort()).toEqual(
        ["id", "projectId", "title", "kind", "status", "userFeedback", "createdAt"].sort(),
      );
      expect(JSON.stringify(response.body)).not.toContain(privateMarker);
      expect(mocks.tasks[0]!.stagingSnapshot).toEqual(snapshot);
      expect(mocks.writes).toEqual([2001]);
    },
  );

  it.each([2002, 2003, 2999])(
    "rejects foreign or missing task %s without writing",
    async (taskId) => {
      const before = structuredClone(mocks.tasks);
      const response = await request(application())
        .patch("/projects/1001/tasks/" + taskId + "/feedback")
        .send({ feedback: "positive" });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Task not found" });
      expect(mocks.tasks).toEqual(before);
      expect(mocks.writes).toEqual([]);
    },
  );

  it.each(["002002", "2002e0", "0x7d2", "2002.0", "%32%30%30%32"])(
    "keeps equivalent foreign task encoding %s inside the same project boundary",
    async (taskId) => {
      const response = await request(application())
        .patch("/projects/1001/tasks/" + taskId + "/feedback")
        .send({ feedback: "positive" });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Task not found" });
      expect(mocks.writes).toEqual([]);
    },
  );

  it.each(["001001", "1001"])(
    "preserves valid project spelling %s and feedback replay",
    async (projectId) => {
      const server = application();
      const url = "/projects/" + projectId + "/tasks/002001/feedback";
      const first = await request(server).patch(url).send({ feedback: "positive" });
      const second = await request(server).patch(url).send({ feedback: "positive" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(second.body).toEqual(first.body);
      expect(mocks.writes).toEqual([2001, 2001]);
    },
  );

  it.each(["1001e0", "1001.0", "-1001", "0", "2147483648", "1001suffix"])(
    "rejects malformed project identifier %s before any update",
    async (projectId) => {
      const response = await request(application())
        .patch("/projects/" + projectId + "/tasks/2001/feedback")
        .send({ feedback: "positive" });
      expect(response.status).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([1002, 1004, 1999])("hides unowned, retired or absent project %s", async (projectId) => {
    const response = await request(application())
      .patch("/projects/" + projectId + "/tasks/2001/feedback")
      .send({ feedback: "positive" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated feedback before reading or writing", async () => {
    const response = await request(application(""))
      .patch("/projects/1001/tasks/2001/feedback")
      .send({ feedback: "positive" });
    expect(response.status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it.each([{}, { feedback: "unknown" }, { feedback: null }, { feedback: ["positive"] }])(
    "rejects invalid feedback body %j without writing",
    async (body) => {
      const response = await request(application())
        .patch("/projects/1001/tasks/2001/feedback")
        .send(body);
      expect(response.status).toBe(400);
      expect(mocks.update).not.toHaveBeenCalled();
    },
  );

  it.each([
    "queued",
    "answering",
    "planning",
    "building",
    "testing",
    "needs_approval",
    "needs_review",
    "needs_fix",
    "completed",
    "failed",
    "canceled",
    "discarded",
  ])("preserves valid feedback for %s tasks", async (status) => {
    mocks.tasks[0]!.status = status;
    const response = await request(application())
      .patch("/projects/1001/tasks/2001/feedback")
      .send({ feedback: "positive" });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe(status);
    expect(SubmitTaskFeedbackResponse.safeParse(response.body).success).toBe(true);
    expect(mocks.writes).toEqual([2001]);
  });
});
