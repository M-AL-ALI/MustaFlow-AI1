import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@127.0.0.1:1/test"),
  connect: vi.fn(),
  select: vi.fn(),
  selectResults: [] as unknown[][],
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => {
    const rows = mocks.selectResults.shift() ?? [];
    const query = {
      from: vi.fn(),
      innerJoin: vi.fn(),
      where: vi.fn(),
      orderBy: vi.fn(),
      limit: vi.fn(async () => rows),
      then: <TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => Promise.resolve(rows).then(onfulfilled, onrejected),
    };
    query.from.mockReturnValue(query);
    query.innerJoin.mockReturnValue(query);
    query.where.mockReturnValue(query);
    query.orderBy.mockReturnValue(query);
    return query;
  });
  return {
    ...original,
    db: { ...original.db, select: mocks.select },
    pool: { connect: mocks.connect },
  };
});

import {
  abortLocalProjectWork,
  acquireProjectLifecycleSession,
  projectMutationLifecycleProjectId,
  registerProjectWorkController,
  requireActiveProjectLifecycleFor,
  requireActiveProjectMutationLifecycleSession,
  withActiveProjectLifecycle,
} from "./project-lifecycle";

function responseHarness(): Response & EventEmitter {
  return Object.assign(new EventEmitter(), {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }) as unknown as Response & EventEmitter;
}

function mockActiveLifecycleLock(projectId: number): ReturnType<typeof vi.fn> {
  const release = vi.fn();
  mocks.connect.mockResolvedValue({
    release,
    query: vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ id: projectId }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] }),
  });
  return release;
}

describe("project lifecycle sessions", () => {
  const lateMutationPaths = [
    ["GitHub manual connection", "/projects/9201/github/connect"],
    ["GitHub push", "/projects/9201/github/push"],
    ["GitHub branch creation", "/projects/9201/github/create-branch"],
    ["GitHub pull-request creation", "/projects/9201/github/open-pr"],
    ["share-link creation", "/projects/9201/share"],
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
  });

  it("holds one dedicated advisory-lock connection until final persistence releases it", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 51 }] })
      .mockResolvedValueOnce({ rows: [{ id: 51 }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });

    const session = await acquireProjectLifecycleSession(51);

    expect(session).not.toBeNull();
    expect(release).not.toHaveBeenCalled();
    await expect(session!.assertActive()).resolves.toBe(true);
    expect(release).not.toHaveBeenCalled();
    await session!.release();
    await session!.release();

    expect(query.mock.calls[0]?.[0]).toContain("pg_try_advisory_lock");
    expect(query.mock.calls[1]?.[0]).toContain("deleted_at IS NULL");
    expect(query.mock.calls[3]?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("refuses an already tombstoned project before caller work can begin", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });

    await expect(acquireProjectLifecycleSession(51)).resolves.toBeNull();

    expect(query.mock.calls[2]?.[0]).toContain("pg_advisory_unlock");
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("classifies ordinary project mutations while excluding reads and lifecycle transitions", () => {
    expect(
      projectMutationLifecycleProjectId({ method: "POST", path: "/projects/51/messages" }),
    ).toBe(51);
    expect(
      projectMutationLifecycleProjectId({ method: "PATCH", path: "/projects/51/secrets/9" }),
    ).toBe(51);
    expect(
      projectMutationLifecycleProjectId({ method: "GET", path: "/projects/51/messages" }),
    ).toBe(null);
    expect(projectMutationLifecycleProjectId({ method: "DELETE", path: "/projects/51" })).toBe(
      null,
    );
    expect(
      projectMutationLifecycleProjectId({ method: "POST", path: "/projects/51/restore" }),
    ).toBe(null);
    expect(
      projectMutationLifecycleProjectId({
        method: "POST",
        path: "/projects/51/retirement/retry",
      }),
    ).toBe(null);
    expect(
      projectMutationLifecycleProjectId({ method: "POST", path: "/projects/0051/messages" }),
    ).toBe(51);
    expect(projectMutationLifecycleProjectId({ method: "DELETE", path: "/projects/0051" })).toBe(
      null,
    );
    expect(
      projectMutationLifecycleProjectId({ method: "POST", path: "/projects/51/RESTORE/" }),
    ).toBe(null);
    expect(
      projectMutationLifecycleProjectId({
        method: "POST",
        path: "/projects/0051/RETIREMENT/RETRY/",
      }),
    ).toBe(null);
    expect(
      projectMutationLifecycleProjectId({
        method: "POST",
        path: "/projects/51/retirement/retry-later",
      }),
    ).toBe(51);
    expect(projectMutationLifecycleProjectId({ method: "DELETE", path: "/projects/51/" })).toBe(
      null,
    );
  });

  it.each(lateMutationPaths)("classifies %s as a project lifecycle mutation", (_name, path) => {
    expect(projectMutationLifecycleProjectId({ method: "POST", path })).toBe(9201);
  });

  it.each(lateMutationPaths)(
    "refuses %s after the project is tombstoned without starting caller work",
    async (_name, path) => {
      mocks.selectResults = [[]];
      const response = responseHarness();
      const next = vi.fn() as NextFunction;

      await requireActiveProjectMutationLifecycleSession(
        {
          userId: "owner-9201",
          method: "POST",
          path,
        } as unknown as Request,
        response,
        next,
      );

      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.json).toHaveBeenCalledWith({ error: "Project not found" });
      expect(next).not.toHaveBeenCalled();
      expect(mocks.connect).not.toHaveBeenCalled();
    },
  );

  it.each(lateMutationPaths)(
    "holds the response lifecycle lock across successful async %s work",
    async (_name, path) => {
      mocks.selectResults = [[{ ownerId: "owner-9201", organizationId: null }]];
      const release = mockActiveLifecycleLock(9201);
      const response = responseHarness();
      const next = vi.fn() as NextFunction;

      await requireActiveProjectMutationLifecycleSession(
        {
          userId: "owner-9201",
          method: "POST",
          path,
        } as unknown as Request,
        response,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();

      response.emit("finish");
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    },
  );

  it("leaves governed retirement retry to its tombstone-aware owner and admin boundary", async () => {
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        method: "POST",
        path: "/projects/51/retirement/retry",
      } as unknown as Request,
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(response.status).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated mutation before any project read or advisory-lock checkout", async () => {
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        method: "POST",
        path: "/projects/9101/messages",
      } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.json).toHaveBeenCalledWith({ error: "Unauthenticated" });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("does not turn an overflow project id into a database or advisory-lock operation", async () => {
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "hostile-caller",
        method: "PATCH",
        path: "/projects/9007199254740992/secrets/1",
      } as unknown as Request,
      response,
      next,
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("hides an existing hostile project id and never checks out its advisory-lock connection", async () => {
    mocks.selectResults = [[{ ownerId: "real-owner", organizationId: null }], [], [], []];
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "hostile-caller",
        method: "POST",
        path: "/projects/9102/messages",
      } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: "Project not found" });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledTimes(4);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("rejects a missing project without consulting stale support grants or acquiring a lock", async () => {
    mocks.selectResults = [[]];
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "support-user",
        method: "DELETE",
        path: "/projects/9103/domains/7",
      } as unknown as Request,
      response,
      next,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({ error: "Project not found" });
    expect(next).not.toHaveBeenCalled();
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("admits a project owner before acquiring the response-scoped lock", async () => {
    mocks.selectResults = [[{ ownerId: "owner-9104", organizationId: null }]];
    const release = mockActiveLifecycleLock(9104);
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "owner-9104",
        method: "POST",
        path: "/projects/9104/messages",
      } as unknown as Request,
      response,
      next,
    );

    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit("finish");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("admits a viewer collaborator before acquiring the response-scoped lock", async () => {
    mocks.selectResults = [[{ ownerId: "owner-9105", organizationId: null }], [{ role: "viewer" }]];
    const release = mockActiveLifecycleLock(9105);
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "viewer-9105",
        method: "PATCH",
        path: "/projects/9105/files/1",
      } as unknown as Request,
      response,
      next,
    );

    expect(mocks.select).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit("finish");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("admits staff with a live project-scoped support grant before acquiring the lock", async () => {
    mocks.selectResults = [
      [{ ownerId: "owner-9106", organizationId: null }],
      [],
      [],
      [
        {
          id: 106,
          projectId: 9106,
          staffUserId: "support-9106",
          status: "active",
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    ];
    const release = mockActiveLifecycleLock(9106);
    const response = responseHarness();
    const next = vi.fn() as NextFunction;

    await requireActiveProjectMutationLifecycleSession(
      {
        userId: "support-9106",
        method: "POST",
        path: "/projects/9106/messages",
      } as unknown as Request,
      response,
      next,
    );

    expect(mocks.select).toHaveBeenCalledTimes(4);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    response.emit("finish");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("acquires one response-scoped lock even when central and route-local fences both run", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ id: 51 }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const release = vi.fn();
    mocks.connect.mockResolvedValue({ query, release });
    const response = Object.assign(new EventEmitter(), {
      locals: {},
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    }) as unknown as Response;
    const request = {
      userId: "owner-51",
      method: "POST",
      path: "/projects/51/messages",
      params: { id: "51" },
    } as unknown as Request;
    const next = vi.fn() as NextFunction;
    mocks.selectResults = [[{ ownerId: "owner-51", organizationId: null }]];

    await requireActiveProjectMutationLifecycleSession(request, response, next);
    await requireActiveProjectLifecycleFor(51, response, next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(mocks.connect).toHaveBeenCalledTimes(1);
    (response as unknown as EventEmitter).emit("finish");
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });

  it("aborts every registered non-agent work unit for the retired project only", () => {
    const project51a = new AbortController();
    const project51b = new AbortController();
    const project52 = new AbortController();
    const unregister51a = registerProjectWorkController(51, project51a);
    const unregister51b = registerProjectWorkController(51, project51b);
    const unregister52 = registerProjectWorkController(52, project52);

    expect(abortLocalProjectWork(51)).toBe(2);
    expect(project51a.signal.aborted).toBe(true);
    expect(project51b.signal.aborted).toBe(true);
    expect(project52.signal.aborted).toBe(false);

    unregister51a();
    unregister51b();
    unregister52();
  });

  it("lets Trash wait for an in-flight provider receipt, then removes every created surface", async () => {
    let locked = false;
    let active = true;
    const clients: Array<{ release: ReturnType<typeof vi.fn> }> = [];
    mocks.connect.mockImplementation(async () => {
      const release = vi.fn();
      clients.push({ release });
      return {
        release,
        query: vi.fn(async (statement: string) => {
          if (statement.includes("pg_try_advisory_lock")) {
            if (locked) return { rows: [{ acquired: false }] };
            locked = true;
            return { rows: [{ acquired: true }] };
          }
          if (statement.includes("deleted_at IS NULL")) {
            return { rows: active ? [{ id: 51 }] : [] };
          }
          if (statement.includes("pg_advisory_unlock")) {
            locked = false;
            return { rows: [{ unlocked: true }] };
          }
          throw new Error(`unexpected query: ${statement}`);
        }),
      };
    });

    const model = {
      providerResources: [] as string[],
      pointers: [] as string[],
      routes: [] as string[],
      domains: [] as string[],
      easBuilds: [] as string[],
    };
    let providerCreated!: () => void;
    const created = new Promise<void>((resolve) => (providerCreated = resolve));
    let allowProviderReceipt!: () => void;
    const receiptBarrier = new Promise<void>((resolve) => (allowProviderReceipt = resolve));

    const providerMutation = withActiveProjectLifecycle(51, async (session) => {
      model.providerResources.push("runtime-51");
      providerCreated();
      await receiptBarrier;
      expect(await session.assertActive()).toBe(true);
      model.pointers.push("runtime-51");
      model.routes.push("route-51");
      model.domains.push("app.example.test");
      model.easBuilds.push("eas-51");
    });
    await created;

    let trashAccepted = false;
    const trash = (async () => {
      const session = await acquireProjectLifecycleSession(51);
      expect(session).not.toBeNull();
      trashAccepted = true;
      active = false;
      model.providerResources.length = 0;
      model.pointers.length = 0;
      model.routes.length = 0;
      model.domains.length = 0;
      model.easBuilds.length = 0;
      await session!.release();
    })();

    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(trashAccepted).toBe(false);
    allowProviderReceipt();
    await providerMutation;
    await trash;

    expect(active).toBe(false);
    expect(model).toEqual({
      providerResources: [],
      pointers: [],
      routes: [],
      domains: [],
      easBuilds: [],
    });
    expect(clients.every(({ release }) => release.mock.calls.length === 1)).toBe(true);
  });
});
