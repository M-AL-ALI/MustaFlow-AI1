import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANTRY_CATALOG_STAMP_FORMAT,
  pantryShelfContentHashesHash,
  pantryShelfContentHashesResponseSchema,
  sha256Hex,
  verifyPantryDigestSignature,
  type PantryCatalogShelfRecord,
} from "@workspace/tenant-runtime-contracts";
import { PantryCatalogDurableObject } from "../src/pantry-catalog-durable-object";
import type { PantryStockQueueMessage, PantryWorkerBindings } from "../src/pantry-catalog-model";
import { handlePantryQueue, handlePantryWorkerRequest } from "../src/pantry-worker";
import { PantryIngestError } from "../src/pantry-registry-client";
import { MemoryR2Bucket } from "./helpers";
import {
  makePantryFixture,
  PANTRY_TEST_KEY,
  type PantryFixture,
} from "../scripts/pantry-catalog-fixture";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, structuredClone(entry));
    }
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    let deleted = false;
    for (const key of typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys) {
      deleted = this.values.delete(key) || deleted;
    }
    return deleted;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }
}

interface TestContext {
  bucket: MemoryR2Bucket;
  coordinator: PantryCatalogDurableObject;
  env: PantryWorkerBindings;
  queueMessages: PantryStockQueueMessage[];
  storage: MemoryDurableStorage;
}

function context(): TestContext {
  const bucket = new MemoryR2Bucket();
  const queueMessages: PantryStockQueueMessage[] = [];
  const storage = new MemoryDurableStorage();
  const env = {
    PANTRY_CATALOG_OBJECTS: bucket as unknown as R2Bucket,
    PANTRY_INGEST_QUEUE: {
      async send(message: PantryStockQueueMessage) {
        queueMessages.push(structuredClone(message));
      },
    } as unknown as Queue<PantryStockQueueMessage>,
    PANTRY_REVISION_PUBLIC_KEYS: JSON.stringify({
      [PANTRY_TEST_KEY.kid]: PANTRY_TEST_KEY.publicKeyPem,
    }),
    PANTRY_INGEST_SIGNING_KEY_ID: PANTRY_TEST_KEY.kid,
    PANTRY_INGEST_SIGNING_PRIVATE_KEY: PANTRY_TEST_KEY.privateKeyPem,
  } as unknown as PantryWorkerBindings;
  const coordinator = new PantryCatalogDurableObject(
    { storage } as unknown as DurableObjectState,
    env,
  );
  return { bucket, coordinator, env, queueMessages, storage };
}

function request(
  path: string,
  input?: {
    method?: string;
    principal?: string;
    body?: unknown | Uint8Array;
  },
): Request {
  const rawBody =
    input?.body === undefined
      ? undefined
      : input.body instanceof Uint8Array
        ? input.body.slice().buffer
        : JSON.stringify(input.body);
  return new Request(`https://pantry.internal${path}`, {
    method: input?.method ?? "GET",
    headers: {
      ...(input?.principal === undefined ? {} : { "x-nabuflow-pantry-principal": input.principal }),
      ...(rawBody === undefined
        ? {}
        : {
            "content-type":
              input?.body instanceof Uint8Array ? "application/octet-stream" : "application/json",
          }),
    },
    body: rawBody,
  });
}

async function call(
  test: TestContext,
  path: string,
  input?: Parameters<typeof request>[1],
): Promise<Response> {
  return handlePantryWorkerRequest(request(path, input), test.env, test.coordinator);
}

async function beginAndStage(test: TestContext, fixture: PantryFixture): Promise<void> {
  const begin = await call(test, "/internal/v1/stock-requests", {
    method: "POST",
    principal: "catalog-admin",
    body: fixture.request,
  });
  expect([200, 201]).toContain(begin.status);
  for (const [sha256, object] of fixture.objects) {
    const staged = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`,
      {
        method: "PUT",
        principal: "catalog-admin",
        body: object.bytes,
      },
    );
    expect([200, 201]).toContain(staged.status);
  }
}

async function commit(test: TestContext, fixture: PantryFixture): Promise<Response> {
  return call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}/commit`, {
    method: "POST",
    principal: "catalog-admin",
    body: fixture.commit,
  });
}

describe("private Pantry catalog Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("commits a multi-package shelf and verifies its exact stamp and object bytes", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    const committed = await commit(test, fixture);
    expect(committed.status).toBe(201);
    const body = (await committed.json()) as { shelf: PantryCatalogShelfRecord };
    expect(body.shelf.revision.content.closure.ingredients).toHaveLength(2);

    const read = await call(
      test,
      `/internal/v1/revisions/${fixture.commit.revision.content.revisionId}`,
      { principal: "builder-readonly" },
    );
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ shelf: body.shelf });

    const stamp = {
      format: PANTRY_CATALOG_STAMP_FORMAT,
      schemaVersion: 1,
      pantryRevisionId: body.shelf.revision.content.revisionId,
      pantryRevisionRootSha256: body.shelf.revision.rootSha256,
      dependencyClosureSha256: body.shelf.revision.content.dependencyClosureSha256,
      lockfileSha256: body.shelf.lockfileSha256,
      sbomSha256: body.shelf.sbomSha256,
      toolchainImageDigest: body.shelf.revision.content.closure.platform.toolchainImageDigest,
      toolchainAttestationSha256: body.shelf.toolchainAttestationSha256,
    };
    const verified = await call(test, "/internal/v1/stamps/verify", {
      method: "POST",
      principal: "builder-readonly",
      body: stamp,
    });
    expect(verified.status).toBe(200);
    const firstObject = fixture.objects.entries().next().value as [string, { bytes: Uint8Array }];
    const objectRead = await call(test, `/internal/v1/objects/${firstObject[0]}`, {
      principal: "builder-readonly",
    });
    expect(new Uint8Array(await objectRead.arrayBuffer())).toEqual(firstObject[1].bytes);
    const rangeEnd = Math.min(7, firstObject[1].bytes.byteLength - 1);
    const rangeRead = await handlePantryWorkerRequest(
      new Request(`https://pantry.internal/internal/v1/objects/${firstObject[0]}`, {
        headers: {
          "x-nabuflow-pantry-principal": "builder-readonly",
          range: `bytes=0-${rangeEnd}`,
        },
      }),
      test.env,
      test.coordinator,
    );
    expect(rangeRead.status).toBe(206);
    expect(rangeRead.headers.get("content-range")).toBe(
      `bytes 0-${rangeEnd}/${firstObject[1].bytes.byteLength}`,
    );
    expect(rangeRead.headers.get("x-nabuflow-content-sha256")).toBe(firstObject[0]);
    expect(new Uint8Array(await rangeRead.arrayBuffer())).toEqual(
      firstObject[1].bytes.slice(0, rangeEnd + 1),
    );
    const invalidRange = await handlePantryWorkerRequest(
      new Request(`https://pantry.internal/internal/v1/objects/${firstObject[0]}`, {
        headers: {
          "x-nabuflow-pantry-principal": "builder-readonly",
          range: "bytes=0-1048576",
        },
      }),
      test.env,
      test.coordinator,
    );
    expect(invalidRange.status).toBe(400);
  });

  it("serves only an attested shelf-content hash set to the builder identity", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const root = fixture.commit.revision.rootSha256;
    const path = `/internal/v1/revisions/by-root/${root}/content-hashes`;
    const response = await call(test, path, { principal: "builder-readonly" });
    expect(response.status).toBe(200);
    const body = pantryShelfContentHashesResponseSchema.parse(await response.json());
    expect(body.statement).toMatchObject({
      pantryRevisionRootSha256: root,
      pantryRevisionId: fixture.commit.revision.content.revisionId,
    });
    expect(body.statement.contentHashes).toEqual(
      [
        await sha256Hex(new TextEncoder().encode("module.exports=1")),
        await sha256Hex(new TextEncoder().encode("module.exports='leaf'")),
      ].sort(),
    );
    expect(JSON.stringify(body)).not.toContain("module.exports");
    expect(await pantryShelfContentHashesHash(body.statement)).toBe(body.statementSha256);
    await expect(
      verifyPantryDigestSignature(
        new Map([[PANTRY_TEST_KEY.kid, PANTRY_TEST_KEY.publicKeyPem]]),
        body.signature,
      ),
    ).resolves.toEqual({ ok: true });

    const denied = await Promise.all([
      call(test, path, { principal: "catalog-admin" }),
      call(test, path, { principal: "tenant" }),
    ]);
    expect(denied.map((attempt) => attempt.status)).toEqual([403, 403]);
    expect(await denied[0].text()).toBe(await denied[1].text());

    const unknown = await call(
      test,
      `/internal/v1/revisions/by-root/${"f".repeat(64)}/content-hashes`,
      { principal: "builder-readonly" },
    );
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ code: "catalog_not_found" });
  });

  it("rejects a provenance read when trusted shelf bytes are tampered", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const normalized = [...fixture.objects].find(
      ([, object]) => object.kind === "normalized-package",
    );
    expect(normalized).toBeDefined();
    const [sha256, object] = normalized!;
    const tampered = object.bytes.slice();
    tampered[tampered.byteLength - 1] ^= 1;
    test.bucket.objects.set(`cas/sha256/${sha256}`, tampered);
    const response = await call(
      test,
      `/internal/v1/revisions/by-root/${fixture.commit.revision.rootSha256}/content-hashes`,
      { principal: "builder-readonly" },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ code: "catalog_integrity_mismatch" });
  });

  it("coalesces 100 identical misses and makes staging and commit retries idempotent", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        }),
      ),
    );
    expect(results.filter((response) => response.status === 201)).toHaveLength(1);
    expect(results.every((response) => response.status === 200 || response.status === 201)).toBe(
      true,
    );
    expect(test.queueMessages).toHaveLength(1);
    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: test.queueMessages.map((body) => ({
          body,
          ack: () => undefined,
        })),
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      async () => {
        throw new PantryIngestError("package_not_found", "fixture intentionally not ingested");
      },
    );
    const failedStatus = await call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}`, {
      principal: "builder-readonly",
    });
    expect(failedStatus.status).toBe(200);
    await expect(failedStatus.json()).resolves.toMatchObject({
      ingest: {
        state: "failed",
        failure: { code: "package_not_found", retryable: false },
      },
    });
    await beginAndStage(test, fixture);
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const replay = await commit(test, fixture);
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({ state: "replay" });
    const diagnostics = await call(test, "/internal/v1/diagnostics", {
      principal: "catalog-admin",
    });
    await expect(diagnostics.json()).resolves.toMatchObject({
      ledger: {
        assemblies: 0,
        shelves: 1,
        committedObjects: fixture.objects.size,
        queueDeliveries: 1,
      },
      r2: { quarantineObjects: 0 },
    });
  });

  it("runs one successful ingest and immutable commit for 100 concurrent cold misses", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await Promise.all(
      Array.from({ length: 100 }, () =>
        call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        }),
      ),
    );
    expect(test.queueMessages).toHaveLength(1);
    let ingestCalls = 0;
    let acknowledgements = 0;
    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: test.queueMessages.map((body) => ({
          body,
          ack: () => {
            acknowledgements += 1;
          },
          retry: () => {
            throw new Error("successful ingest must not retry");
          },
        })),
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      async () => {
        ingestCalls += 1;
        return {
          closure: fixture.commit.revision.content.closure,
          objects: [...fixture.objects.entries()].map(([sha256, object]) => ({
            ...object,
            sha256,
          })),
          lockfileSha256: fixture.commit.lockfileSha256,
          sbomSha256: fixture.commit.sbomSha256,
          toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
          provenanceStatus: "unavailable",
        };
      },
    );
    expect(ingestCalls).toBe(1);
    expect(acknowledgements).toBe(1);
    const warm = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: fixture.request,
    });
    expect(warm.status).toBe(200);
    await expect(warm.json()).resolves.toMatchObject({ state: "committed" });
    expect(test.queueMessages).toHaveLength(1);
    const diagnostics = await call(test, "/internal/v1/diagnostics", {
      principal: "catalog-admin",
    });
    await expect(diagnostics.json()).resolves.toMatchObject({
      ledger: { assemblies: 0, shelves: 1, queueDeliveries: 1, failedIngests: 0 },
      r2: { quarantineObjects: 0 },
    });
  });

  it("keeps an old shelf byte-identical when a child revision is added", async () => {
    const test = context();
    const first = await makePantryFixture({ nowMs: Date.now(), sequence: 1 });
    await beginAndStage(test, first);
    expect((await commit(test, first)).status).toBe(201);
    const before = await call(
      test,
      `/internal/v1/revisions/by-root/${first.commit.revision.rootSha256}`,
      { principal: "builder-readonly" },
    );
    const beforeBody = await before.text();

    const second = await makePantryFixture({
      nowMs: Date.now() + 1_000,
      sequence: 2,
      parentRootSha256: first.commit.revision.rootSha256,
      selector: "^2.0.0",
    });
    await beginAndStage(test, second);
    expect((await commit(test, second)).status).toBe(201);
    const after = await call(
      test,
      `/internal/v1/revisions/by-root/${first.commit.revision.rootSha256}`,
      { principal: "builder-readonly" },
    );
    expect(await after.text()).toBe(beforeBody);

    expect(
      await test.coordinator.transitionShelf(
        second.commit.revision.rootSha256,
        1,
        "quarantined",
        new Date(Date.now() + 2_000).toISOString(),
      ),
    ).toBe("updated");
    expect(
      await test.coordinator.transitionShelf(
        second.commit.revision.rootSha256,
        2,
        "retired",
        new Date(Date.now() + 3_000).toISOString(),
      ),
    ).toBe("updated");
    expect(
      await test.coordinator.collectRetiredShelf(
        second.commit.revision.rootSha256,
        "staging-acceptance",
        Date.now() + 3 * 60 * 60 * 1_000,
      ),
    ).toMatchObject({ shelf: { revision: { rootSha256: second.commit.revision.rootSha256 } } });

    const replacementChild = await makePantryFixture({
      nowMs: Date.now() + 4_000,
      sequence: 3,
      parentRootSha256: first.commit.revision.rootSha256,
      selector: "replacement-child",
    });
    await beginAndStage(test, replacementChild);
    expect((await commit(test, replacementChild)).status).toBe(201);
  });

  it("rejects conflicting CAS bytes and incomplete commits without publishing a shelf", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    const begin = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: fixture.request,
    });
    expect(begin.status).toBe(201);
    const incomplete = await commit(test, fixture);
    expect(incomplete.status).toBe(409);
    await expect(incomplete.json()).resolves.toMatchObject({ code: "catalog_incomplete" });

    const [sha256, object] = fixture.objects.entries().next().value as [
      string,
      { kind: string; bytes: Uint8Array },
    ];
    const altered = object.bytes.slice();
    altered[0] ^= 0xff;
    const conflict = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`,
      { method: "PUT", principal: "catalog-admin", body: altered },
    );
    expect(conflict.status).toBe(422);
    expect([...test.bucket.objects.keys()].every((key) => key.startsWith("quarantine/"))).toBe(
      true,
    );
    const lookup = await call(
      test,
      `/internal/v1/revisions/by-root/${fixture.commit.revision.rootSha256}`,
      { principal: "builder-readonly" },
    );
    expect(lookup.status).toBe(404);
    await test.coordinator.cleanupExpiredAssemblies(Date.parse(fixture.request.expiresAt) + 1, 10);
    expect(test.bucket.objects.size).toBe(0);
  });

  it("expires only incomplete quarantine state and persists committed shelves across a DO restart", async () => {
    const test = context();
    const committedFixture = await makePantryFixture({ nowMs: Date.now(), sequence: 1 });
    await beginAndStage(test, committedFixture);
    expect((await commit(test, committedFixture)).status).toBe(201);

    const pending = await makePantryFixture({
      nowMs: Date.now() + 1_000,
      sequence: 2,
      parentRootSha256: committedFixture.commit.revision.rootSha256,
      selector: "pending",
    });
    const begin = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: pending.request,
    });
    expect(begin.status).toBe(201);
    const [sha256, object] = pending.objects.entries().next().value as [
      string,
      { kind: string; bytes: Uint8Array },
    ];
    expect(
      (
        await call(
          test,
          `/internal/v1/assemblies/${pending.commit.assemblyId}/objects/${sha256}/${object.kind}`,
          { method: "PUT", principal: "catalog-admin", body: object.bytes },
        )
      ).status,
    ).toBe(201);
    const deleted = await test.coordinator.cleanupExpiredAssemblies(
      Date.parse(pending.request.expiresAt) + 1,
      10,
    );
    expect(deleted).toEqual([pending.commit.assemblyId]);
    expect(
      [...test.bucket.objects.keys()].some((key) => key.includes(pending.commit.assemblyId)),
    ).toBe(false);

    const restarted = new PantryCatalogDurableObject(
      { storage: test.storage } as unknown as DurableObjectState,
      test.env,
    );
    const lookup = await restarted.getShelfByRoot(committedFixture.commit.revision.rootSha256);
    expect(lookup?.shelf.revision.rootSha256).toBe(committedFixture.commit.revision.rootSha256);
  });

  it("denies tenant principals identically across read, list, and write surfaces", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    const attempts = [
      request("/internal/v1/diagnostics", { principal: "tenant" }),
      request(`/internal/v1/revisions/by-root/${fixture.commit.revision.rootSha256}`, {
        principal: "tenant",
      }),
      request("/internal/v1/stock-requests", {
        method: "POST",
        principal: "tenant",
        body: fixture.request,
      }),
    ];
    const responses = await Promise.all(
      attempts.map((attempt) => handlePantryWorkerRequest(attempt, test.env, test.coordinator)),
    );
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    const bodies = await Promise.all(responses.map((response) => response.text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it("retains referenced shelves and permits only scoped GC after retirement", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const root = fixture.commit.revision.rootSha256;
    expect(
      (
        await call(test, `/internal/v1/revisions/${root}/references`, {
          method: "POST",
          principal: "catalog-admin",
          body: { referenceId: "artifact:test-release" },
        })
      ).status,
    ).toBe(201);
    const quarantined = await call(test, `/internal/v1/revisions/${root}/state`, {
      method: "POST",
      principal: "catalog-admin",
      body: {
        expectedStateRevision: 1,
        nextState: "quarantined",
        updatedAt: new Date(Date.now() + 2_000).toISOString(),
      },
    });
    expect(quarantined.status).toBe(200);
    const retired = await call(test, `/internal/v1/revisions/${root}/state`, {
      method: "POST",
      principal: "catalog-admin",
      body: {
        expectedStateRevision: 2,
        nextState: "retired",
        updatedAt: new Date(Date.now() + 3_000).toISOString(),
      },
    });
    expect(retired.status).toBe(200);
    const blockedGc = await call(test, "/internal/v1/gc", {
      method: "POST",
      principal: "catalog-gc",
      body: {
        scope: "retired-unreferenced",
        now: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
        maxDeletes: 10,
        retentionNamespace: "staging-acceptance",
      },
    });
    await expect(blockedGc.json()).resolves.toMatchObject({ deletedRevisionRoots: [] });
    expect(
      (
        await call(test, `/internal/v1/revisions/${root}/references`, {
          method: "DELETE",
          principal: "catalog-admin",
          body: { referenceId: "artifact:test-release" },
        })
      ).status,
    ).toBe(200);
    const collected = await call(test, "/internal/v1/gc", {
      method: "POST",
      principal: "catalog-gc",
      body: {
        scope: "retired-unreferenced",
        now: new Date(Date.now() + 3 * 60 * 60 * 1_000).toISOString(),
        maxDeletes: 10,
        retentionNamespace: "staging-acceptance",
      },
    });
    await expect(collected.json()).resolves.toMatchObject({ deletedRevisionRoots: [root] });
    expect(
      (
        await call(test, `/internal/v1/revisions/by-root/${root}`, {
          principal: "builder-readonly",
        })
      ).status,
    ).toBe(404);
    expect(test.bucket.objects.size).toBe(0);
    const diagnostics = await call(test, "/internal/v1/diagnostics", {
      principal: "catalog-admin",
    });
    await expect(diagnostics.json()).resolves.toMatchObject({
      ledger: { assemblies: 0, shelves: 0, committedObjects: 0, externalReferences: 0 },
      r2: { objects: 0, bytes: 0 },
    });
  });

  it("captures a verified build resource into a new immutable derived shelf", async () => {
    const test = context();
    const now = new Date().toISOString();
    await test.storage.put(`revision-sequence:${now.slice(0, 10)}`, 1);
    const fixture = await makePantryFixture({ nowMs: Date.parse(now) });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const bytes = new TextEncoder().encode("trusted-captured-resource\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes, {
            headers: {
              "content-type": "application/octet-stream",
              "content-length": String(bytes.byteLength),
            },
          }),
      ),
    );
    const captured = await call(test, "/internal/v1/build-resources", {
      method: "POST",
      principal: "catalog-admin",
      body: {
        schemaVersion: 1,
        parentRevisionRootSha256: fixture.commit.revision.rootSha256,
        url: "https://assets.example.test/build-input.bin",
        expectedSha256: null,
        maxBytes: 1024,
        requestedAt: new Date(Date.parse(now) + 60_000).toISOString(),
      },
    });
    expect(captured.status).toBe(201);
    const body = (await captured.json()) as { shelf: PantryCatalogShelfRecord; resource: unknown };
    expect(body.shelf.revision.content.parentRootSha256).toBe(fixture.commit.revision.rootSha256);
    expect(body.shelf.revision.content.capturedBuildResources).toHaveLength(1);
    expect(body.shelf.objectReferences).toContainEqual(
      expect.objectContaining({ kind: "captured-build-resource" }),
    );
    expect(body.resource).toEqual(body.shelf.revision.content.capturedBuildResources?.[0]);
    const read = await call(
      test,
      `/internal/v1/revisions/by-root/${body.shelf.revision.rootSha256}`,
      { principal: "builder-readonly" },
    );
    expect(read.status).toBe(200);
  });
});
