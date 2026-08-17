import { describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeIdentity,
  sha256Hex,
  signControlRequest,
} from "@workspace/tenant-runtime-contracts";
import type { StoredRuntime, StoredRuntimeArtifact } from "../src/model";
import { handleControlRequest, handleWorkerRequest } from "../src/worker";
import {
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  TEST_SECRET,
  ensureBody,
  fakeEnv,
  mutationAndDrain,
  signedRequest,
} from "./helpers";

const FIXED_VECTOR = {
  body: '{"projectId":42}',
  fields: {
    method: "POST",
    pathAndQuery: "/_nabuflow/control/v1/runtimes/42/preview/primary/start?wait=true",
    timestamp: "1785859200000",
    nonce: "01JXYZABCDEF0123456789ABCD",
    bodySha256: "63e3cf682f2319d705ec920c8d78d555ec5b465d8ef83be0e6e0e476cba562a2",
    idempotencyKey: "runtime-start-42-0001",
  },
  signature: "83afa15033d2649dc94448bacc80ea19dd336304d76a52d7621e01be3118d3e9",
} as const;

describe("authenticated staging control plane", () => {
  it("discovers recent durable jobs through signed bounded metadata only", async () => {
    const coordinator = new MemoryCoordinator();
    const runtimeIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const subjectKey = "a".repeat(64);
    await coordinator.registerDurableOperation({
      key: "discovery-commit-1",
      fingerprint: "fingerprint-discovery-1",
      kind: "layers-v1",
      runtimeIdentity,
      subjectKey,
      sealedArtifactSha256: subjectKey,
      expectedDeploymentVersion: "worker-version-test-1",
      nowMs: TEST_NOW_MS - 5_000,
    });
    const since = new Date(TEST_NOW_MS - 60_000).toISOString();
    const path = `/_nabuflow/control/v1/durable-operations?since=${encodeURIComponent(since)}&limit=10&kind=layers-v1`;
    const response = await handleControlRequest(
      await signedRequest({ path, nonce: "nonce-durable-discovery-0001" }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { jobs: Array<Record<string, unknown>> };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]).toMatchObject({
      kind: "layers-v1",
      runtimeIdentity,
      subjectKey,
      state: "active",
      checkpoint: "initialized",
      attempt: 0,
    });
    expect(body.jobs[0]).not.toHaveProperty("fingerprint");
    expect(body.jobs[0]).not.toHaveProperty("ownerId");
    expect(body.jobs[0]).not.toHaveProperty("response");

    const unsigned = await handleControlRequest(
      new Request(`https://runtime.example${path}`),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(unsigned.status).toBe(401);

    const tooOld = new Date(TEST_NOW_MS - 24 * 60 * 60_000 - 1).toISOString();
    const invalid = await handleControlRequest(
      await signedRequest({
        path: `/_nabuflow/control/v1/durable-operations?since=${encodeURIComponent(tooOld)}`,
        nonce: "nonce-durable-discovery-old-1",
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: "invalid_discovery_window" });
  });

  it("is byte-compatible with the slice 2b-i fixed HMAC vector", async () => {
    expect(await sha256Hex(FIXED_VECTOR.body)).toBe(FIXED_VECTOR.fields.bodySha256);
    expect(await signControlRequest(TEST_SECRET, FIXED_VECTOR.fields)).toBe(FIXED_VECTOR.signature);
  });

  it("accepts signed requests and rejects unsigned, tampered, replayed, and expired requests", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const dependencies = { coordinator, backend, nowMs: TEST_NOW_MS, requestId: "request-test" };

    const unsigned = await handleControlRequest(
      new Request("https://runtime.example/_nabuflow/control/v1/version"),
      fakeEnv(),
      dependencies,
    );
    expect(unsigned.status).toBe(401);

    const valid = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-valid-version-0001",
    });
    const validClone = valid.clone() as Request;
    const accepted = await handleControlRequest(valid, fakeEnv(), dependencies);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      protocolVersion: "1",
      deploymentVersion: "worker-version-test-1",
      provider: "cloudflare",
    });

    const replayed = await handleControlRequest(validClone, fakeEnv(), dependencies);
    expect(replayed.status).toBe(409);
    await expect(replayed.json()).resolves.toMatchObject({ code: "replay_detected" });

    const tampered = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-tampered-signature-1",
    });
    tampered.headers.set("x-nabuflow-signature", "0".repeat(64));
    const tamperedResponse = await handleControlRequest(tampered, fakeEnv(), dependencies);
    expect(tamperedResponse.status).toBe(401);
    await expect(tamperedResponse.json()).resolves.toMatchObject({ code: "invalid_signature" });

    const expired = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-expired-version-001",
      timestamp: TEST_NOW_MS - 60_001,
    });
    const expiredResponse = await handleControlRequest(expired, fakeEnv(), dependencies);
    expect(expiredResponse.status).toBe(401);
    await expect(expiredResponse.json()).resolves.toMatchObject({ code: "expired_signature" });
  });

  it("gives the control prefix precedence on the staging workers.dev host", async () => {
    const request = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-workers-dev-control-0001",
    });
    const workersDevRequest = new Request(
      `https://nabuflow-runtime-staging.mustafa-alali74.workers.dev${new URL(request.url).pathname}`,
      request,
    );
    const response = await handleWorkerRequest(workersDevRequest, fakeEnv(), {
      coordinator: new MemoryCoordinator(),
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ provider: "cloudflare" });
  });

  it.each([
    ["tampered", "0".repeat(64)],
    ["truncated", "0".repeat(62)],
    ["wrong-length", "0".repeat(66)],
    ["non-hex/non-base64", "~".repeat(64)],
    ["oversized", "a".repeat(16 * 1024)],
  ])("rejects a %s signature with a clean 401", async (_name, signature) => {
    const coordinator = new MemoryCoordinator();
    const request = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: `nonce-malformed-${_name}-0001`,
    });
    request.headers.set("x-nabuflow-signature", signature);

    const response = await handleControlRequest(request, fakeEnv(), {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_signature" });
    expect(coordinator.nonces).toHaveLength(0);
  });

  it("rejects a missing signature header with a clean 401", async () => {
    const coordinator = new MemoryCoordinator();
    const request = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-missing-signature-0001",
    });
    request.headers.delete("x-nabuflow-signature");

    const response = await handleControlRequest(request, fakeEnv(), {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "unauthorized" });
    expect(coordinator.nonces).toHaveLength(0);
  });

  it("contains unexpected errors at the Worker boundary and audits the failing stage", async () => {
    const coordinator = new MemoryCoordinator();
    coordinator.consumeOnce = async () => {
      throw new Error("simulated coordinator failure");
    };
    const request = await signedRequest({
      path: "/_nabuflow/control/v1/version",
      nonce: "nonce-worker-boundary-0001",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await handleWorkerRequest(request, fakeEnv(), {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
      requestId: "request-boundary-test",
    });

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    await expect(response.json()).resolves.toMatchObject({
      code: "unexpected_worker_error",
      retryable: true,
      requestId: "request-boundary-test",
    });
    expect(coordinator.audits).toContainEqual(
      expect.objectContaining({
        requestId: "request-boundary-test",
        stage: "authentication",
        outcome: "unexpected_worker_error",
        status: 503,
      }),
    );
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('"stage":"authentication"'));
    consoleError.mockRestore();
  });

  it("strictly rejects unknown fields without caching a server error", async () => {
    const coordinator = new MemoryCoordinator();
    const response = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/42/preview/primary",
        method: "PUT",
        nonce: "nonce-unknown-field-0001",
        idempotencyKey: "ensure-unknown-field-1",
        body: { ...ensureBody(), unexpected: true },
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("enforces the request cap before authentication and strictly validates query values", async () => {
    const oversized = await handleControlRequest(
      new Request("https://runtime.example/_nabuflow/control/v1/version", {
        method: "POST",
        body: "x".repeat(256 * 1024 + 1),
      }),
      fakeEnv(),
      { coordinator: new MemoryCoordinator(), backend: new MockBackend() },
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ code: "request_too_large" });

    const invalidFollow = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/42/preview/primary/logs?follow=maybe",
        nonce: "nonce-invalid-follow-0001",
      }),
      fakeEnv(),
      { coordinator: new MemoryCoordinator(), backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(invalidFollow.status).toBe(400);
    await expect(invalidFollow.json()).resolves.toMatchObject({ code: "invalid_request" });
  });

  it("replays a completed mutation response for a new nonce with the same idempotency key", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const path = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const first = await handleControlRequest(
      await signedRequest({
        path,
        method: "PUT",
        nonce: "nonce-idempotency-first-1",
        idempotencyKey: "ensure-runtime-42-1",
        body: ensureBody(),
      }),
      fakeEnv(),
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    const second = await handleControlRequest(
      await signedRequest({
        path,
        method: "PUT",
        nonce: "nonce-idempotency-second",
        idempotencyKey: "ensure-runtime-42-1",
        body: ensureBody(),
      }),
      fakeEnv(),
      { coordinator, backend, nowMs: TEST_NOW_MS },
    );
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual(firstBody);
    expect(coordinator.runtimes).toHaveLength(1);
  });

  it("rejects idempotency-key reuse for a different request and never audits request bodies", async () => {
    const coordinator = new MemoryCoordinator();
    const path = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    const original = ensureBody();
    original.manifest.startCommand = ["node", "server.mjs", "secret-body-marker"];
    const first = await handleControlRequest(
      await signedRequest({
        path,
        method: "PUT",
        nonce: "nonce-idempotency-audit-first",
        idempotencyKey: "ensure-audit-conflict",
        body: original,
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(first.status).toBe(200);

    const changed = ensureBody();
    changed.manifest.revision = "manifest-2";
    const conflict = await handleControlRequest(
      await signedRequest({
        path,
        method: "PUT",
        nonce: "nonce-idempotency-audit-second",
        idempotencyKey: "ensure-audit-conflict",
        body: changed,
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "idempotency_conflict" });
    expect(JSON.stringify(coordinator.audits)).not.toContain("secret-body-marker");
    expect(coordinator.audits.every((record) => !("body" in record))).toBe(true);
  });

  it("returns worker_version_not_ready before creating a runtime", async () => {
    const coordinator = new MemoryCoordinator();
    const body = ensureBody();
    body.expectedDeploymentVersion = "version-not-propagated";
    const response = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/42/preview/primary",
        method: "PUT",
        nonce: "nonce-version-gate-0001",
        idempotencyKey: "ensure-version-gate-1",
        body,
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "worker_version_not_ready" });
    expect(coordinator.runtimes).toHaveLength(0);
  });

  it("authenticates, CAS-activates, replay-protects, and removes a published route", async () => {
    const coordinator = new MemoryCoordinator();
    const env = {
      ...fakeEnv(),
      CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production",
    };
    const projectId = 51;
    const blueManifestRevision = "prod-e7e60acd1aab9f576472f7d28ffc058f186117c80ec77ab5";
    const identity = await deriveRuntimeIdentity({
      namespace: "production",
      projectId,
      role: "production",
      slot: "blue",
    });
    const runtime: StoredRuntime = {
      descriptor: {
        identity,
        projectId,
        role: "production",
        slot: "blue",
        status: "running",
        servicePort: 8080,
        manifestRevision: blueManifestRevision,
        deploymentVersion: "worker-version-test-1",
        endpoint: null,
        readyAt: new Date(TEST_NOW_MS).toISOString(),
        lastError: null,
      },
      manifest: {
        revision: blueManifestRevision,
        runtime: "node-api",
        buildCommand: ["npm", "run", "build"],
        startCommand: ["node", "src/index.js"],
        servicePort: 8080,
        healthPath: "/healthz",
        resourceProfile: "production",
        public: true,
      },
      artifactRevision: "published-artifact-1",
      artifactSha256: "a".repeat(64),
      processId: "published-service",
      stdoutLength: 0,
      stderrLength: 0,
      nextLogSequence: 0,
      logs: [],
    };
    await coordinator.putRuntime(identity, runtime);
    const hostname = "platform-canary.apps.mustaflow.com";
    const path = `/_nabuflow/control/v1/routes/${hostname}/activate`;
    const body = {
      route: {
        hostname,
        projectId,
        role: "production" as const,
        activeSlot: "blue" as const,
        manifestRevision: blueManifestRevision,
        servicePort: 8080,
        sandboxIdentity: identity,
      },
      expectedPreviousManifestRevision: null,
    };
    const backend = new MockBackend();
    const dependencies = {
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    };

    const greenIdentity = await deriveRuntimeIdentity({
      namespace: "production",
      projectId,
      role: "production",
      slot: "green",
    });
    const missingGreenRuntime = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        nonce: "nonce-route-green-0000001",
        idempotencyKey: "route-activate-green",
        body: {
          ...body,
          route: { ...body.route, activeSlot: "green", sandboxIdentity: greenIdentity },
        },
      }),
      env,
      dependencies,
    );
    expect(missingGreenRuntime.status).toBe(409);
    await expect(missingGreenRuntime.json()).resolves.toMatchObject({
      code: "published_runtime_not_ready",
    });
    expect(await coordinator.getRoute(hostname)).toBeNull();

    const unsigned = await handleControlRequest(
      new Request(`https://runtime.example${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      env,
      dependencies,
    );
    expect(unsigned.status).toBe(401);

    const tampered = await signedRequest({
      path,
      method: "POST",
      nonce: "nonce-route-tampered-0001",
      idempotencyKey: "route-activate-tampered",
      body,
    });
    tampered.headers.set("x-nabuflow-signature", "0".repeat(64));
    expect((await handleControlRequest(tampered, env, dependencies)).status).toBe(401);

    const expired = await signedRequest({
      path,
      method: "POST",
      nonce: "nonce-route-expired-00001",
      idempotencyKey: "route-activate-expired",
      timestamp: TEST_NOW_MS - 60_001,
      body,
    });
    expect((await handleControlRequest(expired, env, dependencies)).status).toBe(401);

    const valid = await signedRequest({
      path,
      method: "POST",
      nonce: "nonce-route-valid-000001",
      idempotencyKey: "route-activate-valid",
      body,
    });
    const replay = valid.clone() as Request;
    const activated = await handleControlRequest(valid, env, dependencies);
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({ ok: true, route: { hostname } });
    expect((await coordinator.getRoute(hostname))?.sandboxIdentity).toBe(identity);
    const replayed = await handleControlRequest(replay, env, dependencies);
    expect(replayed.status).toBe(409);
    await expect(replayed.json()).resolves.toMatchObject({ code: "replay_detected" });

    const greenManifestRevision = "published-manifest-green-2";
    await coordinator.putRuntime(greenIdentity, {
      ...runtime,
      descriptor: {
        ...runtime.descriptor,
        identity: greenIdentity,
        slot: "green",
        manifestRevision: greenManifestRevision,
      },
      manifest: { ...runtime.manifest, revision: greenManifestRevision },
      artifactRevision: "published-artifact-green-2",
      artifactSha256: "b".repeat(64),
    });
    const greenBody = {
      route: {
        ...body.route,
        activeSlot: "green" as const,
        manifestRevision: greenManifestRevision,
        sandboxIdentity: greenIdentity,
      },
      expectedPreviousManifestRevision: blueManifestRevision,
    };
    backend.availabilityResult = {
      ready: false,
      stage: "health",
      cause: "health_transport",
      status: null,
    };
    const staleGreen = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        nonce: "nonce-route-green-stale-01",
        idempotencyKey: "route-activate-green-stale",
        body: greenBody,
      }),
      env,
      dependencies,
    );
    expect(staleGreen.status).toBe(409);
    await expect(staleGreen.json()).resolves.toMatchObject({
      code: "published_runtime_not_ready",
    });
    await expect(coordinator.getRoute(hostname)).resolves.toMatchObject({
      activeSlot: "blue",
      sandboxIdentity: identity,
    });
    await expect(coordinator.getRuntime(greenIdentity)).resolves.toMatchObject({
      logs: expect.arrayContaining([
        expect.objectContaining({
          message:
            "Published route activation rejected runtime availability (stage=health, cause=health_transport).",
        }),
      ]),
    });
    const greenRecovery = await coordinator.getLatestDurableOperation(
      "runtime-start",
      greenIdentity,
      "start",
    );
    expect(greenRecovery).toMatchObject({
      kind: "runtime-start",
      runtimeIdentity: greenIdentity,
      state: "active",
      request: {
        artifactRevision: "published-artifact-green-2",
        artifactSha256: "b".repeat(64),
      },
    });
    expect(
      (env.DURABLE_OPERATION_QUEUE as unknown as { messages: unknown[] }).messages,
    ).toHaveLength(1);

    backend.availabilityResult = {
      ready: true,
      stage: "health",
      cause: "ready",
      status: 200,
    };
    const greenActivated = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        nonce: "nonce-route-green-valid-01",
        idempotencyKey: "route-activate-green-valid",
        body: greenBody,
      }),
      env,
      dependencies,
    );
    expect(greenActivated.status).toBe(200);
    await expect(greenActivated.json()).resolves.toMatchObject({
      route: { activeSlot: "green", sandboxIdentity: greenIdentity },
    });
    await expect(coordinator.getRoute(hostname)).resolves.toMatchObject({
      activeSlot: "green",
      sandboxIdentity: greenIdentity,
    });
    backend.availabilityResult = {
      ready: false,
      stage: "process",
      cause: "process_not_running",
      status: null,
    };
    const staleBlue = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        nonce: "nonce-route-blue-stale-001",
        idempotencyKey: "route-reactivate-blue-stale",
        body: {
          ...body,
          expectedPreviousManifestRevision: greenManifestRevision,
        },
      }),
      env,
      dependencies,
    );
    expect(staleBlue.status).toBe(409);
    await expect(staleBlue.json()).resolves.toMatchObject({
      code: "published_runtime_not_ready",
    });
    await expect(coordinator.getRoute(hostname)).resolves.toMatchObject({
      activeSlot: "green",
      sandboxIdentity: greenIdentity,
    });
    const blueRecovery = await coordinator.getLatestDurableOperation(
      "runtime-start",
      identity,
      "start",
    );
    expect(blueRecovery).toMatchObject({
      kind: "runtime-start",
      runtimeIdentity: identity,
      state: "active",
      request: {
        artifactRevision: "published-artifact-1",
        artifactSha256: "a".repeat(64),
      },
    });
    expect(
      (env.DURABLE_OPERATION_QUEUE as unknown as { messages: unknown[] }).messages,
    ).toHaveLength(2);

    backend.availabilityResult = {
      ready: true,
      stage: "health",
      cause: "ready",
      status: 200,
    };

    const blueReactivated = await handleControlRequest(
      await signedRequest({
        path,
        method: "POST",
        nonce: "nonce-route-blue-valid-001",
        idempotencyKey: "route-reactivate-blue-valid",
        body: {
          ...body,
          expectedPreviousManifestRevision: greenManifestRevision,
        },
      }),
      env,
      dependencies,
    );
    expect(blueReactivated.status).toBe(200);
    await expect(blueReactivated.json()).resolves.toMatchObject({
      route: { activeSlot: "blue", sandboxIdentity: identity },
    });
    await expect(coordinator.getRoute(hostname)).resolves.toMatchObject({
      activeSlot: "blue",
      sandboxIdentity: identity,
    });
    expect(backend.availabilityChecks).toEqual([
      identity,
      greenIdentity,
      greenIdentity,
      identity,
      identity,
    ]);

    const deletePath = `/_nabuflow/control/v1/routes/${hostname}`;
    const deleted = await handleControlRequest(
      await signedRequest({
        path: deletePath,
        method: "DELETE",
        nonce: "nonce-route-delete-00001",
        idempotencyKey: "route-delete-valid",
        body: {
          hostname,
          expectedManifestRevision: blueManifestRevision,
          expectedSandboxIdentity: identity,
        },
      }),
      env,
      dependencies,
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true, hostname });
    expect(await coordinator.getRoute(hostname)).toBeNull();

    backend.availabilityResult = {
      ready: false,
      stage: "health",
      cause: "health_status",
      status: 503,
    };
    const reconciledStatus = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/51/production/green",
        method: "GET",
        nonce: "nonce-runtime-health-status-1",
      }),
      env,
      dependencies,
    );
    expect(reconciledStatus.status).toBe(200);
    await expect(reconciledStatus.json()).resolves.toMatchObject({
      runtime: {
        identity: greenIdentity,
        status: "error",
        readyAt: null,
        lastError: "Runtime availability failed (health:health_status)",
      },
    });
    await expect(coordinator.getRuntime(greenIdentity)).resolves.toMatchObject({
      processId: null,
      descriptor: { status: "error", readyAt: null },
      logs: expect.arrayContaining([
        expect.objectContaining({
          message: "Runtime availability failed (stage=health, cause=health_status).",
        }),
      ]),
    });
  });

  it("runs the complete control lifecycle through the shared schemas", async () => {
    const coordinator = new MemoryCoordinator();
    const backend = new MockBackend();
    const env = fakeEnv();
    const base = "/_nabuflow/control/v1/runtimes/42/preview/primary";
    let nonce = 0;
    const send = async (input: {
      path: string;
      method: string;
      body?: unknown;
      idempotencyKey?: string;
    }) =>
      handleControlRequest(
        await signedRequest({
          ...input,
          nonce: `nonce-lifecycle-${String(++nonce).padStart(4, "0")}`,
        }),
        env,
        { coordinator, backend, nowMs: TEST_NOW_MS },
      );

    expect(
      (
        await send({
          path: base,
          method: "PUT",
          body: ensureBody(),
          idempotencyKey: "lifecycle-ensure",
        })
      ).status,
    ).toBe(200);

    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      ...ensureBody().locator,
    });
    const artifactSha256 = "a".repeat(64);
    coordinator.artifacts.set(`${identity}:${artifactSha256}`, {
      runtimeIdentity: identity,
      state: "committed",
      receivedChunks: [],
      expiresAtMs: null,
      envelope: {
        content: {
          format: "nabu-artifact/v1",
          payloadBytes: 0,
          chunkBytes: 1024 * 1024,
          chunks: [],
          files: [],
        },
        contentSha256: "b".repeat(64),
        sealedArtifactSha256: artifactSha256,
        targetRuntimeIdentity: identity,
        manifestRevision: "manifest-1",
        artifactRevision: "artifact-1",
        sourceRevision: "source-lifecycle",
        scan: { policyVersion: "nabu-secret-scan/v1", zeroMatches: true },
      },
    } satisfies StoredRuntimeArtifact);

    const start = await mutationAndDrain({
      path: `${base}/start`,
      idempotencyKey: "lifecycle-start",
      nonce: `nonce-lifecycle-${String(++nonce).padStart(4, "0")}`,
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: "artifact-1",
        artifactSha256,
      },
      env,
      coordinator,
      backend,
      nowMs: TEST_NOW_MS,
    });
    expect(start.status).toBe(200);
    await expect(start.json()).resolves.toMatchObject({ runtime: { status: "running" } });
    expect(coordinator.containerBindings).toHaveLength(1);
    expect([...coordinator.containerBindings.values()][0]).toContain("-p42-preview-primary");
    const activeBinding = await send({
      path: `${base}/capability-binding`,
      method: "GET",
    });
    expect(activeBinding.status).toBe(200);
    await expect(activeBinding.json()).resolves.toMatchObject({
      active: true,
      containerId: expect.stringContaining("container:nrf-"),
    });

    const status = await send({ path: base, method: "GET" });
    expect(status.status).toBe(200);
    await expect(status.json()).resolves.toMatchObject({ runtime: { servicePort: 8080 } });

    const exec = await send({
      path: `${base}/exec`,
      method: "POST",
      idempotencyKey: "lifecycle-exec",
      body: {
        locator: ensureBody().locator,
        argv: ["node", "-e", "console.log('ok')"],
        cwd: "/workspace",
        timeoutMs: 5_000,
      },
    });
    expect(exec.status).toBe(200);
    await expect(exec.json()).resolves.toMatchObject({ ok: true, exitCode: 0 });

    const logs = await send({ path: `${base}/logs?limit=20`, method: "GET" });
    expect(logs.status).toBe(200);
    const logBody = (await logs.json()) as { entries: Array<{ message: string }> };
    expect(logBody.entries.some((entry) => entry.message.includes("server ready"))).toBe(true);

    expect(
      (
        await send({
          path: `${base}/stop`,
          method: "POST",
          idempotencyKey: "lifecycle-stop",
          body: { locator: ensureBody().locator, reason: "test complete" },
        })
      ).status,
    ).toBe(200);
    expect(backend.stops).toBe(1);
    expect(coordinator.containerBindings).toHaveLength(0);
    const stoppedBinding = await send({
      path: `${base}/capability-binding`,
      method: "GET",
    });
    expect(stoppedBinding.status).toBe(200);
    await expect(stoppedBinding.json()).resolves.toMatchObject({
      active: false,
      containerId: null,
    });

    expect(
      (
        await send({
          path: base,
          method: "DELETE",
          idempotencyKey: "lifecycle-destroy",
          body: { locator: ensureBody().locator, reason: "test cleanup" },
        })
      ).status,
    ).toBe(200);
    expect(backend.destroys).toBe(1);
    expect(coordinator.runtimes).toHaveLength(0);
    expect(coordinator.containerBindings).toHaveLength(0);
  });
});
