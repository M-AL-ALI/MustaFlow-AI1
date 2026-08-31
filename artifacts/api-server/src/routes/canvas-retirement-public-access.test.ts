import express, { type IRouter } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    selectResults: [] as unknown[][],
    metricWrites: 0,
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  };
});

function selectQuery(rows: unknown[]) {
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
}

function updateQuery() {
  const query = {
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(async () => {
      mocks.metricWrites += 1;
      return [{ id: 801 }];
    }),
  };
  query.set.mockReturnValue(query);
  query.where.mockReturnValue(query);
  return query;
}

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  mocks.select.mockImplementation(() => selectQuery(mocks.selectResults.shift() ?? []));
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
  guessMime: vi.fn(() => "text/html"),
  runRefinePipeline: vi.fn(),
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
  acquireProjectLifecycleSession: vi.fn(),
  holdResponseProjectLifecycleSession: vi.fn(() => vi.fn(async () => undefined)),
  registerProjectWorkController: vi.fn(() => vi.fn()),
  responseProjectLifecycleSession: vi.fn(() => ({
    projectId: 51,
    assertActive: vi.fn(async () => true),
  })),
}));

import canvasRouter, { publicCanvasRouter } from "./canvas";

const activeVariant = {
  id: 701,
  projectId: 51,
  explorationId: "exploration-1",
  label: "Active variant",
  prompt: "Render the active variant",
  status: "ready",
  files: [
    {
      path: "index.html",
      content: "<!doctype html><html><body>active canvas</body></html>",
      mimeType: "text/html",
    },
  ],
  assistantSummary: null,
  errorMessage: null,
  rank: 1,
  source: "explore",
  variantParentId: null,
  savedToLibrary: false,
  shareToken: "share-active-701",
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  updatedAt: new Date("2026-08-31T00:00:00.000Z"),
  lastViewedAt: new Date("2026-08-31T00:00:00.000Z"),
};

const activeTest = {
  id: 801,
  projectId: 51,
  variantAId: 701,
  variantBId: 702,
  trafficSplitPct: 50,
  metric: "conversions",
  status: "running",
  winnerId: null,
  viewsA: 0,
  viewsB: 0,
  conversionsA: 0,
  conversionsB: 0,
  createdAt: new Date("2026-08-31T00:00:00.000Z"),
  endedAt: null,
};

function appWith(router: IRouter) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "owner-51";
    next();
  });
  app.use(router);
  return app;
}

const routeCopies = [
  { name: "authenticated canvas router", router: canvasRouter },
  { name: "public canvas router", router: publicCanvasRouter },
] as const;

describe.each(routeCopies)("canvas retirement access through $name", ({ router }) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectResults = [];
    mocks.metricWrites = 0;
  });

  it("serves an active shared variant", async () => {
    mocks.selectResults = [[activeVariant]];

    const response = await request(appWith(router)).get("/canvas/share/share-active-701/");

    expect(response.status).toBe(200);
    expect(response.text).toContain("active canvas");
    expect(mocks.metricWrites).toBe(0);
  });

  it("returns 404 for a shared variant whose project is tombstoned", async () => {
    // The active-project inner join deliberately yields no row.
    mocks.selectResults = [[]];

    const response = await request(appWith(router)).get("/canvas/share/share-retired-701/");

    expect(response.status).toBe(404);
    expect(mocks.metricWrites).toBe(0);
  });

  it("serves an active A/B test and records its view", async () => {
    mocks.selectResults = [[activeTest], [activeVariant]];

    const response = await request(appWith(router)).get("/canvas/ab/801/");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.status).toBe(200);
    expect(response.text).toContain("active canvas");
    expect(mocks.metricWrites).toBe(1);
  });

  it("returns 404 for a tombstoned A/B test without writing a view metric", async () => {
    // The active-project inner join deliberately yields no row.
    mocks.selectResults = [[]];

    const response = await request(appWith(router)).get("/canvas/ab/801/");
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(response.status).toBe(404);
    expect(mocks.metricWrites).toBe(0);
  });

  it("records a conversion for an active A/B test", async () => {
    // Kept in the queue for the active-project lookup at the conversion boundary.
    mocks.selectResults = [[activeTest]];

    const response = await request(appWith(router))
      .post("/canvas/ab-tests/801/convert")
      .send({ variant: "a" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ recorded: true });
    expect(mocks.metricWrites).toBe(1);
  });

  it("returns 404 for a tombstoned A/B conversion without metric DML", async () => {
    // The active-project lookup deliberately yields no row.
    mocks.selectResults = [[]];

    const response = await request(appWith(router))
      .post("/canvas/ab-tests/801/convert")
      .send({ variant: "a" });

    expect(response.status).toBe(404);
    expect(mocks.metricWrites).toBe(0);
  });
});
