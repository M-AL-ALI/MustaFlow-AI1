import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  ZERO_SEALED_BUILD_PLATFORM,
  sha256Hex,
  trustedBuildDependencyIntentHash,
  trustedBuildRequestHash,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  type TrustedBuildRequest,
} from "@workspace/tenant-runtime-contracts";
import { PANTRY_TEST_KEY } from "../scripts/pantry-catalog-fixture";
import { TrustedBuildDurableObject } from "../src/trusted-build-durable-object";
import type {
  StoredTrustedBuild,
  TrustedBuildLegacyIdentity,
  TrustedBuildWorkerBindings,
} from "../src/trusted-build-model";
import { handleTrustedBuildWorkerRequest } from "../src/trusted-build-worker";
import { trustedBuildRequestObjectKey } from "../src/trusted-build-storage";
import { MemoryR2Bucket } from "./helpers";

const START = Date.parse("2026-09-15T10:00:00.000Z");
const BUILD = "pbuild_" + "a".repeat(64);

class MemoryStorage {
  private readonly values = new Map<string, unknown>();
  private tail: Promise<void> = Promise.resolve();
  private alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else
      for (const [name, item] of Object.entries(key)) this.values.set(name, structuredClone(item));
  }
  async delete(keys: string | string[]): Promise<boolean> {
    let removed = false;
    for (const key of typeof keys === "string" ? [keys] : keys)
      removed = this.values.delete(key) || removed;
    return removed;
  }
  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options?.prefix ?? ""))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }
  async transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback(this);
    } finally {
      release();
    }
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(time: number): Promise<void> {
    this.alarm = time;
  }
}

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  const storage = new MemoryStorage();
  const bucket = new MemoryR2Bucket();
  const queued: unknown[] = [];
  const env = {
    TRUSTED_BUILD_OBJECTS: bucket,
    TRUSTED_BUILD_QUEUE: {
      async send(message: unknown) {
        queued.push(structuredClone(message));
      },
    },
    TRUSTED_BUILD_MAX_ACTIVE: "1",
    TRUSTED_BUILD_PLATFORM: JSON.stringify(ZERO_SEALED_BUILD_PLATFORM),
    TRUSTED_BUILD_SIGNING_KEY_ID: PANTRY_TEST_KEY.kid,
    TRUSTED_BUILD_SIGNING_PRIVATE_KEY: PANTRY_TEST_KEY.privateKeyPem,
    TRUSTED_BUILD_PUBLIC_KEYS: JSON.stringify({
      [PANTRY_TEST_KEY.kid]: PANTRY_TEST_KEY.publicKeyPem,
    }),
    TRUSTED_BUILD_SANDBOX: {},
  } as unknown as TrustedBuildWorkerBindings;
  const coordinator = new TrustedBuildDurableObject(
    { storage } as unknown as DurableObjectState,
    env,
  );
  return { storage, bucket, queued, env, coordinator };
}

function admission(marker = "b"): Parameters<TrustedBuildDurableObject["begin"]>[0] {
  return {
    buildId: BUILD,
    requestId: "pbuildreq_" + marker.repeat(64),
    requestSha256: marker.repeat(64),
    semanticRequestSha256: "c".repeat(64),
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
    requestObjectSha256: "d".repeat(64),
    sourceObjectSha256: "e".repeat(64),
    sourceBytes: 1,
  };
}

async function request(): Promise<TrustedBuildRequest> {
  const payload = Buffer.from("// isolated admission fixture\n");
  const manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    payloadBytes: payload.length,
    files: [
      {
        path: "build.mjs",
        mode: 0o644 as const,
        offset: 0,
        size: payload.length,
        sha256: await sha256Hex(payload),
      },
    ],
  };
  const dependencyIntents = [{ ecosystem: "npm" as const, name: "express", selector: "4.22.3" }];
  const unsigned = {
    format: TRUSTED_BUILD_REQUEST_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    input: {
      format: PANTRY_BUILD_INPUT_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      buildId: BUILD,
      sourceArtifactSha256: await trustedBuildSourceManifestHash(manifest),
      dependencyIntentSha256: await trustedBuildDependencyIntentHash(dependencyIntents),
      lockfileSha256: "1".repeat(64),
      pantryRevisionId: "pantry-2026-09-15.1",
      pantryRevisionRootSha256: "2".repeat(64),
      dependencyClosureSha256: "3".repeat(64),
      platform: ZERO_SEALED_BUILD_PLATFORM,
      buildCommand: ["node", "build.mjs"],
      createdAt: new Date(START).toISOString(),
    },
    source: { manifest, payloadBase64: payload.toString("base64") },
    dependencyIntents,
    output: {
      strategy: "bundle-first" as const,
      dependencyPackaging: "bundle" as const,
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules" as const,
    },
  };
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: "pbuildreq_" + (await trustedBuildRequestHash(unsigned)),
  });
}

async function changed(input: TrustedBuildRequest, mutate: (copy: TrustedBuildRequest) => void) {
  const copy = structuredClone(input);
  mutate(copy);
  const { requestId: _requestId, ...unsigned } = copy;
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: "pbuildreq_" + (await trustedBuildRequestHash(unsigned)),
  });
}

function submit(test: ReturnType<typeof fixture>, input: TrustedBuildRequest) {
  return handleTrustedBuildWorkerRequest(
    new Request("https://build.internal/internal/v1/builds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-nabuflow-build-principal": "build-control",
      },
      body: JSON.stringify(input),
    }),
    test.env,
    { coordinator: test.coordinator, now: () => new Date(START) },
  );
}

afterEach(() => vi.useRealTimers());

describe("immutable trusted-build admission", () => {
  it("coalesces a changed transport identity without resetting an active job or its deadline", async () => {
    const test = fixture();
    const first = admission();
    expect((await test.coordinator.begin(first, 1)).state).toBe("created");
    await test.coordinator.claim(
      BUILD,
      new Date(START + 1).toISOString(),
      new Date(START + 60_000).toISOString(),
    );
    await test.coordinator.bindCell(BUILD, 1, "isolated-cell");
    const before = await test.coordinator.get(BUILD);
    const alarm = await test.storage.getAlarm();
    const result = await test.coordinator.begin(
      {
        ...admission("f"),
        createdAt: new Date(START + 30_000).toISOString(),
        updatedAt: new Date(START + 30_000).toISOString(),
      },
      1,
    );
    expect(result).toEqual({ state: "coalesced", build: before });
    expect(await test.coordinator.get(BUILD)).toEqual(before);
    expect(await test.storage.getAlarm()).toBe(alarm);
    expect(await test.storage.get("request:" + admission("f").requestId)).toBeUndefined();
  });

  it("rejects different semantic inputs without overwriting the original job", async () => {
    const test = fixture();
    await test.coordinator.begin(admission(), 2);
    const before = await test.coordinator.get(BUILD);
    expect(
      await test.coordinator.begin({ ...admission("f"), semanticRequestSha256: "9".repeat(64) }, 2),
    ).toEqual({ state: "conflict" });
    expect(await test.coordinator.get(BUILD)).toEqual(before);
  });

  it("does not rebind an existing request ID to another build", async () => {
    const test = fixture();
    await test.coordinator.begin(admission(), 2);
    expect(
      await test.coordinator.begin({ ...admission(), buildId: "pbuild_" + "9".repeat(64) }, 2),
    ).toEqual({ state: "conflict" });
    expect(await test.coordinator.get(BUILD)).toMatchObject({ requestId: admission().requestId });
  });

  it("keeps exact legacy replays valid but requires proof for a new request ID", async () => {
    const test = fixture();
    const { semanticRequestSha256: _semantic, ...legacy } = admission();
    await test.coordinator.begin(legacy, 2);
    const before = await test.coordinator.get(BUILD);
    expect(await test.coordinator.begin(legacy, 2)).toEqual({ state: "coalesced", build: before });
    expect(await test.coordinator.begin(admission("f"), 2)).toEqual({ state: "conflict" });
    expect(await test.coordinator.get(BUILD)).toEqual(before);
  });

  it("hydrates a legacy identity only when its verified tuple still matches", async () => {
    const test = fixture();
    const { semanticRequestSha256: _semantic, ...legacy } = admission();
    await test.coordinator.begin(legacy, 2);
    const proof: TrustedBuildLegacyIdentity = {
      requestId: legacy.requestId,
      requestSha256: legacy.requestSha256,
      requestObjectSha256: legacy.requestObjectSha256,
      semanticRequestSha256: "c".repeat(64),
    };
    const before = await test.coordinator.get(BUILD);
    expect(
      await test.coordinator.begin(admission("f"), 2, {
        ...proof,
        requestObjectSha256: "0".repeat(64),
      }),
    ).toEqual({ state: "conflict" });
    expect(await test.coordinator.get(BUILD)).toEqual(before);
    const result = await test.coordinator.begin(admission("f"), 2, proof);
    expect(result).toEqual({
      state: "coalesced",
      build: { ...before, semanticRequestSha256: "c".repeat(64) },
    });
  });

  it.each(["succeeded", "failed", "cancelled"] as const)(
    "preserves a terminal %s receipt across equivalent retries",
    async (state) => {
      const test = fixture();
      await test.coordinator.begin(admission(), 1);
      const original = (await test.coordinator.get(BUILD))!;
      const terminal: StoredTrustedBuild = {
        ...original,
        state,
        attempt: 2,
        outputObjectSha256: state === "succeeded" ? "8".repeat(64) : null,
      };
      await test.storage.put("build:" + BUILD, terminal);
      expect(await test.coordinator.begin(admission("f"), 1)).toEqual({
        state: state === "succeeded" ? "succeeded" : "coalesced",
        build: terminal,
      });
      expect(await test.coordinator.get(BUILD)).toEqual(terminal);
    },
  );

  it("serializes simultaneous equivalent requests into one durable job", async () => {
    const test = fixture();
    const results = await Promise.all([
      test.coordinator.begin(admission(), 1),
      test.coordinator.begin(admission("f"), 1),
    ]);
    expect(results.map((result) => result.state).sort()).toEqual(["coalesced", "created"]);
    expect(await test.storage.list({ prefix: "build:" })).toHaveLength(1);
  });

  it("reuses the original HTTP job and queues only once when input time changes", async () => {
    const test = fixture();
    const first = await request();
    expect((await submit(test, first)).status).toBe(201);
    const before = await test.coordinator.get(BUILD);
    const retry = await changed(first, (copy) => {
      copy.input.createdAt = new Date(START + 30_000).toISOString();
    });
    expect(retry.requestId).not.toBe(first.requestId);
    const response = await submit(test, retry);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: "coalesced",
      requestId: first.requestId,
      buildId: BUILD,
    });
    expect(await test.coordinator.get(BUILD)).toEqual(before);
    expect(test.queued).toHaveLength(1);
  });

  it.each(["command", "shelf", "output"] as const)(
    "rejects a signed request that reuses the build ID with changed %s",
    async (part) => {
      const test = fixture();
      const first = await request();
      expect((await submit(test, first)).status).toBe(201);
      const before = await test.coordinator.get(BUILD);
      const retry = await changed(first, (copy) => {
        if (part === "command") copy.input.buildCommand = ["node", "different.mjs"];
        if (part === "shelf") copy.input.pantryRevisionRootSha256 = "4".repeat(64);
        if (part === "output") copy.output.dependencyPackaging = "layer";
      });
      const response = await submit(test, retry);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        ok: false,
        code: "build_invalid_request",
        retryable: false,
      });
      expect(await test.coordinator.get(BUILD)).toEqual(before);
      expect(test.queued).toHaveLength(1);
    },
  );

  it("verifies stored legacy request metadata before coalescing a timestamp-only retry", async () => {
    const test = fixture();
    const first = await request();
    expect((await submit(test, first)).status).toBe(201);
    const original = (await test.coordinator.get(BUILD))!;
    const { semanticRequestSha256: _semantic, ...legacy } = original;
    await test.storage.put("build:" + BUILD, legacy);
    const retry = await changed(first, (copy) => {
      copy.input.createdAt = new Date(START + 30_000).toISOString();
    });
    expect((await submit(test, retry)).status).toBe(200);
    expect(await test.coordinator.get(BUILD)).toEqual(original);
    expect(test.queued).toHaveLength(1);
  });

  it("fails closed without overwriting legacy state if its stored metadata is missing", async () => {
    const test = fixture();
    const first = await request();
    expect((await submit(test, first)).status).toBe(201);
    const original = (await test.coordinator.get(BUILD))!;
    const { semanticRequestSha256: _semantic, ...legacy } = original;
    await test.storage.put("build:" + BUILD, legacy);
    await test.bucket.delete(
      trustedBuildRequestObjectKey(original.requestId, original.requestObjectSha256),
    );
    const retry = await changed(first, (copy) => {
      copy.input.createdAt = new Date(START + 30_000).toISOString();
    });
    const response = await submit(test, retry);
    expect(response.ok).toBe(false);
    expect(await test.coordinator.get(BUILD)).toEqual(legacy);
    expect(test.queued).toHaveLength(1);
  });
});
