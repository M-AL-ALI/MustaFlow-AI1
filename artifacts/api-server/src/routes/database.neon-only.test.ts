import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: null as {
    id: number;
    name: string;
    ownerId: string;
    dbProvider: string;
    dbStatus: string;
    dbConnectionId: string | null;
    neonProjectId: string | null;
  } | null,
  ownerAllowed: true,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  inserts: [] as Array<Record<string, unknown>>,
  encrypt: vi.fn(() => "encrypted-fixture"),
  logError: vi.fn(),
  lifecycle: vi.fn(),
  assertActive: vi.fn(async () => true),
  releaseHold: vi.fn(async () => undefined),
  hold: vi.fn(),
  lookup: vi.fn(),
  deleteNeon: vi.fn(),
  failWrite: null as "intent" | "ownership" | "secret" | "connected" | null,
  zeroWrite: false,
  deletes: 0,
}));

vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const database = {
    select: () => ({
      from: (table: unknown) => ({
        where: async () => (table === schema.projectsTable && state.project ? [state.project] : []),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          const apply = async () => {
            if (state.zeroWrite) return [];
            if (
              (state.failWrite === "intent" &&
                values.dbStatus === "provisioning" &&
                !values.neonProjectId) ||
              (state.failWrite === "ownership" &&
                values.neonProjectId &&
                values.dbStatus === "provisioning") ||
              (state.failWrite === "connected" && values.dbStatus === "connected")
            )
              throw new Error("synthetic-persistence-failure");
            state.updates.push({
              table: table === schema.projectsTable ? "projects" : "secrets",
              values,
            });
            if (table === schema.projectsTable && state.project)
              Object.assign(state.project, values);
            return [{ id: 77 }];
          };
          return {
            then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
              apply().then(resolve, reject),
            catch: (reject: (reason: unknown) => unknown) => apply().catch(reject),
            returning: apply,
          };
        },
      }),
    }),
    insert: () => ({
      values: async (values: Record<string, unknown>) => {
        if (state.failWrite === "secret") throw new Error("synthetic-secret-persistence-failure");
        state.inserts.push(values);
      },
    }),
    delete: () => ({
      where: async () => {
        state.deletes += 1;
      },
    }),
  };
  return {
    ...schema,
    db: {
      ...database,
      transaction: async (work: (tx: typeof database) => Promise<unknown>) => {
        const project = state.project ? { ...state.project } : null;
        const inserts = [...state.inserts];
        const deletes = state.deletes;
        try {
          return await work(database);
        } catch (error) {
          state.project = project;
          state.inserts = inserts;
          state.deletes = deletes;
          throw error;
        }
      },
    },
  };
});
vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (_req: unknown, res: express.Response, next: express.NextFunction) => {
    if (!state.ownerAllowed) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  },
}));
vi.mock("../lib/project-lifecycle", () => ({
  responseProjectLifecycleSession: () => ({ projectId: 77, assertActive: state.assertActive }),
  holdResponseProjectLifecycleSession: () => {
    state.hold();
    return state.releaseHold;
  },
  requireActiveProjectLifecycleSession: (
    _req: unknown,
    _res: unknown,
    next: express.NextFunction,
  ) => {
    state.lifecycle();
    next();
  },
}));
vi.mock("../lib/encryption", () => ({
  encryptionService: { encrypt: state.encrypt, decrypt: vi.fn() },
  maskValue: () => "masked-neon-connection",
}));
vi.mock("../lib/logger", () => ({
  logger: { error: state.logError, warn: vi.fn(), info: vi.fn() },
}));
vi.mock("../lib/tenant-runtime", () => ({ execInContainer: vi.fn() }));
vi.mock("../lib/db-snapshot-restore", () => ({
  restorePostgresDump: vi.fn(),
  restoreSQLiteSnapshot: vi.fn(),
}));
vi.mock("../lib/snapshot-storage", () => ({
  uploadSnapshotBlob: vi.fn(),
  downloadSnapshotBlob: vi.fn(),
  deleteSnapshotBlobAndProveAbsent: vi.fn(),
}));
vi.mock("../lib/neon-project-lifecycle", () => ({
  deleteNeonProjectAndProveAbsent: state.deleteNeon,
  lookupNeonProjectsByStableName: state.lookup,
  neonProjectNameFor: (id: number) => `mf-project-${id}`,
}));

vi.mock("../lib/neon-allocation-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/neon-allocation-intent")>()),
  resolveNeonAllocationOrganization: vi.fn(async () => ({ kind: "ready", organizationId: null })),
}));

import databaseRouter from "./database";

const app = express();
app.use(express.json());
app.use("/api", databaseRouter);
const endpoint = "/api/projects/77/database/provision";
const connectionString = "postgresql://fixture:synthetic@ep-fixture.aws.neon.tech/neondb";

describe("Neon-only manual database provisioning", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("NEON_API_KEY", "synthetic-neon-key");
    vi.stubGlobal("fetch", vi.fn());
    state.project = {
      id: 77,
      name: "Neon-only fixture",
      ownerId: "fixture-owner",
      dbProvider: "none",
      dbStatus: "none",
      dbConnectionId: null,
      neonProjectId: null,
    };
    state.ownerAllowed = true;
    state.updates = [];
    state.inserts = [];
    state.failWrite = null;
    state.zeroWrite = false;
    state.deletes = 0;
    state.assertActive.mockResolvedValue(true);
    state.lookup.mockResolvedValue({ kind: "absent" });
    state.deleteNeon.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function expectNoConnection() {
    expect(state.inserts).toEqual([]);
    expect(state.encrypt).not.toHaveBeenCalled();
    expect(state.updates.some(({ values }) => values.dbStatus === "connected")).toBe(false);
  }

  it.each(["sqlite", "fly", "mysql", null, undefined])(
    "rejects unsupported provider %j without allocation or metadata changes",
    async (provider) => {
      const response = await request(app).post(endpoint).send({ provider });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe("database_provider_not_supported");
      expect(fetch).not.toHaveBeenCalled();
      expect(state.updates).toEqual([]);
      expectNoConnection();
    },
  );

  it.each([undefined, "", "   "])("fails closed without Neon credentials %j", async (value) => {
    vi.stubEnv("NEON_API_KEY", value);
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("neon_not_configured");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
    expectNoConnection();
  });

  it.each([401, 403, 429, 500])("does not invent a database after Neon HTTP %i", async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response("sensitive-provider-response", { status }));
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("neon_provisioning_unavailable");
    expect(state.updates.at(-1)?.values).toEqual({ dbStatus: "error" });
    expect(JSON.stringify(state.logError.mock.calls)).not.toContain("sensitive-provider-response");
    expectNoConnection();
  });

  it.each([
    {},
    { project: { id: "neon-fixture" } },
    { project: { id: 42 }, connection_uris: [{ connection_uri: connectionString }] },
    { project: { id: "neon-fixture" }, connection_uris: [{ connection_uri: {} }] },
    { project: { id: "" }, connection_uris: [{ connection_uri: "" }] },
  ])("rejects incomplete or invalid Neon metadata", async (document) => {
    vi.mocked(fetch).mockResolvedValue(Response.json(document));
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expectNoConnection();
  });

  it("catches transport failure without exposing provider error text or marking connected", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("sensitive-provider-error"));
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toContain("sensitive-provider-error");
    expect(JSON.stringify(state.logError.mock.calls)).not.toContain("sensitive-provider-error");
    expectNoConnection();
  });

  it("stores only a successful Neon allocation behind the owner and lifecycle gates", async () => {
    vi.mocked(fetch).mockResolvedValue(
      Response.json({
        project: { id: "neon-fixture" },
        connection_uris: [{ connection_uri: connectionString }],
      }),
    );
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      dbProvider: "postgres",
      dbStatus: "connected",
      dbConnectionId: "neon-fixture",
      maskedUrl: "masked-neon-connection",
    });
    expect(state.lifecycle).toHaveBeenCalledOnce();
    expect(state.hold).toHaveBeenCalledOnce();
    expect(state.releaseHold).toHaveBeenCalledOnce();
    expect(state.project?.neonProjectId).toBe("neon-fixture");
    expect(state.updates.slice(0, 2).map(({ values }) => values)).toEqual([
      { dbProvider: "postgres", dbStatus: "provisioning" },
      {
        dbProvider: "postgres",
        dbStatus: "provisioning",
        neonProjectId: "neon-fixture",
        dbConnectionId: "neon-fixture",
      },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://console.neon.tech/api/v2/projects",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(state.encrypt).toHaveBeenCalledWith(connectionString);
    expect(state.inserts).toEqual([
      expect.objectContaining({
        projectId: 77,
        name: "DATABASE_URL",
        valueEncrypted: "encrypted-fixture",
      }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain(connectionString);
  });

  it("preserves a non-revealing owner denial without provider access", async () => {
    state.ownerAllowed = false;
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.lifecycle).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it.each(["connected"])("does not replace a %s database", async (status) => {
    state.project!.dbStatus = status;
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("does not POST until the durable intent has committed", async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      expect(state.project?.dbProvider).toBe("postgres");
      expect(state.project?.dbStatus).toBe("provisioning");
      return Response.json({ project: { id: "neon-fixture" } });
    });
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
    expect(state.project?.neonProjectId).toBe("neon-fixture");
    expectNoConnection();
  });

  it.each(["intent", "ownership", "secret", "connected"] as const)(
    "retains a recoverable receipt after %s persistence failure",
    async (failure) => {
      state.failWrite = failure;
      vi.mocked(fetch).mockResolvedValue(
        Response.json({
          project: { id: "neon-fixture" },
          connection_uris: [{ connection_uri: connectionString }],
        }),
      );
      const response = await request(app).post(endpoint).send({ provider: "postgres" });
      expect(response.status).toBe(503);
      expect(state.project?.dbStatus).not.toBe("connected");
      expect(state.inserts).toEqual([]);
      if (failure === "intent") expect(fetch).not.toHaveBeenCalled();
      else {
        expect(fetch).toHaveBeenCalledOnce();
        expect(state.project?.dbProvider).toBe("postgres");
        expect(state.project?.dbStatus).toBe("error");
      }
      if (failure === "secret" || failure === "connected") {
        expect(state.project?.neonProjectId).toBe("neon-fixture");
      }
      expect(state.releaseHold).toHaveBeenCalledOnce();
    },
  );

  it("never posts after a zero-row intent CAS", async () => {
    state.zeroWrite = true;
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.project?.dbProvider).toBe("none");
  });

  it("does not burn a fresh attempt when the preflight catalog is unavailable", async () => {
    state.lookup.mockResolvedValue({ kind: "unavailable" });
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
  });

  it("retries an uncertain POST through lookup only and refuses to reset its intent", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("synthetic-response-lost"));
    expect((await request(app).post(endpoint).send({ provider: "postgres" })).status).toBe(503);
    expect((await request(app).post(endpoint).send({ provider: "postgres" })).status).toBe(503);
    expect(fetch).toHaveBeenCalledOnce();
    const removal = await request(app).delete("/api/projects/77/database");
    expect(removal.status).toBe(503);
    expect(removal.body.code).toBe("database_provider_cleanup_unconfirmed");
    expect(state.deleteNeon).not.toHaveBeenCalled();
    expect(state.deletes).toBe(0);
    expect(state.project?.dbProvider).toBe("postgres");
  });

  it("recovers an interrupted provisioning attempt without another allocation", async () => {
    Object.assign(state.project!, { dbProvider: "postgres", dbStatus: "provisioning" });
    state.lookup.mockResolvedValue({ kind: "found", projectIds: ["neon-fixture"] });
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        Response.json({
          project: { id: "neon-fixture", name: "mf-project-77", default_branch_id: "br-main" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ databases: [{ name: "original-before-rename" }] }))
      .mockResolvedValueOnce(Response.json({ roles: [{ name: "mustaflow" }] }))
      .mockResolvedValueOnce(Response.json({ uri: connectionString }));
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(200);
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => options?.method === "GET")).toBe(
      true,
    );
    expect(state.project?.neonProjectId).toBe("neon-fixture");
  });

  it("does not contact the provider when lifecycle authority is lost", async () => {
    state.assertActive.mockResolvedValue(false);
    const response = await request(app).post(endpoint).send({ provider: "postgres" });
    expect(response.status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
    expect(state.updates).toEqual([]);
    expect(state.releaseHold).toHaveBeenCalledOnce();
  });

  it("resets ownership only after provider deletion and catalog absence", async () => {
    Object.assign(state.project!, {
      dbProvider: "postgres",
      dbStatus: "connected",
      dbConnectionId: "neon-fixture",
      neonProjectId: "neon-fixture",
    });
    state.lookup
      .mockResolvedValueOnce({ kind: "found", projectIds: ["neon-fixture"] })
      .mockResolvedValueOnce({ kind: "absent" });
    const response = await request(app).delete("/api/projects/77/database");
    expect(response.status).toBe(200);
    expect(state.deleteNeon).toHaveBeenCalledWith("neon-fixture");
    expect(state.project).toMatchObject({
      dbProvider: "none",
      dbStatus: "none",
      dbConnectionId: null,
      neonProjectId: null,
    });
    expect(state.deletes).toBe(1);
    expect(state.releaseHold).toHaveBeenCalledOnce();
  });

  it("retains ownership when the post-deletion catalog is unavailable", async () => {
    Object.assign(state.project!, {
      dbProvider: "postgres",
      dbStatus: "connected",
      dbConnectionId: "neon-fixture",
      neonProjectId: "neon-fixture",
    });
    state.lookup
      .mockResolvedValueOnce({ kind: "found", projectIds: ["neon-fixture"] })
      .mockResolvedValueOnce({ kind: "unavailable" });
    const response = await request(app).delete("/api/projects/77/database");
    expect(response.status).toBe(503);
    expect(state.project?.neonProjectId).toBe("neon-fixture");
    expect(state.deletes).toBe(0);
  });
});
