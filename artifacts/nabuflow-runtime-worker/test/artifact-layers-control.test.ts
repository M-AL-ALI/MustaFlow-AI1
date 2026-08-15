import { describe, expect, it } from "vitest";
import {
  PANTRY_LAYER_FORMAT,
  PANTRY_SCHEMA_VERSION,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  RUNTIME_ARTIFACT_LAYERS_FORMAT,
  deriveRuntimeIdentity,
  runtimeArtifactContentHash,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactLayerContentSchema,
  runtimeArtifactLayerUnpackedManifestHash,
  runtimeArtifactSealedHash,
  runtimeLayeredArtifactContentHash,
  runtimeLayeredArtifactContentSchema,
  runtimeLayeredArtifactEnvelopeSchema,
  runtimeLayeredArtifactMergedReleaseHash,
  runtimeLayeredArtifactSealedHash,
  sha256Hex,
  type PantryPlatform,
  type RuntimeLayeredArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";
import { handleControlRequest } from "../src/worker";
import { layeredArtifactAppChunkKey } from "../src/artifact-layer-storage";
import {
  MemoryCoordinator,
  MemoryR2Bucket,
  MockBackend,
  TEST_NOW_MS,
  commitArtifactAndDrain,
  mutationAndDrain,
  ensureBody,
  fakeEnv,
  signedRawRequest,
  signedRequest,
} from "./helpers";

const platform: PantryPlatform = {
  runtime: "node",
  runtimeVersion: "22.18.0",
  nodeAbi: "127",
  os: "linux",
  cpu: "x64",
  libc: "glibc",
  toolchainImageDigest: "sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738",
};

async function makeLayeredArtifact(input: {
  identity: string;
  artifactRevision: string;
  appText: string;
  layerBytes?: Uint8Array;
  platform?: PantryPlatform;
}): Promise<{
  envelope: RuntimeLayeredArtifactEnvelope;
  appChunks: Uint8Array[];
  layerChunks: Uint8Array[];
}> {
  const targetPlatform = input.platform ?? platform;
  const appBytes = new TextEncoder().encode(input.appText);
  const appContent = runtimeArtifactContentManifestSchema.parse({
    format: RUNTIME_ARTIFACT_FORMAT,
    payloadBytes: appBytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: [await sha256Hex(appBytes)],
    files: [
      {
        path: "server.mjs",
        mode: 0o755,
        offset: 0,
        size: appBytes.byteLength,
        sha256: await sha256Hex(appBytes),
      },
    ],
  });
  const appUnsigned = {
    content: appContent,
    contentSha256: await runtimeArtifactContentHash(appContent),
    targetRuntimeIdentity: input.identity,
    manifestRevision: "manifest-1",
    artifactRevision: `${input.artifactRevision}-app`,
    sourceRevision: "source-layer-test",
    scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
  };
  const appArtifact = {
    ...appUnsigned,
    sealedArtifactSha256: await runtimeArtifactSealedHash(appUnsigned),
  };
  const layerBytes = input.layerBytes ?? new Uint8Array([0, 1, 2, 3, 254, 255]);
  const layerFiles = [
    {
      path: "demo/native.node",
      mode: 0o755 as const,
      offset: 0,
      size: layerBytes.byteLength,
      sha256: await sha256Hex(layerBytes),
    },
  ];
  const layer = runtimeArtifactLayerContentSchema.parse({
    descriptor: {
      format: PANTRY_LAYER_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      contentSha256: await sha256Hex(layerBytes),
      unpackedManifestSha256: await runtimeArtifactLayerUnpackedManifestHash(layerFiles),
      compression: "none",
      contentBytes: layerBytes.byteLength,
      unpackedBytes: layerBytes.byteLength,
      fileCount: 1,
      mountPath: "node_modules",
      platform: targetPlatform,
    },
    payloadBytes: layerBytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: [await sha256Hex(layerBytes)],
    files: layerFiles,
  });
  const partial = {
    format: RUNTIME_ARTIFACT_LAYERS_FORMAT,
    appArtifact,
    pantryRevision: {
      schemaVersion: 1,
      revisionId: "pantry-2026-08-08.1",
      rootSha256: "4".repeat(64),
      state: "committed" as const,
      stateRevision: 1,
      updatedAt: "2026-08-08T00:00:00.000Z",
    },
    dependencyClosureSha256: "2".repeat(64),
    buildAttestationSha256: "3".repeat(64),
    toolchainImageDigest: targetPlatform.toolchainImageDigest,
    platform: targetPlatform,
    layers: [layer],
  };
  const content = runtimeLayeredArtifactContentSchema.parse({
    ...partial,
    finalMergedReleaseSha256: await runtimeLayeredArtifactMergedReleaseHash(partial),
  });
  const unsigned = {
    content,
    contentSha256: await runtimeLayeredArtifactContentHash(content),
    targetRuntimeIdentity: input.identity,
    manifestRevision: "manifest-1",
    artifactRevision: input.artifactRevision,
    sourceRevision: "source-layer-test",
    scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
  };
  return {
    envelope: runtimeLayeredArtifactEnvelopeSchema.parse({
      ...unsigned,
      sealedArtifactSha256: await runtimeLayeredArtifactSealedHash(unsigned),
    }),
    appChunks: [appBytes],
    layerChunks: [layerBytes],
  };
}

describe("additive layered artifact control plane", () => {
  it("advertises and accepts the extension only when its platform config is valid", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    delete env.NABUFLOW_RUNTIME_LAYER_PLATFORM;
    const version = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/version",
        nonce: "layers-version-no-config",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(version.status).toBe(200);
    await expect(version.json()).resolves.toMatchObject({
      features: [
        "artifact-v1",
        "manifest-update-v1",
        "artifact-commit-diagnostics-v1",
        "durable-operation-discovery-v1",
        "runtime-lifecycle-jobs-v1",
      ],
    });
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const artifact = await makeLayeredArtifact({
      identity,
      artifactRevision: "missing-config",
      appText: "console.log('missing config')\n",
    });
    const response = await begin({
      base: "/_nabuflow/control/v1/runtimes/42/preview/primary",
      artifact,
      coordinator,
      backend,
      env,
      key: "missing-config",
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "artifact_layer_infrastructure_unavailable",
      retryable: false,
    });
  });

  it("commits, starts, rehydrates, and reference-counts a shared dependency layer", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const dependencies = { coordinator, backend, nowMs: TEST_NOW_MS };
    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path: base,
            method: "PUT",
            nonce: "layers-ensure-000001",
            idempotencyKey: "layers-ensure",
            body: ensureBody(),
          }),
          env,
          dependencies,
        )
      ).status,
    ).toBe(200);

    const first = await makeLayeredArtifact({
      identity,
      artifactRevision: "layered-first",
      appText: "console.log('first')\n",
    });
    await deliver({ base, artifact: first, coordinator, backend, env, key: "first" });
    expect(backend.materializations).toBe(1);
    await start({ base, artifact: first, coordinator, backend, env, key: "first" });
    expect(backend.materializations).toBe(2);
    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path: `${base}/stop`,
            method: "POST",
            nonce: "layers-stop-0000001",
            idempotencyKey: "layers-stop",
            body: { locator: ensureBody().locator },
          }),
          env,
          dependencies,
        )
      ).status,
    ).toBe(200);
    await start({ base, artifact: first, coordinator, backend, env, key: "rehydrate" });
    expect(backend.materializations).toBe(3);
    await handleControlRequest(
      await signedRequest({
        path: `${base}/stop`,
        method: "POST",
        nonce: "layers-stop-0000002",
        idempotencyKey: "layers-stop-2",
        body: { locator: ensureBody().locator },
      }),
      env,
      dependencies,
    );

    const second = await makeLayeredArtifact({
      identity,
      artifactRevision: "layered-second",
      appText: "console.log('second')\n",
    });
    expect(second.envelope.content.layers[0].descriptor.contentSha256).toBe(
      first.envelope.content.layers[0].descriptor.contentSha256,
    );
    await deliver({ base, artifact: second, coordinator, backend, env, key: "second" });
    expect(coordinator.layerChunkWrites).toBe(1);
    expect(coordinator.runtimeLayers.size).toBe(1);
    expect([...coordinator.runtimeLayers.values()][0].artifactReferences).toHaveLength(2);

    const bucket = env.NABUFLOW_RUNTIME_ARTIFACTS as unknown as MemoryR2Bucket;
    await remove({ base, artifact: first, coordinator, backend, env, key: "first" });
    expect(coordinator.runtimeLayers.size).toBe(1);
    expect([...coordinator.runtimeLayers.values()][0].artifactReferences).toHaveLength(1);
    expect([...bucket.objects.keys()].some((key) => key.startsWith("dependency-layers/v1/"))).toBe(
      true,
    );
    await remove({ base, artifact: second, coordinator, backend, env, key: "second" });
    expect(coordinator.runtimeLayers.size).toBe(0);
    expect(bucket.objects.size).toBe(0);
  });

  it("rejects wrong-platform and altered layer bytes before materialization", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const wrongPlatform = await makeLayeredArtifact({
      identity,
      artifactRevision: "wrong-platform",
      appText: "console.log('wrong')\n",
      platform: { ...platform, cpu: "arm64" },
    });
    const wrongBegin = await begin({
      base,
      artifact: wrongPlatform,
      coordinator,
      backend,
      env,
      key: "wrong-platform",
    });
    expect(wrongBegin.status).toBe(422);
    await expect(wrongBegin.json()).resolves.toMatchObject({
      code: "artifact_layer_platform_mismatch",
    });

    const valid = await makeLayeredArtifact({
      identity,
      artifactRevision: "altered-layer",
      appText: "console.log('valid')\n",
    });
    expect(
      (await begin({ base, artifact: valid, coordinator, backend, env, key: "altered" })).status,
    ).toBe(200);
    const altered = valid.layerChunks[0].slice();
    altered[0] ^= 0xff;
    const sha = valid.envelope.sealedArtifactSha256;
    const layerSha = valid.envelope.content.layers[0].descriptor.contentSha256;
    const response = await handleControlRequest(
      await signedRawRequest({
        path: `${base}/layered-artifacts/${sha}/layers/${layerSha}/chunks/0`,
        method: "PUT",
        nonce: "layers-altered-00001",
        idempotencyKey: "layers-altered",
        body: altered,
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(422);
    expect(backend.materializations).toBe(0);
  });

  it("rejects incomplete layer sets and cleans all pending R2 state", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const artifact = await makeLayeredArtifact({
      identity,
      artifactRevision: "incomplete-layer",
      appText: "console.log('incomplete')\n",
    });
    expect(
      (await begin({ base, artifact, coordinator, backend, env, key: "incomplete" })).status,
    ).toBe(200);
    const sha = artifact.envelope.sealedArtifactSha256;
    await handleControlRequest(
      await signedRawRequest({
        path: `${base}/layered-artifacts/${sha}/app/chunks/0`,
        method: "PUT",
        nonce: "layers-incomplete-app",
        idempotencyKey: "layers-incomplete-app",
        body: artifact.appChunks[0],
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    const commit = await commitArtifactAndDrain({
      path: `${base}/layered-artifacts/${sha}/commit`,
      nonce: "layers-incomplete-commit",
      idempotencyKey: "layers-incomplete-commit",
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        sealedArtifactSha256: sha,
      },
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(commit.status).toBe(409);
    await expect(commit.json()).resolves.toMatchObject({ code: "artifact_incomplete" });
    expect(coordinator.layeredArtifacts.size).toBe(0);
    expect(coordinator.runtimeLayers.size).toBe(0);
    expect((env.NABUFLOW_RUNTIME_ARTIFACTS as unknown as MemoryR2Bucket).objects.size).toBe(0);
  });

  it("promotes a committed preview release through the durable dock without changing its bytes", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const dependencies = { coordinator, backend, nowMs: TEST_NOW_MS };
    const sourceLocator = { projectId: 42, role: "preview" as const, slot: "primary" as const };
    const targetLocator = { projectId: 42, role: "production" as const, slot: "blue" as const };
    const sourceIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      ...sourceLocator,
    });
    const targetIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      ...targetLocator,
    });
    const sourceBase = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const targetBase = "/_nabuflow/control/v1/runtimes/42/production/blue";
    const targetManifest = {
      ...ensureBody().manifest,
      revision: "production-promotion-manifest-1",
      resourceProfile: "production" as const,
      public: true,
    };

    for (const [path, locator, manifest, key] of [
      [sourceBase, sourceLocator, ensureBody().manifest, "promotion-source-ensure"],
      [targetBase, targetLocator, targetManifest, "promotion-target-ensure"],
    ] as const) {
      const response = await handleControlRequest(
        await signedRequest({
          path,
          method: "PUT",
          nonce: `${key}-nonce`,
          idempotencyKey: key,
          body: {
            locator,
            expectedDeploymentVersion: "worker-version-test-1",
            manifest,
          },
        }),
        env,
        dependencies,
      );
      expect(response.status, await response.clone().text()).toBe(200);
    }

    const source = await makeLayeredArtifact({
      identity: sourceIdentity,
      artifactRevision: "accepted-preview-release-1",
      appText: "export default { port: 8080 };\n",
    });
    await deliver({
      base: sourceBase,
      artifact: source,
      coordinator,
      backend,
      env,
      key: "promotion-source",
    });
    const promotionBody = {
      sourceLocator,
      targetLocator,
      expectedDeploymentVersion: "worker-version-test-1",
      sourceSealedArtifactSha256: source.envelope.sealedArtifactSha256,
      targetManifest,
      targetArtifactRevision: "production-artifact-revision-1",
      promotionIdentity: "9".repeat(64),
    };
    const promoted = await mutationAndDrain({
      path: `${targetBase}/promotions/layered`,
      nonce: "production-promotion-nonce-1",
      idempotencyKey: "production-promotion-operation-1",
      body: promotionBody,
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(promoted.status, await promoted.clone().text()).toBe(200);
    const result = (await promoted.json()) as {
      targetSealedArtifactSha256: string;
      appChunksCopied: number;
      layersReused: number;
      envelope: RuntimeLayeredArtifactEnvelope;
    };
    expect(result).toMatchObject({ appChunksCopied: 1, layersReused: 1 });
    expect(result.envelope.targetRuntimeIdentity).toBe(targetIdentity);
    expect(result.envelope.content.appArtifact.content.chunks).toEqual(
      source.envelope.content.appArtifact.content.chunks,
    );
    expect(result.envelope.content.layers).toEqual(source.envelope.content.layers);
    expect(
      await coordinator.getLayeredArtifact(targetIdentity, result.targetSealedArtifactSha256),
    ).toMatchObject({ state: "committed" });
    const diagnostics = await handleControlRequest(
      await signedRequest({
        path: `${targetBase}/promotions/layered/${promotionBody.promotionIdentity}/diagnostics`,
        method: "GET",
        nonce: "production-promotion-diagnostics-1",
      }),
      env,
      dependencies,
    );
    expect(diagnostics.status).toBe(200);
    await expect(diagnostics.json()).resolves.toMatchObject({
      job: {
        kind: "layered-artifact-promotion",
        promotionIdentity: promotionBody.promotionIdentity,
        state: "succeeded",
        checkpoint: "finalized",
        terminal: { status: 200, code: "ok" },
        events: expect.arrayContaining([
          expect.objectContaining({ event: "checkpoint-advanced", checkpoint: "finalized" }),
        ]),
      },
    });

    const bucket = env.NABUFLOW_RUNTIME_ARTIFACTS as unknown as MemoryR2Bucket;
    const targetChunkKey = layeredArtifactAppChunkKey(
      targetIdentity,
      result.targetSealedArtifactSha256,
      0,
    );
    expect(bucket.objects.get(targetChunkKey)).toEqual(source.appChunks[0]);

    bucket.objects.set(targetChunkKey, new TextEncoder().encode("corrupt immutable bytes"));
    const corruptedReplay = await mutationAndDrain({
      path: `${targetBase}/promotions/layered`,
      nonce: "production-promotion-nonce-2",
      idempotencyKey: "production-promotion-integrity-recheck",
      body: promotionBody,
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS + 1,
    });
    expect(corruptedReplay.status).toBe(422);
    await expect(corruptedReplay.json()).resolves.toMatchObject({
      code: "artifact_promotion_target_integrity_mismatch",
    });
  });
});

async function begin(input: {
  base: string;
  artifact: Awaited<ReturnType<typeof makeLayeredArtifact>>;
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  key: string;
}): Promise<Response> {
  const sha = input.artifact.envelope.sealedArtifactSha256;
  return handleControlRequest(
    await signedRequest({
      path: `${input.base}/layered-artifacts/${sha}/begin`,
      method: "POST",
      nonce: `layers-${input.key}-begin-001`,
      idempotencyKey: `layers-${input.key}-begin`,
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        envelope: input.artifact.envelope,
      },
    }),
    input.env,
    { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
  );
}

async function deliver(input: {
  base: string;
  artifact: Awaited<ReturnType<typeof makeLayeredArtifact>>;
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  key: string;
}): Promise<void> {
  const dependencies = {
    coordinator: input.coordinator,
    backend: input.backend,
    nowMs: TEST_NOW_MS,
  };
  const beginResponse = await begin(input);
  expect(beginResponse.status, await beginResponse.clone().text()).toBe(200);
  const beginBody = (await beginResponse.json()) as { layerContentSha256ToUpload: string[] };
  const sha = input.artifact.envelope.sealedArtifactSha256;
  for (let index = 0; index < input.artifact.appChunks.length; index += 1) {
    const response = await handleControlRequest(
      await signedRawRequest({
        path: `${input.base}/layered-artifacts/${sha}/app/chunks/${index}`,
        method: "PUT",
        nonce: `layers-${input.key}-app-${index}`,
        idempotencyKey: `layers-${input.key}-app-${index}`,
        body: input.artifact.appChunks[index],
      }),
      input.env,
      dependencies,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const layerSha = input.artifact.envelope.content.layers[0].descriptor.contentSha256;
  for (
    let index = 0;
    beginBody.layerContentSha256ToUpload.includes(layerSha) &&
    index < input.artifact.layerChunks.length;
    index += 1
  ) {
    const response = await handleControlRequest(
      await signedRawRequest({
        path: `${input.base}/layered-artifacts/${sha}/layers/${layerSha}/chunks/${index}`,
        method: "PUT",
        nonce: `layers-${input.key}-layer-${index}`,
        idempotencyKey: `layers-${input.key}-layer-${index}`,
        body: input.artifact.layerChunks[index],
      }),
      input.env,
      dependencies,
    );
    expect(response.status, await response.clone().text()).toBe(200);
  }
  const response = await commitArtifactAndDrain({
    path: `${input.base}/layered-artifacts/${sha}/commit`,
    nonce: `layers-${input.key}-commit1`,
    idempotencyKey: `layers-${input.key}-commit`,
    body: {
      locator: ensureBody().locator,
      expectedDeploymentVersion: "worker-version-test-1",
      sealedArtifactSha256: sha,
    },
    env: input.env,
    coordinator: input.coordinator,
    backend: input.backend,
    nowMs: TEST_NOW_MS,
  });
  expect(response.status, await response.clone().text()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    materialized: true,
    filesWritten: 2,
    layersMaterialized: 1,
  });
}

async function start(input: {
  base: string;
  artifact: Awaited<ReturnType<typeof makeLayeredArtifact>>;
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  key: string;
}): Promise<void> {
  const response = await mutationAndDrain({
    path: `${input.base}/start`,
    nonce: `layers-${input.key}-start01`,
    idempotencyKey: `layers-${input.key}-start`,
    body: {
      locator: ensureBody().locator,
      expectedDeploymentVersion: "worker-version-test-1",
      artifactRevision: input.artifact.envelope.artifactRevision,
      artifactSha256: input.artifact.envelope.sealedArtifactSha256,
    },
    env: input.env,
    coordinator: input.coordinator,
    backend: input.backend,
    nowMs: TEST_NOW_MS,
  });
  expect(response.status, await response.clone().text()).toBe(200);
}

async function remove(input: {
  base: string;
  artifact: Awaited<ReturnType<typeof makeLayeredArtifact>>;
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  key: string;
}): Promise<void> {
  const sha = input.artifact.envelope.sealedArtifactSha256;
  const response = await handleControlRequest(
    await signedRequest({
      path: `${input.base}/layered-artifacts/${sha}`,
      method: "DELETE",
      nonce: `layers-${input.key}-remove1`,
      idempotencyKey: `layers-${input.key}-remove`,
      body: { locator: ensureBody().locator, sealedArtifactSha256: sha },
    }),
    input.env,
    { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
  );
  expect(response.status, await response.clone().text()).toBe(200);
}

function runtimeFor(identity: string) {
  return {
    descriptor: {
      identity,
      projectId: 42,
      role: "preview" as const,
      slot: "primary" as const,
      status: "stopped" as const,
      servicePort: 8080,
      manifestRevision: "manifest-1",
      deploymentVersion: "worker-version-test-1",
      endpoint: null,
      readyAt: null,
      lastError: null,
    },
    manifest: ensureBody().manifest,
    artifactRevision: null,
    artifactSha256: null,
    artifactKind: null,
    processId: null,
    stdoutLength: 0,
    stderrLength: 0,
    nextLogSequence: 0,
    logs: [],
  };
}
