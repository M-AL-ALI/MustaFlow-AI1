import {
  PREVIEW_DATA_PREFIX,
  deriveRuntimeIdentity,
  signStagingHostOverride,
} from "@workspace/tenant-runtime-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePublishedDataPlaneRequest } from "../src/published-data-plane";
import { handleWorkerRequest } from "../src/worker";
import type { StoredRuntime } from "../src/model";
import {
  MemoryArtifactCommitQueue,
  MemoryCoordinator,
  TEST_NOW_MS,
  TEST_SECRET,
  fakeEnv,
} from "./helpers";

const WORKER_HOST = "nabuflow-runtime-staging.mustafa-alali74.workers.dev";
const ORIGIN = `https://${WORKER_HOST}`;
const PUBLISHED_HOST = "scratch-published.apps.mustaflow.com";

class MockPublishedSandbox {
  readonly httpRequests: Request[] = [];
  readonly wsRequests: Request[] = [];
  responseFactory: (request: Request) => Response | Promise<Response> = (request) =>
    Response.json({ method: request.method, url: request.url });

  async containerFetch(request: Request, port: number): Promise<Response> {
    expect(port).toBe(8080);
    this.httpRequests.push(request);
    return await this.responseFactory(request);
  }

  async wsConnect(request: Request, port: number): Promise<Response> {
    expect(port).toBe(8080);
    this.wsRequests.push(request);
    return new Response(`echo:${request.headers.get("x-test-websocket-message") ?? ""}`, {
      headers: { "x-test-websocket": "connected" },
    });
  }
}

describe("anonymous published application data plane", () => {
  let identity: string;
  let coordinator: MemoryCoordinator;
  let sandbox: MockPublishedSandbox;
  let env: ReturnType<typeof fakeEnv>;

  beforeEach(async () => {
    identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 84,
      role: "production",
      slot: "blue",
    });
    coordinator = new MemoryCoordinator();
    sandbox = new MockPublishedSandbox();
    env = fakeEnv();
    env.NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED = "true";
    env.NABUFLOW_STAGING_WORKER_HOST = WORKER_HOST;
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
    await coordinator.activateRoute(
      {
        hostname: PUBLISHED_HOST,
        projectId: 84,
        role: "production",
        activeSlot: "blue",
        manifestRevision: "published-manifest-1",
        servicePort: 8080,
        sandboxIdentity: identity,
      },
      null,
    );
    await coordinator.activateRoute(
      {
        hostname: WORKER_HOST,
        projectId: 84,
        role: "production",
        activeSlot: "blue",
        manifestRevision: "published-manifest-1",
        servicePort: 8080,
        sandboxIdentity: identity,
      },
      null,
    );
  });

  async function overrideHeaders(path: string, method = "GET", nonce = "override-unit-0000001") {
    const fields = {
      method,
      pathAndQuery: path,
      timestamp: String(TEST_NOW_MS),
      nonce,
      actualHost: WORKER_HOST,
      overrideHost: PUBLISHED_HOST,
    };
    return {
      "x-nabuflow-staging-host-override": PUBLISHED_HOST,
      "x-nabuflow-staging-timestamp": fields.timestamp,
      "x-nabuflow-staging-nonce": fields.nonce,
      "x-nabuflow-staging-signature": await signStagingHostOverride(TEST_SECRET, fields),
    };
  }

  it("proxies every HTTP method anonymously and preserves a large streamed body", async () => {
    const largeBody = "published-stream-integrity-".repeat(50_000);
    sandbox.responseFactory = async (request) =>
      Response.json({ method: request.method, body: await request.text() });

    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const body = method === "GET" ? undefined : method === "POST" ? largeBody : method;
      const path = "/echo?published=true";
      const response = await handlePublishedDataPlaneRequest(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: await overrideHeaders(path, method, `override-method-${method}-0001`),
          body,
          ...(body === undefined ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
        }),
        env,
        { coordinator, sandbox, nowMs: TEST_NOW_MS },
      );
      expect(response.status).toBe(200);
      const reflected = (await response.json()) as { method: string; body: string };
      expect(reflected).toEqual({ method, body: body ?? "" });
    }
  });

  it("returns a structured 404 and invalidates immediately after unregister", async () => {
    const missingPath = "/missing";
    const missingHeaders = await overrideHeaders(missingPath, "GET", "override-missing-host-0001");
    missingHeaders["x-nabuflow-staging-host-override"] = "missing.apps.mustaflow.com";
    const missingFields = {
      method: "GET",
      pathAndQuery: missingPath,
      timestamp: String(TEST_NOW_MS),
      nonce: "override-missing-host-0001",
      actualHost: WORKER_HOST,
      overrideHost: "missing.apps.mustaflow.com",
    };
    missingHeaders["x-nabuflow-staging-signature"] = await signStagingHostOverride(
      TEST_SECRET,
      missingFields,
    );
    const missing = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}${missingPath}`, { headers: missingHeaders }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ code: "published_route_not_found" });

    expect(await coordinator.deactivateRoute(WORKER_HOST, "published-manifest-1", identity)).toBe(
      "deactivated",
    );
    const afterDelete = await handlePublishedDataPlaneRequest(new Request(`${ORIGIN}/`), env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(afterDelete.status).toBe(404);
    await expect(afterDelete.json()).resolves.toMatchObject({ code: "published_route_not_found" });
  });

  it("streams SSE without buffering", async () => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    sandbox.responseFactory = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            value.enqueue(new TextEncoder().encode("data: first\n\n"));
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    const response = await handlePublishedDataPlaneRequest(new Request(`${ORIGIN}/sse`), env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    controller!.enqueue(new TextEncoder().encode("data: second\n\n"));
    controller!.close();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: second\n\n");
  });

  it("passes the original anonymous WebSocket upgrade request under staging PG-2", async () => {
    const request = new Request(`${ORIGIN}/socket`, {
      headers: {
        connection: "Upgrade",
        upgrade: "websocket",
        cookie: "__session=pg2-platform-cookie",
        "x-forwarded-for": "attacker.invalid",
        "x-test-websocket-message": "published-websocket-echo",
      },
    });
    const response = await handlePublishedDataPlaneRequest(request, env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(response.headers.get("x-test-websocket")).toBe("connected");
    await expect(response.text()).resolves.toBe("echo:published-websocket-echo");
    expect(sandbox.wsRequests[0]).toBe(request);
    expect(request.headers.get("cookie")).toContain("pg2-platform-cookie");
    expect(request.headers.get("x-forwarded-for")).toBe("attacker.invalid");
  });

  it("fails closed on published WebSockets outside staging until PG-2 is resolved", async () => {
    const productionIdentity = await deriveRuntimeIdentity({
      namespace: "production",
      projectId: 84,
      role: "production",
      slot: "blue",
    });
    const productionRuntime = await coordinator.getRuntime(identity);
    if (productionRuntime === null) throw new Error("staging fixture missing");
    productionRuntime.descriptor.identity = productionIdentity;
    await coordinator.putRuntime(productionIdentity, productionRuntime);
    await coordinator.activateRoute(
      {
        hostname: PUBLISHED_HOST,
        projectId: 84,
        role: "production",
        activeSlot: "blue",
        manifestRevision: "published-manifest-1",
        servicePort: 8080,
        sandboxIdentity: productionIdentity,
      },
      "published-manifest-1",
    );
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "production";
    env.NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED = "false";

    const response = await handlePublishedDataPlaneRequest(
      new Request(`https://${PUBLISHED_HOST}/socket`, {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(501);
    await expect(response.json()).resolves.toMatchObject({
      code: "published_websocket_unavailable",
      retryable: false,
    });
    expect(sandbox.wsRequests).toHaveLength(0);
  });

  it("strips platform, control, override, and forwarding headers while preserving app auth", async () => {
    sandbox.responseFactory = (request) => {
      const reflected: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        reflected[name] = value;
      });
      return Response.json(reflected);
    };
    const path = "/headers";
    const response = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}${path}`, {
        headers: {
          ...(await overrideHeaders(path, "GET", "override-headers-000001")),
          authorization: "Bearer tenant-app-token",
          cookie: "__session=platform-secret; theme=dark",
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.8",
          "x-forwarded-host": "attacker.invalid",
          "idempotency-key": "control-key",
        },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    const headers = (await response.json()) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tenant-app-token");
    expect(headers.cookie).toBe("theme=dark");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-host"]).toBe(PUBLISHED_HOST);
    expect(headers["x-nabuflow-staging-host-override"]).toBeUndefined();
    expect(headers["x-nabuflow-staging-signature"]).toBeUndefined();
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("suppresses tenant cookies scoped to mustaflow.com", async () => {
    sandbox.responseFactory = () =>
      new Response("ok", {
        headers: { "set-cookie": "tenant_session=secret; Domain=.mustaflow.com; Path=/" },
      });
    const response = await handlePublishedDataPlaneRequest(new Request(`${ORIGIN}/cookie`), env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rejects replayed overrides, disabled overrides, and override WebSockets", async () => {
    const path = "/";
    const headers = await overrideHeaders(path);
    const firstRequest = new Request(`${ORIGIN}${path}`, { headers });
    expect(
      (
        await handlePublishedDataPlaneRequest(firstRequest.clone() as Request, env, {
          coordinator,
          sandbox,
          nowMs: TEST_NOW_MS,
        })
      ).status,
    ).toBe(200);
    const replay = await handlePublishedDataPlaneRequest(firstRequest, env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({ code: "staging_host_override_replayed" });

    const disabledEnv = { ...env, NABUFLOW_STAGING_HOST_OVERRIDE_ENABLED: undefined };
    const disabled = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}/disabled`, {
        headers: await overrideHeaders("/disabled", "GET", "override-disabled-00001"),
      }),
      disabledEnv,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(disabled.status).toBe(400);
    await expect(disabled.json()).resolves.toMatchObject({
      code: "staging_host_override_disabled",
    });

    const wsPath = "/socket";
    const websocket = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}${wsPath}`, {
        headers: {
          ...(await overrideHeaders(wsPath, "GET", "override-websocket-0001")),
          connection: "Upgrade",
          upgrade: "websocket",
        },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(websocket.status).toBe(400);
    await expect(websocket.json()).resolves.toMatchObject({
      code: "staging_host_override_websocket_unsupported",
    });
    expect(sandbox.wsRequests).toHaveLength(0);
  });

  it("atomically switches published traffic from blue to a healthy green candidate", async () => {
    const blue = await coordinator.getRuntime(identity);
    if (blue === null) throw new Error("blue runtime fixture is missing");
    const greenIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 84,
      role: "production",
      slot: "green",
    });
    const greenRevision = "published-manifest-green-2";
    await coordinator.putRuntime(greenIdentity, {
      ...blue,
      descriptor: {
        ...blue.descriptor,
        identity: greenIdentity,
        slot: "green",
        manifestRevision: greenRevision,
      },
      manifest: { ...blue.manifest, revision: greenRevision },
      artifactRevision: "published-artifact-green-2",
      artifactSha256: "b".repeat(64),
    });
    for (const hostname of [PUBLISHED_HOST, WORKER_HOST]) {
      await expect(
        coordinator.activateRoute(
          {
            hostname,
            projectId: 84,
            role: "production",
            activeSlot: "green",
            manifestRevision: greenRevision,
            servicePort: 8080,
            sandboxIdentity: greenIdentity,
          },
          "published-manifest-1",
        ),
      ).resolves.toBe("activated");
    }

    const response = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}/green`, {
        headers: await overrideHeaders("/green", "GET", "override-green-slot-0001"),
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(200);
    expect(sandbox.httpRequests).toHaveLength(1);
    await expect(coordinator.getRuntime(identity)).resolves.toMatchObject({
      descriptor: { status: "running", slot: "blue" },
    });
    await expect(coordinator.getRoute(PUBLISHED_HOST)).resolves.toMatchObject({
      activeSlot: "green",
      sandboxIdentity: greenIdentity,
    });
  });

  it("coalesces durable recovery instead of forwarding to a missing tenant process", async () => {
    const queue = env.DURABLE_OPERATION_QUEUE as unknown as MemoryArtifactCommitQueue;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await handlePublishedDataPlaneRequest(new Request(`${ORIGIN}/`), env, {
        coordinator,
        sandbox,
        runtimeStatus: async () => ({ running: false, lastError: "Tenant service is not running" }),
        nowMs: TEST_NOW_MS,
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        code: "published_runtime_recovering",
        retryable: true,
      });
    }

    expect(sandbox.httpRequests).toHaveLength(0);
    expect(coordinator.runtimeLifecycleJobs.size).toBe(1);
    const recovery = await coordinator.getLatestDurableOperation(
      "runtime-start",
      identity,
      "start",
    );
    if (recovery === null) throw new Error("published runtime recovery job is missing");
    expect(recovery).toMatchObject({
      kind: "runtime-start",
      runtimeIdentity: identity,
      subjectKey: "start",
      request: {
        artifactRevision: "published-artifact-1",
        artifactSha256: "a".repeat(64),
      },
    });
    expect(queue.messages).toHaveLength(2);
    expect(new Set(queue.messages.map((message) => message.jobKey))).toEqual(
      new Set([recovery.jobKey]),
    );
  });

  it("bounds an unresponsive upstream and recovers when the process disappears", async () => {
    let statusChecks = 0;
    sandbox.responseFactory = (request) =>
      new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), {
          once: true,
        });
      });
    const response = await handlePublishedDataPlaneRequest(new Request(`${ORIGIN}/hung`), env, {
      coordinator,
      sandbox,
      runtimeStatus: async () => ({
        running: statusChecks++ === 0,
        lastError: statusChecks === 1 ? null : "Tenant service is not running",
      }),
      upstreamHeaderTimeoutMs: 5,
      nowMs: TEST_NOW_MS,
    });
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "published_runtime_recovering",
      retryable: true,
    });
    expect(statusChecks).toBe(2);
    expect(coordinator.runtimeLifecycleJobs.size).toBe(1);
  });

  it("recovers an adopted runtime whose process is running but health port is unavailable", async () => {
    sandbox.responseFactory = () => {
      throw new TypeError("private transport detail must not be persisted");
    };
    const response = await handlePublishedDataPlaneRequest(
      new Request(`${ORIGIN}/adopted-green`),
      env,
      {
        coordinator,
        sandbox,
        runtimeAvailability: async () => ({
          ready: false,
          stage: "health",
          cause: "health_transport",
          status: null,
        }),
        nowMs: TEST_NOW_MS,
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "published_runtime_recovering",
      retryable: true,
    });
    expect(coordinator.runtimeLifecycleJobs.size).toBe(1);
    const stored = await coordinator.getRuntime(identity);
    expect(stored?.logs.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([
        "Published availability failed (stage=request, cause=transport, class=TypeError).",
        "Published availability failed (stage=health, cause=health_transport).",
      ]),
    );
    expect(stored?.logs.map((entry) => entry.message).join("\n")).not.toContain(
      "private transport detail",
    );
  });

  it("keeps preview routing and its missing-session response unchanged", async () => {
    const response = await handleWorkerRequest(
      new Request(`${ORIGIN}${PREVIEW_DATA_PREFIX}/nrf-0000000000000000-p84-preview-primary/`),
      env,
      { coordinator, nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "preview_auth_required" });
  });
});
