import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    selectRows: [] as unknown[],
    updateValues: [] as Array<Record<string, unknown>>,
    operationOrder: [] as string[],
    capturedController: null as AbortController | null,
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    runRefinePipeline: vi.fn(),
    acquireProjectLifecycleSession: vi.fn(),
    registerProjectWorkController: vi.fn(),
    unregisterWork: vi.fn(),
    releaseLifecycle: vi.fn(),
    assertActive: vi.fn(),
  };
});

function selectQuery(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    innerJoin: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(async () => rows),
    limit: vi.fn(async () => rows),
    then: <TResult1 = unknown[], TResult2 = never>(
      onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
      onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ) => Promise.resolve(rows).then(onfulfilled, onrejected),
  };
  query.from.mockReturnValue(query);
  query.innerJoin.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

function updateQuery() {
  return {
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(async () => {
        mocks.updateValues.push(values);
        mocks.operationOrder.push(`write:${String(values.status ?? "unknown")}`);
        return [];
      }),
    })),
  };
}

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => selectQuery(mocks.selectRows));
  mocks.update.mockImplementation(updateQuery);
  return {
    ...actual,
    db: {
      select: mocks.select,
      update: mocks.update,
      insert: mocks.insert,
      delete: mocks.delete,
    },
  };
});

vi.mock("@clerk/express", () => ({ getAuth: vi.fn(() => ({ userId: "owner-51" })) }));

vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/builder", () => ({
  guessMime: vi.fn(() => "text/plain"),
  runRefinePipeline: mocks.runRefinePipeline,
}));

vi.mock("../lib/consoleBridge", () => ({
  injectBridge: vi.fn((html: string) => html),
  MOCK_FLAG_SCRIPT: "",
}));

vi.mock("../lib/project-file-asset-reference", () => ({
  resolveProjectFileBytes: vi.fn(),
}));

vi.mock("../lib/knowledge", () => ({ writeKnowledge: vi.fn() }));
vi.mock("../lib/canvas-variant-graduation", () => ({
  graduateCanvasVariantAtomically: vi.fn(),
}));

vi.mock("../lib/project-lifecycle", () => ({
  acquireProjectLifecycleSession: mocks.acquireProjectLifecycleSession,
  registerProjectWorkController: mocks.registerProjectWorkController,
  holdResponseProjectLifecycleSession: vi.fn(() => vi.fn(async () => undefined)),
  responseProjectLifecycleSession: vi.fn(() => ({
    projectId: 51,
    assertActive: vi.fn(async () => true),
  })),
}));

import canvasRouter, { runCanvasVariantGeneration } from "./canvas";

const generationInput = {
  variantId: 701,
  projectId: 51,
  projectName: "Lifecycle test",
  projectKind: "web",
  basePrompt: "Show a safe project lifecycle",
  direction: "Use a restrained layout",
  existingFiles: [],
};

function appAsOwner() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "owner-51";
    next();
  });
  app.use(canvasRouter);
  return app;
}

describe("canvas retirement behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.updateValues = [];
    mocks.operationOrder = [];
    mocks.capturedController = null;
    mocks.assertActive.mockResolvedValue(true);
    mocks.releaseLifecycle.mockImplementation(async () => {
      mocks.operationOrder.push("release");
    });
    mocks.registerProjectWorkController.mockImplementation(
      (_projectId: number, controller: AbortController) => {
        mocks.capturedController = controller;
        return mocks.unregisterWork;
      },
    );
  });

  it("does no provider or database work when the detached lifecycle admission is inactive", async () => {
    mocks.acquireProjectLifecycleSession.mockResolvedValue(null);

    await runCanvasVariantGeneration(generationInput);

    expect(mocks.acquireProjectLifecycleSession).toHaveBeenCalledWith(51);
    expect(mocks.runRefinePipeline).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.unregisterWork).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLifecycle).not.toHaveBeenCalled();
  });

  it("serializes Trash cancellation before the detached terminal receipt and lock release", async () => {
    mocks.acquireProjectLifecycleSession.mockResolvedValue({
      projectId: 51,
      assertActive: mocks.assertActive,
      release: mocks.releaseLifecycle,
    });
    mocks.runRefinePipeline.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("Build cancelled")), {
            once: true,
          });
        }),
    );

    const generation = runCanvasVariantGeneration(generationInput);
    await vi.waitFor(() => expect(mocks.runRefinePipeline).toHaveBeenCalledTimes(1));
    expect(mocks.capturedController).not.toBeNull();
    mocks.capturedController!.abort();
    await generation;

    expect(mocks.updateValues.map((values) => values.status)).toEqual(["generating", "failed"]);
    expect(mocks.operationOrder).toEqual(["write:generating", "write:failed", "release"]);
    expect(mocks.unregisterWork).toHaveBeenCalledTimes(1);
  });

  it("keeps the Canvas variants GET metadata-only with zero DML", async () => {
    const response = await request(appAsOwner()).get("/projects/51/canvas/variants");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ variants: [] });
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
