import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return { rows: [] as unknown[][], select: vi.fn(), cancel: vi.fn() };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { select: mocks.select } };
});
vi.mock("../lib/jobs", () => ({ cancelActiveJob: mocks.cancel }));

import cancellationSignalRouter from "./task-cancellation-signal";
import { projectMutationLifecycleProjectId } from "../lib/project-lifecycle";

const path = "/projects/7/tasks/42/cancel";
const task = { id: 42, projectId: 7, status: "building", intentReceiptId: 67 };

function app(userId: string | null = "owner") {
  const server = express();
  const fence = vi.fn();
  server.use((req, _res, next) => {
    if (userId !== null) req.userId = userId;
    next();
  });
  server.use(cancellationSignalRouter);
  server.use((req, res) => {
    fence(projectMutationLifecycleProjectId({ method: req.method, path: req.path }));
    res.status(503).json({ code: "test_lifecycle_fence_still_closed" });
  });
  return { server, fence };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows = [[{ id: 7, ownerId: "owner" }], [task]];
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

describe("owner-authorized stop signal before lifecycle admission", () => {
  it.each(["queued", "planning", "building"])(
    "signals %s work before the fence, without claiming cancellation succeeded",
    async (status) => {
      mocks.rows[1] = [{ ...task, status }];
      const { server, fence } = app();
      const response = await request(server).post(path);
      expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(42);
      expect(fence).toHaveBeenCalledExactlyOnceWith(7);
      expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(
        fence.mock.invocationCallOrder[0],
      );
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ code: "test_lifecycle_fence_still_closed" });
      expect(mocks.select).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["stranger", "collaborator", "staff"])(
    "does not let %s signal another owner's work",
    async (user) => {
      const { server, fence } = app(user);
      const response = await request(server).post(path);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ error: "Project not found" });
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(fence).not.toHaveBeenCalled();
      expect(mocks.select).toHaveBeenCalledTimes(1);
    },
  );

  it("does not signal for an unauthenticated request", async () => {
    const { server, fence } = app(null);
    expect((await request(server).post(path)).status).toBe(401);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
  });

  it("keeps a missing or retired project non-revealing", async () => {
    mocks.rows = [[]];
    const { server, fence } = app();
    const response = await request(server).post(path);
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
  });

  it.each([undefined, { ...task, projectId: 8 }, { ...task, id: 99 }])(
    "never signals a missing or cross-project task: %j",
    async (row) => {
      mocks.rows[1] = row ? [row] : [];
      const { server, fence } = app();
      expect((await request(server).post(path)).status).toBe(404);
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(fence).not.toHaveBeenCalled();
    },
  );

  it.each(["failed", "completed", "cancelled"])(
    "does not signal terminal %s work",
    async (status) => {
      mocks.rows[1] = [{ ...task, status }];
      const { server, fence } = app();
      expect((await request(server).post(path)).status).toBe(409);
      expect(mocks.cancel).not.toHaveBeenCalled();
      expect(fence).not.toHaveBeenCalled();
    },
  );

  it.each([null, 0, -1, 1.5])("rejects an invalid intent receipt %s", async (intentReceiptId) => {
    mocks.rows[1] = [{ ...task, intentReceiptId }];
    const { server, fence } = app();
    expect((await request(server).post(path)).status).toBe(409);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
  });

  it("rejects an ambiguous project identity before any lookup", async () => {
    const { server, fence } = app();
    expect((await request(server).post("/projects/7e0/tasks/42/cancel")).status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(fence).not.toHaveBeenCalled();
  });

  it("does not signal on another mutation route", async () => {
    const { server, fence } = app();
    expect((await request(server).post("/projects/7/tasks/42/steer")).status).toBe(503);
    expect(fence).toHaveBeenCalledExactlyOnceWith(7);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.cancel).not.toHaveBeenCalled();
  });
});
