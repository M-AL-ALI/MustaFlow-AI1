import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
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

describe("authorization lockdown: project workspace selection", () => {
  it("denies POST /projects when workspaceId belongs to another user", async () => {
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

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Workspace not found" });
  });
});
