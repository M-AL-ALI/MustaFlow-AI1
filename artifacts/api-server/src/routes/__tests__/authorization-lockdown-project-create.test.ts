import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

const tenancy = vi.hoisted(() => {
  class Unavailable extends Error {
    readonly code = "project_workspace_unavailable";
  }
  return {
    Unavailable,
    resolveProjectWorkspaceId: vi.fn(async () => {
      throw new Unavailable();
    }),
  };
});

const effects = vi.hoisted(() => ({
  insert: vi.fn(() => {
    throw new Error("insert must not occur after workspace denial");
  }),
  enqueue: vi.fn(),
  containerConfigured: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => []) })),
  }));
  return { ...original, db: { ...original.db, select, insert: effects.insert } };
});
vi.mock("../../lib/jobs", () => ({ resolveAgentIdentity: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("../../lib/provisioning", () => ({
  enqueueProvisionProjectJob: effects.enqueue,
  provisionPreviewDb: vi.fn(),
  getRollingAverageMs: vi.fn(),
}));
vi.mock("../../lib/tenant-runtime", () => ({
  isContainerLayerConfigured: effects.containerConfigured,
}));
vi.mock("../../lib/stack-selection", () => ({ resolveInitialStackSelection: vi.fn() }));
vi.mock("../../lib/runtime-manifest", () => ({ resolveProjectRuntimeManifest: vi.fn() }));
vi.mock("../../lib/zero-sealed-generation", () => ({
  requiresDirectProjectDatabaseProvisioning: vi.fn(),
  resolveZeroProjectDeploymentType: vi.fn(),
  resolveZeroProjectRuntimePort: vi.fn(),
}));
vi.mock("../../lib/workspace-tenancy", () => ({
  ProjectWorkspaceUnavailableError: tenancy.Unavailable,
  resolveProjectWorkspaceId: tenancy.resolveProjectWorkspaceId,
}));

describe("authorization lockdown: project workspace selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("passes a binding destination and denies before insertion or provisioning", async () => {
    const router = (await import("../projects")).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = "requesting-user";
      next();
    });
    app.use(router);

    const response = await request(app).post("/projects").send({
      name: "Scoped project",
      kind: "web",
      workspaceId: 770,
    });

    expect(tenancy.resolveProjectWorkspaceId).toHaveBeenCalledWith({
      userId: "requesting-user",
      requestedWorkspaceId: 770,
    });
    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "project_workspace_unavailable" });
    expect(effects.insert).not.toHaveBeenCalled();
    expect(effects.enqueue).not.toHaveBeenCalled();
    expect(effects.containerConfigured).not.toHaveBeenCalled();
  });
});
