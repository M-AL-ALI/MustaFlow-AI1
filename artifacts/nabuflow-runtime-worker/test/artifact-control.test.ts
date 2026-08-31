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
import {
  ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX,
  RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX,
  RUNTIME_START_ABORT_CHECKPOINT_PREFIX,
} from "../src/artifact-commit-recovery";
import type { StoredRuntime } from "../src/model";
import {
  MemoryCoordinator,
  MemoryR2Bucket,
  MockBackend,
  TEST_NOW_MS,
  commitArtifactAndDrain,
  drainArtifactCommitQueue,
  mutationAndDrain,
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
  it("exposes only the signed, identity-bound bounded commit event trail", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const sha = "d".repeat(64);
    const claim = await coordinator.registerArtifactCommit({
      key: "diagnostic-commit-key",
      fingerprint: "f".repeat(64),
      kind: "v1",
      runtimeIdentity: identity,
      sealedArtifactSha256: sha,
      expectedDeploymentVersion: "worker-version-test-1",
      nowMs: TEST_NOW_MS,
    });
    expect(claim.state).toBe("new");
    const path = `/_nabuflow/control/v1/runtimes/42/preview/primary/artifacts/${sha}/commit-diagnostics`;

    const unsigned = await handleControlRequest(
      new Request(`https://runtime.example${path}`),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(unsigned.status).toBe(401);

    const missigned = await handleControlRequest(
      await signedRequest({
        path,
        nonce: "artifact-diagnostics-missigned-0001",
        secret: "wrong-control-secret-with-at-least-thirty-two-characters",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(missigned.status).toBe(401);

    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "artifact-diagnostics-signed-0001" }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      ok: true,
      job: {
        kind: "v1",
        runtimeIdentity: identity,
        sealedArtifactSha256: sha,
        state: "active",
        checkpoint: "initialized",
        terminal: null,
        events: [expect.objectContaining({ event: "job-created" })],
      },
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("diagnostic-commit-key");
    expect(serialized).not.toContain(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    );
    expect(serialized).not.toContain("ownerId");

    const foreign = await handleControlRequest(
      await signedRequest({
        path: `/_nabuflow/control/v1/runtimes/43/preview/primary/artifacts/${sha}/commit-diagnostics`,
        nonce: "artifact-diagnostics-foreign-0001",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({
      code: "artifact_commit_not_found",
      retryable: false,
    });
  });

  it("exposes only the signed, identity-bound runtime-start event trail", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const locator = ensureBody().locator;
    const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
    const artifactSha256 = "e".repeat(64);
    const claim = await coordinator.registerDurableOperation({
      key: "runtime-start-diagnostic-key",
      fingerprint: "d".repeat(64),
      kind: "runtime-start",
      runtimeIdentity: identity,
      subjectKey: "start",
      request: {
        locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: "runtime-start-diagnostic",
        artifactSha256,
      },
      expectedDeploymentVersion: "worker-version-test-1",
      nowMs: TEST_NOW_MS,
    });
    expect(claim.state).toBe("new");
    const path = "/_nabuflow/control/v1/runtimes/42/preview/primary/start-diagnostics";
    const unsigned = await handleControlRequest(
      new Request(`https://runtime.example${path}`),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(unsigned.status).toBe(401);
    const missigned = await handleControlRequest(
      await signedRequest({
        path,
        nonce: "runtime-start-diagnostics-missigned",
        secret: "wrong-control-secret-with-at-least-thirty-two-characters",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(missigned.status).toBe(401);
    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "runtime-start-diagnostics-signed" }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      job: {
        kind: "runtime-start",
        runtimeIdentity: identity,
        artifactSha256,
        checkpoint: "initialized",
      },
    });
    expect(JSON.stringify(body)).not.toContain("runtime-start-diagnostic-key");
    expect(JSON.stringify(body)).not.toContain("ownerId");
    const foreign = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/43/preview/primary/start-diagnostics",
        nonce: "runtime-start-diagnostics-foreign",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({ code: "runtime_start_not_found" });
  });

  it("exposes only the signed, identity-bound manifest-restart event trail", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const locator = ensureBody().locator;
    const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
    const claim = await coordinator.registerDurableOperation({
      key: "manifest-restart-diagnostic-key",
      fingerprint: "c".repeat(64),
      kind: "runtime-manifest-restart",
      runtimeIdentity: identity,
      subjectKey: "manifest-restart",
      request: {
        locator,
        expectedDeploymentVersion: "worker-version-test-1",
        expectedManifestRevision: "manifest-1",
        manifest: { ...ensureBody().manifest, revision: "manifest-2" },
        restart: "restart",
        sealedArtifactSha256: "b".repeat(64),
      },
      expectedDeploymentVersion: "worker-version-test-1",
      nowMs: TEST_NOW_MS,
    });
    expect(claim.state).toBe("new");
    const path = "/_nabuflow/control/v1/runtimes/42/preview/primary/manifest-diagnostics";
    expect(
      (
        await handleControlRequest(new Request(`https://runtime.example${path}`), env, {
          coordinator,
          backend,
          nowMs: TEST_NOW_MS,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleControlRequest(
          await signedRequest({
            path,
            nonce: "manifest-diagnostics-missigned",
            secret: "wrong-control-secret-with-at-least-thirty-two-characters",
          }),
          env,
          { coordinator, backend, nowMs: TEST_NOW_MS },
        )
      ).status,
    ).toBe(401);
    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "manifest-diagnostics-signed" }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      job: {
        kind: "runtime-manifest-restart",
        runtimeIdentity: identity,
        expectedManifestRevision: "manifest-1",
        manifestRevision: "manifest-2",
        checkpoint: "initialized",
      },
    });
    expect(JSON.stringify(body)).not.toContain("manifest-restart-diagnostic-key");
    expect(JSON.stringify(body)).not.toContain("ownerId");
    const foreign = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/43/preview/primary/manifest-diagnostics",
        nonce: "manifest-diagnostics-foreign",
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(foreign.status).toBe(404);
    await expect(foreign.json()).resolves.toMatchObject({
      code: "runtime_manifest_update_not_found",
    });
  });

  it("resumes idempotently after the queue driver dies at every durable checkpoint", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    env.NABUFLOW_STAGING_ARTIFACT_COMMIT_RECOVERY_PROBE = "enabled";
    const locator = ensureBody().locator;
    const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const checkpoints = [
      "initialized",
      "verification-complete",
      "payloads-transferred",
      "unpack-complete",
      "finalized",
    ] as const;

    for (const [index, checkpoint] of checkpoints.entries()) {
      const artifact = await makeArtifact({
        identity,
        manifestRevision: "manifest-1",
        artifactRevision: `${ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${index}`,
        bytes: new TextEncoder().encode(`console.log('${checkpoint}')\n`),
      });
      const sha = artifact.envelope.sealedArtifactSha256;
      const artifactBase = `${base}/artifacts/${sha}`;
      const dependencies = { coordinator, backend, nowMs: TEST_NOW_MS };
      expect(
        (
          await handleControlRequest(
            await signedRequest({
              path: `${artifactBase}/begin`,
              method: "POST",
              nonce: `checkpoint-${checkpoint}-begin`,
              idempotencyKey: `checkpoint-${checkpoint}-begin`,
              body: {
                locator,
                expectedDeploymentVersion: "worker-version-test-1",
                envelope: artifact.envelope,
              },
            }),
            env,
            dependencies,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await handleControlRequest(
            await signedRawRequest({
              path: `${artifactBase}/chunks/0`,
              method: "PUT",
              nonce: `checkpoint-${checkpoint}-chunk`,
              idempotencyKey: `checkpoint-${checkpoint}-chunk`,
              body: artifact.chunks[0],
            }),
            env,
            dependencies,
          )
        ).status,
      ).toBe(200);
      const commitBody = {
        locator,
        expectedDeploymentVersion: "worker-version-test-1",
        sealedArtifactSha256: sha,
      };
      const idempotencyKey = `checkpoint-${checkpoint}-commit`;
      const materializationsBeforeRequest = backend.materializations;
      const accepted = await handleControlRequest(
        await signedRequest({
          path: `${artifactBase}/commit`,
          method: "POST",
          nonce: `checkpoint-${checkpoint}-commit-first`,
          idempotencyKey,
          body: commitBody,
        }),
        env,
        dependencies,
      );
      expect(accepted.status).toBe(409);
      expect(backend.materializations).toBe(materializationsBeforeRequest);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: TEST_NOW_MS }),
      ).rejects.toMatchObject({ name: "StagingArtifactCommitOwnerLossError" });

      const adoptedAt = TEST_NOW_MS + 16_000;
      const nudged = await handleControlRequest(
        await signedRequest({
          path: `${artifactBase}/commit`,
          method: "POST",
          nonce: `checkpoint-${checkpoint}-commit-adopt`,
          idempotencyKey,
          body: commitBody,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt },
      );
      expect(nudged.status).toBe(409);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: adoptedAt }),
      ).resolves.toBe(1);
      const replay = await handleControlRequest(
        await signedRequest({
          path: `${artifactBase}/commit`,
          method: "POST",
          nonce: `checkpoint-${checkpoint}-commit-terminal`,
          idempotencyKey,
          body: commitBody,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt },
      );
      expect(replay.status, await replay.clone().text()).toBe(200);
      const job = await coordinator.getLatestArtifactCommit(identity, sha);
      expect(job).toMatchObject({ state: "succeeded", checkpoint: "finalized", attempt: 2 });
      expect(job?.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "driver-adopted" })]),
      );
    }
  });

  it("resumes runtime start through the shared durable job at every checkpoint", async () => {
    const checkpoints = [
      "initialized",
      "artifact-verified",
      "materialized",
      "process-started",
      "finalized",
    ] as const;
    for (const [index, checkpoint] of checkpoints.entries()) {
      const coordinator = new MemoryCoordinator();
      const backend = new MockBackend();
      const env = fakeEnv();
      env.NABUFLOW_STAGING_RUNTIME_LIFECYCLE_RECOVERY_PROBE = "enabled";
      const locator = ensureBody().locator;
      const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
      await coordinator.putRuntime(identity, runtimeFor(identity));
      const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
      const artifact = await makeArtifact({
        identity,
        manifestRevision: "manifest-1",
        artifactRevision: `${RUNTIME_START_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${index}`,
      });
      await deliverArtifact({ coordinator, backend, env, artifact, base });
      const body = {
        locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: artifact.envelope.artifactRevision,
        artifactSha256: artifact.envelope.sealedArtifactSha256,
      };
      const idempotencyKey = `runtime-start-checkpoint-${checkpoint}`;
      const first = await handleControlRequest(
        await signedRequest({
          path: `${base}/start`,
          method: "POST",
          nonce: `${idempotencyKey}-first`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: TEST_NOW_MS },
      );
      expect(first.status).toBe(409);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: TEST_NOW_MS }),
      ).rejects.toMatchObject({ name: "StagingDurableOperationOwnerLossError" });

      const adoptedAt = TEST_NOW_MS + 16_000;
      const nudge = await handleControlRequest(
        await signedRequest({
          path: `${base}/start`,
          method: "POST",
          nonce: `${idempotencyKey}-adopt`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt },
      );
      expect(nudge.status).toBe(409);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: adoptedAt }),
      ).resolves.toBe(1);
      const replay = await handleControlRequest(
        await signedRequest({
          path: `${base}/start`,
          method: "POST",
          nonce: `${idempotencyKey}-terminal`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt + 1 },
      );
      expect(replay.status, await replay.clone().text()).toBe(200);
      const job = await coordinator.getLatestDurableOperation("runtime-start", identity, "start");
      expect(job).toMatchObject({
        state: "succeeded",
        checkpoint: "finalized",
        attempt: 2,
      });
      expect(job?.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "driver-adopted" })]),
      );
    }
  });

  it("resumes an explicit manifest restart through the shared durable job at every checkpoint", async () => {
    const checkpoints = [
      "initialized",
      "runtime-unbound",
      "manifest-persisted",
      "materialized",
      "process-started",
      "finalized",
    ] as const;
    for (const [index, checkpoint] of checkpoints.entries()) {
      const coordinator = new MemoryCoordinator();
      const backend = new MockBackend();
      const env = fakeEnv();
      env.NABUFLOW_STAGING_RUNTIME_LIFECYCLE_RECOVERY_PROBE = "enabled";
      const locator = ensureBody().locator;
      const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
      const runtime = runtimeFor(identity);
      runtime.descriptor.status = "running";
      runtime.processId = "tenant-service";
      await coordinator.putRuntime(identity, runtime);
      await coordinator.bindContainer(`container:${identity}`, identity);
      const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
      const manifest = {
        ...ensureBody().manifest,
        revision: `${RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX}${checkpoint}-${index}`,
        servicePort: 8081,
        healthPath: "/healthz",
      };
      const artifact = await makeArtifact({
        identity,
        manifestRevision: manifest.revision,
        artifactRevision: `manifest-restart-artifact-${checkpoint}`,
      });
      await deliverArtifact({ coordinator, backend, env, artifact, base });
      const body = {
        locator,
        expectedDeploymentVersion: "worker-version-test-1",
        expectedManifestRevision: "manifest-1",
        manifest,
        restart: "restart" as const,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
      };
      const idempotencyKey = `manifest-restart-checkpoint-${checkpoint}`;
      const first = await handleControlRequest(
        await signedRequest({
          path: `${base}/manifest`,
          method: "PUT",
          nonce: `${idempotencyKey}-first`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: TEST_NOW_MS },
      );
      expect(first.status).toBe(409);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: TEST_NOW_MS }),
      ).rejects.toMatchObject({ name: "StagingDurableOperationOwnerLossError" });

      const adoptedAt = TEST_NOW_MS + 16_000;
      const nudge = await handleControlRequest(
        await signedRequest({
          path: `${base}/manifest`,
          method: "PUT",
          nonce: `${idempotencyKey}-adopt`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt },
      );
      expect(nudge.status).toBe(409);
      await expect(
        drainArtifactCommitQueue({ env, coordinator, backend, nowMs: adoptedAt }),
      ).resolves.toBe(1);
      const replay = await handleControlRequest(
        await signedRequest({
          path: `${base}/manifest`,
          method: "PUT",
          nonce: `${idempotencyKey}-terminal`,
          idempotencyKey,
          body,
        }),
        env,
        { coordinator, backend, nowMs: adoptedAt + 1 },
      );
      expect(replay.status, await replay.clone().text()).toBe(200);
      const job = await coordinator.getLatestDurableOperation(
        "runtime-manifest-restart",
        identity,
        "manifest-restart",
      );
      expect(job).toMatchObject({
        state: "succeeded",
        checkpoint: "finalized",
        attempt: 2,
      });
      expect(job?.events).toEqual(
        expect.arrayContaining([expect.objectContaining({ event: "driver-adopted" })]),
      );
    }
  });

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

  it("fails closed when the durable artifact commit queue is missing", async () => {
    const env = fakeEnv();
    delete env.DURABLE_OPERATION_QUEUE;
    delete env.ARTIFACT_COMMIT_QUEUE;
    const response = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/version",
        nonce: "missing-commit-queue-version-0001",
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
    const response = await mutationAndDrain({
      path: `${base}/start`,
      nonce: "uncommitted-start-0001",
      idempotencyKey: "uncommitted-start",
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: "uncommitted-artifact",
        artifactSha256: "a".repeat(64),
      },
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "artifact_not_committed" });
    expect(backend.starts).toBe(0);
    expect(backend.materializations).toBe(0);
  });

  it("replays a terminal start failure without creating a second start operation", async () => {
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
    await coordinator.putRuntime(identity, runtimeFor(identity));
    const artifact = await makeArtifact({ identity, manifestRevision: "manifest-1" });
    await deliverArtifact({ coordinator, backend, env, artifact, base });
    backend.start = async () => {
      backend.starts += 1;
      throw new Error("test-only terminal start failure");
    };
    const startBody = {
      locator: ensureBody().locator,
      expectedDeploymentVersion: "worker-version-test-1",
      artifactRevision: artifact.envelope.artifactRevision,
      artifactSha256: artifact.envelope.sealedArtifactSha256,
    };
    const first = await mutationAndDrain({
      path: `${base}/start`,
      nonce: "terminal-start-first-0001",
      idempotencyKey: "terminal-start-one-operation",
      body: startBody,
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    const replay = await handleControlRequest(
      await signedRequest({
        path: `${base}/start`,
        method: "POST",
        nonce: "terminal-start-replay-001",
        idempotencyKey: "terminal-start-one-operation",
        body: startBody,
      }),
      env,
      { coordinator, backend, nowMs: TEST_NOW_MS + 1 },
    );

    expect(first.status).toBe(502);
    expect(replay.status).toBe(502);
    await expect(first.json()).resolves.toMatchObject({ code: "runtime_start_failed" });
    await expect(replay.json()).resolves.toMatchObject({ code: "runtime_start_failed" });
    expect(backend.starts).toBe(1);
    expect(coordinator.idempotency.get("terminal-start-one-operation")).toMatchObject({
      pending: false,
      response: { status: 502 },
    });
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

    const commit = await commitArtifactAndDrain({
      path: `${artifactBase}/commit`,
      nonce: "artifact-commit-0001",
      idempotencyKey: "artifact-commit",
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
      },
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(commit.status).toBe(200);
    await expect(commit.json()).resolves.toMatchObject({ materialized: true, filesWritten: 1 });

    const startBody = {
      locator: ensureBody().locator,
      expectedDeploymentVersion: "worker-version-test-1",
      artifactRevision: artifact.envelope.artifactRevision,
      artifactSha256: artifact.envelope.sealedArtifactSha256,
    };
    const start = await mutationAndDrain({
      path: `${base}/start`,
      nonce: "artifact-start-000001",
      idempotencyKey: "artifact-start",
      body: startBody,
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
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
        await mutationAndDrain({
          path: `${base}/start`,
          nonce: "artifact-restart-0001",
          idempotencyKey: "artifact-restart",
          body: startBody,
          env,
          coordinator,
          backend,
          nowMs: TEST_NOW_MS,
        })
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
    const response = await commitArtifactAndDrain({
      path: `${artifactBase}/commit`,
      nonce: "incomplete-commit-001",
      idempotencyKey: "incomplete-commit",
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
      },
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
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
    const restarted = await mutationAndDrain({
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
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(restarted.status).toBe(200);
    await expect(restarted.json()).resolves.toMatchObject({
      runtime: { manifestRevision: "manifest-3", servicePort: 8082, status: "running" },
    });
    expect(backend.stops).toBe(0);
    expect(backend.materializations).toBeGreaterThanOrEqual(2);
    expect(backend.materializedRuntimeArtifactSha256s.at(-1)).toBe(
      artifact.envelope.sealedArtifactSha256,
    );
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

    const response = await mutationAndDrain({
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
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ code: "runtime_restart_failed" });
    await expect(coordinator.getRuntime(identity)).resolves.toMatchObject({
      manifest: { revision: failedManifest.revision },
      descriptor: { manifestRevision: failedManifest.revision, status: "error" },
    });
    expect(coordinator.containerBindings).toHaveLength(0);
  });

  it("preserves durable manifest responses when audit persistence rejects", async () => {
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
    const audit = vi
      .spyOn(coordinator, "recordAudit")
      .mockRejectedValue(new Error("test-only audit Durable Object rejection"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const accepted = await handleControlRequest(
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

    expect(accepted.status).toBe(409);
    await expect(accepted.json()).resolves.toMatchObject({ code: "request_in_progress" });
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('"event":"control_audit_write_failed"'),
    );
    audit.mockRestore();
    await drainArtifactCommitQueue({ env, coordinator, backend, nowMs: TEST_NOW_MS });
    const response = await handleControlRequest(
      await signedRequest({
        path: `${base}/manifest`,
        method: "PUT",
        nonce: "manifest-finalization-rejection-replay",
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
      await commitArtifactAndDrain({
        path: `${artifactBase}/commit`,
        nonce: `deliver-commit-${input.artifact.envelope.artifactRevision}`,
        idempotencyKey: `deliver-commit-${input.artifact.envelope.artifactRevision}`,
        body: {
          locator,
          expectedDeploymentVersion: "worker-version-test-1",
          sealedArtifactSha256: input.artifact.envelope.sealedArtifactSha256,
        },
        env: input.env,
        coordinator: input.coordinator,
        backend: input.backend,
        nowMs: TEST_NOW_MS,
      })
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
  const response = await mutationAndDrain({
    path: `${input.base}/start`,
    nonce: `${input.key}-nonce-0001`,
    idempotencyKey: input.key,
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
  expect(response.status).toBe(200);
}
