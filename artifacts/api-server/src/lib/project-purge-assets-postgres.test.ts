import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import type { PoolClient, PoolConfig, QueryResult } from "pg";
import type { seedProjectPurgeAssetPostgresFixtures } from "./project-purge-assets-postgres.fixtures";
import type { ProjectPurgeResourceInventory } from "./project-purge-resources";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// The supervisor owns this already-migrated disposable database and its lifetime.
// This file neither imports the app pool nor creates, migrates or cleans a database.
const bridge = vi.hoisted(() => ({
  pool: undefined as Pool | undefined,
  beforeQuery: undefined as ((client: PoolClient, sql: string) => Promise<void>) | undefined,
  afterQuery: undefined as ((client: PoolClient, sql: string) => Promise<void>) | undefined,
}));
const provider = vi.hoisted(() => {
  const forbidden = vi.fn((): never => {
    throw new Error("isolation_pg_proof_provider_call_forbidden");
  });
  const invokeForbidden = (..._args: unknown[]): unknown => forbidden();
  return {
    forbidden,
    putAssetStream: vi.fn(invokeForbidden),
    openAsset: vi.fn(invokeForbidden),
    headAssetObject: vi.fn(invokeForbidden),
    getLegacyObject: vi.fn(invokeForbidden),
    ObjectNotFoundError: class extends Error {},
  };
});

vi.mock("@workspace/db", async () => ({
  // Pure schema exports only; never importActual("@workspace/db").
  ...(await import("../../../../lib/db/src/schema/index")),
  get db(): never {
    throw new Error("isolation_pg_proof_app_db_forbidden");
  },
  pool: {
    query: (statement: string, values?: unknown[]) => {
      if (!bridge.pool) throw new Error("isolation_pg_proof_pool_unavailable");
      return bridge.pool.query(statement, values);
    },
    connect: async () => {
      if (!bridge.pool) throw new Error("isolation_pg_proof_pool_unavailable");
      const client = await bridge.pool.connect();
      return {
        query: async (statement: string, values?: unknown[]): Promise<QueryResult> => {
          await bridge.beforeQuery?.(client, statement);
          const result = await client.query(statement, values);
          await bridge.afterQuery?.(client, statement);
          return result;
        },
        release: () => client.release(),
      };
    },
  },
}));
vi.mock("./asset-r2", () => ({
  deleteAssetObject: provider.forbidden,
  headAssetObject: provider.headAssetObject,
  putAssetStream: provider.putAssetStream,
  openAsset: provider.openAsset,
}));
vi.mock("./snapshot-storage", () => ({
  deleteSnapshotBlob: provider.forbidden,
  snapshotBlobExists: provider.forbidden,
}));
vi.mock("./objectStorage", () => ({
  ObjectNotFoundError: provider.ObjectNotFoundError,
  ObjectStorageService: class {
    getObjectEntityFile = provider.getLegacyObject;
  },
}));
vi.mock("./neon-project-lifecycle", () => ({
  lookupNeonProjectsByStableName: provider.forbidden,
  neonProjectNameFor: (projectId: number) => "mf-project-" + projectId,
}));
vi.mock("./neon-allocation-intent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./neon-allocation-intent")>()),
  reconcileNeonAllocationIntent: provider.forbidden,
}));
vi.mock("./preview-database-allocation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./preview-database-allocation")>()),
  reconcilePreviewDatabaseAllocation: provider.forbidden,
}));

type Manifest = Awaited<ReturnType<typeof seedProjectPurgeAssetPostgresFixtures>>;
type CaseId = keyof Manifest["fixtures"];
type Seed = Manifest["fixtures"][CaseId];
type Fixture = Seed & {
  alias: string;
  retirementProgress: unknown;
  assetBefore: Record<string, unknown>;
  usagesBefore: Record<string, unknown>[];
};

const CASES: readonly CaseId[] = [
  "writer-first-image",
  "writer-first-upload",
  "writer-first-foreign-image",
  "purge-first-image",
  "purge-first-upload",
  "retention-nabuflow",
  "retention-ora",
  "unknown-image",
  "unknown-upload",
  "alias-only-full",
  "alias-only-thumb",
  "admission-upload",
  "remapped-upload",
  "claim-unshared-image",
  "quoted-writer-image",
  "delete-unshared-upload",
  "unknown-unbound-image",
  "known-unbound-image",
  "scope-same-owner-upload",
  "scope-cross-owner-upload",
  "raw-taskless-same-owner-upload",
  "raw-taskless-cross-owner-upload",
  "soft-deleted-image",
  "retained-legacy-upload",
];
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

function quotedKeyReferences(storageKey: string): { name: string; content: string }[] {
  const url = "https://private.invalid/" + storageKey;
  return [
    { name: "single-quoted-html", content: "<img src='" + url + "'>" },
    { name: "double-quoted-html", content: '<img src="' + url + '">' },
    { name: "unquoted-html", content: "<img src=" + url + ">" },
    { name: "markdown-query", content: "![image](" + url + "?token=disposable)" },
    { name: "nested-json", content: JSON.stringify({ src: url }) },
    {
      name: "template-literal",
      content: "const src = " + String.fromCharCode(96) + url + String.fromCharCode(96) + ";",
    },
  ];
}

function proofDatabaseConfig(): PoolConfig | undefined {
  const flag = process.env.NABUFLOW_ISOLATION_PG_PROOF;
  if (flag === undefined) return undefined;
  if (flag !== "1") throw new Error("isolation_pg_proof_invalid_opt_in");
  try {
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    const database = decodeURIComponent(url.pathname.slice(1));
    const port = url.port ? Number(url.port) : 5432;
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "127.0.0.1" ||
      !/^mustaflow_parity_disposable_[a-f0-9]{16}$/u.test(database) ||
      url.search !== "" ||
      url.hash !== "" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("invalid");
    return {
      host: "127.0.0.1",
      port,
      database,
      user: decodeURIComponent(url.username) || "postgres",
      password: decodeURIComponent(url.password),
      ssl: false,
      max: 4,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 45_000,
      application_name: "nabuflow-isolation-pg-proof-" + randomUUID(),
    };
  } catch {
    throw new Error("isolation_pg_proof_disposable_database_required");
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function id(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 2147483647
  );
}

function loadManifest(database: string): Manifest {
  const raw = process.env.NABUFLOW_ISOLATION_PG_FIXTURE_MANIFEST;
  if (!raw || Buffer.byteLength(raw, "utf8") > 24 * 1024) {
    throw new Error("isolation_pg_proof_fixture_manifest_required");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("isolation_pg_proof_fixture_manifest_invalid");
  }
  const invalid = (): never => {
    throw new Error("isolation_pg_proof_fixture_manifest_invalid");
  };
  if (
    !object(value) ||
    !exactKeys(value, ["version", "database", "expectedTestCount", "epoch", "fixtures"]) ||
    value.version !== 1 ||
    value.database !== database ||
    value.expectedTestCount !== 27 ||
    typeof value.epoch !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.epoch) ||
    !object(value.fixtures) ||
    !exactKeys(value.fixtures, CASES)
  )
    return invalid();
  const projects = new Set<number>();
  const assets = new Set<number>();
  const aliases = new Set<string>();
  const physicalKeys = new Set<string>();
  for (const caseId of CASES) {
    const f = value.fixtures[caseId];
    if (
      !object(f) ||
      !exactKeys(f, [
        "tag",
        "sourceId",
        "targetId",
        "assetId",
        "assetProjectId",
        "aliasId",
        "kind",
        "storageKey",
        "aliasStorageKey",
        "operationId",
        "retirementId",
        "owner",
        "productScope",
        "explicitGrant",
        "historicalFileId",
        "historicalContent",
      ])
    )
      return invalid();
    const tag = "purge-pg:" + value.epoch + ":" + caseId;
    const kind = caseId.endsWith("upload") ? "upload" : "image";
    const ora = caseId === "retention-ora";
    const aliasOnly = caseId.startsWith("alias-only-");
    const explicit =
      caseId.startsWith("writer-first-") ||
      caseId.startsWith("purge-first-") ||
      caseId === "admission-upload" ||
      caseId === "remapped-upload";
    const scope =
      caseId.startsWith("unknown-") || caseId === "scope-cross-owner-upload"
        ? null
        : ora
          ? "ora"
          : "nabuflow";
    const rawLegacyUpload = caseId === "retained-legacy-upload" || caseId.startsWith("scope-");
    const rawStorageKey = typeof f.storageKey === "string" ? f.storageKey : "";
    const key = rawLegacyUpload
      ? rawStorageKey
      : caseId.endsWith("unbound-image")
        ? "generated-images/" + value.epoch + "/" + caseId + "/full.webp"
        : "assets/" +
          sha256(tag).slice(0, 24) +
          "/" +
          (ora
            ? "account"
            : "project-" + (caseId === "writer-first-foreign-image" ? f.targetId : f.sourceId)) +
          "/" +
          value.epoch +
          "/" +
          caseId +
          ".webp";
    const aliasKey = aliasOnly
      ? "generated-images/" + value.epoch + "/" + caseId + "/full.webp"
      : key;
    if (
      !id(f.sourceId) ||
      !id(f.targetId) ||
      f.sourceId === 51 ||
      f.targetId === 51 ||
      f.sourceId === f.targetId ||
      projects.has(f.sourceId) ||
      projects.has(f.targetId) ||
      !id(f.assetId) ||
      assets.has(f.assetId) ||
      !id(f.aliasId) ||
      f.tag !== tag ||
      f.owner !== tag ||
      f.kind !== kind ||
      f.productScope !== scope ||
      f.assetProjectId !==
        (ora ? null : caseId === "writer-first-foreign-image" ? f.targetId : f.sourceId) ||
      (rawLegacyUpload &&
        !/^\/objects\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          rawStorageKey,
        )) ||
      f.storageKey !== key ||
      f.aliasStorageKey !== aliasKey ||
      f.operationId !== tag + ":purge" ||
      f.retirementId !== tag + ":retirement" ||
      f.explicitGrant !== explicit ||
      aliases.has(kind + ":" + f.aliasId) ||
      physicalKeys.has(rawStorageKey)
    )
      return invalid();
    const alias =
      kind === "image"
        ? "/api/images/" + f.aliasId + "/file"
        : "/api/projects/" + f.sourceId + "/uploads/" + f.aliasId + "/content";
    const content = aliasOnly
      ? aliasKey.replace(
          /\/full\.webp$/u,
          caseId === "alias-only-thumb" ? "/thumb.webp" : "/full.webp",
        )
      : alias;
    if (
      explicit ||
      ["claim-unshared-image", "quoted-writer-image", "delete-unshared-upload"].includes(caseId)
        ? f.historicalFileId !== null || f.historicalContent !== null
        : !id(f.historicalFileId) || f.historicalContent !== content
    )
      return invalid();
    projects.add(f.sourceId);
    projects.add(f.targetId);
    assets.add(f.assetId);
    aliases.add(kind + ":" + f.aliasId);
    physicalKeys.add(rawStorageKey);
  }
  return value as unknown as Manifest;
}

const config = proofDatabaseConfig();
// Unset opt-in returns before either manifest or database connection is used.
const manifest = config ? loadManifest(String(config.database)) : undefined;

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function boundedSignal(promise: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("isolation_pg_proof_barrier_timeout")), 10_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };
type Observed<T> = {
  settled: Promise<Outcome<T>>;
  result: () => Promise<T>;
  premature: (stage: string) => Promise<never>;
};

function observe<T>(operation: Promise<T>): Observed<T> {
  // Attach a rejection handler immediately, but never replace its original error.
  const settled: Promise<Outcome<T>> = operation.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
  return {
    settled,
    result: async () => {
      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    premature: async (stage) => {
      const outcome = await settled;
      if (!outcome.ok) throw outcome.error;
      throw new Error("isolation_pg_proof_completed_before_" + stage);
    },
  };
}

describe.skipIf(!config)("final purge alias isolation with real PostgreSQL", () => {
  let pool: Pool;
  let purge: typeof import("./project-purge-resources");
  let registry: typeof import("./asset-registry");
  let oraLibrary: typeof import("./ora-assets");
  let preview: typeof import("./preview-database-allocation");
  let retirement: typeof import("./project-retirement-contract");

  beforeAll(async () => {
    pool = new Pool(config!);
    bridge.pool = pool;
    vi.stubGlobal("fetch", provider.forbidden);
    const actual = await pool.query<{ database: string; host: string }>(
      "SELECT current_database() AS database, host(inet_server_addr()) AS host",
    );
    expect(actual.rows).toEqual([{ database: manifest!.database, host: "127.0.0.1" }]);
    expect(manifest!.database).toBe(config!.database);
    expect(
      (
        await pool.query(
          "SELECT epoch FROM production_database_admission_epochs WHERE namespace='production' AND state='active'",
        )
      ).rows,
    ).toHaveLength(0);
    expect(
      (
        await pool.query("SELECT state FROM production_database_admission_epochs WHERE epoch=$1", [
          manifest!.epoch,
        ])
      ).rows,
    ).toEqual([{ state: "prepared" }]);
    // App pool is mocked before dynamic import; predicates and SQL remain real.
    purge = await import("./project-purge-resources");
    registry = await import("./asset-registry");
    oraLibrary = await import("./ora-assets");
    preview = await import("./preview-database-allocation");
    retirement = await import("./project-retirement-contract");
  }, 45_000);

  afterEach(() => {
    bridge.beforeQuery = undefined;
    bridge.afterQuery = undefined;
    expect(provider.forbidden).not.toHaveBeenCalled();
    provider.putAssetStream
      .mockReset()
      .mockImplementation((..._args: unknown[]) => provider.forbidden());
    provider.openAsset
      .mockReset()
      .mockImplementation((..._args: unknown[]) => provider.forbidden());
    provider.headAssetObject
      .mockReset()
      .mockImplementation((..._args: unknown[]) => provider.forbidden());
    provider.getLegacyObject
      .mockReset()
      .mockImplementation((..._args: unknown[]) => provider.forbidden());
  });

  afterAll(async () => {
    bridge.pool = undefined;
    vi.unstubAllGlobals();
    // Only our connections close. Fixtures and cluster remain supervisor-owned.
    await pool?.end();
  }, 10_000);

  async function assetRecord(assetId: number): Promise<Record<string, unknown>> {
    return (
      await pool.query(
        "SELECT id,project_id,owner_user_id,actor_user_id,product_scope,scope,state," +
          "thread_key,version_id,task_id,message_id,storage_key,storage_backend FROM assets WHERE id=$1",
        [assetId],
      )
    ).rows[0] as Record<string, unknown>;
  }

  async function usageRecords(assetId: number): Promise<Record<string, unknown>[]> {
    const rows = (
      await pool.query(
        "SELECT id,asset_id,project_id,artifact_id,version_id,file_path,consumer,created_at " +
          "FROM asset_usage WHERE asset_id=$1 ORDER BY id",
        [assetId],
      )
    ).rows;
    return JSON.parse(JSON.stringify(rows)) as Record<string, unknown>[];
  }

  async function fixture(caseId: CaseId): Promise<Fixture> {
    const f = manifest!.fixtures[caseId];
    // All identifiers are validated in the env manifest AND bound to live tags
    // before any operation checkpoint update or destructive purge entry point.
    const projects = await pool.query(
      "SELECT id,owner_id,name,(deleted_at IS NOT NULL) AS deleted FROM projects WHERE id=ANY($1::integer[]) ORDER BY id",
      [[f.sourceId, f.targetId]],
    );
    expect(projects.rows).toEqual(
      [
        { id: f.sourceId, owner_id: f.owner, name: f.tag + ":source", deleted: true },
        { id: f.targetId, owner_id: f.owner, name: f.tag + ":target", deleted: false },
      ].sort((a, b) => a.id - b.id),
    );
    const assetBefore = await assetRecord(f.assetId);
    expect(assetBefore).toMatchObject({
      id: f.assetId,
      project_id: f.assetProjectId,
      owner_user_id: f.owner,
      actor_user_id: f.owner,
      product_scope: f.productScope,
      scope: f.productScope === "ora" ? "account" : "project",
      state: "ready",
      storage_key: f.storageKey,
    });
    if (f.kind === "image") {
      expect(
        (
          await pool.query(
            "SELECT project_id,asset_id,prompt,storage_key FROM generated_images WHERE id=$1",
            [f.aliasId],
          )
        ).rows,
      ).toEqual([
        {
          project_id: f.sourceId,
          asset_id: caseId === "unknown-unbound-image" ? null : f.assetId,
          prompt: f.tag,
          storage_key: f.aliasStorageKey,
        },
      ]);
    } else {
      expect(
        (
          await pool.query(
            "SELECT project_id,filename,object_path FROM project_uploads WHERE id=$1",
            [f.aliasId],
          )
        ).rows,
      ).toEqual([
        { project_id: f.sourceId, filename: f.tag + ".webp", object_path: f.aliasStorageKey },
      ]);
    }
    if (f.historicalFileId !== null) {
      expect(
        (
          await pool.query("SELECT project_id,path,content FROM project_files WHERE id=$1", [
            f.historicalFileId,
          ])
        ).rows,
      ).toEqual([{ project_id: f.targetId, path: f.tag + ".html", content: f.historicalContent }]);
    }
    const usagesBefore = await usageRecords(f.assetId);
    const grants = usagesBefore.filter((row) => row.consumer === "explicit-project-use:v1");
    expect(grants).toHaveLength(f.explicitGrant ? 1 : 0);
    if (f.explicitGrant)
      expect(grants[0]).toMatchObject({
        project_id: f.targetId,
        artifact_id: null,
        version_id: null,
        file_path: null,
      });
    if (
      caseId.startsWith("alias-only-") ||
      ["claim-unshared-image", "quoted-writer-image", "delete-unshared-upload"].includes(caseId)
    ) {
      if (f.kind === "image") {
        expect(usagesBefore).toEqual([
          expect.objectContaining({
            asset_id: f.assetId,
            project_id: f.sourceId,
            artifact_id: null,
            version_id: null,
            file_path: null,
            consumer: "generated-image:" + f.aliasId,
          }),
        ]);
      } else {
        expect(usagesBefore).toHaveLength(0);
      }
    }
    const retirementRow = await pool.query<{ progress: unknown }>(
      "SELECT progress FROM project_retirement_operations " +
        "WHERE id=$1 AND project_id=$2 AND requested_by=$3 AND state='completed' AND completed_at IS NOT NULL",
      [f.retirementId, f.sourceId, f.owner],
    );
    expect(retirementRow.rows).toHaveLength(1);
    const retirementProgress = retirementRow.rows[0]!.progress;
    expect(retirement.hasCurrentProjectRetirementCompletionEvidence(retirementProgress)).toBe(true);
    expect(
      (
        await pool.query(
          "SELECT state,birth_registered,registration_epoch FROM production_database_admission_receipts WHERE project_id=$1",
          [f.sourceId],
        )
      ).rows,
    ).toEqual([{ state: "sealed", birth_registered: false, registration_epoch: manifest!.epoch }]);
    const evidence = {
      version: 1,
      kind: "no-dispatch",
      stateDigest: preview.previewDatabaseStateDigest(f.sourceId, {
        status: "none",
        hasCredential: false,
        allocation: null,
      }),
    };
    // Only the typed control checkpoint is completed after guarded module import.
    // No historical asset/reference rows are recreated or bypassed here.
    const checkpoint = await pool.query(
      "UPDATE project_purge_operations SET resource_progress=jsonb_set(resource_progress,'{previewDatabaseEvidence}',$5::jsonb) " +
        "WHERE id=$1 AND project_id=$2 AND retirement_operation_id_hash=$3 AND requested_by_hash=$4 " +
        "AND state='running' AND lease_version=1",
      [
        f.operationId,
        f.sourceId,
        sha256(f.retirementId),
        sha256(f.owner),
        JSON.stringify(evidence),
      ],
    );
    expect(checkpoint.rowCount).toBe(1);
    const alias =
      f.kind === "image"
        ? "/api/images/" + f.aliasId + "/file"
        : "/api/projects/" + f.sourceId + "/uploads/" + f.aliasId + "/content";
    return { ...f, alias, retirementProgress, assetBefore, usagesBefore };
  }

  function finalPurge(f: Fixture) {
    return purge.applyProjectRelationalPurge(f.sourceId, f.operationId, {
      inventoryDigestSha256: sha256("disposable:" + f.operationId),
      providerRemoved: 0,
      providerDetached: 0,
      leaseVersion: 1,
    });
  }

  function physicalInventory(f: Fixture): ProjectPurgeResourceInventory {
    return {
      projectId: f.sourceId,
      ownerId: f.owner,
      projectName: f.tag + ":source",
      deletedAt: new Date(),
      retirementOperationId: f.retirementId,
      retirementProgress: f.retirementProgress,
      neonProjectIds: [],
      productionNeonProjectName: "mf-project-" + f.sourceId,
      previewNeonProjectName: "mf-preview-" + f.sourceId,
      previewDatabase: { status: "none", hasCredential: false, allocation: null },
      assetTargets: [
        {
          assetId: f.assetId,
          ownerUserId: f.owner,
          shared: false,
          storageBackend:
            f.assetBefore.storage_backend === "legacy-object" ? "legacy-object" : "r2",
          storageKey: f.storageKey,
          sizeBytes: 1,
        },
      ],
      legacyGeneratedImageTargets: [],
      uploadTargets: [],
      snapshotObjectKeys: [],
      tableCounts: [],
      activeAddonCount: 0,
      digestSha256: sha256(f.operationId),
    };
  }

  async function metadataPresent(f: Fixture): Promise<boolean> {
    return (
      (
        await pool.query(
          f.kind === "image"
            ? "SELECT id FROM generated_images WHERE id=$1"
            : "SELECT id FROM project_uploads WHERE id=$1",
          [f.aliasId],
        )
      ).rowCount === 1
    );
  }

  async function assertRetained(f: Fixture, additionalStorageKeys: readonly string[] = []) {
    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [f.sourceId])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [f.targetId])).rows,
    ).toHaveLength(1);
    expect(await assetRecord(f.assetId)).toEqual(
      f.assetBefore.project_id === f.sourceId
        ? {
            ...f.assetBefore,
            project_id: null,
            thread_key: null,
            version_id: null,
            task_id: null,
            message_id: null,
          }
        : f.assetBefore,
    );
    expect(await usageRecords(f.assetId)).toEqual(
      f.usagesBefore.filter(
        (row) =>
          row.project_id !== f.sourceId &&
          row.consumer !== "project-purge-preserved-direct:" + f.sourceId,
      ),
    );
    expect(await metadataPresent(f)).toBe(false);
    expect(
      (
        await pool.query(
          'SELECT state,storage_key FROM asset_storage_objects WHERE asset_id=$1 ORDER BY storage_key COLLATE "C"',
          [f.assetId],
        )
      ).rows,
    ).toEqual(
      [...new Set([f.storageKey, ...additionalStorageKeys])]
        .sort()
        .map((storage_key) => ({ state: "ready", storage_key })),
    );
    expect(
      (
        await pool.query(
          "SELECT state,birth_registered,registration_epoch FROM production_database_admission_receipts WHERE project_id=$1",
          [f.sourceId],
        )
      ).rows,
    ).toEqual([{ state: "sealed", birth_registered: false, registration_epoch: manifest!.epoch }]);
    expect(
      (
        await pool.query(
          "SELECT epoch FROM production_database_admission_epochs WHERE namespace='production' AND state='active'",
        )
      ).rows,
    ).toHaveLength(0);
  }

  async function assertBlocked(f: Fixture) {
    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [f.sourceId])).rows,
    ).toHaveLength(1);
    expect(await metadataPresent(f)).toBe(true);
    expect(await assetRecord(f.assetId)).toEqual(f.assetBefore);
    expect(await usageRecords(f.assetId)).toEqual(f.usagesBefore);
    expect(
      (await pool.query("SELECT content FROM project_files WHERE id=$1", [f.historicalFileId]))
        .rows,
    ).toEqual([{ content: f.historicalContent }]);
    expect(
      (await pool.query("SELECT state FROM asset_storage_objects WHERE asset_id=$1", [f.assetId]))
        .rows,
    ).toEqual([{ state: "ready" }]);
    expect(
      (
        await pool.query(
          "SELECT state,terminal_evidence FROM project_purge_operations WHERE id=$1",
          [f.operationId],
        )
      ).rows,
    ).toEqual([{ state: "running", terminal_evidence: null }]);
  }

  async function waitForBlock(
    observer: PoolClient,
    waiter: number,
    holder: number,
    abort: AbortSignal,
  ) {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      abort.throwIfAborted();
      const result = await observer.query<{ blocked: boolean }>(
        "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked",
        [waiter, holder],
      );
      if (result.rows[0]?.blocked === true) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("isolation_pg_proof_expected_lock_wait_absent");
  }

  async function expectBlock(
    observer: PoolClient,
    waiter: number,
    holder: number,
    operations: readonly Observed<unknown>[],
  ) {
    const abort = new AbortController();
    const polling = waitForBlock(observer, waiter, holder, abort.signal);
    try {
      await Promise.race([
        polling,
        ...operations.map((operation) => operation.premature("lock_evidence")),
      ]);
    } finally {
      abort.abort();
      await polling.catch(() => undefined);
    }
  }

  async function canonicalizeEarlier(f: Fixture) {
    if (f.assetProjectId === f.sourceId) {
      expect(await purge.releaseProjectAssetStorage(physicalInventory(f))).toMatchObject({
        deletedObjects: 0,
        detachedObjects: 1,
      });
      return;
    }
    // Foreign target has no source-owned physical target to release.
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query("SELECT id FROM assets WHERE id=$1 FOR UPDATE", [f.assetId]);
      await purge.canonicalizeSurvivingAssetAliases(client, f.sourceId, f.assetId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  it.each([
    { caseId: "writer-first-image" as const, kind: "image", foreignAsset: false },
    { caseId: "writer-first-upload" as const, kind: "upload", foreignAsset: false },
    { caseId: "writer-first-foreign-image" as const, kind: "image", foreignAsset: true },
  ])(
    "refreshes a committed $kind alias after earlier canonicalization (foreign=$foreignAsset)",
    async ({ caseId }) => {
      const f = await fixture(caseId);
      await canonicalizeEarlier(f);
      const writer = await pool.connect();
      const observer = await pool.connect();
      const entering = signal();
      let purgePid = 0;
      let completion: Observed<unknown> | undefined;
      try {
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        const file = await writer.query<{ id: number }>(
          "INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3) RETURNING id",
          [f.targetId, "late-" + randomUUID() + ".html", f.alias],
        );
        bridge.beforeQuery = async (client, sql) => {
          if (!sql.includes("/* purge-final-assets-lock */")) return;
          purgePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]!.pid;
          entering.resolve();
        };
        completion = observe(finalPurge(f));
        await boundedSignal(
          Promise.race([entering.promise, completion.premature("asset_barrier")]),
        );
        await expectBlock(observer, purgePid, writerPid, [completion]);
        await writer.query("COMMIT");
        await completion.result();
        expect(
          (await pool.query("SELECT content FROM project_files WHERE id=$1", [file.rows[0]!.id]))
            .rows,
        ).toEqual([{ content: "/api/assets/" + f.assetId + "/content" }]);
        await assertRetained(f);
      } finally {
        await writer.query("ROLLBACK").catch(() => undefined);
        await completion?.settled;
        bridge.beforeQuery = undefined;
        observer.release();
        writer.release();
      }
    },
    120_000,
  );

  it.each(["image", "upload"] as const)(
    "rejects a late %s alias writer after protected metadata removal",
    async (kind) => {
      const f = await fixture(kind === "image" ? "purge-first-image" : "purge-first-upload");
      const writer = await pool.connect();
      const observer = await pool.connect();
      const locked = signal();
      const continuePurge = signal();
      let purgePid = 0;
      let paused = false;
      let completion: Observed<unknown> | undefined;
      let write: Observed<unknown> | undefined;
      const path = "blocked-" + randomUUID() + ".html";
      try {
        const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
        bridge.afterQuery = async (client, sql) => {
          if (paused || !sql.includes("/* purge-final-upload-metadata */")) return;
          paused = true;
          purgePid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
            .rows[0]!.pid;
          locked.resolve();
          await boundedSignal(continuePurge.promise);
        };
        completion = observe(finalPurge(f));
        await boundedSignal(
          Promise.race([locked.promise, completion.premature("metadata_barrier")]),
        );
        write = observe(
          writer.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
            f.targetId,
            path,
            f.alias,
          ]),
        );
        await expectBlock(observer, writerPid, purgePid, [completion, write]);
        continuePurge.resolve();
        await completion.result();
        await expect(write.result()).rejects.toMatchObject({ code: "55000" });
        await writer.query("ROLLBACK");
        expect(
          (
            await pool.query("SELECT id FROM project_files WHERE project_id=$1 AND path=$2", [
              f.targetId,
              path,
            ])
          ).rows,
        ).toHaveLength(0);
        await assertRetained(f);
      } finally {
        continuePurge.resolve();
        await completion?.settled;
        await write?.settled;
        await writer.query("ROLLBACK").catch(() => undefined);
        bridge.afterQuery = undefined;
        observer.release();
        writer.release();
      }
    },
    120_000,
  );

  it.each(["nabuflow", "ora"] as const)(
    "keeps historical %s physical references without manufacturing target grants",
    async (scope) => {
      const f = await fixture(scope === "ora" ? "retention-ora" : "retention-nabuflow");
      expect((await finalPurge(f)).absenceDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
      await assertRetained(f);
      expect(
        (
          await pool.query(
            "SELECT id FROM asset_usage WHERE asset_id=$1 AND consumer='explicit-project-use:v1'",
            [f.assetId],
          )
        ).rows,
      ).toHaveLength(0);
      const canonical =
        scope === "ora"
          ? "/api/ora/canonical-assets/" + f.assetId + "/content"
          : "/api/assets/" + f.assetId + "/content";
      expect(
        (await pool.query("SELECT content FROM project_files WHERE id=$1", [f.historicalFileId]))
          .rows,
      ).toEqual([{ content: canonical }]);
    },
    120_000,
  );

  it("adopts historical NULL scope only for exact same-owner NabuFlow provenance", async () => {
    const sameOwner = await fixture("scope-same-owner-upload");
    const crossOwner = await fixture("scope-cross-owner-upload");
    expect(sameOwner.assetBefore.product_scope).toBe("nabuflow");
    expect(crossOwner.assetBefore.product_scope).toBeNull();
    expect(
      (
        await pool.query("SELECT public.asset_has_verified_nabuflow_provenance($1) AS verified", [
          sameOwner.assetId,
        ])
      ).rows,
    ).toEqual([{ verified: true }]);
    expect(
      (
        await pool.query("SELECT public.asset_has_verified_nabuflow_provenance($1) AS verified", [
          crossOwner.assetId,
        ])
      ).rows,
    ).toEqual([{ verified: false }]);
    const crossOwners = (
      await pool.query<{ owner_id: string }>(
        "SELECT DISTINCT p.owner_id FROM project_uploads pu " +
          "JOIN projects p ON p.id=pu.project_id WHERE pu.object_path=$1",
        [crossOwner.storageKey],
      )
    ).rows.map((row) => row.owner_id);
    expect(new Set(crossOwners)).toEqual(
      new Set([crossOwner.owner, manifest!.fixtures["writer-first-image"].owner]),
    );
  });

  it.each(["image", "upload"] as const)(
    "fails closed for historical unknown-origin %s without guessed authority",
    async (kind) => {
      const f = await fixture(kind === "image" ? "unknown-image" : "unknown-upload");
      await expect(finalPurge(f)).rejects.toThrow("project_purge_asset_origin_unresolved");
      await assertBlocked(f);
    },
    120_000,
  );

  it("leaves a NULL-scope assetless image unbound and fails closed without widening product authority", async () => {
    const f = await fixture("unknown-unbound-image");
    expect(f.assetBefore.product_scope).toBeNull();
    expect(
      (
        await pool.query(
          "SELECT asset_id,product_scope,storage_key FROM generated_images WHERE id=$1",
          [f.aliasId],
        )
      ).rows,
    ).toEqual([{ asset_id: null, product_scope: null, storage_key: f.aliasStorageKey }]);
    expect(
      f.usagesBefore.filter((row) => row.consumer === "generated-image:" + f.aliasId),
    ).toHaveLength(0);
    await expect(finalPurge(f)).rejects.toThrow("project_purge_asset_release_failed");
    await assertBlocked(f);
  });

  it("binds a known same-product same-project ready legacy image during the real migration", async () => {
    const f = await fixture("known-unbound-image");
    expect(
      (
        await pool.query("SELECT asset_id,product_scope FROM generated_images WHERE id=$1", [
          f.aliasId,
        ])
      ).rows,
    ).toEqual([{ asset_id: f.assetId, product_scope: "nabuflow" }]);
    expect(f.usagesBefore.filter((row) => row.consumer === "generated-image:" + f.aliasId)).toEqual(
      [
        expect.objectContaining({
          asset_id: f.assetId,
          project_id: f.sourceId,
          artifact_id: null,
          version_id: null,
          file_path: null,
        }),
      ],
    );
    await assertBlocked(f);
  });

  it("canonicalizes a same-owner taskless raw upload alias and blocks a cross-owner alias without mutation", async () => {
    const crossOwner = await fixture("raw-taskless-cross-owner-upload");
    const crossBefore = (
      await pool.query<{ args_summary: string }>(
        "SELECT args_summary FROM agent_tool_calls WHERE task_id IS NULL AND tool_name=$1",
        [crossOwner.tag],
      )
    ).rows;
    expect(crossBefore).toHaveLength(1);
    expect(crossBefore[0]!.args_summary).toMatch(/^\/objects\/uploads\//u);
    await expect(finalPurge(crossOwner)).rejects.toThrow();
    expect(
      (
        await pool.query(
          "SELECT args_summary FROM agent_tool_calls WHERE task_id IS NULL AND tool_name=$1",
          [crossOwner.tag],
        )
      ).rows,
    ).toEqual(crossBefore);
    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [crossOwner.sourceId])).rows,
    ).toEqual([{ id: crossOwner.sourceId }]);

    const sameOwner = await fixture("raw-taskless-same-owner-upload");
    const sameOwnerRawAlias = (
      await pool.query<{ args_summary: string }>(
        "SELECT args_summary FROM agent_tool_calls WHERE task_id IS NULL AND tool_name=$1",
        [sameOwner.tag],
      )
    ).rows[0]!.args_summary;
    expect(sameOwnerRawAlias).toMatch(/^\/objects\/uploads\//u);
    expect((await finalPurge(sameOwner)).absenceDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await pool.query(
          "SELECT args_summary FROM agent_tool_calls WHERE task_id IS NULL AND tool_name=$1",
          [sameOwner.tag],
        )
      ).rows,
    ).toEqual([{ args_summary: "/api/assets/" + sameOwner.assetId + "/content" }]);
    await assertRetained(sameOwner, [sameOwnerRawAlias]);
  }, 120_000);

  it("does not retain an asset through soft-deleted generated-image file or thumbnail aliases", async () => {
    const f = await fixture("soft-deleted-image");
    if (f.historicalFileId !== null) {
      await pool.query("DELETE FROM project_files WHERE id=$1", [f.historicalFileId]);
    }
    await pool.query("DELETE FROM asset_usage WHERE asset_id=$1", [f.assetId]);
    expect(
      (
        await pool.query(
          "SELECT (deleted_at IS NOT NULL) AS deleted,file_url,thumbnail_url " +
            "FROM generated_images WHERE id=$1",
          [f.aliasId],
        )
      ).rows,
    ).toEqual([
      {
        deleted: true,
        file_url: "/api/images/" + f.aliasId + "/file",
        thumbnail_url: "/api/images/" + f.aliasId + "/thumbnail",
      },
    ]);
    expect(
      (
        await pool.query(
          "SELECT public.durable_asset_reference_exists($1,NULL,NULL) AS referenced",
          [f.assetId],
        )
      ).rows,
    ).toEqual([{ referenced: false }]);
    const pending = await registry.deleteReadyAsset({
      assetId: f.assetId,
      userId: f.owner,
      productScope: "nabuflow",
      generatedImageIdBeingDeleted: f.aliasId,
    });
    expect(pending.storageObjects).toEqual([
      { storageKey: f.storageKey, storageBackend: "r2", sizeBytes: 1 },
    ]);
  });

  it("migrates a retained legacy upload to verified R2 and completes permanent deletion", async () => {
    const f = await fixture("retained-legacy-upload");
    const original = physicalInventory(f);
    const bytes = Buffer.from("x");
    let legacyPresent = true;
    let r2Object = Buffer.alloc(0);
    const metadata = {
      size: String(bytes.length),
      contentType: "image/webp",
      generation: "1",
      md5Hash: "ndTkYSaMgDT1yFZOFVxnpg==",
    };
    const legacyFile = {
      getMetadata: vi.fn(async () => [metadata]),
      createReadStream: vi.fn(() => Readable.from(bytes)),
      delete: vi.fn(async () => {
        legacyPresent = false;
      }),
    };
    provider.getLegacyObject.mockImplementation(async (..._args: unknown[]) => {
      if (!legacyPresent) throw new provider.ObjectNotFoundError();
      return legacyFile;
    });
    provider.putAssetStream.mockImplementation(async (...args: unknown[]) => {
      const input = args[0] as { body: AsyncIterable<Uint8Array | Buffer> };
      const chunks: Buffer[] = [];
      for await (const chunk of input.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      r2Object = Buffer.concat(chunks);
    });
    provider.headAssetObject.mockImplementation(async (..._args: unknown[]) => ({
      sizeBytes: r2Object.length,
    }));
    provider.openAsset.mockImplementation(async (..._args: unknown[]) => ({
      body: Readable.from(r2Object),
      sizeBytes: r2Object.length,
      contentType: "image/webp",
    }));

    expect(await purge.migrateRetainedLegacyAssetsForPurge(original)).toBe(true);
    expect(legacyPresent).toBe(false);
    expect(r2Object.equals(bytes)).toBe(true);
    const migrated = (
      await pool.query<{
        storage_key: string;
        storage_backend: string;
        state: string;
      }>("SELECT storage_key,storage_backend,state FROM assets WHERE id=$1", [f.assetId])
    ).rows[0]!;
    expect(migrated).toMatchObject({ storage_backend: "r2", state: "ready" });
    expect(migrated.storage_key).toMatch(/^assets\/[a-f0-9]{24}\/account\/[a-f0-9-]{36}\/.+$/u);
    expect(
      (await pool.query("SELECT content FROM project_files WHERE id=$1", [f.historicalFileId]))
        .rows,
    ).toEqual([{ content: "/api/assets/" + f.assetId + "/content" }]);
    const storageBeforeFinal = (
      await pool.query<{
        storage_backend: string;
        storage_key: string;
        role: string;
        state: string;
        measured: boolean;
      }>(
        "SELECT storage_backend,storage_key,role,state,(size_measured_at IS NOT NULL) AS measured " +
          "FROM asset_storage_objects WHERE asset_id=$1 ORDER BY id",
        [f.assetId],
      )
    ).rows;
    expect(storageBeforeFinal).toEqual([
      {
        storage_backend: "legacy-object",
        storage_key: f.storageKey,
        role: "project-purge-legacy-source:" + original.digestSha256 + ":1",
        state: "deleted",
        measured: true,
      },
      {
        storage_backend: "r2",
        storage_key: migrated.storage_key,
        role: "primary",
        state: "ready",
        measured: true,
      },
    ]);

    const migratedInventory: ProjectPurgeResourceInventory = {
      ...original,
      assetTargets: [
        {
          assetId: f.assetId,
          ownerUserId: f.owner,
          shared: true,
          storageBackend: "r2",
          storageKey: migrated.storage_key,
          sizeBytes: bytes.length,
        },
      ],
    };
    await expect(purge.releaseProjectAssetStorage(migratedInventory)).resolves.toMatchObject({
      deletedObjects: 0,
      detachedObjects: 1,
      complete: true,
    });
    await finalPurge(f);

    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [f.sourceId])).rows,
    ).toHaveLength(0);
    expect(
      (await pool.query("SELECT id FROM projects WHERE id=$1", [f.targetId])).rows,
    ).toHaveLength(1);
    expect(await metadataPresent(f)).toBe(false);
    expect(await assetRecord(f.assetId)).toMatchObject({
      project_id: null,
      storage_backend: "r2",
      storage_key: migrated.storage_key,
      product_scope: "nabuflow",
      state: "ready",
    });
    expect(r2Object.equals(bytes)).toBe(true);
    expect(provider.forbidden).not.toHaveBeenCalled();
  }, 120_000);

  it.each(["full", "thumb"] as const)(
    "blocks unregistered alias-only %s before physical release and final deletion",
    async (part) => {
      const f = await fixture(part === "full" ? "alias-only-full" : "alias-only-thumb");
      expect(f.usagesBefore).toEqual([
        expect.objectContaining({
          asset_id: f.assetId,
          project_id: f.sourceId,
          artifact_id: null,
          version_id: null,
          file_path: null,
          consumer: "generated-image:" + f.aliasId,
        }),
      ]);
      await expect(purge.releaseProjectAssetStorage(physicalInventory(f))).rejects.toThrow(
        "project_purge_asset_release_failed",
      );
      await assertBlocked(f);
      await expect(finalPurge(f)).rejects.toThrow("project_purge_asset_release_failed");
      await assertBlocked(f);
    },
    120_000,
  );

  it("admits same-project and explicitly granted URL-only upload references", async () => {
    const f = await fixture("admission-upload");
    const client = await pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(
        (
          await client.query(
            "SELECT public.resolve_durable_storage_keys($1::jsonb) AS storage_key",
            [JSON.stringify({ content: f.alias })],
          )
        ).rows,
      ).toEqual([{ storage_key: f.storageKey }]);
      // SQL reference admission only: project lifecycle admission remains the
      // responsibility of the HTTP/worker lease tests. No provider work runs.
      for (const projectId of [f.sourceId, f.targetId]) {
        const inserted = await client.query(
          "INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3) RETURNING content",
          [projectId, "url-only-" + randomUUID() + ".html", f.alias],
        );
        expect(inserted.rows).toEqual([{ content: f.alias }]);
      }
      expect(
        (
          await client.query(
            "SELECT public.resolve_durable_storage_keys($1::jsonb) AS storage_key",
            [JSON.stringify({ content: "/api/projects/9999999999/uploads/9999999999/content" })],
          )
        ).rows,
      ).toEqual([]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("rejects URL-only upload references while their physical key is durably claimed", async () => {
    const f = await fixture("admission-upload");
    const client = await pool.connect();
    const path = "claimed-url-" + randomUUID() + ".html";
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await client.query(
        "INSERT INTO durable_asset_deletion_claims (storage_key,claim_kind,retired_project_id,retired_asset_id) " +
          "VALUES ($1,'project-purge-asset',$2,$3)",
        [f.storageKey, f.sourceId, f.assetId],
      );
      await client.query("SAVEPOINT rejected_reference");
      await expect(
        client.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
          f.targetId,
          path,
          f.alias,
        ]),
      ).rejects.toMatchObject({ code: "55000", message: "asset_reference_unavailable" });
      await client.query("ROLLBACK TO SAVEPOINT rejected_reference");
      expect(
        (
          await client.query("SELECT id FROM project_files WHERE project_id=$1 AND path=$2", [
            f.targetId,
            path,
          ])
        ).rows,
      ).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  });

  it("rejects an upload alias remapped while its writer waits for the physical key", async () => {
    const f = await fixture("remapped-upload");
    const remapper = await pool.connect();
    const writer = await pool.connect();
    const observer = await pool.connect();
    let write: Observed<unknown> | undefined;
    const path = "remapped-url-" + randomUUID() + ".html";
    try {
      const remapperPid = (await remapper.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      await remapper.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await remapper.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('nabuflow:durable-object:' || $1, 0))",
        [f.storageKey],
      );
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      write = observe(
        writer.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
          f.targetId,
          path,
          f.alias,
        ]),
      );
      await expectBlock(observer, writerPid, remapperPid, [write]);
      // Exercise a live alias mutation, not post-guard historical fixture seeding.
      await remapper.query(
        "UPDATE project_uploads SET object_path=$3 WHERE project_id=$1 AND id=$2",
        [f.sourceId, f.aliasId, f.storageKey + ".remapped"],
      );
      await remapper.query("COMMIT");
      await expect(write.result()).rejects.toMatchObject({
        code: "55000",
        message: "asset_reference_unavailable",
      });
      await writer.query("ROLLBACK");
      expect(
        (
          await observer.query("SELECT id FROM project_files WHERE project_id=$1 AND path=$2", [
            f.targetId,
            path,
          ])
        ).rows,
      ).toHaveLength(0);
    } finally {
      await remapper.query("ROLLBACK").catch(() => undefined);
      await write?.settled;
      await writer.query("ROLLBACK").catch(() => undefined);
      observer.release();
      writer.release();
      remapper.release();
    }
  }, 45_000);

  it("commits an unshared registered-asset claim before the provider boundary and rejects late references", async () => {
    const f = await fixture("claim-unshared-image");
    // Real registered production-shaped keys, not an artificial namespace.
    // These are SQL reference controls, not project lifecycle or provider proof.
    const control = await pool.connect();
    try {
      await control.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      for (const reference of quotedKeyReferences(f.storageKey)) {
        expect(
          (
            await control.query(
              "SELECT public.resolve_durable_storage_keys($1::jsonb) AS storage_key",
              [JSON.stringify({ content: reference.content })],
            )
          ).rows,
        ).toEqual([{ storage_key: f.storageKey }]);
        expect(
          (
            await control.query(
              "SELECT DISTINCT public.resolve_durable_asset_ids($1::jsonb) AS asset_id",
              [JSON.stringify({ content: reference.content })],
            )
          ).rows,
        ).toEqual([{ asset_id: f.assetId }]);
        await control.query(
          "INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)",
          [f.sourceId, "ready-control-" + reference.name + ".html", reference.content],
        );
      }
    } finally {
      await control.query("ROLLBACK").catch(() => undefined);
      control.release();
    }
    const controller = new AbortController();
    const boundary = new Error("isolation_pg_claim_proven_provider_not_executed");
    let claimInserted = false;
    let claimCommitted = false;
    bridge.afterQuery = async (_client, sql) => {
      if (sql.includes("INSERT INTO durable_asset_deletion_claims")) claimInserted = true;
      if (sql === "COMMIT" && claimInserted) {
        claimCommitted = true;
        controller.abort(boundary);
      }
    };
    try {
      await expect(
        purge.releaseProjectAssetStorage(
          physicalInventory(f),
          undefined,
          undefined,
          controller.signal,
        ),
      ).rejects.toBe(boundary);
      expect(claimCommitted).toBe(true);
      expect((await pool.query("SELECT state FROM assets WHERE id=$1", [f.assetId])).rows).toEqual([
        { state: "deleting" },
      ]);
      expect(
        (
          await pool.query(
            "SELECT state,storage_key FROM asset_storage_objects WHERE asset_id=$1",
            [f.assetId],
          )
        ).rows,
      ).toEqual([{ state: "deleting", storage_key: f.storageKey }]);
      expect(
        (
          await pool.query(
            "SELECT claim_kind,retired_project_id,retired_asset_id FROM durable_asset_deletion_claims WHERE storage_key=$1",
            [f.storageKey],
          )
        ).rows,
      ).toEqual([
        {
          claim_kind: "project-purge-asset",
          retired_project_id: f.sourceId,
          retired_asset_id: f.assetId,
        },
      ]);
      await expect(
        pool.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
          f.targetId,
          "after-claim-" + randomUUID() + ".html",
          "/api/assets/" + f.assetId + "/content",
        ]),
      ).rejects.toMatchObject({ code: "55000" });
      for (const reference of quotedKeyReferences(f.storageKey)) {
        await expect(
          pool.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
            f.sourceId,
            "after-claim-" + reference.name + ".html",
            reference.content,
          ]),
        ).rejects.toMatchObject({ code: "55000" });
      }
      expect(provider.forbidden).not.toHaveBeenCalled();
      // This proves SQL claim durability, not physical object/provider absence.
      expect(
        (
          await pool.query(
            "SELECT state,terminal_evidence FROM project_purge_operations WHERE id=$1",
            [f.operationId],
          )
        ).rows,
      ).toEqual([{ state: "running", terminal_evidence: null }]);
    } finally {
      bridge.afterQuery = undefined;
    }
  });

  it("serializes a single-quoted raw-key writer before ordinary image deletion", async () => {
    const f = await fixture("quoted-writer-image");
    const writer = await pool.connect();
    const observer = await pool.connect();
    const entering = signal();
    let deletionPid = 0;
    let deletion: Observed<unknown> | undefined;
    try {
      const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const content = quotedKeyReferences(f.storageKey)[0]!.content;
      await writer.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
        f.sourceId,
        "quoted-writer.html",
        content,
      ]);
      bridge.beforeQuery = async (client, sql) => {
        if (!sql.includes("SELECT storage_key, storage_backend, size_bytes, state")) return;
        deletionPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
          .rows[0]!.pid;
        entering.resolve();
      };
      deletion = observe(
        registry.deleteReadyAsset({
          assetId: f.assetId,
          userId: f.owner,
          productScope: "nabuflow",
          generatedImageIdBeingDeleted: f.aliasId,
        }),
      );
      await boundedSignal(
        Promise.race([entering.promise, deletion.premature("quoted_writer_lock")]),
      );
      await expectBlock(observer, deletionPid, writerPid, [deletion]);
      await writer.query("COMMIT");
      await expect(deletion.result()).rejects.toMatchObject({
        code: "asset_referenced",
        status: 409,
      });
      expect(
        (await observer.query("SELECT state FROM assets WHERE id=$1", [f.assetId])).rows,
      ).toEqual([{ state: "ready" }]);
      expect(
        (
          await observer.query(
            "SELECT storage_key FROM durable_asset_deletion_claims WHERE storage_key=$1",
            [f.storageKey],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await deletion?.settled;
      bridge.beforeQuery = undefined;
      observer.release();
      writer.release();
    }
  }, 45_000);

  it("retains transcript-only Ora aliases before deletion and across the final-check race", async () => {
    const owner = "purge-pg:" + manifest!.epoch + ":ora-transcript-delete";
    const storageKey = "ora/account/" + manifest!.epoch + "/transcript-delete.webp";
    let assetId: number | null = null;
    let oraAssetId: number | null = null;
    let initialTicketId: number | null = null;
    let raceTicketId: number | null = null;
    try {
      assetId = (
        await pool.query<{ id: number }>(
          "INSERT INTO assets (owner_user_id,actor_user_id,project_id,scope,product_scope,kind,source," +
            "filename,mime_type,size_bytes,storage_key,state,scan_state,storage_backend,ready_at) " +
            "VALUES ($1,$1,NULL,'account','ora','image','isolation-proof',$2,'image/webp',1,$3," +
            "'ready','not-required','r2',NOW()) RETURNING id",
          [owner, owner + ".webp", storageKey],
        )
      ).rows[0]!.id;
      await pool.query(
        "INSERT INTO asset_storage_objects (asset_id,storage_backend,storage_key,role,state,size_bytes) " +
          "VALUES ($1,'r2',$2,'primary','ready',1)",
        [assetId, storageKey],
      );
      oraAssetId = (
        await pool.query<{ id: number }>(
          "INSERT INTO ora_assets (user_id,kind,file_name,mime_type,storage_key,asset_id) " +
            "VALUES ($1,'image',$2,'image/webp',$3,$4) RETURNING id",
          [owner, owner + ".webp", storageKey, assetId],
        )
      ).rows[0]!.id;
      await pool.query(
        "INSERT INTO asset_usage (asset_id,project_id,consumer) VALUES ($1,NULL,$2)",
        [assetId, "ora-library:" + oraAssetId],
      );

      const alias = "/api/ora/assets/" + oraAssetId + "/download";
      const transcript = JSON.stringify([{ role: "user", content: alias }]);
      initialTicketId = (
        await pool.query<{ id: number }>(
          "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
            "VALUES ($1,$2,$3::jsonb,'[]'::jsonb) RETURNING id",
          [owner, owner + ":preflight", transcript],
        )
      ).rows[0]!.id;

      await expect(oraLibrary.deleteOraAsset({ oraAssetId, userId: owner })).resolves.toBe(
        "referenced",
      );
      expect(
        (await pool.query("SELECT deleted_at FROM ora_assets WHERE id=$1", [oraAssetId])).rows,
      ).toEqual([{ deleted_at: null }]);
      await pool.query("DELETE FROM support_tickets WHERE id=$1", [initialTicketId]);
      initialTicketId = null;

      let injected = false;
      bridge.afterQuery = async (client, sql) => {
        if (injected || !sql.includes("FROM ora_assets ora") || !sql.includes("FOR UPDATE")) return;
        injected = true;
        raceTicketId = (
          await client.query<{ id: number }>(
            "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
              "VALUES ($1,$2,$3::jsonb,'[]'::jsonb) RETURNING id",
            [owner, owner + ":race", transcript],
          )
        ).rows[0]!.id;
      };

      await expect(oraLibrary.deleteOraAsset({ oraAssetId, userId: owner })).resolves.toBe(
        "retained",
      );
      bridge.afterQuery = undefined;
      expect(injected).toBe(true);
      expect(
        (
          await pool.query(
            "SELECT state FROM assets WHERE id=$1 AND owner_user_id=$2 AND product_scope='ora'",
            [assetId, owner],
          )
        ).rows,
      ).toEqual([{ state: "ready" }]);
      expect(
        (
          await pool.query("SELECT deleted_at IS NOT NULL AS deleted FROM ora_assets WHERE id=$1", [
            oraAssetId,
          ])
        ).rows,
      ).toEqual([{ deleted: true }]);
      expect(
        (
          await pool.query(
            "SELECT public.durable_asset_reference_exists($1,NULL,NULL) AS referenced",
            [assetId],
          )
        ).rows,
      ).toEqual([{ referenced: true }]);
      expect(
        (await pool.query("SELECT state FROM asset_storage_objects WHERE asset_id=$1", [assetId]))
          .rows,
      ).toEqual([{ state: "ready" }]);
    } finally {
      bridge.afterQuery = undefined;
      for (const ticketId of [initialTicketId, raceTicketId]) {
        if (ticketId !== null) {
          await pool
            .query("DELETE FROM support_tickets WHERE id=$1", [ticketId])
            .catch(() => undefined);
        }
      }
      if (assetId !== null) {
        await pool
          .query("DELETE FROM asset_usage WHERE asset_id=$1", [assetId])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM ora_assets WHERE asset_id=$1", [assetId])
          .catch(() => undefined);
        await pool
          .query("DELETE FROM asset_storage_objects WHERE asset_id=$1", [assetId])
          .catch(() => undefined);
        await pool.query("DELETE FROM assets WHERE id=$1", [assetId]).catch(() => undefined);
      }
    }
  }, 45_000);

  it("serializes Ora support-ticket attachment writers and rejects cross-user attachment", async () => {
    const f = manifest!.fixtures["retention-ora"];
    const oraAssetId = (
      await pool.query<{ id: number }>(
        "INSERT INTO ora_assets (user_id,kind,file_name,mime_type,storage_key,asset_id) " +
          "VALUES ($1,'image',$2,'image/webp',$3,$4) RETURNING id",
        [f.owner, f.tag + "-support.webp", f.storageKey, f.assetId],
      )
    ).rows[0]!.id;
    const alias = "/api/ora/assets/" + oraAssetId + "/download";
    const attachments = JSON.stringify([{ name: f.tag + ".webp", url: alias }]);
    const transcript = JSON.stringify([{ role: "user", content: alias }]);
    expect(
      (
        await pool.query(
          "SELECT DISTINCT public.resolve_durable_asset_ids($1::jsonb) AS asset_id",
          [JSON.stringify({ attachments: JSON.parse(attachments) })],
        )
      ).rows,
    ).toEqual([{ asset_id: f.assetId }]);

    const writer = await pool.connect();
    const deleter = await pool.connect();
    const observer = await pool.connect();
    const transcriptTicketId = (
      await pool.query<{ id: number }>(
        "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
          "VALUES ($1,$2,'[]'::jsonb,'[]'::jsonb) RETURNING id",
        [f.owner, f.tag + ":transcript-update"],
      )
    ).rows[0]!.id;
    let writerFirstDelete: Observed<unknown> | undefined;
    let deleterFirstWrite: Observed<unknown> | undefined;
    let deleterFirstTranscriptWrite: Observed<unknown> | undefined;
    try {
      const writerPid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;
      const deleterPid = (await deleter.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]!.pid;

      await writer.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      const writerFirstTicketId = (
        await writer.query<{ id: number }>(
          "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
            "VALUES ($1,$2,'[]'::jsonb,$3::jsonb) RETURNING id",
          [f.owner, f.tag + ":writer-first", attachments],
        )
      ).rows[0]!.id;
      await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      writerFirstDelete = observe(
        deleter.query("SELECT id FROM assets WHERE id=$1 FOR UPDATE", [f.assetId]),
      );
      await expectBlock(observer, deleterPid, writerPid, [writerFirstDelete]);
      await writer.query("COMMIT");
      await writerFirstDelete.result();
      expect(
        (
          await deleter.query(
            "SELECT public.durable_asset_reference_exists($1,NULL,NULL) AS referenced",
            [f.assetId],
          )
        ).rows,
      ).toEqual([{ referenced: true }]);
      await deleter.query("ROLLBACK");
      await pool.query("DELETE FROM support_tickets WHERE id=$1", [writerFirstTicketId]);

      await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await deleter.query("SELECT id FROM assets WHERE id=$1 FOR UPDATE", [f.assetId]);
      await deleter.query("UPDATE assets SET state='deleting' WHERE id=$1", [f.assetId]);
      deleterFirstWrite = observe(
        writer.query(
          "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
            "VALUES ($1,$2,'[]'::jsonb,$3::jsonb)",
          [f.owner, f.tag + ":deleter-first", attachments],
        ),
      );
      await expectBlock(observer, writerPid, deleterPid, [deleterFirstWrite]);
      await deleter.query("COMMIT");
      await expect(deleterFirstWrite.result()).rejects.toMatchObject({
        code: "55000",
        message: "asset_not_ready",
      });
      await pool.query("UPDATE assets SET state='ready' WHERE id=$1", [f.assetId]);

      await deleter.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      await deleter.query("SELECT id FROM assets WHERE id=$1 FOR UPDATE", [f.assetId]);
      await deleter.query("UPDATE assets SET state='deleting' WHERE id=$1", [f.assetId]);
      deleterFirstTranscriptWrite = observe(
        writer.query("UPDATE support_tickets SET transcript=$2::jsonb WHERE id=$1", [
          transcriptTicketId,
          transcript,
        ]),
      );
      await expectBlock(observer, writerPid, deleterPid, [deleterFirstTranscriptWrite]);
      await deleter.query("COMMIT");
      await expect(deleterFirstTranscriptWrite.result()).rejects.toMatchObject({
        code: "55000",
        message: "asset_not_ready",
      });
      await pool.query("UPDATE assets SET state='ready' WHERE id=$1", [f.assetId]);
      expect(
        (
          await pool.query("SELECT transcript FROM support_tickets WHERE id=$1", [
            transcriptTicketId,
          ])
        ).rows,
      ).toEqual([{ transcript: [] }]);

      await expect(
        pool.query(
          "INSERT INTO support_tickets (user_id,subject,transcript,attachments) " +
            "VALUES ($1,$2,'[]'::jsonb,$3::jsonb)",
          [f.owner + ":foreign", f.tag + ":cross-user", attachments],
        ),
      ).rejects.toMatchObject({ code: "42501", message: "asset_reference_forbidden" });
    } finally {
      await writer.query("ROLLBACK").catch(() => undefined);
      await deleter.query("ROLLBACK").catch(() => undefined);
      await writerFirstDelete?.settled;
      await deleterFirstWrite?.settled;
      await deleterFirstTranscriptWrite?.settled;
      await pool
        .query("DELETE FROM support_tickets WHERE id=$1", [transcriptTicketId])
        .catch(() => undefined);
      observer.release();
      deleter.release();
      writer.release();
    }
  }, 45_000);

  it("excludes only an unused upload's exact self-alias while preserving real references", async () => {
    const f = await fixture("delete-unshared-upload");
    const client = await pool.connect();
    const referenceSql =
      "SELECT public.durable_asset_reference_exists_excluding_upload($1,NULL,NULL,$2) AS referenced";
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(
        (
          await client.query(
            "SELECT public.durable_asset_reference_exists($1,NULL,NULL) AS referenced",
            [f.assetId],
          )
        ).rows,
      ).toEqual([{ referenced: true }]);
      expect((await client.query(referenceSql, [f.assetId, f.aliasId])).rows).toEqual([
        { referenced: false },
      ]);
      expect((await client.query(referenceSql, [f.assetId, -1])).rows).toEqual([
        { referenced: true },
      ]);
      await client.query("SAVEPOINT competing_metadata");
      await client.query(
        "INSERT INTO project_uploads (project_id,filename,object_path) VALUES ($1,$2,$3)",
        [f.sourceId, "another-upload.webp", f.storageKey],
      );
      expect((await client.query(referenceSql, [f.assetId, f.aliasId])).rows).toEqual([
        { referenced: true },
      ]);
      await client.query("ROLLBACK TO SAVEPOINT competing_metadata");
      await client.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
        f.sourceId,
        "real-upload-use.html",
        f.alias,
      ]);
      expect((await client.query(referenceSql, [f.assetId, f.aliasId])).rows).toEqual([
        { referenced: true },
      ]);
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
    const pending = await registry.deleteReadyAsset({
      assetId: f.assetId,
      userId: f.owner,
      productScope: "nabuflow",
      projectUploadIdBeingDeleted: f.aliasId,
    });
    expect(pending.storageObjects).toEqual([
      { storageKey: f.storageKey, storageBackend: "r2", sizeBytes: 1 },
    ]);
    expect((await pool.query("SELECT state FROM assets WHERE id=$1", [f.assetId])).rows).toEqual([
      { state: "deleting" },
    ]);
    expect(
      (
        await pool.query(
          "SELECT claim_kind,retired_asset_id FROM durable_asset_deletion_claims WHERE storage_key=$1",
          [f.storageKey],
        )
      ).rows,
    ).toEqual([{ claim_kind: "asset-delete", retired_asset_id: f.assetId }]);
    // The route removes this metadata only after real provider absence. This
    // SQL-only case must leave it intact and must not call any provider.
    expect(await metadataPresent(f)).toBe(true);
    await expect(
      pool.query("INSERT INTO project_files (project_id,path,content) VALUES ($1,$2,$3)", [
        f.sourceId,
        "too-late-upload.html",
        f.alias,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    expect(provider.forbidden).not.toHaveBeenCalled();
  });

  it("propagates the original purge rejection before the metadata barrier", async () => {
    const cause = Object.assign(new Error("original purge SQL error"), { code: "42P18" });
    const operation = observe(Promise.reject(cause));
    await expect(
      boundedSignal(Promise.race([signal().promise, operation.premature("metadata_barrier")])),
    ).rejects.toBe(cause);
  });

  it("propagates the original writer rejection while awaiting lock evidence", async () => {
    const cause = Object.assign(new Error("original writer SQL error"), { code: "42702" });
    const operation = observe(Promise.reject(cause));
    await expect(
      boundedSignal(Promise.race([signal().promise, operation.premature("lock_evidence")])),
    ).rejects.toBe(cause);
  });
});
