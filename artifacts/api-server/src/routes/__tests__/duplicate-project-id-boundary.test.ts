import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});
const state = vi.hoisted(() => {
  class Unavailable extends Error {
    readonly code = "project_workspace_unavailable";
  }
  return {
    Unavailable,
    reads: [] as Array<{ table: string; id: unknown }>,
    resolve: vi.fn(),
    insert: vi.fn(),
    provision: vi.fn(),
  };
});
vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const fixtures = new Map([
    [12, { id: 12, ownerId: "caller", workspaceId: 7, name: "Owned project", deletedAt: null }],
    [
      120,
      {
        id: 120,
        ownerId: "another-user",
        workspaceId: 41,
        name: "Private victim project",
        deletedAt: null,
      },
    ],
  ]);
  return {
    ...original,
    db: {
      select: () => ({
        from: (table: Parameters<typeof getTableName>[0]) => ({
          where: async (condition: SQL) => {
            const id = new PgDialect().sqlToQuery(condition).params[0];
            const name = getTableName(table);
            state.reads.push({ table: name, id });
            if (name === "projects") {
              const project = fixtures.get(Number(id));
              return project ? [project] : [];
            }
            return [];
          },
        }),
      }),
      insert: state.insert,
    },
  };
});
vi.mock("../../lib/workspace-tenancy", () => ({
  ProjectWorkspaceUnavailableError: state.Unavailable,
  resolveProjectWorkspaceId: state.resolve,
}));
vi.mock("../../lib/knowledge", () => ({ writeKnowledge: vi.fn() }));
vi.mock("../../lib/provisioning", () => ({ enqueueProvisionProjectJob: state.provision }));
vi.mock("../../lib/project-file-asset-usage", () => ({ reconcileProjectFileAssetUsage: vi.fn() }));

async function appFor(userId: string | null = "caller") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.userId = userId;
    next();
  });
  const { requireProjectOwnership } = await import("../../lib/auth");
  app.get("/owned/:id", requireProjectOwnership, (req, res) => {
    res.json({ projectId: Number(req.params.id) });
  });
  app.use((await import("../duplicate")).default);
  return app;
}

describe("Project ownership and copy use the same numeric identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.reads = [];
    // Stop the legitimate copy control after source access, before any writes/provider work.
    state.resolve.mockRejectedValue(new state.Unavailable());
  });

  it.each([
    "12e1",
    "12.0",
    "0xC",
    "+12",
    "12trailing",
    "12/120",
    "-12",
    "0",
    "2147483648",
    "9007199254740992",
  ])("rejects ambiguous or out-of-range source %s before ownership lookup", async (raw) => {
    const result = await request(await appFor()).post(
      `/projects/${encodeURIComponent(raw)}/duplicate`,
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "Invalid project id" });
    expect(state.reads).toEqual([]);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });

  it.each(["12", "0012", "%31%32"])(
    "preserves owner access with a consistently interpreted digit ID %s",
    async (id) => {
      const result = await request(await appFor()).get(`/owned/${id}`);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ projectId: 12 });
      expect(state.reads).toEqual([{ table: "projects", id: 12 }]);
    },
  );

  it("never reads another project's files or destination after a valid foreign ID is denied", async () => {
    const result = await request(await appFor()).post("/projects/120/duplicate");
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: "Project not found" });
    expect(state.reads).toEqual([{ table: "projects", id: 120 }]);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
  });

  it("checks authentication before project existence or syntax", async () => {
    const result = await request(await appFor(null)).post("/projects/12e1/duplicate");
    expect(result.status).toBe(401);
    expect(state.reads).toEqual([]);
  });

  it("uses the owned source consistently through the real copy route", async () => {
    const result = await request(await appFor()).post("/projects/12/duplicate");
    expect(result.status).toBe(409);
    expect(state.reads).toEqual([
      { table: "projects", id: 12 },
      { table: "projects", id: 12 },
      { table: "project_files", id: 12 },
    ]);
    expect(state.resolve).toHaveBeenCalledWith({ userId: "caller", preferredWorkspaceId: 7 });
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.provision).not.toHaveBeenCalled();
  });
});
