import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  updateCalls: 0,
  liveStatus: "stopped",
  liveError: false,
  sealedTarget: true,
  resumeCalls: 0,
  resumeError: null as Error | null,
  warning: null as unknown,
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

vi.mock("../lib/zero-sealed-generation", () => ({
  resolveZeroGenerationTarget: vi.fn(() => "cloudflare"),
  isZeroSealedGenerationTarget: vi.fn(() => state.sealedTarget),
}));

vi.mock("../lib/sealed-preview-resume", () => ({
  SealedPreviewResumeError: class SealedPreviewResumeError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  resumeAcceptedProjectPreview: vi.fn(async () => {
    state.resumeCalls += 1;
    if (state.resumeError !== null) throw state.resumeError;
    return {
      identity: "runtime-52",
      manifestRevision: "manifest-52",
      status: "running",
      endpoint: null,
    };
  }),
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
import { CloudflareRuntimeControlError } from "../lib/cloudflare-runtime-provider";

describe("container status read purity", () => {
  beforeEach(() => {
    state.updateCalls = 0;
    state.liveStatus = "stopped";
    state.liveError = false;
    state.sealedTarget = true;
    state.resumeCalls = 0;
    state.resumeError = null;
    state.warning = null;
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

  it("does not trust a stored running label when waking a stopped sealed preview", async () => {
    const app = express();
    app.use(express.json());
    app.use(containersRouter);

    const response = await request(app).post("/projects/52/container/start");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      containerId: "runtime-52",
      containerStatus: "running",
    });
    expect(state.resumeCalls).toBe(1);
    expect(state.updateCalls).toBe(1);
  });

  it("replays an explicit sealed-preview wake even when the provider label is running", async () => {
    state.liveStatus = "running";
    const app = express();
    app.use(express.json());
    app.use(containersRouter);

    const response = await request(app).post("/projects/52/container/start");

    expect(response.status).toBe(200);
    expect(response.body.containerStatus).toBe("running");
    expect(state.resumeCalls).toBe(1);
    expect(state.updateCalls).toBe(1);
  });

  it("records only sanitized provider evidence when a sealed-preview wake fails", async () => {
    state.resumeError = new CloudflareRuntimeControlError(
      409,
      "artifact_not_committed",
      false,
      "provider response body must not be logged",
    );
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.log = {
        warn: (details: unknown) => {
          state.warning = details;
        },
      } as never;
      next();
    });
    app.use(containersRouter);

    const response = await request(app).post("/projects/52/container/start");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "The preview could not be woken yet. Please try again.",
      code: "preview_resume_unavailable",
    });
    expect(state.warning).toEqual({
      projectId: 52,
      code: "preview_resume_failed",
      providerFailure: {
        class: "CloudflareRuntimeControlError",
        status: 409,
        code: "artifact_not_committed",
        retryable: false,
        transportCause: null,
      },
    });
    expect(JSON.stringify(state.warning)).not.toContain("provider response body");
    expect(state.updateCalls).toBe(0);
  });

  it("does not mutate after an ambiguous provider status failure", async () => {
    state.liveError = true;
    state.sealedTarget = false;
    const app = express();
    app.use(express.json());
    app.use(containersRouter);

    const response = await request(app).post("/projects/52/container/start");

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      error: "We could not check the preview just now. Please try again.",
      code: "preview_status_unavailable",
    });
    expect(state.resumeCalls).toBe(0);
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
