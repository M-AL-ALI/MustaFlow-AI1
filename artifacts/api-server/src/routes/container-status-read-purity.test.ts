import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updateCalls: 0,
  liveStatus: "stopped",
  liveError: false,
}));

const tables = vi.hoisted(() => ({
  projectsTable: {
    id: "projects.id",
    deletedAt: "projects.deletedAt",
  },
  projectFilesTable: { projectId: "projectFiles.projectId" },
  containerLogsTable: {
    id: "containerLogs.id",
    projectId: "containerLogs.projectId",
    createdAt: "containerLogs.createdAt",
  },
}));

vi.mock("drizzle-orm", () => ({
  and: (...parts: unknown[]) => ({ and: parts }),
  desc: (value: unknown) => value,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

vi.mock("@workspace/db", () => {
  const project = {
    id: 52,
    containerId: "runtime-52",
    containerStatus: "running",
    containerUrl: "https://runtime.example.test",
  };
  const query = {
    from: () => query,
    where: () => Promise.resolve([project]),
  };
  return {
    ...tables,
    db: {
      select: () => query,
      update: () => {
        state.updateCalls += 1;
        return { set: () => ({ where: () => Promise.resolve() }) };
      },
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

vi.mock("../lib/tenant-runtime", () => ({
  provisionContainer: vi.fn(),
  hibernateContainer: vi.fn(),
  getContainerStatus: vi.fn(async () => {
    if (state.liveError) throw new Error("provider weather");
    return state.liveStatus;
  }),
  execInContainer: vi.fn(),
  destroyContainer: vi.fn(),
  ensureContainerLogTailer: vi.fn(),
  recordContainerLog: vi.fn(),
  tenantRuntimeProvider: { providerId: "cloudflare" },
}));

vi.mock("../lib/event-bus", () => ({
  subscribeContainerLogs: vi.fn(() => () => undefined),
}));
vi.mock("../lib/container-secrets", () => ({
  getContainerSecretMap: vi.fn(async () => ({})),
}));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/preview-access", () => ({
  deriveConfiguredPreviewAccess: vi.fn(() => ({ kind: "ready" })),
}));

import containersRouter from "./containers";

describe("container status read purity", () => {
  beforeEach(() => {
    state.updateCalls = 0;
    state.liveStatus = "stopped";
    state.liveError = false;
  });

  it("reports the observed runtime state without writing project state", async () => {
    const app = express();
    app.use(containersRouter);

    const response = await request(app).get("/projects/52/container/status");

    expect(response.status).toBe(200);
    expect(response.body.containerStatus).toBe("stopped");
    expect(state.updateCalls).toBe(0);
  });

  it("does not write when the provider observation fails", async () => {
    state.liveError = true;
    const app = express();
    app.use(containersRouter);
    app.use(
      (
        _error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => res.status(503).json({ error: "unavailable" }),
    );

    const response = await request(app).get("/projects/52/container/status");

    expect(response.status).toBe(503);
    expect(state.updateCalls).toBe(0);
  });

  it("reports unavailable metrics instead of fabricating resource usage", async () => {
    const app = express();
    app.use(containersRouter);

    const response = await request(app).get("/projects/52/resources");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      metricsAvailable: false,
      reason: "provider_metrics_unavailable",
      cpuPercent: null,
      ramMb: null,
      ramLimitMb: null,
      diskMb: null,
      diskLimitMb: null,
      status: "running",
    });
  });
});
