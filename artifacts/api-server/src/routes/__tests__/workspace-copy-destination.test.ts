import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});
const mocks = vi.hoisted(() => {
  class Unavailable extends Error {
    readonly code = "project_workspace_unavailable";
  }
  return {
    Unavailable,
    results: [] as unknown[][],
    resolve: vi.fn(),
    insert: vi.fn(),
    provision: vi.fn(),
  };
});
vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...original,
    db: {
      select: () => ({ from: () => ({ where: async () => mocks.results.shift() ?? [] }) }),
      insert: mocks.insert,
    },
  };
});
vi.mock("../../lib/auth", () => ({
  requireProjectOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/workspace-tenancy", () => ({
  ProjectWorkspaceUnavailableError: mocks.Unavailable,
  resolveProjectWorkspaceId: mocks.resolve,
}));
vi.mock("../../lib/knowledge", () => ({ writeKnowledge: vi.fn() }));
vi.mock("../../lib/provisioning", () => ({ enqueueProvisionProjectJob: mocks.provision }));
vi.mock("../../lib/project-file-asset-usage", () => ({ reconcileProjectFileAssetUsage: vi.fn() }));

describe("Copy workspace placement contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.results = [];
  });
  it("uses the source as an internal preference, not an explicit destination supplied by the request", async () => {
    mocks.results.push([{ id: 12, workspaceId: 8, name: "Source" }], []);
    mocks.resolve.mockRejectedValue(new mocks.Unavailable());
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = "project-owner";
      next();
    });
    app.use((await import("../duplicate")).default);
    const result = await request(app)
      .post("/projects/12/duplicate")
      .send({ workspaceId: 999, preferredWorkspaceId: 999 });
    expect(mocks.resolve).toHaveBeenCalledWith({
      userId: "project-owner",
      preferredWorkspaceId: 8,
    });
    expect(result.status).toBe(409);
    expect(result.body).toEqual({ error: "project_workspace_unavailable" });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.provision).not.toHaveBeenCalled();
  });
});
