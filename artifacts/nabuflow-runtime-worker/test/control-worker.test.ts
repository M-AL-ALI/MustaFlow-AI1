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
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 84,
      role: "production",
      slot: "blue",
    });
    const runtime: StoredRuntime = {
      descriptor: {
        identity,
        projectId: 84,
        role: "production",
        slot: "blue",
        status: "running",
        servicePort: 8080,
        manifestRevision: "published-manifest-1",
        deploymentVersion: "worker-version-test-1",
        endpoint: null,
        readyAt: new Date(TEST_NOW_MS).toISOString(),
        lastError: null,
      },
      manifest: {
        revision: "published-manifest-1",
        runtime: "node",
        buildCommand: ["node", "--version"],
        startCommand: ["node", "server.mjs"],
        servicePort: 8080,
        healthPath: "/health",
        resourceProfile: "dev",
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
    const hostname = "project-84.apps.mustaflow.com";
    const path = `/_nabuflow/control/v1/routes/${hostname}/activate`;
    const body = {
      route: {
        hostname,
        projectId: 84,
        role: "production" as const,
        activeSlot: "blue" as const,
        manifestRevision: "published-manifest-1",
        servicePort: 8080,
        sandboxIdentity: identity,
      },
      expectedPreviousManifestRevision: null,
    };
    const dependencies = {
      coordinator,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    };

    const greenIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 84,
      role: "production",
      slot: "green",
    });
    const greenRejected = await handleControlRequest(
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
      fakeEnv(),
      dependencies,
    );
    expect(greenRejected.status).toBe(400);
    await expect(greenRejected.json()).resolves.toMatchObject({ code: "production_blue_required" });
    expect(await coordinator.getRoute(hostname)).toBeNull();

    const unsigned = await handleControlRequest(
      new Request(`https://runtime.example${path}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      fakeEnv(),
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
    expect((await handleControlRequest(tampered, fakeEnv(), dependencies)).status).toBe(401);

    const expired = await signedRequest({
      path,
      method: "POST",
      nonce: "nonce-route-expired-00001",
      idempotencyKey: "route-activate-expired",
      timestamp: TEST_NOW_MS - 60_001,
      body,
    });
    expect((await handleControlRequest(expired, fakeEnv(), dependencies)).status).toBe(401);

    const valid = await signedRequest({
      path,
      method: "POST",
      nonce: "nonce-route-valid-000001",
      idempotencyKey: "route-activate-valid",
      body,
    });
    const replay = valid.clone() as Request;
    const activated = await handleControlRequest(valid, fakeEnv(), dependencies);
    expect(activated.status).toBe(200);
    await expect(activated.json()).resolves.toMatchObject({ ok: true, route: { hostname } });
    expect((await coordinator.getRoute(hostname))?.sandboxIdentity).toBe(identity);
    const replayed = await handleControlRequest(replay, fakeEnv(), dependencies);
    expect(replayed.status).toBe(409);
    await expect(replayed.json()).resolves.toMatchObject({ code: "replay_detected" });

    const deletePath = `/_nabuflow/control/v1/routes/${hostname}`;
    const deleted = await handleControlRequest(
      await signedRequest({
        path: deletePath,
        method: "DELETE",
        nonce: "nonce-route-delete-00001",
        idempotencyKey: "route-delete-valid",
        body: {
          hostname,
          expectedManifestRevision: "published-manifest-1",
          expectedSandboxIdentity: identity,
        },
      }),
      fakeEnv(),
      dependencies,
    );
    expect(deleted.status).toBe(200);
    await expect(deleted.json()).resolves.toEqual({ ok: true, hostname });
    expect(await coordinator.getRoute(hostname)).toBeNull();
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

    const start = await send({
      path: `${base}/start`,
      method: "POST",
      idempotencyKey: "lifecycle-start",
      body: {
        locator: ensureBody().locator,
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: "artifact-1",
        artifactSha256,
      },
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
