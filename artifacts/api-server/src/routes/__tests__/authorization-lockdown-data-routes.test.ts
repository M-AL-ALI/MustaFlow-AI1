import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test"),
  checkProjectAccess: vi.fn(),
  listAccessibleProjectIds: vi.fn(),
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
    mocks.checkProjectAccess.mockResolvedValue("denied");
    mocks.listAccessibleProjectIds.mockResolvedValue([]);
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
