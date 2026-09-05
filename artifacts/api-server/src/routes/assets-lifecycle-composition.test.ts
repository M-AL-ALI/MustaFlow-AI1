import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import express, { type Response } from "express";
import request from "supertest";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Database = typeof import("@workspace/db").db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const bridge = vi.hoisted(() => ({
  database: undefined as Database | undefined,
  lifecyclePool: undefined as Pick<Pool, "connect"> | undefined,
  access: vi.fn(),
  forbidden: vi.fn((): never => {
    throw new Error("asset_lifecycle_provider_forbidden");
  }),
  realUsage: false,
  beforeUsage: undefined as ((tx: Transaction) => Promise<void>) | undefined,
}));

// Never initialize the application pool, read DATABASE_URL, or load provider credentials.
vi.mock("@workspace/db", async () => ({
  ...(await import("../../../../lib/db/src/schema/index")),
  get db() {
    if (!bridge.database) throw new Error("asset_lifecycle_fixture_db_missing");
    return bridge.database;
  },
  get pool() {
    if (!bridge.lifecyclePool) throw new Error("asset_lifecycle_fixture_pool_missing");
    return bridge.lifecyclePool;
  },
}));
vi.mock("../lib/auth", () => ({
  checkProjectAccess: bridge.access,
  requireProjectAccess:
    (role: string) => async (req: express.Request, res: Response, next: express.NextFunction) => {
      if ((await bridge.access(req.userId, Number(req.params.id), role)) !== "granted") {
        res.status(404).json({ error: "Project not found" });
        return;
      }
      next();
    },
}));
vi.mock("../lib/support-access", () => ({ findLiveSupportGrant: async () => null }));
vi.mock("../lib/asset-analysis", () => ({
  analyzeAssetBuffer: bridge.forbidden,
  MAX_INLINE_ASSET_ANALYSIS_BYTES: 1024,
}));
vi.mock("../lib/asset-image-normalization", () => ({ normalizeUploadedImage: bridge.forbidden }));
vi.mock("../lib/asset-alt-text-analysis", () => ({
  createAssetAltTextEvent: bridge.forbidden,
  enqueueAutomaticAssetAltText: bridge.forbidden,
  runAssetAltTextAnalysis: bridge.forbidden,
}));
vi.mock("../lib/asset-derivatives", () => ({
  ASSET_DERIVATIVE_PRESETS: [],
  generateAssetDerivatives: bridge.forbidden,
}));
vi.mock("../lib/asset-registry", () => ({
  AssetAdmissionError: class extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  beginAssetUpload: bridge.forbidden,
  cancelReservedAsset: bridge.forbidden,
  completeAsset: bridge.forbidden,
  deleteReadyAsset: bridge.forbidden,
  getQuota: bridge.forbidden,
  recordAssetDeleted: bridge.forbidden,
  rejectReservedAsset: bridge.forbidden,
  reserveAsset: bridge.forbidden,
}));
vi.mock("../lib/asset-r2", () => ({
  assetR2Configured: bridge.forbidden,
  deleteAssetObject: bridge.forbidden,
  openAsset: bridge.forbidden,
  putAssetBuffer: bridge.forbidden,
  putAssetStream: bridge.forbidden,
  readAssetBuffer: bridge.forbidden,
}));
vi.mock("../lib/asset-storage-billing", () => ({
  ASSET_STORAGE_PLANS: {},
  createAssetStorageCheckout: bridge.forbidden,
  isAssetStorageSku: () => false,
  listAssetStorageSubscriptions: bridge.forbidden,
}));
vi.mock("../lib/nabuflow-stripe", () => ({ requireStripe: bridge.forbidden }));
vi.mock("./billing", () => ({ ensureStripeCustomer: bridge.forbidden }));
vi.mock("../lib/artifacts", () => ({ resolveArtifactId: async () => 9103 }));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: bridge.forbidden,
}));
vi.mock("../lib/project-file-asset-usage", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/project-file-asset-usage")>();
  return {
    ...original,
    reconcileProjectFileAssetUsage: async (
      ...args: Parameters<typeof original.reconcileProjectFileAssetUsage>
    ) => {
      await bridge.beforeUsage?.(args[0]);
      if (bridge.realUsage) await original.reconcileProjectFileAssetUsage(...args);
    },
  };
});

import {
  assetsTable,
  assetStorageObjectsTable,
  assetUsageTable,
  projectFilesTable,
} from "@workspace/db";
import assetsRouter, { materializeProjectAsset } from "./assets";
import {
  requireActiveProjectLifecycleFor,
  requireActiveProjectMutationLifecycleSession,
  transactionHoldsProjectLifecycleLock,
  withActiveProjectLifecycle,
  withResponseProjectLifecycleTransaction,
} from "../lib/project-lifecycle";
import {
  assertExistingProjectAssetUse,
  grantExplicitProjectAssetUse,
} from "../lib/asset-project-use";
import { PROJECT_LIFECYCLE_LOCK_NAMESPACE } from "../lib/project-retirement-contract";
import { parseProjectFileAssetReference } from "../lib/project-file-asset-reference";
import { AssetProductScopeError } from "../lib/asset-platform-scope";

const PROJECT = 9101;
const SOURCE = 9102;
const PRIOR = 81001;
const REPLACEMENT = 81002;
const OWNER = "asset-lifecycle-fixture-owner";
const PATH = "public/assets/lifecycle.webp";
const methods = ["materialize", "replace"] as const;
type Action = (typeof methods)[number];

function fixtureAsset(id = REPLACEMENT, projectId: number | null = null) {
  return {
    id,
    projectId,
    ownerUserId: OWNER,
    actorUserId: OWNER,
    productScope: "nabuflow" as const,
    scope: projectId === null ? "account" : "project",
    kind: "image",
    source: "picker",
    filename: "lifecycle.webp",
    mimeType: "image/webp",
    sizeBytes: 4,
    sha256: "a".repeat(64),
    storageBackend: "r2",
    storageKey: "assets/fixture/" + id + "/lifecycle.webp",
    state: "ready",
  };
}

function mountedApp(
  options: {
    userId?: string;
    central?: boolean;
    spoofLocals?: boolean;
    response?: (res: Response) => void;
  } = {},
) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.userId = options.userId ?? OWNER; // Test-controlled identity, never a request header.
    options.response?.(res);
    if (options.spoofLocals) {
      res.locals.projectLifecycleSession = { projectId: PROJECT, assertActive: async () => true };
      res.locals.projectLifecycleSessionState = {
        session: res.locals.projectLifecycleSession,
        holds: 99,
        responseEnded: false,
        releaseStarted: false,
      };
    }
    next();
  });
  // Same order as routes/index.ts: central lifecycle boundary, then assets router.
  if (options.central !== false) app.use("/api", requireActiveProjectMutationLifecycleSession);
  app.use("/api", assetsRouter);
  app.use((error: unknown, _req: express.Request, res: Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "unknown" });
  });
  return app;
}

function mutation(app: ReturnType<typeof mountedApp>, action: Action) {
  return request(app)
    .post(
      "/api/projects/" +
        PROJECT +
        "/assets/" +
        (action === "replace" ? PRIOR : REPLACEMENT) +
        "/" +
        action,
    )
    .send({ path: PATH, replacementAssetId: REPLACEMENT })
    .timeout({ response: 8_000, deadline: 10_000 });
}

function responseHarness(): Response & EventEmitter {
  return Object.assign(new EventEmitter(), {
    locals: {},
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  }) as unknown as Response & EventEmitter;
}

function chain(rows: unknown[], values?: (value: unknown) => void) {
  const query: Record<string, unknown> = {
    then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
  };
  for (const method of ["from", "where", "orderBy", "limit", "for", "onConflictDoNothing", "set"]) {
    query[method] = () => query;
  }
  query.values = (value: unknown) => {
    values?.(value);
    return query;
  };
  return query;
}

function lockModel() {
  const model = {
    held: false,
    events: [] as string[],
    sharedProjects: [] as number[],
    statements: [] as string[],
    writes: [] as unknown[],
    dbRows: [] as unknown[][],
    txRows: [] as unknown[][],
    beforeSettlement: undefined as (() => Promise<void>) | undefined,
  };
  const dialect = new PgDialect();
  const tx = {
    select: vi.fn(() => {
      const rows = model.txRows.shift();
      if (!rows) throw new Error("unexpected_transaction_select");
      return chain(rows);
    }),
    execute: vi.fn(async (statement: SQL) => {
      const query = dialect.sqlToQuery(statement);
      model.statements.push(query.sql);
      if (
        query.sql.includes("pg_advisory_xact_lock_shared(") &&
        query.params[0] === PROJECT_LIFECYCLE_LOCK_NAMESPACE
      ) {
        const projectId = Number(query.params[1]);
        model.sharedProjects.push(projectId);
        if (model.held && projectId === PROJECT) {
          // Deterministic model of PostgreSQL's conflicting lock on a different connection.
          throw new Error("different_connection_self_block");
        }
      }
      return { rows: [{ claimed: false }] };
    }),
    insert: vi.fn(() => chain([], (value) => model.writes.push(value))),
    update: vi.fn(() => chain([])),
  };
  const transaction = vi.fn(async (work: (value: Transaction) => Promise<unknown>) => {
    model.events.push("begin");
    try {
      const result = await work(tx as unknown as Transaction);
      await model.beforeSettlement?.();
      model.events.push("commit");
      return result;
    } catch (error) {
      model.events.push("rollback");
      throw error;
    } finally {
      model.events.push("settled");
    }
  });
  bridge.database = {
    select: () => {
      const rows = model.dbRows.shift();
      if (!rows) throw new Error("unexpected_route_select");
      return chain(rows);
    },
    transaction,
  } as unknown as Database;
  bridge.lifecyclePool = {
    connect: async () => ({
      query: async (statement: string, values: unknown[] = []) => {
        if (statement.includes("pg_try_advisory_lock(")) {
          const acquired = !model.held;
          if (acquired) {
            model.held = true;
            model.events.push("session-lock");
          }
          return { rows: [{ acquired }] };
        }
        if (statement.includes("pg_advisory_unlock(")) {
          model.held = false;
          model.events.push("unlock");
          return { rows: [{ unlocked: true }] };
        }
        if (statement.includes("deleted_at IS NULL")) return { rows: [{ id: Number(values[0]) }] };
        throw new Error("unexpected_lifecycle_query");
      },
      release: () => {
        model.events.push("release");
      },
    }),
  } as unknown as Pick<Pool, "connect">;
  return { ...model, state: model, tx, transaction };
}

function seedModel(
  model: ReturnType<typeof lockModel>,
  action: Action,
  source: number | null = null,
) {
  const asset = fixtureAsset(REPLACEMENT, source);
  model.state.dbRows =
    action === "replace" ? [[{ id: PRIOR }], [{ filePath: PATH }], [asset]] : [[asset]];
  const projectIds = [...new Set([PROJECT, ...(source === null ? [] : [source])])].sort(
    (a, b) => a - b,
  );
  model.state.txRows = [
    [{ projectId: source }],
    ...projectIds.map((id) => [{ id }]),
    [asset],
    [{ storageKey: asset.storageKey }],
    [],
    [],
  ];
}

beforeEach(() => {
  bridge.forbidden.mockClear();
  bridge.access
    .mockReset()
    .mockImplementation(async (userId, projectId) =>
      userId === OWNER && projectId === PROJECT ? "granted" : "denied",
    );
  bridge.beforeUsage = undefined;
  vi.stubGlobal("fetch", bridge.forbidden);
});
afterEach(() => {
  expect(bridge.forbidden).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe.sequential("mounted asset lifecycle composition, deterministic lock model", () => {
  let model: ReturnType<typeof lockModel>;
  beforeEach(() => {
    bridge.realUsage = false;
    model = lockModel();
  });

  it.each(methods)(
    "allows legitimate mounted %s without the cross-connection self-block",
    async (action) => {
      seedModel(model, action);
      const response = await mutation(mountedApp(), action);
      expect(response.status).toBe(action === "materialize" ? 201 : 200);
      expect(model.state.sharedProjects).toEqual([]);
      expect(
        model.state.statements.some((value) => value.includes("nabuflow:durable-object:")),
      ).toBe(true);
      expect(
        model.state.statements.some((value) => value.includes("durable_asset_deletion_claims")),
      ).toBe(true);
      expect(model.state.events.indexOf("unlock")).toBeGreaterThan(
        model.state.events.indexOf("commit"),
      );
    },
  );

  it("still takes the other source project's transaction lock", async () => {
    seedModel(model, "materialize", SOURCE);
    const response = await mutation(mountedApp(), "materialize");
    expect(response.status).toBe(201);
    expect(model.state.sharedProjects).toEqual([SOURCE]);
  });

  it.each(["commit", "rollback"] as const)(
    "keeps retirement excluded on close through transaction %s",
    async (outcome) => {
      seedModel(model, "materialize");
      let response!: Response;
      model.state.beforeSettlement = async () => {
        response.emit("close");
        expect(model.state.held).toBe(true);
        expect(model.state.events).not.toContain("unlock");
        if (outcome === "rollback") throw new Error("fixture_rollback");
      };
      const result = await mutation(
        mountedApp({
          response: (res) => {
            response = res;
          },
        }),
        "materialize",
      );
      expect(result.status).toBe(outcome === "commit" ? 201 : 500);
      expect(model.state.events).toContain(outcome);
      expect(model.state.events.indexOf("unlock")).toBeGreaterThan(
        model.state.events.indexOf("settled"),
      );
      expect(model.state.held).toBe(false);
    },
  );

  it("retains the exclusive session until finish even after its transaction commits", async () => {
    const res = responseHarness();
    await requireActiveProjectLifecycleFor(PROJECT, res, vi.fn());
    let registered!: Transaction;
    await withResponseProjectLifecycleTransaction(res, PROJECT, async (tx) => {
      registered = tx;
      expect(transactionHoldsProjectLifecycleLock(tx, PROJECT)).toBe(true);
      expect(transactionHoldsProjectLifecycleLock(tx, SOURCE)).toBe(false);
      expect(transactionHoldsProjectLifecycleLock({ ...tx }, PROJECT)).toBe(false);
    });
    expect(transactionHoldsProjectLifecycleLock(registered, PROJECT)).toBe(false);
    expect(model.state.held).toBe(true);
    res.emit("finish");
    await vi.waitFor(() => expect(model.state.held).toBe(false));
  });

  it.each(["project-owned", "explicit-account-grant"] as const)(
    "composes place_upload's active session with %s materialization",
    async (authority) => {
      seedModel(model, "materialize", authority === "project-owned" ? PROJECT : null);
      if (authority === "explicit-account-grant") model.state.txRows[4] = [{ id: 1 }];
      model.state.beforeSettlement = async () => {
        expect(model.state.held).toBe(true);
        expect(model.state.events).not.toContain("unlock");
      };
      const result = await withActiveProjectLifecycle(
        PROJECT,
        async () =>
          await materializeProjectAsset({
            userId: OWNER,
            projectId: PROJECT,
            assetId: REPLACEMENT,
            path: PATH,
          }),
      );
      expect(result).toEqual({
        state: "active",
        value: { path: PATH, src: "/assets/lifecycle.webp", assetId: REPLACEMENT },
      });
      expect(model.transaction).toHaveBeenCalledTimes(1);
      expect(model.state.sharedProjects).toEqual([]);
      expect(model.state.writes).toEqual(
        expect.arrayContaining([expect.objectContaining({ projectId: PROJECT, path: PATH })]),
      );
      expect(model.state.events.indexOf("unlock")).toBeGreaterThan(
        model.state.events.indexOf("settled"),
      );
    },
  );

  it.each(["commit", "rollback"] as const)(
    "pins an inherited transaction through %s after its background callback ends",
    async (outcome) => {
      const entered = signal();
      const proceed = signal();
      let pending: ReturnType<typeof observe<void>> | undefined;
      model.state.beforeSettlement = async () => {
        entered.resolve();
        await proceed.promise;
        expect(model.state.held).toBe(true);
        if (outcome === "rollback") throw new Error("fixture_background_rollback");
      };
      try {
        await withActiveProjectLifecycle(PROJECT, async () => {
          pending = observe(
            withResponseProjectLifecycleTransaction(undefined, PROJECT, async (tx) => {
              expect(transactionHoldsProjectLifecycleLock(tx, PROJECT)).toBe(true);
            }),
          );
          await bounded(
            Promise.race([
              entered.promise,
              pending.result().then(() => {
                throw new Error("transaction_settled_before_barrier");
              }),
            ]),
          );
        });
        expect(model.state.held).toBe(true);
        expect(model.state.events).not.toContain("unlock");
        proceed.resolve();
        if (outcome === "rollback") {
          await expect(pending!.result()).rejects.toThrow("fixture_background_rollback");
        } else {
          await pending!.result();
        }
        expect(model.state.held).toBe(false);
        expect(model.state.events.indexOf("unlock")).toBeGreaterThan(
          model.state.events.indexOf("settled"),
        );
      } finally {
        proceed.resolve();
        await pending?.outcome;
      }
    },
  );

  it("refuses mismatched or expired inherited contexts without opening a transaction", async () => {
    const proceed = signal();
    let delayed: ReturnType<typeof observe<void>> | undefined;
    try {
      await withActiveProjectLifecycle(PROJECT, async () => {
        await expect(
          withResponseProjectLifecycleTransaction(undefined, SOURCE, async () => undefined),
        ).rejects.toThrow("project_lifecycle_session_missing");
        delayed = observe(
          proceed.promise.then(() =>
            withResponseProjectLifecycleTransaction(undefined, PROJECT, async () => undefined),
          ),
        );
      });
      proceed.resolve();
      await expect(delayed!.result()).rejects.toThrow("project_lifecycle_session_missing");
      expect(model.transaction).not.toHaveBeenCalled();
    } finally {
      proceed.resolve();
      await delayed?.outcome;
    }
  });

  it("does not reuse a genuinely acquired session after it was explicitly released", async () => {
    await withActiveProjectLifecycle(PROJECT, async (session) => {
      await session.release();
      await expect(
        withResponseProjectLifecycleTransaction(undefined, PROJECT, async () => undefined),
      ).rejects.toThrow("project_lifecycle_session_missing");
    });
    expect(model.transaction).not.toHaveBeenCalled();
  });

  it("does not turn background placement of an account logo into an explicit-use grant", async () => {
    seedModel(model, "materialize");
    await expect(
      withActiveProjectLifecycle(PROJECT, async () =>
        materializeProjectAsset({
          userId: OWNER,
          projectId: PROJECT,
          assetId: REPLACEMENT,
          path: PATH,
        }),
      ),
    ).rejects.toBeInstanceOf(AssetProductScopeError);
    expect(model.state.sharedProjects).toEqual([]);
    expect(model.state.writes).toEqual([]);
    expect(model.state.events).toContain("rollback");
    expect(model.state.held).toBe(false);
  });

  it.each([grantExplicitProjectAssetUse, assertExistingProjectAssetUse])(
    "preserves standalone transaction fencing for %s",
    async (admit) => {
      seedModel(model, "materialize", PROJECT);
      await withResponseProjectLifecycleTransaction(undefined, PROJECT, async (tx) => {
        expect(transactionHoldsProjectLifecycleLock(tx, PROJECT)).toBe(false);
        await admit(tx, {
          actorUserId: OWNER,
          targetProjectId: PROJECT,
          assetId: REPLACEMENT,
          productScope: "nabuflow",
        });
      });
      expect(model.state.sharedProjects).toEqual([PROJECT]);
    },
  );

  it.each(methods)(
    "does not accept forged locals as a held-lock witness for %s",
    async (action) => {
      seedModel(model, action);
      const response = await mutation(mountedApp({ central: false, spoofLocals: true }), action);
      expect(response.status).toBe(500);
      expect(response.body.error).toBe("project_lifecycle_session_missing");
      expect(model.transaction).not.toHaveBeenCalled();
    },
  );

  it("rejects mismatched and ended genuine response contexts before opening a transaction", async () => {
    const res = responseHarness();
    await requireActiveProjectLifecycleFor(PROJECT, res, vi.fn());
    await expect(
      withResponseProjectLifecycleTransaction(res, SOURCE, async () => undefined),
    ).rejects.toThrow("project_lifecycle_session_missing");
    res.emit("finish");
    await expect(
      withResponseProjectLifecycleTransaction(res, PROJECT, async () => undefined),
    ).rejects.toThrow("project_lifecycle_session_missing");
    expect(model.transaction).not.toHaveBeenCalled();
  });

  it("ignores spoofed body/header context and still denies a nonmember before writes", async () => {
    const response = await request(mountedApp({ userId: "stranger" }))
      .post("/api/projects/" + PROJECT + "/assets/" + REPLACEMENT + "/materialize")
      .set("x-project-lifecycle-session", String(PROJECT))
      .send({ projectLifecycleSession: { projectId: PROJECT, held: true }, path: PATH });
    expect(response.status).toBe(404);
    expect(model.transaction).not.toHaveBeenCalled();
    expect(model.state.events).toEqual([]);
  });
});

// Real PostgreSQL is essential for this bug: the model is not a lock-semantics proof.
// Explicit supervisor opt-in only. No database creation, migrations, production pool,
// provider calls, or changes outside a private schema in a prepared disposable lab.
function proofConfig(): { pool: PoolConfig; epoch: string } | undefined {
  const flag = process.env.NABUFLOW_ASSET_LIFECYCLE_PG_PROOF;
  if (flag === undefined) return undefined;
  if (flag !== "1") throw new Error("asset_lifecycle_pg_invalid_opt_in");
  try {
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    const database = decodeURIComponent(url.pathname.slice(1));
    const epoch = process.env.NABUFLOW_ASSET_LIFECYCLE_PG_EPOCH ?? "";
    const port = url.port ? Number(url.port) : 5432;
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      !/^mustaflow_parity_disposable_[a-f0-9]{16}$/u.test(database) ||
      url.search !== "" ||
      url.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(epoch)
    ) {
      throw new Error("invalid");
    }
    return {
      epoch,
      pool: {
        host: "127.0.0.1",
        port,
        database,
        user: decodeURIComponent(url.username) || "postgres",
        password: decodeURIComponent(url.password),
        ssl: false,
        max: 6,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 10_000,
        application_name: "asset-lifecycle-pg-" + randomUUID(),
      },
    };
  } catch {
    throw new Error("asset_lifecycle_pg_prepared_disposable_required");
  }
}

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  return {
    outcome,
    result: async () => {
      const result = await outcome;
      if (!result.ok) throw result.error;
      return result.value;
    },
  };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("asset_lifecycle_barrier_timeout")), 8_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const config = proofConfig();
describe.skipIf(!config).sequential("mounted asset lifecycle composition, real PostgreSQL", () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let schemaCreated = false;
  let lifecyclePid = 0;
  const schema = "asset_lifecycle_" + randomUUID().replace(/-/gu, "");
  const tables = [
    "projects",
    "assets",
    "asset_storage_objects",
    "asset_usage",
    "project_files",
    "durable_asset_deletion_claims",
  ];

  beforeAll(async () => {
    admin = new Pool(config!.pool);
    expect(
      (await admin.query("SELECT current_database() AS database, host(inet_server_addr()) AS host"))
        .rows,
    ).toEqual([{ database: config!.pool.database, host: "127.0.0.1" }]);
    expect(
      (
        await admin.query(
          "SELECT epoch FROM production_database_admission_epochs WHERE namespace='production' AND state='active'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await admin.query("SELECT state FROM production_database_admission_epochs WHERE epoch=$1", [
          config!.epoch,
        ])
      ).rows,
    ).toEqual([{ state: "prepared" }]);
    await admin.query("CREATE SCHEMA " + schema);
    schemaCreated = true;
    for (const table of tables) {
      await admin.query(
        "CREATE TABLE " + schema + "." + table + " (LIKE public." + table + " INCLUDING ALL)",
      );
    }
    // Only these inserts allocate ids. Keep their sequences private too.
    for (const table of ["asset_usage", "project_files"]) {
      const sequence = schema + "." + table + "_fixture_id_seq";
      await admin.query(
        "CREATE SEQUENCE " + sequence + " OWNED BY " + schema + "." + table + ".id",
      );
      await admin.query(
        "ALTER TABLE " +
          schema +
          "." +
          table +
          " ALTER COLUMN id SET DEFAULT nextval('" +
          sequence +
          "')",
      );
    }
    pool = new Pool({ ...config!.pool, options: "-c search_path=" + schema + ",pg_catalog" });
    bridge.database = drizzle(pool) as unknown as Database;
    bridge.lifecyclePool = {
      connect: async () => {
        const client = await pool!.connect();
        lifecyclePid = Number((await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        return client;
      },
    } as Pick<Pool, "connect">;
  }, 30_000);

  beforeEach(async () => {
    bridge.realUsage = true;
    await pool!.query(
      "TRUNCATE " + tables.map((table) => schema + "." + table).join(", ") + " RESTART IDENTITY",
    );
    await pool!.query(
      "INSERT INTO projects (id,owner_id,workspace_id,name) VALUES ($1,$2,1,'lifecycle fixture')",
      [PROJECT, OWNER],
    );
    await bridge
      .database!.insert(assetsTable)
      .values([fixtureAsset(PRIOR, PROJECT), fixtureAsset()]);
    await bridge.database!.insert(assetStorageObjectsTable).values(
      [PRIOR, REPLACEMENT].map((id) => ({
        id,
        assetId: id,
        storageBackend: "r2",
        storageKey: fixtureAsset(id).storageKey,
        role: "original",
        sizeBytes: 4,
        sizeMeasuredAt: new Date(),
        state: "ready",
      })),
    );
    await bridge.database!.insert(projectFilesTable).values({
      projectId: PROJECT,
      artifactId: 9103,
      path: PATH,
      content: "/api/assets/" + PRIOR + "/content",
      mimeType: "image/webp",
    });
    await bridge.database!.insert(assetUsageTable).values({
      assetId: PRIOR,
      projectId: PROJECT,
      artifactId: 9103,
      filePath: PATH,
      consumer: "project-file",
    });
  });

  afterAll(async () => {
    await pool?.end();
    try {
      if (schemaCreated) await admin!.query("DROP SCHEMA " + schema + " CASCADE");
    } finally {
      await admin?.end();
    }
  });

  it.each([
    ["materialize", "commit"],
    ["replace", "commit"],
    ["place_upload", "commit"],
    ["place_upload", "rollback"],
  ] as const)(
    "lets %s settle with %s while a concurrent retirement waits for the session",
    async (action, outcome) => {
      const entered = signal();
      const proceed = signal();
      let transactionPid = 0;
      bridge.beforeUsage = async (tx) => {
        transactionPid = Number(
          (await tx.execute(sql.raw("SELECT pg_backend_pid() AS pid"))).rows[0]!.pid,
        );
        entered.resolve();
        await proceed.promise;
        if (outcome === "rollback") throw new Error("fixture_placement_rollback");
      };
      if (action === "place_upload") {
        // Existing explicit authority, not a grant manufactured by the agent.
        await bridge.database!.insert(assetUsageTable).values({
          assetId: REPLACEMENT,
          projectId: PROJECT,
          consumer: "explicit-project-use:v1",
        });
      }
      const writer = observe<{ status: number }>(
        action === "place_upload"
          ? withActiveProjectLifecycle(PROJECT, async () =>
              materializeProjectAsset({
                userId: OWNER,
                projectId: PROJECT,
                assetId: REPLACEMENT,
                path: PATH,
              }),
            ).then((receipt) => {
              if (receipt.state !== "active") throw new Error("placement_fixture_inactive");
              return { status: 201 };
            })
          : mutation(mountedApp(), action).then((value) => value),
      );
      let retireClient: PoolClient | undefined;
      let retirement: ReturnType<typeof observe<void>> | undefined;
      try {
        await bounded(
          Promise.race([
            entered.promise,
            writer.result().then(() => {
              throw new Error("writer_finished_before_transaction_barrier");
            }),
          ]),
        );
        expect(transactionPid).not.toBe(lifecyclePid);
        retireClient = await pool!.connect();
        const retirePid = Number(
          (await retireClient.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
        );
        await retireClient.query("BEGIN");
        retirement = observe(
          (async () => {
            await retireClient!.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [
              PROJECT_LIFECYCLE_LOCK_NAMESPACE,
              PROJECT,
            ]);
            await retireClient!.query("UPDATE projects SET deleted_at=now() WHERE id=$1", [
              PROJECT,
            ]);
            await retireClient!.query("COMMIT");
          })(),
        );
        await vi.waitFor(
          async () => {
            const blockers = (
              await pool!.query("SELECT pg_blocking_pids($1) AS blockers", [retirePid])
            ).rows[0].blockers;
            expect(blockers).toContain(lifecyclePid);
          },
          { timeout: 5_000, interval: 20 },
        );
        expect(
          (await pool!.query("SELECT deleted_at FROM projects WHERE id=$1", [PROJECT])).rows[0]
            .deleted_at,
        ).toBeNull();
        proceed.resolve();
        if (outcome === "rollback") {
          await expect(writer.result()).rejects.toThrow("fixture_placement_rollback");
        } else {
          expect((await writer.result()).status).toBe(action === "replace" ? 200 : 201);
        }
        await retirement.result();
        const content = (
          await pool!.query("SELECT content FROM project_files WHERE project_id=$1 AND path=$2", [
            PROJECT,
            PATH,
          ])
        ).rows[0].content as string;
        if (outcome === "rollback") {
          expect(content).toBe("/api/assets/" + PRIOR + "/content");
          expect(
            (
              await pool!.query(
                "SELECT id FROM asset_usage WHERE asset_id=$1 AND consumer<>'explicit-project-use:v1'",
                [REPLACEMENT],
              )
            ).rows,
          ).toHaveLength(0);
        } else if (action === "replace") {
          expect(content).toBe("/api/assets/" + REPLACEMENT + "/content");
        } else {
          expect(parseProjectFileAssetReference(content)?.assetId).toBe(REPLACEMENT);
        }
        expect(
          (
            await pool!.query(
              "SELECT consumer FROM asset_usage WHERE asset_id=$1 AND project_id=$2 AND consumer='explicit-project-use:v1'",
              [REPLACEMENT, PROJECT],
            )
          ).rows,
        ).toHaveLength(1);
        expect(
          (await pool!.query("SELECT deleted_at FROM projects WHERE id=$1", [PROJECT])).rows[0]
            .deleted_at,
        ).not.toBeNull();
      } finally {
        proceed.resolve();
        await writer.outcome;
        await retirement?.outcome;
        if (retireClient) {
          await retireClient.query("ROLLBACK");
          retireClient.release();
        }
      }
    },
    20_000,
  );

  it("keeps a standalone helper blocked by a real retirement lock", async () => {
    const retiring = await pool!.connect();
    await retiring.query("BEGIN");
    try {
      await retiring.query("SELECT pg_advisory_xact_lock($1::integer,$2::integer)", [
        PROJECT_LIFECYCLE_LOCK_NAMESPACE,
        PROJECT,
      ]);
      let failure: unknown;
      try {
        await bridge.database!.transaction(async (tx) => {
          await tx.execute(sql.raw("SET LOCAL lock_timeout = '250ms'"));
          await grantExplicitProjectAssetUse(tx, {
            actorUserId: OWNER,
            assetId: REPLACEMENT,
            targetProjectId: PROJECT,
            productScope: "nabuflow",
          });
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ cause: { code: "55P03" } });
      expect(
        (await pool!.query("SELECT id FROM asset_usage WHERE asset_id=$1", [REPLACEMENT])).rows,
      ).toHaveLength(0);
    } finally {
      await retiring.query("ROLLBACK");
      retiring.release();
    }
  });

  it.each(["foreign-owner", "ora"] as const)(
    "does not let spoofed context override %s authority",
    async (denial) => {
      if (denial === "ora") {
        await pool!.query("UPDATE assets SET product_scope='ora' WHERE id=$1", [REPLACEMENT]);
      } else {
        await pool!.query("UPDATE assets SET owner_user_id='foreign-owner' WHERE id=$1", [
          REPLACEMENT,
        ]);
      }
      const result = await request(mountedApp())
        .post("/api/projects/" + PROJECT + "/assets/" + REPLACEMENT + "/materialize")
        .set("x-project-lifecycle-session", String(PROJECT))
        .send({
          path: PATH,
          productScope: "nabuflow",
          ownerUserId: OWNER,
          projectLifecycleSession: { projectId: PROJECT, held: true },
        });
      expect(result.status).toBe(404);
      expect(
        (await pool!.query("SELECT id FROM asset_usage WHERE asset_id=$1", [REPLACEMENT])).rows,
      ).toHaveLength(0);
      expect(
        (await pool!.query("SELECT content FROM project_files WHERE project_id=$1", [PROJECT]))
          .rows[0].content,
      ).toBe("/api/assets/" + PRIOR + "/content");
    },
  );
});
