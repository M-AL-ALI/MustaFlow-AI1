import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ wakeCalls: 0 }));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => parts,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

vi.mock("@workspace/db", () => {
  const project = {
    id: 51,
    builderMode: "agentic",
    containerId: "runtime-51",
    containerUrl: "https://runtime.example.test",
    containerStatus: "running",
    provisioningStatus: "ready",
    provisioningStep: null,
  };
  const query = {
    from: () => query,
    where: () => Promise.resolve([project]),
  };
  return {
    db: { select: () => query },
    projectsTable: {
      id: "projects.id",
      builderMode: "projects.builderMode",
      containerId: "projects.containerId",
      containerUrl: "projects.containerUrl",
      containerStatus: "projects.containerStatus",
      provisioningStatus: "projects.provisioningStatus",
      provisioningStep: "projects.provisioningStep",
      deletedAt: "projects.deletedAt",
    },
  };
});

vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleSession: (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next(),
}));

vi.mock("../lib/tenant-runtime", () => ({
  hasContainerLayerCredentials: () => true,
  ensureContainerAwake: vi.fn(async () => {
    state.wakeCalls += 1;
    return { ok: true, message: "ready" };
  }),
}));

vi.mock("../lib/logger", () => ({
  logger: { warn: vi.fn() },
}));

import developerModeRouter from "./developer-mode";

describe("developer mode runtime status purity", () => {
  beforeEach(() => {
    state.wakeCalls = 0;
  });

  it("keeps GET metadata-only and never wakes a runtime", async () => {
    const app = express();
    app.use(developerModeRouter);

    const response = await request(app).get("/projects/51/developer-mode/runtime-status");

    expect(response.status).toBe(200);
    expect(response.body.preflightOk).toBeNull();
    expect(state.wakeCalls).toBe(0);
  });

  it("runs the live wake only through the explicit mutation", async () => {
    const app = express();
    app.use(developerModeRouter);

    const response = await request(app).post("/projects/51/developer-mode/runtime-status/wake");

    expect(response.status).toBe(200);
    expect(response.body.preflightOk).toBe(true);
    expect(state.wakeCalls).toBe(1);
  });
});
