import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
  readProjectMemoryReconciliationSummary: vi.fn(),
  selectedRows: [] as unknown[],
}));

vi.mock("../../lib/auth", () => ({
  checkProjectAccess: mocks.checkProjectAccess,
  listAccessibleProjectIds: mocks.listAccessibleProjectIds,
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => mocks.selectedRows),
    })),
  }));
  return { ...original, db: { ...original.db, select } };
});

vi.mock("../../lib/adminAuth", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("../../lib/memory-reconciliation-reader", () => ({
  readProjectMemoryReconciliationSummary: mocks.readProjectMemoryReconciliationSummary,
}));
vi.mock("../../lib/embeddings", () => ({
  buildEmbeddingInput: vi.fn(() => ""),
  generateEmbedding: vi.fn(async () => null),
}));
vi.mock("../../lib/knowledge-promotion", () => ({ anonymiseContent: vi.fn((v) => v) }));
vi.mock("../credits", () => ({ getOrCreateCredits: vi.fn() }));

function appFor(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "requesting-user";
    next();
  });
  app.use(router);
  return app;
}

describe("authorization lockdown: data routes reject hostile resource identifiers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectedRows = [];
    mocks.checkProjectAccess.mockResolvedValue("not_member");
    mocks.listAccessibleProjectIds.mockResolvedValue([]);
    mocks.readProjectMemoryReconciliationSummary.mockResolvedValue({
      semantics: "zero-project-memory-reconciliation-summary-v1",
      status: "current",
      observedAt: "2026-08-25T23:00:00.000Z",
      counts: { confirmed: 2, stale: 0, unverifiable: 0 },
      surfaces: [],
    });
  });

  it("scopes GET /activity to projects accessible to the requesting user", async () => {
    const router = (await import("../activity")).default;
    const response = await request(appFor(router)).get("/activity");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mocks.listAccessibleProjectIds).toHaveBeenCalledWith("requesting-user", "viewer");
  });

  it("denies GET /knowledge for another user's project", async () => {
    const router = (await import("../knowledge")).default;
    const response = await request(appFor(router)).get("/knowledge?projectId=991");

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 991, "viewer");
  });

  it("denies the memory-health read for another user's project without revealing it", async () => {
    const router = (await import("../knowledge")).default;
    const response = await request(appFor(router)).get("/knowledge/reconciliation?projectId=991");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 991, "viewer");
    expect(mocks.readProjectMemoryReconciliationSummary).not.toHaveBeenCalled();
  });

  it("returns only the bounded memory-health projection to an authorized collaborator", async () => {
    mocks.checkProjectAccess.mockResolvedValue("granted");
    const router = (await import("../knowledge")).default;
    const response = await request(appFor(router)).get("/knowledge/reconciliation?projectId=52");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      semantics: "zero-project-memory-reconciliation-summary-v1",
      status: "current",
      observedAt: "2026-08-25T23:00:00.000Z",
      counts: { confirmed: 2, stale: 0, unverifiable: 0 },
      surfaces: [],
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /memoryRecord|evidenceIdentity|checks|content/,
    );
    expect(mocks.readProjectMemoryReconciliationSummary).toHaveBeenCalledWith(52);
  });

  it("denies POST /knowledge for another user's project", async () => {
    const router = (await import("../knowledge")).default;
    const response = await request(appFor(router)).post("/knowledge").send({
      title: "Scoped note",
      content: "Content",
      projectId: 992,
    });

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 992, "member");
  });

  it("denies POST /knowledge/:id/rate for a private entry in another project", async () => {
    mocks.selectedRows = [
      {
        id: 42,
        userId: "different-user",
        projectId: 993,
        isPublic: false,
        approvedForReuse: false,
      },
    ];
    const router = (await import("../knowledge")).default;
    const response = await request(appFor(router))
      .post("/knowledge/42/rate")
      .send({ rating: "up" });

    expect(response.status).toBe(404);
    expect(mocks.checkProjectAccess).toHaveBeenCalledWith("requesting-user", 993, "viewer");
  });
});
