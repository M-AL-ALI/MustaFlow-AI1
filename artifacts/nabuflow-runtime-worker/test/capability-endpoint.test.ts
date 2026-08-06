import {
  deriveRuntimeIdentity,
  type CapabilityDefinition,
  type CapabilityInvocation,
} from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ENDPOINT,
  handleCapabilityIntentFromContainer,
  handleCapabilityRequest,
} from "../src/capability-endpoint";
import type { StoredRuntime } from "../src/model";
import {
  MemoryCapabilityVault,
  MemoryCoordinator,
  TEST_NOW_MS,
  fakeEnv,
  signedRequest,
} from "./helpers";

const definition: CapabilityDefinition = {
  name: "echo",
  provider: "nabuflow-harness",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/echo" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 5_000,
    maxRequestBytes: 32_768,
    maxResponseBytes: 32_768,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

async function setup(projectId = 42) {
  const env = fakeEnv();
  const coordinator = new MemoryCoordinator();
  const vault = new MemoryCapabilityVault();
  const identity = await deriveRuntimeIdentity({
    namespace: "staging",
    projectId,
    role: "production",
    slot: "blue",
  });
  const containerId = `container:${identity}`;
  const runtime: StoredRuntime = {
    descriptor: {
      identity,
      projectId,
      role: "production",
      slot: "blue",
      status: "running",
      servicePort: 8080,
      manifestRevision: "manifest-v1",
      deploymentVersion: "worker-version-test-1",
      endpoint: null,
      readyAt: new Date(TEST_NOW_MS).toISOString(),
      lastError: null,
    },
    manifest: {
      revision: "manifest-v1",
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: ["node", "server.mjs"],
      servicePort: 8080,
      healthPath: "/health",
      resourceProfile: "dev",
      public: true,
    },
    artifactRevision: "artifact-v1",
    artifactSha256: "a".repeat(64),
    processId: "tenant-service",
    stdoutLength: 0,
    stderrLength: 0,
    nextLogSequence: 0,
    logs: [],
  };
  await coordinator.putRuntime(identity, runtime);
  await coordinator.bindContainer(containerId, identity);
  await vault.provisionEcho({ projectId, revision: "echo-v1", definition });
  return { env, coordinator, vault, identity, containerId, runtime };
}

function invocation(
  identity: string,
  containerId: string,
  options: { requestId?: string; requestedProjectId?: number } = {},
): CapabilityInvocation {
  return {
    v: 1,
    capability: { provider: "nabuflow-harness", name: "echo" },
    action: "invoke",
    requestId: options.requestId ?? "capability-request-0001",
    ...(options.requestedProjectId === undefined
      ? {}
      : { requestedProjectId: options.requestedProjectId }),
    input: { message: "hello" },
    caller: { containerId, runtimeIdentity: identity },
  };
}

async function invoke(
  state: Awaited<ReturnType<typeof setup>>,
  body: CapabilityInvocation,
  nonce: string,
  options: { timestamp?: number; secret?: string } = {},
) {
  const request = await signedRequest({
    path: CAPABILITY_ENDPOINT,
    method: "POST",
    body,
    timestamp: options.timestamp,
    nonce,
    idempotencyKey: body.requestId,
    secret: options.secret,
  });
  return handleCapabilityRequest(request, state.env, {
    coordinator: state.coordinator,
    vault: state.vault,
    nowMs: TEST_NOW_MS,
  });
}

describe("signed capability endpoint", () => {
  it("executes the echo capability for the bound running runtime", async () => {
    const state = await setup();
    const response = await invoke(
      state,
      invocation(state.identity, state.containerId),
      "capability-valid-0001",
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      actedBy: "capability-vault",
      runtimeIdentity: state.identity,
      echo: { message: "hello" },
    });
  });

  it("rejects unsigned, tampered, expired, and replayed requests cleanly", async () => {
    const state = await setup();
    const body = invocation(state.identity, state.containerId);
    const unsigned = await handleCapabilityRequest(
      new Request(`https://runtime.example${CAPABILITY_ENDPOINT}`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      state.env,
      { coordinator: state.coordinator, vault: state.vault, nowMs: TEST_NOW_MS },
    );
    expect(unsigned.status).toBe(401);
    await expect(unsigned.json()).resolves.toMatchObject({ code: "unauthorized" });

    const tamperedRequest = await signedRequest({
      path: CAPABILITY_ENDPOINT,
      method: "POST",
      body,
      nonce: "capability-tampered-0001",
      idempotencyKey: body.requestId,
    });
    tamperedRequest.headers.set("x-nabuflow-signature", "0".repeat(64));
    const tampered = await handleCapabilityRequest(tamperedRequest, state.env, {
      coordinator: state.coordinator,
      vault: state.vault,
      nowMs: TEST_NOW_MS,
    });
    expect(tampered.status).toBe(401);
    await expect(tampered.json()).resolves.toMatchObject({ code: "invalid_signature" });

    const expired = await invoke(
      state,
      { ...body, requestId: "capability-request-expired" },
      "capability-expired-0001",
      { timestamp: TEST_NOW_MS - 61_000 },
    );
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toMatchObject({ code: "expired_signature" });

    const replayBody = { ...body, requestId: "capability-request-replay" };
    const replayRequest = await signedRequest({
      path: CAPABILITY_ENDPOINT,
      method: "POST",
      body: replayBody,
      nonce: "capability-replay-0001",
      idempotencyKey: replayBody.requestId,
    });
    const replayClone = replayRequest.clone() as unknown as Request;
    expect(
      (
        await handleCapabilityRequest(replayRequest, state.env, {
          coordinator: state.coordinator,
          vault: state.vault,
          nowMs: TEST_NOW_MS,
        })
      ).status,
    ).toBe(200);
    const replay = await handleCapabilityRequest(replayClone, state.env, {
      coordinator: state.coordinator,
      vault: state.vault,
      nowMs: TEST_NOW_MS,
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "replay_detected" });
  });

  it("returns identical anti-enumeration bodies for existing and absent foreign projects", async () => {
    const state = await setup(42);
    await state.vault.provisionEcho({ projectId: 43, revision: "echo-v1", definition });
    const requestId = "capability-cross-project";
    const existing = await invoke(
      state,
      invocation(state.identity, state.containerId, { requestId, requestedProjectId: 43 }),
      "capability-cross-existing",
    );
    const absent = await invoke(
      state,
      invocation(state.identity, state.containerId, { requestId, requestedProjectId: 44 }),
      "capability-cross-absent",
    );
    expect(existing.status).toBe(403);
    expect(absent.status).toBe(403);
    expect(await existing.text()).toBe(await absent.text());
    expect(state.coordinator.audits.slice(-2).map((record) => record.outcome)).toEqual([
      "capability_tenant_mismatch",
      "capability_tenant_mismatch",
    ]);
  });

  it("rejects missing, mismatched, and inactive runtime bindings", async () => {
    const state = await setup();
    await state.coordinator.unbindContainer(state.containerId, state.identity);
    const unbound = await invoke(
      state,
      invocation(state.identity, state.containerId, { requestId: "capability-unbound-request" }),
      "capability-unbound-0001",
    );
    expect(unbound.status).toBe(403);
    await expect(unbound.json()).resolves.toMatchObject({ code: "capability_runtime_unbound" });

    await state.coordinator.bindContainer(state.containerId, state.identity);
    await state.coordinator.putRuntime(state.identity, {
      ...state.runtime,
      descriptor: { ...state.runtime.descriptor, status: "stopped" },
    });
    const inactive = await invoke(
      state,
      invocation(state.identity, state.containerId, { requestId: "capability-inactive-request" }),
      "capability-inactive-0001",
    );
    expect(inactive.status).toBe(403);
    await expect(inactive.json()).resolves.toMatchObject({ code: "capability_runtime_inactive" });
  });

  it("rejects WebSocket upgrades before capability execution", async () => {
    const state = await setup();
    const response = await handleCapabilityRequest(
      new Request(`https://runtime.example${CAPABILITY_ENDPOINT}`, {
        method: "GET",
        headers: { connection: "Upgrade", upgrade: "websocket" },
      }),
      state.env,
      { coordinator: state.coordinator, vault: state.vault, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(426);
    await expect(response.json()).resolves.toMatchObject({
      code: "capability_upgrade_not_supported",
    });
  });

  it("turns an unsigned container intent into a trusted signed invocation", async () => {
    const state = await setup();
    const intent = {
      v: 1,
      capability: { provider: "nabuflow-harness", name: "echo" },
      action: "invoke",
      requestId: "capability-container-intent",
      input: { via: "outbound-handler" },
    } as const;
    const response = await handleCapabilityIntentFromContainer(
      new Request("http://doorman.staging.nabuflow.internal/v1/invoke", {
        method: "POST",
        body: JSON.stringify(intent),
      }),
      state.env,
      state.containerId,
      {
        coordinator: state.coordinator,
        vault: state.vault,
        nowMs: TEST_NOW_MS,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      requestId: intent.requestId,
      runtimeIdentity: state.identity,
      echo: intent.input,
    });
  });

  it("keeps audit records free of keys, envelopes, and credential material", async () => {
    const state = await setup();
    await invoke(
      state,
      invocation(state.identity, state.containerId, { requestId: "capability-audit-request" }),
      "capability-audit-0001",
    );
    const serialized = JSON.stringify(state.coordinator.audits);
    expect(serialized).not.toContain("0123456789abcdef0123456789abcdef");
    expect(serialized).not.toMatch(/CLOUDFLARE|ciphertext|envelope|canary|credential|secret|KEK/i);
    expect(state.coordinator.audits.at(-1)).toMatchObject({
      endpoint: "capabilityInvoke",
      outcome: "capability_invoked",
      projectId: 42,
    });
  });
});
