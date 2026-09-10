import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetRecentActivityQueryParams } from "@workspace/api-zod";

const mocks = vi.hoisted(() => ({
  accessibleProjectIds: vi.fn<(userId: string, role: string) => Promise<number[]>>(),
  execute:
    vi.fn<
      (sql: string, params: unknown[], method: "all" | "execute") => Promise<{ rows: unknown[][] }>
    >(),
}));

vi.mock("../lib/auth", () => ({
  listAccessibleProjectIds: mocks.accessibleProjectIds,
}));

vi.mock("@workspace/db", async () => {
  // Import the public schema-only entrypoint, not the PostgreSQL pool module.
  // Only execution is mocked: real tables, operators, joins, dialect compilation
  // and select builders remain in the route's path.
  const schema = await import("@workspace/db/schema");
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { ...schema, db: drizzle(mocks.execute) };
});

import activityRouter from "./activity";

const userId = "activity-viewer";
const accessibleIds = [81, 82, 83];
const sources = [
  { table: "chat_messages", limit: 15 },
  { table: "agent_tasks", limit: 15 },
  { table: "project_versions", limit: 15 },
  { table: "projects", limit: 10 },
] as const;

function appFor(actor: string | null = userId, structuredQuery = false) {
  const app = express();
  // Exercise array/object query values explicitly without assuming the main
  // application's query-parser configuration.
  if (structuredQuery) app.set("query parser", "extended");
  app.use((req, _res, next) => {
    if (actor !== null) req.userId = actor;
    next();
  });
  app.use(activityRouter);
  return app;
}

function expectScopedQueries(projectIds: number[], workspaceId: number | null) {
  expect(mocks.execute).toHaveBeenCalledTimes(4);
  const seen = new Set<string>();
  for (const [sql, params, method] of mocks.execute.mock.calls) {
    expect(method).toBe("all");
    const table = sql.match(/ from "([^"]+)"/u)?.[1];
    const expectedSource = sources.find((source) => source.table === table);
    expect(expectedSource).toBeDefined();
    if (!expectedSource) throw new Error("Unexpected activity query source");
    seen.add(expectedSource.table);

    const whereIndex = sql.indexOf(" where ");
    const orderIndex = sql.indexOf(" order by ");
    const limitIndex = sql.lastIndexOf(" limit ");
    expect(whereIndex).toBeGreaterThan(sql.indexOf(" from "));
    expect(orderIndex).toBeGreaterThan(whereIndex);
    expect(limitIndex).toBeGreaterThan(orderIndex);

    const idParameters = projectIds.map((_id, index) => "$" + (index + 1)).join(", ");
    const predicates = [
      '"projects"."id" in (' + idParameters + ")",
      '"projects"."deleted_at" is null',
      ...(workspaceId === null ? [] : ['"projects"."workspace_id" = $' + (projectIds.length + 1)]),
    ];
    // Check the entire conjunction, not independent substrings that could pass
    // if an OR widened the scope. All predicates must be inside WHERE, before
    // the per-source sort/limit, not applied to the already-limited JS feed.
    const where = sql.slice(whereIndex + " where ".length, orderIndex);
    expect(where).toBe("(" + predicates.join(" and ") + ")");

    const scopeParameters = [...projectIds, ...(workspaceId === null ? [] : [workspaceId])];
    expect(params).toEqual([...scopeParameters, expectedSource.limit]);
    expect(sql.slice(limitIndex)).toBe(" limit $" + (scopeParameters.length + 1));
    expect(sql.slice(orderIndex, limitIndex)).toContain('"created_at" desc');

    if (expectedSource.table !== "projects") {
      expect(sql.slice(0, whereIndex)).toContain(
        'left join "projects" on "projects"."id" = "' + expectedSource.table + '"."project_id"',
      );
    }
    // No workspace-existence lookup is needed to reveal a scoped empty feed.
    expect(sql).not.toMatch(/(?:from|join) "workspaces"/u);
  }
  expect([...seen].sort()).toEqual(sources.map((source) => source.table).sort());
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accessibleProjectIds.mockResolvedValue([...accessibleIds]);
  mocks.execute.mockResolvedValue({ rows: [] });
});

describe("GET /activity workspace SQL boundary", () => {
  it("uses the generated query contract on the real request path", async () => {
    const parse = vi.spyOn(GetRecentActivityQueryParams, "safeParse");
    try {
      const response = await request(appFor()).get("/activity?workspaceId=7");
      expect(response.status).toBe(200);
      expect(parse).toHaveBeenCalledExactlyOnceWith({ workspaceId: "7" });
      expectScopedQueries(accessibleIds, 7);
    } finally {
      parse.mockRestore();
    }
  });

  it("fails closed when the generated contract rejects an otherwise canonical scope", async () => {
    const rejected = GetRecentActivityQueryParams.safeParse({ workspaceId: 0 });
    expect(rejected.success).toBe(false);
    const parse = vi.spyOn(GetRecentActivityQueryParams, "safeParse").mockReturnValue(rejected);
    try {
      const response = await request(appFor()).get("/activity?workspaceId=7");
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid workspace selection" });
      expect(mocks.accessibleProjectIds).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it("requires authentication before workspace parsing, access lookup or database queries", async () => {
    const response = await request(appFor(null)).get("/activity?workspaceId=invalid");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthenticated" });
    expect(mocks.accessibleProjectIds).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it.each<[string, number[]]>([
    ["activity-viewer-a", [81, 82, 83]],
    ["activity-viewer-b", [94]],
  ])(
    "intersects %s's viewer-accessible project IDs with the workspace in every source",
    async (actor, ids) => {
      mocks.accessibleProjectIds.mockResolvedValue(ids);
      const response = await request(appFor(actor)).get("/activity?workspaceId=7");

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(mocks.accessibleProjectIds).toHaveBeenCalledExactlyOnceWith(actor, "viewer");
      expectScopedQueries(ids, 7);
    },
  );

  it("applies the non-deleted project predicate to all four queries before each source limit", async () => {
    const response = await request(appFor()).get("/activity?workspaceId=26");
    expect(response.status).toBe(200);
    // The auth helper may return IDs for several workspaces or a retired
    // project; SQL must independently intersect access, workspace and liveness.
    expectScopedQueries(accessibleIds, 26);
  });

  it("keeps an omitted workspace account-wide but still access-scoped and non-deleted", async () => {
    const response = await request(appFor()).get("/activity");
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
    expect(mocks.accessibleProjectIds).toHaveBeenCalledExactlyOnceWith(userId, "viewer");
    expectScopedQueries(accessibleIds, null);
  });

  it.each(["1", "2147483647"])("accepts canonical workspace boundary %s", async (value) => {
    const response = await request(appFor()).get("/activity?workspaceId=" + value);
    expect(response.status).toBe(200);
    expectScopedQueries(accessibleIds, Number(value));
  });

  it.each([
    "",
    "0",
    "-1",
    "01",
    "0007",
    "+7",
    "7.0",
    "7e0",
    "7junk",
    " 7",
    "7 ",
    "7\n",
    "7\r\n",
    "7\t",
    "7\u2028",
    "2147483648",
    "9007199254740992",
    "Infinity",
    "NaN",
    "null",
    "true",
    "7 OR 1=1",
  ])(
    "returns a generic 400 for noncanonical workspace value %j before access or SQL",
    async (value) => {
      const response = await request(appFor()).get(
        "/activity?workspaceId=" + encodeURIComponent(value),
      );
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid workspace selection" });
      expect(mocks.accessibleProjectIds).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["workspaceId=7&workspaceId=8", "workspaceId[]=7", "workspaceId[id]=7"])(
    "rejects structured workspace query %s without broadening to account scope",
    async (query) => {
      const response = await request(appFor(userId, true)).get("/activity?" + query);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: "Invalid workspace selection" });
      expect(mocks.accessibleProjectIds).not.toHaveBeenCalled();
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it.each(["", "?workspaceId=7", "?workspaceId=2147483647"])(
    "returns [] and performs no activity queries when access is empty (%s)",
    async (query) => {
      mocks.accessibleProjectIds.mockResolvedValue([]);
      const response = await request(appFor()).get("/activity" + query);
      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
      expect(mocks.accessibleProjectIds).toHaveBeenCalledExactlyOnceWith(userId, "viewer");
      expect(mocks.execute).not.toHaveBeenCalled();
    },
  );

  it("keeps an unknown workspace indistinguishable from an empty accessible workspace", async () => {
    const app = appFor();
    const empty = await request(app).get("/activity?workspaceId=7");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
    expectScopedQueries(accessibleIds, 7);

    mocks.execute.mockClear();
    mocks.accessibleProjectIds.mockClear();
    const unknown = await request(app).get("/activity?workspaceId=999999");
    expect(unknown.status).toBe(empty.status);
    expect(unknown.body).toEqual(empty.body);
    expect(mocks.accessibleProjectIds).toHaveBeenCalledExactlyOnceWith(userId, "viewer");
    expectScopedQueries(accessibleIds, 999999);
  });
});
