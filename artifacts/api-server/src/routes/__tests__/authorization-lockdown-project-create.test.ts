import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

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

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => []) })),
  }));
  return { ...original, db: { ...original.db, select } };
});
vi.mock("../../lib/jobs", () => ({ resolveAgentIdentity: vi.fn(), enqueueJob: vi.fn() }));
vi.mock("../../lib/provisioning", () => ({
  enqueueProvisionProjectJob: vi.fn(),
  provisionPreviewDb: vi.fn(),
  getRollingAverageMs: vi.fn(),
}));
vi.mock("../../lib/tenant-runtime", () => ({ isContainerLayerConfigured: vi.fn() }));
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
  it("passes a caller hint to the central selector and returns its typed fail-closed outcome", async () => {
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
  });
});
