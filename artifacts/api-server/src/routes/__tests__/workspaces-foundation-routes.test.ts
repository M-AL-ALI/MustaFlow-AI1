import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  createOwnedWorkspace: vi.fn(),
}));

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({
          where: () => {
            const query = {
              orderBy: async () => mocks.rows,
              then: <TResult1 = unknown, TResult2 = never>(
                onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
                onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
              ) => Promise.resolve(mocks.rows).then(onfulfilled, onrejected),
            };
            return query;
          },
        }),
      }),
    },
  };
});

vi.mock("../../lib/workspace-foundation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/workspace-foundation")>();
  return { ...actual, createOwnedWorkspace: mocks.createOwnedWorkspace };
});

function workspace(id: number, ownerUserId = "owner-a") {
  return {
    id,
    ownerUserId,
    systemKey: "fixture-system-key",
    name: "Display label",
    description: null,
    type: "personal",
    deletedAt: null,
    createdAt: new Date("2026-08-18T00:00:00.000Z"),
    updatedAt: new Date("2026-08-18T00:00:00.000Z"),
  };
}

async function appFor(userId = "owner-a") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use((await import("../workspaces")).default);
  return app;
}

describe("workspace foundation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows = [];
  });

  it("keeps GET /workspaces a pure read", async () => {
    mocks.rows = [workspace(1)];

    const response = await request(await appFor()).get("/workspaces");

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      expect.objectContaining({ id: 1, ownerUserId: "owner-a", name: "Display label" }),
    ]);
    expect(response.body[0]).not.toHaveProperty("systemKey");
    expect(mocks.createOwnedWorkspace).not.toHaveBeenCalled();
  });

  it("returns the existing non-enumerating denial for another workspace id", async () => {
    mocks.rows = [];

    const response = await request(await appFor("owner-a")).get("/workspaces/999");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Workspace not found" });
  });

  it("returns an owned workspace by id on the positive path", async () => {
    mocks.rows = [workspace(7)];

    const response = await request(await appFor()).get("/workspaces/7");

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: 7, ownerUserId: "owner-a" });
    expect(response.body).not.toHaveProperty("systemKey");
  });

  it("creates a workspace through the transactional owner-membership helper", async () => {
    mocks.createOwnedWorkspace.mockResolvedValue(workspace(8));

    const response = await request(await appFor())
      .post("/workspaces")
      .send({
        name: "Team label",
        description: "Display copy",
        type: "team",
      });

    expect(response.status).toBe(201);
    expect(mocks.createOwnedWorkspace).toHaveBeenCalledWith({
      ownerUserId: "owner-a",
      name: "Team label",
      description: "Display copy",
      type: "team",
    });
    expect(response.body).not.toHaveProperty("systemKey");
  });
});
