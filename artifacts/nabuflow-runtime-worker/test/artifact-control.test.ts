import { describe, expect, it, vi } from "vitest";
import {
  MAX_RUNTIME_ARTIFACT_BYTES,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_FORMAT,
  deriveRuntimeIdentity,
  runtimeArtifactContentHash,
  runtimeArtifactContentManifestSchema,
  runtimeArtifactEnvelopeSchema,
  runtimeArtifactSealedHash,
  sha256Hex,
  type RuntimeArtifactEnvelope,
} from "@workspace/tenant-runtime-contracts";
import { handleControlRequest } from "../src/worker";
import type { StoredRuntime } from "../src/model";
import {
  MemoryCoordinator,
  MemoryR2Bucket,
  MockBackend,
  TEST_NOW_MS,
  ensureBody,
  fakeEnv,
  signedRawRequest,
  signedRequest,
} from "./helpers";

async function makeArtifact(input: {
  identity: string;
  manifestRevision: string;
  bytes?: Uint8Array;
  path?: string;
  artifactRevision?: string;
}): Promise<{ envelope: RuntimeArtifactEnvelope; chunks: Uint8Array[] }> {
  const bytes = input.bytes ?? new TextEncoder().encode("console.log('artifact-v1')\n");
  const chunks: Uint8Array[] = [];
  const chunkHashes: string[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += RUNTIME_ARTIFACT_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, offset + RUNTIME_ARTIFACT_CHUNK_BYTES);
    chunks.push(chunk);
    chunkHashes.push(await sha256Hex(chunk));
  }
  const content = runtimeArtifactContentManifestSchema.parse({
    format: RUNTIME_ARTIFACT_FORMAT,
    payloadBytes: bytes.byteLength,
    chunkBytes: RUNTIME_ARTIFACT_CHUNK_BYTES,
    chunks: chunkHashes,
    files: [
      {
        path: input.path ?? "server.mjs",
        mode: 0o644,
        offset: 0,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
      },
    ],
  });
  const contentSha256 = await runtimeArtifactContentHash(content);
  const unsigned = {
    content,
    contentSha256,
    targetRuntimeIdentity: input.identity,
    manifestRevision: input.manifestRevision,
    artifactRevision: input.artifactRevision ?? "artifact-test-1",
    sourceRevision: "source-test-1",
    scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true as const },
  };
  return {
    chunks,
    envelope: runtimeArtifactEnvelopeSchema.parse({
      ...unsigned,
      sealedArtifactSha256: await runtimeArtifactSealedHash(unsigned),
    }),
  };
}

describe("sealed runtime artifact control plane", () => {
  it("fails closed when the private artifact bucket binding is missing", async () => {
    const env = fakeEnv();
    delete (env as Partial<typeof env>).NABUFLOW_RUNTIME_ARTIFACTS;
    const response = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/version",
        nonce: "missing-r2-version-0001",
      }),
      env,
      { coordinator: new MemoryCoordinator(), backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "artifact_infrastructure_unavailable",
      retryable: false,
    });
  });

  it("refuses to start when the requested artifact was never committed", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    await handleControlRequest(
      await signedRequest({
        path: base,
        method: "PUT",
        nonce: "uncommitted-ensure-0001",
        idempotencyKey: "uncommitted-ensure",
        body: ensureBody(),
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    const response = await handleControlRequest(
      await signedRequest({
        path: `${base}/start`,
        method: "POST",
        nonce: "uncommitted-start-0001",
        idempotencyKey: "uncommitted-start",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          artifactRevision: "uncommitted-artifact",
          artifactSha256: "a".repeat(64),
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "artifact_not_committed" });
    expect(backend.starts).toBe(0);
    expect(backend.materializations).toBe(0);
  });

  it("delivers, commits, starts, and rehydrates a target-bound artifact", async () => {
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
    const ensure = await handleControlRequest(
      await signedRequest({
        path: base,
        method: "PUT",
        nonce: "artifact-ensure-0001",
        idempotencyKey: "artifact-ensure",
        body: ensureBody(),
      }),
      env,
      dependencies,
    );
    expect(ensure.status).toBe(200);

    const artifact = await makeArtifact({ identity, manifestRevision: "manifest-1" });
    const artifactBase = `${base}/artifacts/${artifact.envelope.sealedArtifactSha256}`;
    const begin = await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/begin`,
        method: "POST",
        nonce: "artifact-begin-00001",
        idempotencyKey: "artifact-begin",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          envelope: artifact.envelope,
        },
      }),
      env,
      dependencies,
    );
    expect(begin.status).toBe(200);

    const chunk = await handleControlRequest(
      await signedRawRequest({
        path: `${artifactBase}/chunks/0`,
        method: "PUT",
        nonce: "artifact-chunk-00001",
        idempotencyKey: "artifact-chunk-0",
        body: artifact.chunks[0],
      }),
      env,
      dependencies,
    );
    expect(chunk.status, await chunk.clone().text()).toBe(200);

    const commit = await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/commit`,
        method: "POST",
        nonce: "artifact-commit-0001",
        idempotencyKey: "artifact-commit",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        },
      }),
      env,
      dependencies,
    );
    expect(commit.status).toBe(200);
    await expect(commit.json()).resolves.toMatchObject({ materialized: true, filesWritten: 1 });

    const startBody = {
      locator: ensureBody().locator,
      expectedDeploymentVersion: "worker-version-test-1",
      artifactRevision: artifact.envelope.artifactRevision,
      artifactSha256: artifact.envelope.sealedArtifactSha256,
    };
    const start = await handleControlRequest(
      await signedRequest({
        path: `${base}/start`,
        method: "POST",
        nonce: "artifact-start-000001",
        idempotencyKey: "artifact-start",
        body: startBody,
      }),
      env,
      dependencies,
    );
    expect(start.status).toBe(200);
    expect(backend.materializations).toBe(2);

    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path: `${base}/stop`,
            method: "POST",
            nonce: "artifact-stop-0000001",
            idempotencyKey: "artifact-stop",
            body: { locator: ensureBody().locator },
          }),
          env,
          dependencies,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path: `${base}/start`,
            method: "POST",
            nonce: "artifact-restart-0001",
            idempotencyKey: "artifact-restart",
            body: startBody,
          }),
          env,
          dependencies,
        )
      ).status,
    ).toBe(200);
    expect(backend.materializations).toBe(3);
  });

  it("rejects an incomplete upload and cleans its pending state and chunks", async () => {
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
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const artifact = await makeArtifact({
      identity,
      manifestRevision: "manifest-1",
      bytes: new Uint8Array(RUNTIME_ARTIFACT_CHUNK_BYTES + 1).fill(7),
    });
    const artifactBase = `${base}/artifacts/${artifact.envelope.sealedArtifactSha256}`;
    await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/begin`,
        method: "POST",
        nonce: "incomplete-begin-0001",
        idempotencyKey: "incomplete-begin",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          envelope: artifact.envelope,
        },
      }),
      env,
      dependencies,
    );
    await handleControlRequest(
      await signedRawRequest({
        path: `${artifactBase}/chunks/0`,
        method: "PUT",
        nonce: "incomplete-chunk-0001",
        idempotencyKey: "incomplete-chunk",
        body: artifact.chunks[0],
      }),
      env,
      dependencies,
    );
    const response = await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/commit`,
        method: "POST",
        nonce: "incomplete-commit-001",
        idempotencyKey: "incomplete-commit",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        },
      }),
      env,
      dependencies,
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "artifact_incomplete" });
    expect(
      await coordinator.getArtifact(identity, artifact.envelope.sealedArtifactSha256),
    ).toBeNull();
    expect((env.NABUFLOW_RUNTIME_ARTIFACTS as unknown as MemoryR2Bucket).objects).toHaveLength(0);
  });

  it("rejects integrity failures, receiver-side traversal, and cross-runtime delivery", async () => {
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
    const artifact = await makeArtifact({ identity, manifestRevision: "manifest-1" });
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const artifactBase = `${base}/artifacts/${artifact.envelope.sealedArtifactSha256}`;
    const dependencies = { coordinator, backend, nowMs: TEST_NOW_MS };
    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path: `${artifactBase}/begin`,
            method: "POST",
            nonce: "integrity-begin-00001",
            idempotencyKey: "integrity-begin",
            body: {
              locator: ensureBody().locator,
              expectedDeploymentVersion: "worker-version-test-1",
              envelope: artifact.envelope,
            },
          }),
          env,
          dependencies,
        )
      ).status,
    ).toBe(200);
    const altered = artifact.chunks[0].slice();
    altered[0] ^= 0xff;
    const badChunk = await handleControlRequest(
      await signedRawRequest({
        path: `${artifactBase}/chunks/0`,
        method: "PUT",
        nonce: "integrity-chunk-00001",
        idempotencyKey: "integrity-chunk",
        body: altered,
      }),
      env,
      dependencies,
    );
    expect(badChunk.status, await badChunk.clone().text()).toBe(422);
    await expect(badChunk.json()).resolves.toMatchObject({ code: "artifact_integrity_mismatch" });

    const traversalEnvelope = structuredClone(artifact.envelope) as unknown as Record<
      string,
      unknown
    >;
    const traversalContent = traversalEnvelope.content as { files: Array<{ path: string }> };
    traversalContent.files[0].path = "../escape.mjs";
    const traversal = await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/begin`,
        method: "POST",
        nonce: "traversal-begin-0001",
        idempotencyKey: "traversal-begin",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          envelope: traversalEnvelope,
        },
      }),
      env,
      dependencies,
    );
    expect(traversal.status).toBe(400);
    await expect(traversal.json()).resolves.toMatchObject({ code: "invalid_request" });

    const oversizedEnvelope = structuredClone(artifact.envelope) as unknown as Record<
      string,
      unknown
    >;
    const oversizedContent = oversizedEnvelope.content as {
      payloadBytes: number;
      files: Array<{ size: number }>;
    };
    oversizedContent.payloadBytes = MAX_RUNTIME_ARTIFACT_BYTES + 1;
    oversizedContent.files[0].size = MAX_RUNTIME_ARTIFACT_BYTES + 1;
    const oversized = await handleControlRequest(
      await signedRequest({
        path: `${artifactBase}/begin`,
        method: "POST",
        nonce: "oversized-begin-0001",
        idempotencyKey: "oversized-begin",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          envelope: oversizedEnvelope,
        },
      }),
      env,
      dependencies,
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ code: "artifact_too_large" });

    for (const projectId of [43, 44]) {
      const foreignIdentity = await deriveRuntimeIdentity({
        namespace: "staging",
        projectId,
        role: "preview",
        slot: "primary",
      });
      if (projectId === 43)
        await coordinator.putRuntime(foreignIdentity, runtimeFor(foreignIdentity, projectId));
      const foreignBase = `/_nabuflow/control/v1/runtimes/${projectId}/preview/primary`;
      const response = await handleControlRequest(
        await signedRequest({
          path: `${foreignBase}/artifacts/${artifact.envelope.sealedArtifactSha256}/begin`,
          method: "POST",
          nonce: `foreign-begin-${projectId}-0001`,
          idempotencyKey: `foreign-begin-${projectId}`,
          body: {
            locator: { projectId, role: "preview", slot: "primary" },
            expectedDeploymentVersion: "worker-version-test-1",
            envelope: artifact.envelope,
          },
        }),
        env,
        dependencies,
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({ code: "artifact_runtime_mismatch" });
    }
  });

  it("CAS-updates a stopped manifest and explicitly restarts a running runtime", async () => {
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
    const nextManifest = {
      ...ensureBody().manifest,
      revision: "manifest-2",
      runtime: "node-api",
      startCommand: ["node", "server.mjs"],
      servicePort: 8081,
      healthPath: "/healthz",
    };
    const updated = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-update-00001",
        idempotencyKey: "manifest-update",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          expectedManifestRevision: "manifest-1",
          manifest: nextManifest,
          restart: "reject-if-running",
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({
      runtime: { manifestRevision: "manifest-2", servicePort: 8081, status: "stopped" },
    });

    const artifact = await makeArtifact({
      identity,
      manifestRevision: "manifest-2",
      artifactRevision: "artifact-manifest-2",
    });
    await deliverArtifact({ coordinator, backend, env, artifact, base });
    await startArtifact({ coordinator, backend, env, artifact, base, key: "manifest-start" });

    const rejected = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-busy-0000001",
        idempotencyKey: "manifest-busy",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          expectedManifestRevision: "manifest-2",
          manifest: { ...nextManifest, revision: "manifest-3", servicePort: 8082 },
          restart: "reject-if-running",
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(rejected.status).toBe(409);

    const restartArtifact = await makeArtifact({
      identity,
      manifestRevision: "manifest-3",
      artifactRevision: "artifact-manifest-3",
    });
    await deliverArtifact({ coordinator, backend, env, artifact: restartArtifact, base });
    const restarted = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-restart-0001",
        idempotencyKey: "manifest-restart",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          expectedManifestRevision: "manifest-2",
          manifest: { ...nextManifest, revision: "manifest-3", servicePort: 8082 },
          restart: "restart",
          sealedArtifactSha256: restartArtifact.envelope.sealedArtifactSha256,
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      runtime: { manifestRevision: "manifest-3", servicePort: 8082, status: "running" },
    });
    expect(backend.stops).toBe(0);
    expect(backend.materializations).toBeGreaterThanOrEqual(2);
  });

  it("persists the new manifest in error state when an explicit restart fails", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const runtime = runtimeFor(identity);
    runtime.descriptor.status = "running";
    runtime.processId = "tenant-service";
    await coordinator.putRuntime(identity, runtime);
    await coordinator.bindContainer(`container:${identity}`, identity);
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const failedManifest = {
      ...ensureBody().manifest,
      revision: "manifest-failed-restart",
      servicePort: 8081,
      healthPath: "/missing-health",
    };
    const artifact = await makeArtifact({
      identity,
      manifestRevision: failedManifest.revision,
      artifactRevision: "artifact-failed-restart",
    });
    await deliverArtifact({ coordinator, backend, env, artifact, base });
    backend.materialize = async () => {
      throw new Error("test-only materialization failure");
    };

    const response = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-failed-restart-0001",
        idempotencyKey: "manifest-failed-restart",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          expectedManifestRevision: "manifest-1",
          manifest: failedManifest,
          restart: "restart",
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "runtime_restart_failed" });
    await expect(coordinator.getRuntime(identity)).resolves.toMatchObject({
      manifest: { revision: failedManifest.revision },
      descriptor: { manifestRevision: failedManifest.revision, status: "error" },
    });
    expect(coordinator.containerBindings).toHaveLength(0);
  });

  it("preserves a typed restart failure when Durable Object error finalization rejects", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const runtime = runtimeFor(identity);
    runtime.descriptor.status = "running";
    runtime.processId = "tenant-service";
    await coordinator.putRuntime(identity, runtime);
    await coordinator.bindContainer(`container:${identity}`, identity);
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const failedManifest = {
      ...ensureBody().manifest,
      revision: "manifest-finalization-rejection",
      servicePort: 8081,
      healthPath: "/missing-health",
    };
    const artifact = await makeArtifact({
      identity,
      manifestRevision: failedManifest.revision,
      artifactRevision: "artifact-finalization-rejection",
    });
    await deliverArtifact({ coordinator, backend, env, artifact, base });
    backend.materialize = async () => {
      throw new Error("test-only materialization failure");
    };
    vi.spyOn(coordinator, "abandonIdempotency").mockRejectedValue(
      new Error("test-only idempotency Durable Object rejection"),
    );
    vi.spyOn(coordinator, "recordAudit").mockRejectedValue(
      new Error("test-only audit Durable Object rejection"),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-finalization-rejection-0001",
        idempotencyKey: "manifest-finalization-rejection",
        body: {
          locator: ensureBody().locator,
          expectedDeploymentVersion: "worker-version-test-1",
          expectedManifestRevision: "manifest-1",
          manifest: failedManifest,
          restart: "restart",
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        },
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "runtime_restart_failed",
      message: "Runtime failed after manifest update",
      retryable: true,
    });
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(consoleError.mock.calls.map(([message]) => String(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('"operation":"idempotency"'),
        expect.stringContaining('"operation":"audit"'),
      ]),
    );
    consoleError.mockRestore();
  });
});

function runtimeFor(identity: string, projectId = 42): StoredRuntime {
  return {
    descriptor: {
      identity,
      projectId,
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
    processId: null,
    stdoutLength: 0,
    stderrLength: 0,
    nextLogSequence: 0,
    logs: [],
  };
}

async function deliverArtifact(input: {
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  artifact: Awaited<ReturnType<typeof makeArtifact>>;
  base: string;
}) {
  const locator = ensureBody().locator;
  const artifactBase = `${input.base}/artifacts/${input.artifact.envelope.sealedArtifactSha256}`;
  expect(
    (
      await handleControlRequest(
        await signedRequest({
          path: `${artifactBase}/begin`,
          method: "POST",
          nonce: `deliver-begin-${input.artifact.envelope.artifactRevision}`,
          idempotencyKey: `deliver-begin-${input.artifact.envelope.artifactRevision}`,
          body: {
            locator,
            expectedDeploymentVersion: "worker-version-test-1",
            envelope: input.artifact.envelope,
          },
        }),
        input.env,
        { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
      )
    ).status,
  ).toBe(200);
  for (let index = 0; index < input.artifact.chunks.length; index += 1) {
    expect(
      (
        await handleControlRequest(
          await signedRawRequest({
            path: `${artifactBase}/chunks/${index}`,
            method: "PUT",
            nonce: `deliver-chunk-${input.artifact.envelope.artifactRevision}-${index}`,
            idempotencyKey: `deliver-chunk-${input.artifact.envelope.artifactRevision}-${index}`,
            body: input.artifact.chunks[index],
          }),
          input.env,
          { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
        )
      ).status,
    ).toBe(200);
  }
  expect(
    (
      await handleControlRequest(
        await signedRequest({
          path: `${artifactBase}/commit`,
          method: "POST",
          nonce: `deliver-commit-${input.artifact.envelope.artifactRevision}`,
          idempotencyKey: `deliver-commit-${input.artifact.envelope.artifactRevision}`,
          body: {
            locator,
            expectedDeploymentVersion: "worker-version-test-1",
            sealedArtifactSha256: input.artifact.envelope.sealedArtifactSha256,
          },
        }),
        input.env,
        { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
      )
    ).status,
  ).toBe(200);
}

async function startArtifact(input: {
  coordinator: MemoryCoordinator;
  backend: MockBackend;
  env: ReturnType<typeof fakeEnv>;
  artifact: Awaited<ReturnType<typeof makeArtifact>>;
  base: string;
  key: string;
}) {
  const response = await handleControlRequest(
    await signedRequest({
      path: `${input.base}/start`,
      method: "POST",
      nonce: `${input.key}-nonce-0001`,
      idempotencyKey: input.key,
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: input.artifact.envelope.artifactRevision,
        artifactSha256: input.artifact.envelope.sealedArtifactSha256,
      },
    }),
    input.env,
    { coordinator: input.coordinator, backend: input.backend, nowMs: TEST_NOW_MS },
  );
  expect(response.status).toBe(200);
}
