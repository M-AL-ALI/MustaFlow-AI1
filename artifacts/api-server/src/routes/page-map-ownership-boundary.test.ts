import express from "express";
import request from "supertest";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireProjectOwnership } from "../lib/auth";
import type { PageMapData } from "../lib/page-map";
import type { PageMapRepository } from "../lib/page-map-repository";
import { pageMapRevision } from "../lib/page-map-revision";
import { createPageMapRouter } from "./page-map";

// Lifecycle locking is covered separately; this suite exercises real ownership.
vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  holdResponseProjectLifecycleSession: () => async () => {},
}));

type StoredProject = {
  id: number;
  ownerId: string;
  deletedAt: Date | null;
  pageMapData: PageMapData;
};

const storage = vi.hoisted(() => ({
  projects: new Map<number, StoredProject>(),
  ownershipIds: [] as number[],
  select: vi.fn(),
}));

// Keep the actual tables and SQL operators. Only storage is replaced, and its
// result depends on the real middleware's predicate, not a queued owner row.
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();

  storage.select.mockImplementation(() => ({
    from(table: unknown) {
      if (table !== schema.projectsTable) {
        throw new Error("Unexpected table in the ownership boundary test");
      }
      return {
        async where(predicate: SQL) {
          const { sql, params } = dialect.sqlToQuery(predicate);
          const projectId = params[0];
          if (
            params.length !== 1 ||
            typeof projectId !== "number" ||
            !/"projects"\."id"\s*=\s*\$1\b/.test(sql) ||
            !/"projects"\."deleted_at"\s+is\s+null/i.test(sql)
          ) {
            throw new Error("Expected an ID-scoped, active-project ownership query");
          }
          storage.ownershipIds.push(projectId);
          const project = storage.projects.get(projectId);
          return project && project.deletedAt === null ? [{ ...project }] : [];
        },
      };
    },
  }));

  return { ...schema, db: { select: storage.select } };
});

const OWNER = "owner-of-12";
const VICTIM = "owner-of-1200";
const MAX_PROJECT_ID = 2_147_483_647;
const FILE_REVISION = "deterministic-empty-file-snapshot";
const emptyPlatform = (): PageMapData["web"] => ({ nodes: [], edges: [] });

function expectedEmptyFileAnalysis(originalMap: PageMapData): PageMapData {
  return {
    ...originalMap,
    web: { ...originalMap.web, unresolvedTransitions: [] },
  };
}

function makeMap(label: string): PageMapData {
  const platform = (name: string): PageMapData["web"] => ({
    nodes: [
      {
        id: name + "-home",
        label: label + " " + name,
        pageType: "other",
        filePath: name === "web" ? "index.html" : "screens/" + name + ".tsx",
        position: { x: 10, y: 20 },
        isNew: false,
        hasError: false,
        aiGenerated: false,
        notes: label + " notes",
      },
    ],
    edges: [],
  });
  return { web: platform("web"), ios: platform("ios"), android: platform("android") };
}

function harness(useDefaultOwnership = false) {
  const ownerMap = makeMap("Owner map");
  const victimMap = makeMap("Victim map");
  for (const id of [1, 12, MAX_PROJECT_ID]) {
    storage.projects.set(id, {
      id,
      ownerId: OWNER,
      deletedAt: null,
      pageMapData: structuredClone(ownerMap),
    });
  }
  storage.projects.set(1200, {
    id: 1200,
    ownerId: VICTIM,
    deletedAt: null,
    pageMapData: structuredClone(victimMap),
  });

  const repository = {
    read: vi.fn(async (projectId: number) => {
      const project = storage.projects.get(projectId);
      return project && project.deletedAt === null
        ? { pageMapData: structuredClone(project.pageMapData) }
        : null;
    }),
    // Empty files take the real extractor's deterministic path before any AI
    // request. Do not replace these with HTML fixtures in this boundary suite.
    readFiles: vi.fn(async (_projectId: number) => ({
      files: [],
      revision: FILE_REVISION,
    })),
    write: vi.fn(
      async (
        projectId: number,
        data: PageMapData,
        expectedMap: unknown,
        sourceRevision?: string,
      ) => {
        const project = storage.projects.get(projectId);
        if (
          !project ||
          project.deletedAt !== null ||
          pageMapRevision(project.pageMapData) !== pageMapRevision(expectedMap) ||
          (sourceRevision !== undefined && sourceRevision !== FILE_REVISION)
        ) {
          return false;
        }
        project.pageMapData = structuredClone(data);
        return true;
      },
    ),
  } satisfies PageMapRepository;

  // This is a call-through spy, not substitute authorization logic.
  const ownership = vi.fn(requireProjectOwnership);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-page-map-test-user");
    if (userId) req.userId = userId;
    Object.defineProperty(req, "log", { value: { info: vi.fn() } });
    next();
  });
  app.use(
    "/api",
    useDefaultOwnership
      ? createPageMapRouter(repository)
      : createPageMapRouter(repository, ownership),
  );
  return { app, repository, ownership, ownerMap, victimMap };
}

type Harness = ReturnType<typeof harness>;
const endpoints = [
  { name: "GET", method: "get", suffix: "" },
  { name: "PUT", method: "put", suffix: "" },
  { name: "analyze", method: "post", suffix: "/analyze" },
] as const;
type Endpoint = (typeof endpoints)[number];

function send(
  h: Harness,
  endpoint: Endpoint,
  pathId: string,
  options: { userId?: string | null; body?: Record<string, unknown> } = {},
) {
  const pending = request(h.app)[endpoint.method](
    "/api/projects/" + pathId + "/page-map" + endpoint.suffix,
  );
  const userId = options.userId === undefined ? OWNER : options.userId;
  if (userId !== null) pending.set("x-page-map-test-user", userId);
  if (endpoint.method === "put") {
    pending.send(
      options.body ?? {
        web: emptyPlatform(),
        expectedRevision: pageMapRevision(h.ownerMap),
      },
    );
  }
  return pending;
}

function expectNoRepositoryCalls(h: Harness) {
  expect(h.repository.read).not.toHaveBeenCalled();
  expect(h.repository.readFiles).not.toHaveBeenCalled();
  expect(h.repository.write).not.toHaveBeenCalled();
}

function expectAuthorizedCalls(
  h: Harness,
  endpoint: Endpoint,
  projectId: number,
  originalMap: PageMapData,
) {
  expect(h.ownership).toHaveBeenCalledTimes(1);
  expect(storage.select).toHaveBeenCalledTimes(1);
  expect(storage.ownershipIds).toEqual([projectId]);
  expect(h.repository.read).toHaveBeenCalledTimes(1);
  expect(h.repository.read).toHaveBeenCalledWith(projectId);
  if (endpoint.method === "get") {
    expect(h.repository.readFiles).not.toHaveBeenCalled();
    expect(h.repository.write).not.toHaveBeenCalled();
  } else if (endpoint.method === "put") {
    expect(h.repository.readFiles).not.toHaveBeenCalled();
    expect(h.repository.write).toHaveBeenCalledTimes(1);
    expect(h.repository.write).toHaveBeenCalledWith(
      projectId,
      { ...originalMap, web: emptyPlatform() },
      originalMap,
    );
  } else {
    expect(h.repository.readFiles).toHaveBeenCalledTimes(1);
    expect(h.repository.readFiles).toHaveBeenCalledWith(projectId);
    expect(h.repository.write).toHaveBeenCalledTimes(1);
    expect(h.repository.write).toHaveBeenCalledWith(
      projectId,
      expectedEmptyFileAnalysis(originalMap),
      originalMap,
      FILE_REVISION,
    );
  }
}

const invalidIds = [
  { name: "lowercase exponent authorizing 12 but selecting 1200", id: "12e2" },
  { name: "uppercase exponent", id: "12E2" },
  { name: "positive exponent sign", id: "12e+2" },
  { name: "decimal exponent", id: "12.0e2" },
  { name: "negative exponent", id: "12000e-1" },
  { name: "integer-valued decimal", id: "12.0" },
  { name: "fractional decimal", id: "12.5" },
  { name: "decimal rounded to a different integer", id: "11.9999999999999999" },
  { name: "trailing decimal point", id: "12." },
  { name: "positive sign", id: "+12" },
  { name: "negative integer", id: "-12" },
  { name: "zero", id: "0" },
  { name: "leading-zero zero", id: "000" },
  { name: "hexadecimal", id: "0x4b0" },
  { name: "first ID beyond signed 32-bit range", id: "2147483648" },
  { name: "unsigned 32-bit maximum", id: "4294967295" },
  { name: "JavaScript safe-integer maximum", id: "9007199254740991" },
  { name: "unsafe integer", id: "9007199254740992" },
  { name: "integer overflowing Number", id: "9".repeat(400) },
  { name: "fully encoded exponent", id: "%31%32%65%32" },
  { name: "encoded exponent sign", id: "12E%2B2" },
  { name: "encoded decimal separator", id: "12%2E0" },
  { name: "encoded overflowing ID", id: "%32%31%34%37%34%38%33%36%34%38" },
  { name: "encoded surrounding whitespace", id: "%2012%20" },
  { name: "encoded trailing newline", id: "12%0A" },
  { name: "encoded NUL", id: "12%00" },
  { name: "encoded slash inside the ID", id: "12%2F1200" },
  { name: "double-encoded exponent character", id: "12%25652" },
  { name: "non-numeric suffix", id: "12junk" },
  { name: "non-finite number spelling", id: "Infinity" },
];

const validIds = [
  { name: "ordinary decimal ID", id: "12", projectId: 12 },
  { name: "leading zeros", id: "00012", projectId: 12 },
  { name: "encoded digits", id: "%31%32", projectId: 12 },
  { name: "encoded digits with leading zeros", id: "%30%30%31%32", projectId: 12 },
  { name: "minimum sequence ID", id: "1", projectId: 1 },
  { name: "signed 32-bit maximum", id: "2147483647", projectId: MAX_PROJECT_ID },
  { name: "maximum with leading zeros", id: "0002147483647", projectId: MAX_PROJECT_ID },
  {
    name: "encoded signed 32-bit maximum",
    id: "%32%31%34%37%34%38%33%36%34%37",
    projectId: MAX_PROJECT_ID,
  },
];

beforeEach(() => {
  storage.projects.clear();
  storage.ownershipIds.length = 0;
  storage.select.mockClear();
});

describe.each(endpoints)("$name Page Map ownership boundary", (endpoint) => {
  it.each(invalidIds)("rejects $name before ownership or storage", async ({ id }) => {
    const h = harness();
    const response = await send(h, endpoint, id);
    expect(response.status).toBe(404);
    expect(h.ownership).not.toHaveBeenCalled();
    expect(storage.select).not.toHaveBeenCalled();
    expect(storage.ownershipIds).toEqual([]);
    expectNoRepositoryCalls(h);
    expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it.each(validIds)("allows $name using one authorized ID", async ({ id, projectId }) => {
    const h = harness();
    const response = await send(h, endpoint, id);
    expect(response.status).toBe(200);
    expectAuthorizedCalls(h, endpoint, projectId, h.ownerMap);
    expect(response.body.pageMapData).toEqual(
      endpoint.method === "put"
        ? { ...h.ownerMap, web: emptyPlatform() }
        : endpoint.method === "post"
          ? expectedEmptyFileAnalysis(h.ownerMap)
          : h.ownerMap,
    );
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it("returns 401 for a valid ID without a signed-in user", async () => {
    const h = harness();
    const response = await send(h, endpoint, "12", { userId: null });
    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Unauthenticated" });
    expect(h.ownership).toHaveBeenCalledTimes(1);
    expect(storage.select).not.toHaveBeenCalled();
    expectNoRepositoryCalls(h);
  });

  it("denies owner 12 access to victim 1200", async () => {
    const h = harness();
    const response = await send(h, endpoint, "1200");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(h.ownership).toHaveBeenCalledTimes(1);
    expect(storage.ownershipIds).toEqual([1200]);
    expectNoRepositoryCalls(h);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it("allows project 1200 for its actual owner", async () => {
    const h = harness();
    const response = await send(h, endpoint, "1200", {
      userId: VICTIM,
      body: { web: emptyPlatform(), expectedRevision: pageMapRevision(h.victimMap) },
    });
    expect(response.status).toBe(200);
    expectAuthorizedCalls(h, endpoint, 1200, h.victimMap);
    expect(response.body.pageMapData).toEqual(
      endpoint.method === "put"
        ? { ...h.victimMap, web: emptyPlatform() }
        : endpoint.method === "post"
          ? expectedEmptyFileAnalysis(h.victimMap)
          : h.victimMap,
    );
    expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
  });

  it.each(["deleted", "missing"] as const)("hides a %s project behind 404", async (state) => {
    const h = harness();
    if (state === "deleted") {
      storage.projects.get(12)!.deletedAt = new Date("2026-01-01T00:00:00.000Z");
    } else {
      storage.projects.delete(12);
    }
    const response = await send(h, endpoint, "12");
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: "Project not found" });
    expect(h.ownership).toHaveBeenCalledTimes(1);
    expect(storage.ownershipIds).toEqual([12]);
    expectNoRepositoryCalls(h);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });
});

describe("Page Map revision and default-ownership integration", () => {
  it("uses real ownership when the router's ownership argument is omitted", async () => {
    const h = harness(true);
    const response = await send(h, endpoints[0], "12");
    expect(response.status).toBe(200);
    expect(response.body.pageMapData).toEqual(h.ownerMap);
    expect(h.ownership).not.toHaveBeenCalled();
    expect(storage.select).toHaveBeenCalledTimes(1);
    expect(storage.ownershipIds).toEqual([12]);
    expect(h.repository.read).toHaveBeenCalledWith(12);
  });

  it("returns 409 for a valid PUT payload missing expectedRevision", async () => {
    const h = harness();
    const response = await send(h, endpoints[1], "12", { body: { web: emptyPlatform() } });
    expect(response.status).toBe(409);
    expect(h.ownership).toHaveBeenCalledTimes(1);
    expect(storage.ownershipIds).toEqual([12]);
    expect(h.repository.readFiles).not.toHaveBeenCalled();
    expect(h.repository.write).not.toHaveBeenCalled();
    expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it.each([
    { name: "empty string", value: "" },
    { name: "non-digest text", value: "not-a-revision" },
    { name: "short digest", value: "a".repeat(63) },
    { name: "long digest", value: "a".repeat(65) },
    { name: "non-hex digest", value: "g".repeat(64) },
    { name: "number", value: 12 },
    { name: "null", value: null },
    { name: "object", value: {} },
    { name: "array", value: ["a".repeat(64)] },
  ])("returns 400 for a malformed revision: $name", async ({ value }) => {
    const h = harness();
    const response = await send(h, endpoints[1], "12", {
      body: { web: emptyPlatform(), expectedRevision: value },
    });
    expect(response.status).toBe(400);
    expect(h.ownership).toHaveBeenCalledTimes(1);
    expect(storage.ownershipIds).toEqual([12]);
    expect(h.repository.readFiles).not.toHaveBeenCalled();
    expect(h.repository.write).not.toHaveBeenCalled();
    expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it("returns 409 for a well-formed revision from a different map", async () => {
    const h = harness();
    const response = await send(h, endpoints[1], "12", {
      body: { web: emptyPlatform(), expectedRevision: pageMapRevision(h.victimMap) },
    });
    expect(response.status).toBe(409);
    expect(storage.ownershipIds).toEqual([12]);
    expect(h.repository.read).toHaveBeenCalledWith(12);
    expect(h.repository.write).not.toHaveBeenCalled();
    expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
    expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
  });

  it.each([endpoints[1], endpoints[2]])(
    "preserves the $name conflict response when persistence loses a race",
    async (endpoint) => {
      const h = harness();
      h.repository.write.mockResolvedValueOnce(false);
      const response = await send(h, endpoint, "12");
      expect(response.status).toBe(409);
      expectAuthorizedCalls(h, endpoint, 12, h.ownerMap);
      expect(storage.projects.get(12)?.pageMapData).toEqual(h.ownerMap);
      expect(storage.projects.get(1200)?.pageMapData).toEqual(h.victimMap);
    },
  );
});
