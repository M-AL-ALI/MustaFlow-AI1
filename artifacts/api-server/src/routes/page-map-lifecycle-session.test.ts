import { EventEmitter } from "node:events";
import express, { Router, type RequestHandler, type Response } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageMapData, PageMapPlatform } from "../lib/page-map";
import type { PageMapRepository } from "../lib/page-map-repository";

// These tests exercise the real lifecycle middleware and hold/finally path.
// Only pool I/O, ownership, and analysis are fake. The pool always grants locks:
// this proves control flow and release ordering, not PostgreSQL contention.
const doubles = vi.hoisted(() => ({
  connect: vi.fn(),
  extract: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { connect: doubles.connect },
  // The injected repository and ownership handler do not use Drizzle. Keeping
  // db empty also makes an unexpected real-repository call fail visibly.
  db: {},
  projectsTable: {},
  projectFilesTable: {},
}));

vi.mock("../lib/auth", () => ({
  requireProjectOwnership: () => {
    throw new Error("This harness must inject its ownership handler");
  },
  checkProjectAccess: vi.fn(async () => "granted"),
}));

vi.mock("../lib/support-access", () => ({
  findLiveSupportGrant: vi.fn(async () => null),
}));

vi.mock("../lib/page-map", () => ({
  extractPageMapForFiles: doubles.extract,
  EMPTY_PAGE_MAP: {
    web: { nodes: [], edges: [] },
    ios: { nodes: [], edges: [] },
    android: { nodes: [], edges: [] },
  },
}));

// Deliberately do not mock project-lifecycle. The router uses its real
// requireActiveProjectLifecycleSession and holdResponseProjectLifecycleSession.
import { requireActiveProjectLifecycleFor } from "../lib/project-lifecycle";
import { PROJECT_LIFECYCLE_LOCK_NAMESPACE } from "../lib/project-retirement-contract";
import { pageMapRevision } from "../lib/page-map-revision";
import { createPageMapRouter } from "./page-map";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function emptyPlatform(): PageMapPlatform {
  return { nodes: [], edges: [] };
}

function emptyMap(): PageMapData {
  return { web: emptyPlatform(), ios: emptyPlatform(), android: emptyPlatform() };
}

type QueryCall = { sql: string; values: readonly unknown[] };

function fakeClient(activeIds: ReadonlySet<number>) {
  const queries: QueryCall[] = [];
  const released = deferred<void>();
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values: [...values] });
    if (sql === "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired") {
      return { rows: [{ acquired: true }] };
    }
    if (sql === "SELECT id FROM projects WHERE id = $1 AND deleted_at IS NULL LIMIT 1") {
      const id = values[0];
      return { rows: typeof id === "number" && activeIds.has(id) ? [{ id }] : [] };
    }
    if (sql === "SELECT pg_advisory_unlock($1::integer, $2::integer)") {
      return { rows: [{ pg_advisory_unlock: true }] };
    }
    throw new Error("Unexpected lifecycle query: " + sql);
  });
  const release = vi.fn(() => released.resolve(undefined));
  return { query, release, queries, released: released.promise };
}

function installPool(activeIds: readonly number[] = [12]) {
  const clients: ReturnType<typeof fakeClient>[] = [];
  doubles.connect.mockImplementation(async () => {
    const client = fakeClient(new Set(activeIds));
    clients.push(client);
    return client;
  });
  return { clients };
}

function lockCalls(client: ReturnType<typeof fakeClient>) {
  return client.queries.filter(({ sql }) => sql.startsWith("SELECT pg_try_advisory_lock("));
}

function unlockCalls(client: ReturnType<typeof fakeClient>) {
  return client.queries.filter(({ sql }) => sql.startsWith("SELECT pg_advisory_unlock("));
}

function makeRepository() {
  return {
    read: vi.fn(async (_projectId: number) => ({ pageMapData: emptyMap() })),
    readFiles: vi.fn(async (_projectId: number) => ({
      files: [{ path: "index.html", content: "<main>Home</main>", mimeType: "text/html" }],
      revision: "source-revision-12",
    })),
    write: vi.fn(
      async (
        _projectId: number,
        _data: PageMapData,
        _expectedMap: unknown,
        _sourceRevision?: string,
      ) => true,
    ),
  } satisfies PageMapRepository;
}

function lifecycleResponse() {
  const response = Object.assign(new EventEmitter(), {
    locals: {} as Record<string, unknown>,
    destroyed: false,
    writableEnded: false,
    headersSent: false,
  });
  return Object.assign(response, {
    status: vi.fn((_status: number) => response),
    json: vi.fn((_body: unknown) => response),
  });
}

function makeApp(repository: PageMapRepository, upstreamProjectId?: number) {
  const app = express();
  const api = Router();
  const responseSeen = deferred<Response>();
  const responseClosed = deferred<void>();
  const errors: unknown[] = [];
  app.use(express.json());
  app.use((req, res, next) => {
    Object.assign(req, { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    responseSeen.resolve(res);
    res.once("close", () => responseClosed.resolve(undefined));
    next();
  });
  if (upstreamProjectId !== undefined) {
    api.use((_req, res, next) => {
      void requireActiveProjectLifecycleFor(upstreamProjectId, res, next).catch(next);
    });
  }
  const owner: RequestHandler = (req, _res, next) => {
    Object.assign(req, { userId: "owner-12" });
    next();
  };
  api.use(createPageMapRouter(repository, owner));
  app.use("/api", api);
  app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    errors.push(error);
    if (!res.destroyed && !res.headersSent) {
      res.status(500).json({ error: "Analysis failed" });
    }
  });
  return {
    app,
    responseSeen: responseSeen.promise,
    responseClosed: responseClosed.promise,
    errors,
  };
}

function mutation(app: express.Express, method: "put" | "post", rawId: string) {
  const path = "/api/projects/" + rawId + "/page-map";
  if (method === "post") {
    return request(app)
      .post(path + "/analyze?platform=web")
      .send({});
  }
  const map = emptyMap();
  return request(app)
    .put(path)
    .send({
      expectedRevision: pageMapRevision(map),
      web: map.web,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  doubles.connect.mockReset();
  doubles.extract.mockReset();
  doubles.extract.mockResolvedValue(emptyPlatform());
});

describe("Page Map lifecycle session with a fake pool", () => {
  it.each([
    { method: "put" as const, rawId: "12" },
    { method: "put" as const, rawId: "%31%32" },
    { method: "post" as const, rawId: "12" },
    { method: "post" as const, rawId: "%31%32" },
  ])(
    "$method $rawId admits decoded project 12 and releases its client",
    async ({ method, rawId }) => {
      const pool = installPool();
      const repository = makeRepository();
      const { app } = makeApp(repository);

      await mutation(app, method, rawId).expect(200);

      expect(doubles.connect).toHaveBeenCalledTimes(1);
      const client = pool.clients[0]!;
      await client.released;
      expect(lockCalls(client).map(({ values }) => values)).toEqual([
        [PROJECT_LIFECYCLE_LOCK_NAMESPACE, 12],
      ]);
      expect(repository.read).toHaveBeenCalledWith(12);
      expect(repository.write.mock.calls[0]?.[0]).toBe(12);
      if (method === "post") {
        expect(repository.readFiles).toHaveBeenCalledWith(12);
        expect(doubles.extract).toHaveBeenCalledTimes(1);
      } else {
        expect(doubles.extract).not.toHaveBeenCalled();
      }
      expect(unlockCalls(client).map(({ values }) => values)).toEqual([
        [PROJECT_LIFECYCLE_LOCK_NAMESPACE, 12],
      ]);
      expect(client.release).toHaveBeenCalledTimes(1);
    },
  );

  it("reuses a real upstream session for an encoded request without a second connect", async () => {
    const pool = installPool();
    const repository = makeRepository();
    const { app } = makeApp(repository, 12);

    await mutation(app, "post", "%31%32").expect(200);

    expect(doubles.connect).toHaveBeenCalledTimes(1);
    const client = pool.clients[0]!;
    await client.released;
    expect(lockCalls(client)).toHaveLength(1);
    expect(lockCalls(client)[0]?.values).toEqual([PROJECT_LIFECYCLE_LOCK_NAMESPACE, 12]);
    expect(repository.read).toHaveBeenCalledWith(12);
    expect(doubles.extract).toHaveBeenCalledTimes(1);
    expect(unlockCalls(client)).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each(["put", "post"] as const)(
    "inactive encoded %s returns 404 before repository or analysis",
    async (method) => {
      const pool = installPool([]);
      const repository = makeRepository();
      const { app } = makeApp(repository);

      await mutation(app, method, "%31%32").expect(404).expect({ error: "Project not found" });

      expect(doubles.connect).toHaveBeenCalledTimes(1);
      const client = pool.clients[0]!;
      await client.released;
      expect(repository.read).not.toHaveBeenCalled();
      expect(repository.readFiles).not.toHaveBeenCalled();
      expect(repository.write).not.toHaveBeenCalled();
      expect(doubles.extract).not.toHaveBeenCalled();
      expect(unlockCalls(client)).toHaveLength(1);
      expect(client.release).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["resolve", "reject"] as const)(
    "keeps pending analysis held across real response close until %s",
    async (settlement) => {
      const pool = installPool();
      const repository = makeRepository();
      const pending = deferred<PageMapPlatform>();
      const started = deferred<void>();
      const failure = new Error("Synthetic extractor failure");
      doubles.extract.mockImplementation(() => {
        started.resolve(undefined);
        return pending.promise;
      });
      const { app, responseSeen, responseClosed } = makeApp(repository);
      // Starting the Supertest thenable immediately also handles its expected
      // socket error; an aborted connection must not leave an unhandled rejection.
      const outcome = mutation(app, "post", "%31%32").then(
        () => ({ disconnected: false }),
        () => ({ disconnected: true }),
      );
      const res = await responseSeen;

      try {
        await started.promise;
        expect(doubles.connect).toHaveBeenCalledTimes(1);
        const client = pool.clients[0]!;
        expect(unlockCalls(client)).toHaveLength(0);

        // Destroy the real ServerResponse/socket, rather than using a response
        // double. Extra close emissions exercise the idempotent event boundary.
        res.destroy();
        await responseClosed;
        res.emit("close");
        res.emit("close");
        expect(unlockCalls(client)).toHaveLength(0);
        expect(client.release).not.toHaveBeenCalled();
      } finally {
        if (settlement === "reject") pending.reject(failure);
        else pending.resolve(emptyPlatform());
        res.destroy();
        await outcome;
      }

      const client = pool.clients[0]!;
      await client.released;
      expect(await outcome).toEqual({ disconnected: true });
      res.emit("close");
      res.emit("close");
      expect(unlockCalls(client)).toHaveLength(1);
      expect(client.release).toHaveBeenCalledTimes(1);
    },
  );

  it("releases a grant arriving after close during acquisition without continuing the request", async () => {
    const client = fakeClient(new Set([12]));
    const acquisitionStarted = deferred<void>();
    const grant = deferred<void>();
    client.query.mockImplementationOnce(async (sql, values = []) => {
      client.queries.push({ sql, values: [...values] });
      acquisitionStarted.resolve(undefined);
      await grant.promise;
      return { rows: [{ acquired: true }] };
    });
    doubles.connect.mockResolvedValueOnce(client);
    const repository = makeRepository();
    const response = lifecycleResponse();
    const next = vi.fn(() => {
      void repository.read(12);
      void doubles.extract();
    });

    // Exercise the real admission function directly so a deliberately closed
    // request cannot leave a Supertest completion waiting on an HTTP response.
    const admission = requireActiveProjectLifecycleFor(12, response as unknown as Response, next);
    try {
      await acquisitionStarted.promise;
      expect(client.query).toHaveBeenNthCalledWith(
        1,
        "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired",
        [PROJECT_LIFECYCLE_LOCK_NAMESPACE, 12],
      );
      expect(response.listenerCount("finish")).toBeGreaterThan(0);
      expect(response.listenerCount("close")).toBeGreaterThan(0);

      // Leave destroyed/writableEnded false: the pending close listener must
      // remember this event independently of the response-flag fallback.
      response.emit("close");
      response.emit("close");
      expect(next).not.toHaveBeenCalled();
      expect(unlockCalls(client)).toHaveLength(0);
      expect(client.release).not.toHaveBeenCalled();
    } finally {
      grant.resolve(undefined);
      await admission;
    }

    expect(doubles.connect).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.readFiles).not.toHaveBeenCalled();
    expect(repository.write).not.toHaveBeenCalled();
    expect(doubles.extract).not.toHaveBeenCalled();
    expect(unlockCalls(client).map(({ values }) => values)).toEqual([
      [PROJECT_LIFECYCLE_LOCK_NAMESPACE, 12],
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    response.emit("finish");
    response.emit("close");
    expect(next).not.toHaveBeenCalled();
    expect(unlockCalls(client)).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("removes pending response listeners when acquisition throws", async () => {
    const failure = new Error("Synthetic lifecycle acquisition failure");
    const client = fakeClient(new Set([12]));
    client.query.mockRejectedValueOnce(failure);
    doubles.connect.mockResolvedValueOnce(client);
    const repository = makeRepository();
    const response = lifecycleResponse();
    const next = vi.fn(() => {
      void repository.read(12);
      void doubles.extract();
    });

    await expect(
      requireActiveProjectLifecycleFor(12, response as unknown as Response, next),
    ).rejects.toBe(failure);

    expect(doubles.connect).toHaveBeenCalledTimes(1);
    expect(response.listenerCount("finish")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    response.emit("close");
    response.emit("finish");
    expect(next).not.toHaveBeenCalled();
    expect(repository.read).not.toHaveBeenCalled();
    expect(repository.readFiles).not.toHaveBeenCalled();
    expect(repository.write).not.toHaveBeenCalled();
    expect(doubles.extract).not.toHaveBeenCalled();
    // The first lock query failed before granting a lock, so only the client
    // is returned; an unlock would incorrectly claim a successful acquisition.
    expect(unlockCalls(client)).toHaveLength(0);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("releases the real session when extraction rejects and the error response finishes", async () => {
    const pool = installPool();
    const repository = makeRepository();
    const failure = new Error("Synthetic extractor failure");
    doubles.extract.mockRejectedValue(failure);
    const { app, errors } = makeApp(repository);

    await mutation(app, "post", "%31%32").expect(500);

    expect(errors).toContain(failure);
    expect(repository.write).not.toHaveBeenCalled();
    expect(doubles.connect).toHaveBeenCalledTimes(1);
    const client = pool.clients[0]!;
    await client.released;
    expect(unlockCalls(client)).toHaveLength(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
