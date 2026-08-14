import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANTRY_ASSEMBLY_LEASE_MS,
  PANTRY_CATALOG_STAMP_FORMAT,
  pantryShelfContentHashesHash,
  pantryShelfContentHashesResponseSchema,
  sha256Hex,
  verifyPantryDigestSignature,
  type PantryCatalogShelfRecord,
} from "@workspace/tenant-runtime-contracts";
import { PantryCatalogDurableObject } from "../src/pantry-catalog-durable-object";
import type {
  PantryIngestFailureRecord,
  PantryStockQueueMessage,
  PantryWorkerBindings,
} from "../src/pantry-catalog-model";
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

  it("serves shelf metadata with one manifest verification instead of an unbounded closure walk", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const get = vi.spyOn(test.bucket, "get");

    const read = await call(
      test,
      `/internal/v1/revisions/by-root/${fixture.commit.revision.rootSha256}`,
      { principal: "builder-readonly" },
    );

    expect(read.status).toBe(200);
    expect(get).toHaveBeenCalledTimes(1);
    expect(String(get.mock.calls[0]?.[0])).toMatch(/^revisions\//u);
  });

  it("returns a sanitized content-hash inventory only to the catalog operator", async () => {
    const test = context();
    const bytes = new TextEncoder().encode("public fixture bytes");
    const digest = await sha256Hex(bytes);
    await test.bucket.put(`quarantine/passembly_${"a".repeat(64)}/objects/${digest}`, bytes);
    expect((await call(test, "/internal/v1/diagnostics/objects")).status).toBe(403);
    expect(
      (
        await call(test, "/internal/v1/diagnostics/objects", {
          principal: "builder-readonly",
        })
      ).status,
    ).toBe(403);
    const response = await call(test, "/internal/v1/diagnostics/objects", {
      principal: "catalog-admin",
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      objects: [
        {
          key: `quarantine/passembly_${"a".repeat(64)}/objects/${digest}`,
          size: bytes.byteLength,
          uploadedAt: "2026-08-10T00:00:00.000Z",
          sha256: digest,
        },
      ],
      totalBytes: bytes.byteLength,
    });
  });

  it("replays the realistic heavy R2 operation shape and removes all diagnostic state", async () => {
    const test = context();
    const bodyBearingPut = vi.spyOn(test.bucket, "put");
    const probeId = "r2probe_unit_heavy_shape";
    const invoke = (window: number) =>
      call(test, "/internal/v1/diagnostics/r2-probe", {
        method: "POST",
        principal: "catalog-admin",
        body: {
          profile: "heavy-stage-object",
          mode: "run",
          probeId,
          window,
          concurrency: 1,
          idleBetweenBatchesMs: 0,
          cpuHashRounds: 1,
        },
      });
    const cold = await invoke(1);
    expect(cold.status).toBe(200);
    await expect(cold.json()).resolves.toMatchObject({
      ok: true,
      probeSucceeded: true,
      requested: 14,
      completed: 14,
      results: [
        { operation: 1, bytes: 460_701, state: "created" },
        ...Array.from({ length: 12 }, (_, index) => ({ operation: index + 2 })),
        { operation: 14, bytes: 4_377_468, state: "created" },
      ],
    });
    expect(bodyBearingPut).toHaveBeenCalledTimes(14);
    const warm = await invoke(2);
    expect(warm.status).toBe(200);
    const warmBody = (await warm.json()) as {
      ok: boolean;
      probeSucceeded: boolean;
      results: Array<{ operation: number; state: string }>;
    };
    expect(warmBody.ok).toBe(true);
    expect(warmBody.probeSucceeded).toBe(true);
    expect(warmBody.results).toHaveLength(14);
    expect(warmBody.results.every((entry) => entry.state === "exists")).toBe(true);
    expect(bodyBearingPut).toHaveBeenCalledTimes(14);

    const cleanup = await call(test, "/internal/v1/diagnostics/r2-probe", {
      method: "POST",
      principal: "catalog-admin",
      body: { profile: "heavy-stage-object", mode: "cleanup", probeId },
    });
    expect(cleanup.status).toBe(200);
    await expect(cleanup.json()).resolves.toMatchObject({
      ok: true,
      cleaned: { objects: 14, checkpoints: 28 },
    });
    expect(
      [...test.bucket.objects.keys()].filter((key) =>
        key.startsWith(`diagnostics/r2-realistic/${probeId}/`),
      ),
    ).toEqual([]);
    expect((await test.storage.list({ prefix: `diagnostic-r2-probe:${probeId}:` })).size).toBe(0);
  });

  it("persists a typed sanitized terminal when shelf commit storage rejects the queue consumer", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    const begin = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: fixture.request,
    });
    expect(begin.status).toBe(201);
    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(1);
    vi.spyOn(test.coordinator, "commitShelf").mockRejectedValueOnce(
      new Error("Transaction exceeded the maximum number of modified keys"),
    );

    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: test.queueMessages.map((body) => ({ body, ack: () => undefined })),
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      async () => ({
        closure: fixture.commit.revision.content.closure,
        objects: [...fixture.objects.entries()].map(([sha256, object]) => ({
          kind: object.kind,
          bytes: object.bytes,
          sha256,
        })),
        lockfileSha256: fixture.commit.lockfileSha256,
        sbomSha256: fixture.commit.sbomSha256,
        toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
        provenanceStatus: "unavailable" as const,
      }),
    );

    const status = await call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}`, {
      principal: "builder-readonly",
    });
    expect(status.status).toBe(200);
    const statusText = await status.text();
    expect(statusText).not.toContain("maximum number");
    expect(JSON.parse(statusText)).toMatchObject({
      ingest: {
        state: "failed",
        failure: {
          code: "catalog_execution_failed",
          retryable: false,
          stage: "commit-shelf",
          operation: "catalog-commit-ledger",
          cause: "catalog-storage-limit",
          errorClass: "Error",
        },
      },
    });
    const diagnostics = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/diagnostics`,
      { principal: "builder-readonly" },
    );
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      currentStage: "failed",
      events: expect.arrayContaining([
        expect.objectContaining({
          kind: "ingest-failed",
          failureCode: "catalog_execution_failed",
          failureStage: "commit-shelf",
          failureOperation: "catalog-commit-ledger",
          failureCause: "catalog-storage-limit",
          failureErrorClass: "Error",
        }),
      ]),
    });
  });

  it("retries transient catalog connection loss with bounded backoff before a typed terminal", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    await test.coordinator.alarm();
    const ingest = async () => ({
      closure: fixture.commit.revision.content.closure,
      objects: [...fixture.objects.entries()].map(([sha256, object]) => ({
        kind: object.kind,
        bytes: object.bytes,
        sha256,
      })),
      lockfileSha256: fixture.commit.lockfileSha256,
      sbomSha256: fixture.commit.sbomSha256,
      toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
      provenanceStatus: "unavailable" as const,
    });
    vi.spyOn(test.coordinator, "commitShelf").mockRejectedValue(
      new Error("Network connection lost."),
    );

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(test.queueMessages).toHaveLength(attempt);
      await handlePantryQueue(
        {
          queue: "pantry-test",
          messages: [{ body: test.queueMessages[attempt - 1], ack: () => undefined }],
        } as unknown as MessageBatch<PantryStockQueueMessage>,
        test.env,
        test.coordinator,
        ingest,
      );
      const status = await call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}`, {
        principal: "builder-readonly",
      });
      const body = (await status.json()) as {
        ingest: { failure: PantryIngestFailureRecord };
      };
      expect(body.ingest.failure).toMatchObject({
        code: attempt < 5 ? "upstream_unavailable" : "catalog_execution_failed",
        retryable: attempt < 5,
        stage: "commit-shelf",
        operation: "catalog-commit-ledger",
        cause: "catalog-storage-unavailable",
        errorClass: "Error",
        errorCode: null,
        errorFingerprint: "53ae6aaa06472a15",
      });
      if (attempt < 5) {
        vi.spyOn(Date, "now").mockReturnValue(
          Date.parse(body.ingest.failure.negativeCacheUntil) + 1,
        );
        await test.coordinator.alarm();
      }
    }
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(5);
    expect(test.bucket.objects.size).toBe(0);
  });

  it("rolls back a staged R2 object when durable recording fails and reaches a typed terminal", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    await test.coordinator.alarm();
    vi.spyOn(test.coordinator, "recordStagedObject").mockRejectedValueOnce(
      new Error("Transaction exceeded the maximum number of modified keys"),
    );
    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: [{ body: test.queueMessages[0], ack: () => undefined }],
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      async () => ({
        closure: fixture.commit.revision.content.closure,
        objects: [...fixture.objects.entries()].map(([sha256, object]) => ({
          kind: object.kind,
          bytes: object.bytes,
          sha256,
        })),
        lockfileSha256: fixture.commit.lockfileSha256,
        sbomSha256: fixture.commit.sbomSha256,
        toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
        provenanceStatus: "unavailable" as const,
      }),
    );
    const status = await call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}`, {
      principal: "builder-readonly",
    });
    await expect(status.json()).resolves.toMatchObject({
      ingest: {
        state: "failed",
        failure: {
          code: "catalog_execution_failed",
          stage: "stage-object",
          operation: "catalog-record-object",
          cause: "catalog-storage-limit",
        },
      },
    });
    expect(test.bucket.objects.size).toBe(0);
  });

  it("retries a transient R2 binding disconnect at the exact object operation", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    const originalPut = test.bucket.put.bind(test.bucket);
    const put = vi
      .spyOn(test.bucket, "put")
      .mockRejectedValueOnce(new Error("Network connection lost."))
      .mockImplementation(originalPut);
    const [sha256, object] = fixture.objects.entries().next().value as [
      string,
      { kind: string; bytes: Uint8Array },
    ];
    const response = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`,
      { method: "PUT", principal: "catalog-admin", body: object.bytes },
    );
    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("converges concurrent immutable misses and verifies the winning bytes", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    const [sha256, object] = fixture.objects.entries().next().value as [
      string,
      { kind: string; bytes: Uint8Array },
    ];
    const path = `/internal/v1/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`;
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        call(test, path, { method: "PUT", principal: "catalog-admin", body: object.bytes }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
    expect(
      test.bucket.objects.get(`quarantine/${fixture.commit.assemblyId}/objects/${sha256}`),
    ).toEqual(object.bytes);
  });

  it("fails closed when immutable content-addressed bytes are corrupt", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    const [sha256, object] = fixture.objects.entries().next().value as [
      string,
      { kind: string; bytes: Uint8Array },
    ];
    const key = `quarantine/${fixture.commit.assemblyId}/objects/${sha256}`;
    const corrupt = object.bytes.slice();
    corrupt[0] ^= 1;
    test.bucket.objects.set(key, corrupt);
    const bodyBearingPut = vi.spyOn(test.bucket, "put");
    const response = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/objects/${sha256}/${object.kind}`,
      { method: "PUT", principal: "catalog-admin", body: object.bytes },
    );
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      code: "catalog_integrity_mismatch",
      retryable: false,
    });
    expect(response.headers.get("x-nabuflow-pantry-error-code")).toMatch(
      /^hash-mismatch-[0-9a-f]{8}-[0-9a-f]{8}$/u,
    );
    expect(response.headers.get("x-nabuflow-pantry-error-fingerprint")).toMatch(/^[0-9a-f]{16}$/u);
    expect(bodyBearingPut).not.toHaveBeenCalled();
    expect(test.bucket.objects.get(key)).toEqual(corrupt);
  });

  it("hash-verifies a completed object prefix and resumes at the first incomplete object", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    await test.coordinator.alarm();
    const orderedObjects = [...fixture.objects.entries()].map(([sha256, object]) => ({
      sha256,
      ...object,
    }));
    expect(orderedObjects.length).toBeGreaterThan(2);
    const firstIncomplete = orderedObjects[2];
    const originalRecord = test.coordinator.recordStagedObject.bind(test.coordinator);
    let rejectFirstIncomplete = true;
    vi.spyOn(test.coordinator, "recordStagedObject").mockImplementation(
      async (assemblyId, reference) => {
        if (rejectFirstIncomplete && reference.sha256 === firstIncomplete.sha256) {
          rejectFirstIncomplete = false;
          throw new Error("Network connection lost.");
        }
        return originalRecord(assemblyId, reference);
      },
    );
    const ingest = async () => ({
      closure: fixture.commit.revision.content.closure,
      objects: orderedObjects,
      lockfileSha256: fixture.commit.lockfileSha256,
      sbomSha256: fixture.commit.sbomSha256,
      toolchainAttestationSha256: fixture.commit.toolchainAttestationSha256,
      provenanceStatus: "unavailable" as const,
    });
    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: [{ body: test.queueMessages[0], ack: () => undefined }],
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      ingest,
    );
    const failed = await call(test, `/internal/v1/assemblies/${fixture.commit.assemblyId}`, {
      principal: "builder-readonly",
    });
    const failedBody = (await failed.json()) as {
      ingest: { failure: PantryIngestFailureRecord };
    };
    expect(failedBody.ingest.failure).toMatchObject({
      code: "upstream_unavailable",
      retryable: true,
      stage: "stage-object",
      operation: "catalog-record-object",
    });
    const stagedAfterFailure = await test.coordinator.getAssembly(fixture.commit.assemblyId);
    expect(stagedAfterFailure?.objects.map((reference) => reference.sha256)).toEqual(
      orderedObjects.slice(0, 2).map((object) => object.sha256),
    );

    const quarantinePuts: string[] = [];
    const originalPut = test.bucket.put.bind(test.bucket);
    vi.spyOn(test.bucket, "put").mockImplementation(async (key, value, options) => {
      if (key.startsWith(`quarantine/${fixture.commit.assemblyId}/objects/`)) {
        quarantinePuts.push(key);
      }
      return originalPut(key, value, options);
    });
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse(failedBody.ingest.failure.negativeCacheUntil) + 1,
    );
    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(2);
    await handlePantryQueue(
      {
        queue: "pantry-test",
        messages: [{ body: test.queueMessages[1], ack: () => undefined }],
      } as unknown as MessageBatch<PantryStockQueueMessage>,
      test.env,
      test.coordinator,
      ingest,
    );
    expect(quarantinePuts).toEqual(
      orderedObjects
        .slice(2)
        .map((object) => `quarantine/${fixture.commit.assemblyId}/objects/${object.sha256}`),
    );
    const evidence = await test.coordinator.getGenerationResourceEvidence(
      fixture.commit.assemblyId,
    );
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          generation: 2,
          outcome: "succeeded",
          verifiedResumedObjects: 2,
        }),
      ]),
    );
    expect(
      (await test.coordinator.getAssemblyDiagnostics(fixture.commit.assemblyId))?.events,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "object-resume-verified", generation: 2 }),
      ]),
    );
  });

  it("sweeps only old unreferenced CAS candidates and preserves committed shelf bytes", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const committedSha256 = fixture.commit.objectReferences[0].sha256;
    const orphanBytes = new TextEncoder().encode("unreferenced public fixture");
    const orphanSha256 = await sha256Hex(orphanBytes);
    await test.bucket.put(`cas/sha256/${orphanSha256}`, orphanBytes);

    const response = await call(test, "/internal/v1/gc", {
      method: "POST",
      principal: "catalog-gc",
      body: {
        scope: "targeted-orphan-cas",
        now: "2026-08-10T02:00:00.000Z",
        maxDeletes: 10,
        objectSha256: [committedSha256, orphanSha256],
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deletedObjectSha256: [orphanSha256],
      deletedBytes: orphanBytes.byteLength,
    });
    expect(test.bucket.objects.has(`cas/sha256/${committedSha256}`)).toBe(true);
    expect(test.bucket.objects.has(`cas/sha256/${orphanSha256}`)).toBe(false);
  });

  it("sweeps crash-gap bytes but preserves every assembly and committed-shelf reference", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const committedSha256 = fixture.commit.objectReferences[0].sha256;
    const committedRevisionKey = `revisions/${fixture.commit.revision.content.revisionId}/${fixture.commit.revision.rootSha256}.json`;

    const liveFixture = await makePantryFixture({
      nowMs: Date.now() + 1_000,
      sequence: 2,
      selector: "@fixture/heavy-app@1.0.1",
    });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: liveFixture.request,
        })
      ).status,
    ).toBe(201);
    const liveReference = liveFixture.commit.objectReferences[0];
    await test.bucket.put(
      `cas/sha256/${liveReference.sha256}`,
      liveFixture.objects.get(liveReference.sha256)!.bytes,
    );
    await test.coordinator.recordStagedObject(liveFixture.commit.assemblyId, liveReference);

    const missingAssemblyId = `passembly_${"f".repeat(64)}`;
    const orphanQuarantineKey = `quarantine/${missingAssemblyId}/objects/${"e".repeat(64)}`;
    const orphanRevisionKey = `revisions/pantry-2026-08-10.999/${"d".repeat(64)}.json`;
    await test.bucket.put(orphanQuarantineKey, new TextEncoder().encode("orphan quarantine"));
    await test.bucket.put(orphanRevisionKey, new TextEncoder().encode("orphan revision"));

    const response = await call(test, "/internal/v1/gc", {
      method: "POST",
      principal: "catalog-gc",
      body: {
        scope: "orphan-cas-sweep",
        now: "2026-08-10T02:00:00.000Z",
        maxDeletes: 100,
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      deletedQuarantineKeys: [orphanQuarantineKey],
      deletedRevisionKeys: [orphanRevisionKey],
    });
    expect(test.bucket.objects.has(`cas/sha256/${committedSha256}`)).toBe(true);
    expect(test.bucket.objects.has(`cas/sha256/${liveReference.sha256}`)).toBe(true);
    expect(test.bucket.objects.has(committedRevisionKey)).toBe(true);
    expect(test.bucket.objects.has(orphanQuarantineKey)).toBe(false);
    expect(test.bucket.objects.has(orphanRevisionKey)).toBe(false);
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
    await test.coordinator.alarm();
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

  it("attaches or adopts resumed semantic identities with fresh timestamps", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    const first = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: fixture.request,
    });
    expect(first.status).toBe(201);
    const resumedRequest = {
      ...fixture.request,
      requestedAt: new Date(Date.parse(fixture.request.requestedAt) + 30_000).toISOString(),
      expiresAt: new Date(Date.parse(fixture.request.expiresAt) + 30_000).toISOString(),
    };
    const attached = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: resumedRequest,
    });
    expect(attached.status).toBe(200);
    await expect(attached.json()).resolves.toMatchObject({ state: "assembling" });
    expect(test.queueMessages).toHaveLength(0);

    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(1);

    const nowMs = Date.now();
    const initial = test.queueMessages[0];
    await test.coordinator.claimIngest(
      fixture.commit.assemblyId,
      initial.generation,
      "expired-test-owner",
      nowMs - 400_000,
    );
    await test.coordinator.alarm();
    const adopted = await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: resumedRequest,
    });
    expect(adopted.status).toBe(200);
    await expect(adopted.json()).resolves.toMatchObject({ state: "assembling" });
    expect(test.queueMessages).toHaveLength(2);
  });

  it("lets only the alarm adopt an expired generation while concurrent polls remain read-only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-10T16:00:00.000Z");
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(1);
    const first = test.queueMessages[0];
    await test.coordinator.markQueueDelivery(fixture.commit.assemblyId);
    await expect(
      test.coordinator.claimIngest(
        fixture.commit.assemblyId,
        first.generation,
        "generation-one-owner",
        Date.now(),
      ),
    ).resolves.toMatchObject({ state: "claimed" });

    vi.advanceTimersByTime(PANTRY_ASSEMBLY_LEASE_MS + 1);
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

    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(2);
    const adopted = test.queueMessages[1];
    expect(adopted.generation).toBe(first.generation + 1);
    await test.coordinator.markQueueDelivery(fixture.commit.assemblyId);
    await expect(test.coordinator.diagnostics()).resolves.toMatchObject({ queueDeliveries: 2 });
    await expect(
      test.coordinator.getAssemblyDiagnostics(fixture.commit.assemblyId),
    ).resolves.toMatchObject({ generation: 2, alarmReenqueues: 1, queueEnqueues: 2 });
  });

  it("renews a long assembly lease and records the renewals without alarm re-enqueue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-10T17:00:00.000Z");
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await call(test, "/internal/v1/stock-requests", {
      method: "POST",
      principal: "catalog-admin",
      body: fixture.request,
    });
    await test.coordinator.alarm();
    const queued = test.queueMessages[0];
    await test.coordinator.claimIngest(
      fixture.commit.assemblyId,
      queued.generation,
      "long-stage-owner",
      Date.now(),
    );
    vi.advanceTimersByTime(30_000);
    await expect(
      test.coordinator.renewIngest(
        fixture.commit.assemblyId,
        queued.generation,
        "long-stage-owner",
        Date.now(),
      ),
    ).resolves.toBe("renewed");
    vi.advanceTimersByTime(30_000);
    await expect(
      test.coordinator.renewIngest(
        fixture.commit.assemblyId,
        queued.generation,
        "long-stage-owner",
        Date.now(),
      ),
    ).resolves.toBe("renewed");
    await test.coordinator.alarm();
    expect(test.queueMessages).toHaveLength(1);
    await expect(
      test.coordinator.getAssemblyDiagnostics(fixture.commit.assemblyId),
    ).resolves.toMatchObject({ leaseRenewals: 2, alarmReenqueues: 0, generation: 1 });
  });

  it("persists a bounded sanitized assembly trail through terminal commit", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect(
      (
        await call(test, "/internal/v1/stock-requests", {
          method: "POST",
          principal: "catalog-admin",
          body: fixture.request,
        })
      ).status,
    ).toBe(201);
    const claimedAt = new Date().toISOString();
    await test.coordinator.alarm();
    await test.coordinator.markQueueDelivery(fixture.commit.assemblyId);
    const queued = test.queueMessages[0];
    await test.coordinator.claimIngest(
      fixture.commit.assemblyId,
      queued.generation,
      "diagnostic-test-owner",
      Date.parse(claimedAt),
    );
    await test.coordinator.recordAssemblyEvent(fixture.commit.assemblyId, {
      kind: "ingest-progress",
      stage: "fetching-tarball",
      at: new Date(Date.parse(claimedAt) + 1_000).toISOString(),
      attempt: 1,
      metrics: {
        resolvedPackages: 2,
        fetchedTarballs: 1,
        verifiedTarballs: 0,
        extractedTarballs: 0,
        dependencyEdges: 3,
        tarballBytes: 512,
        unpackedBytes: 0,
      },
    });
    const live = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/diagnostics`,
      { principal: "builder-readonly" },
    );
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toMatchObject({
      currentStage: "fetching-tarball",
      queueEnqueues: 1,
      queueDeliveries: 1,
      ingestAttempts: 1,
      metrics: { resolvedPackages: 2, fetchedTarballs: 1 },
    });

    await beginAndStage(test, fixture);
    expect((await commit(test, fixture)).status).toBe(201);
    const terminal = await call(
      test,
      `/internal/v1/assemblies/${fixture.commit.assemblyId}/diagnostics`,
      { principal: "builder-readonly" },
    );
    expect(terminal.status).toBe(200);
    await expect(terminal.json()).resolves.toMatchObject({
      currentStage: "committed",
      queueDeliveries: 1,
      events: expect.arrayContaining([
        expect.objectContaining({ kind: "shelf-committed", stage: "committed" }),
      ]),
    });
  });

  it("returns a typed identity conflict instead of throwing an internal error", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    expect((await test.coordinator.beginStock(fixture.request)).state).toBe("created");
    const colliding = {
      ...fixture.request,
      intents: [{ ecosystem: "npm" as const, name: "semantically-distinct", selector: "1.0.0" }],
    };
    await expect(test.coordinator.beginStock(colliding)).resolves.toEqual({
      state: "conflict",
      assemblyId: fixture.commit.assemblyId,
    });

    const conflictCoordinator = new Proxy(test.coordinator, {
      get(target, property, receiver) {
        if (property === "beginStock") {
          return async () => ({ state: "conflict", assemblyId: fixture.commit.assemblyId });
        }
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const response = await handlePantryWorkerRequest(
      request("/internal/v1/stock-requests", {
        method: "POST",
        principal: "catalog-admin",
        body: fixture.request,
      }),
      test.env,
      conflictCoordinator,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "catalog_conflict" });
  });

  it("discovers pending stock state without creating or mutating an operation", async () => {
    const test = context();
    const fixture = await makePantryFixture({ nowMs: Date.now() });
    await test.coordinator.beginStock(fixture.request);
    const before = await test.coordinator.diagnostics();
    const response = await call(
      test,
      `/internal/v1/stock-identities/${fixture.request.requestSha256}`,
      { principal: "builder-readonly" },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: "assembling",
      identitySha256: fixture.request.requestSha256,
      revisionRootSha256: null,
    });
    expect(await test.coordinator.diagnostics()).toEqual(before);
    expect(test.queueMessages).toHaveLength(0);
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
    await test.coordinator.alarm();
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
