import {
  PREVIEW_DATA_PREFIX,
  deriveRuntimeIdentity,
  signPreviewGrant,
} from "@workspace/tenant-runtime-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { handlePreviewDataPlaneRequest } from "../src/preview-data-plane";
import type { StoredRuntime } from "../src/model";
import { MemoryCoordinator, TEST_NOW_MS, fakeEnv } from "./helpers";
import { PREVIEW_GRANT_COMPATIBILITY_VECTOR as vector } from "../../../lib/tenant-runtime-contracts/test/preview-grant-vector";

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 =
    btoa(binary)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    privateKey: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: toPem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

class MockPreviewSandbox {
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
      status: 200,
      headers: { "x-test-websocket": "connected" },
    });
  }
}

describe("authenticated preview data plane", () => {
  const origin = "https://runtime-staging.example.workers.dev";
  const nowSeconds = Math.floor(TEST_NOW_MS / 1_000);
  let identity: string;
  let keys: Awaited<ReturnType<typeof keyPair>>;
  let wrongKeys: Awaited<ReturnType<typeof keyPair>>;
  let coordinator: MemoryCoordinator;
  let sandbox: MockPreviewSandbox;
  let env: ReturnType<typeof fakeEnv>;

  beforeEach(async () => {
    identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    keys = await keyPair();
    wrongKeys = await keyPair();
    coordinator = new MemoryCoordinator();
    sandbox = new MockPreviewSandbox();
    env = fakeEnv();
    env.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY = keys.publicKey;
    const runtime: StoredRuntime = {
      descriptor: {
        identity,
        projectId: 42,
        role: "preview",
        slot: "primary",
        status: "running",
        servicePort: 8080,
        manifestRevision: "preview-test",
        deploymentVersion: "worker-version-test-1",
        endpoint: null,
        readyAt: new Date(TEST_NOW_MS).toISOString(),
        lastError: null,
      },
      manifest: {
        revision: "preview-test",
        runtime: "node",
        buildCommand: ["node", "--version"],
        startCommand: ["node", "server.mjs"],
        servicePort: 8080,
        healthPath: "/health",
        resourceProfile: "dev",
        public: false,
      },
      artifactRevision: "artifact-test",
      artifactSha256: "0".repeat(64),
      processId: "tenant-service",
      stdoutLength: 0,
      stderrLength: 0,
      nextLogSequence: 0,
      logs: [],
    };
    await coordinator.putRuntime(identity, runtime);
  });

  it("verifies the fixed raw-P1363 compatibility vector on the Worker side", async () => {
    await coordinator.putRuntime(vector.claims.sub, {
      ...(await coordinator.getRuntime(identity))!,
      descriptor: {
        ...(await coordinator.getRuntime(identity))!.descriptor,
        identity: vector.claims.sub,
        projectId: 424_242,
      },
    });
    env.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY = vector.publicKeyPem;
    const response = await handlePreviewDataPlaneRequest(
      new Request(
        `${vector.claims.aud}${PREVIEW_DATA_PREFIX}/${vector.claims.sub}/?__nfg=${encodeURIComponent(vector.token)}`,
      ),
      env,
      { coordinator, sandbox, nowMs: vector.claims.iat * 1_000 },
    );
    expect(response?.status).toBe(302);
  });

  async function grant(
    input: {
      privateKey?: string;
      jti?: string;
      issuedAt?: number;
      expiresAt?: number;
    } = {},
  ) {
    return signPreviewGrant(input.privateKey ?? keys.privateKey, {
      v: 1,
      iss: "nabuflow-api",
      aud: origin,
      sub: identity,
      port: 8080,
      iat: input.issuedAt ?? nowSeconds,
      exp: input.expiresAt ?? nowSeconds + 300,
      jti: input.jti ?? "worker-preview-test-jti",
    });
  }

  async function redeem(token: string, path = "/") {
    return handlePreviewDataPlaneRequest(
      new Request(
        `${origin}${PREVIEW_DATA_PREFIX}/${identity}${path}?__nfg=${encodeURIComponent(token)}`,
      ),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
  }

  function cookieFrom(response: Response): string {
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) throw new Error("redemption omitted Set-Cookie");
    return setCookie.split(";", 1)[0];
  }

  it("redeems a valid grant once, then accepts the host-only HttpOnly session", async () => {
    const token = await grant();
    const redeemed = await redeem(token, "/hello");
    expect(redeemed?.status).toBe(302);
    expect(redeemed?.headers.get("location")).toBe(
      `${origin}${PREVIEW_DATA_PREFIX}/${identity}/hello`,
    );
    expect(redeemed?.headers.get("set-cookie")).toMatch(
      /HttpOnly; Secure; SameSite=None; Max-Age=300; Path=\/$/,
    );
    expect(redeemed?.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(redeemed?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");

    const replay = await redeem(token, "/hello");
    expect(replay?.status).toBe(409);
    await expect(replay?.json()).resolves.toMatchObject({ code: "preview_grant_replayed" });

    const session = await handlePreviewDataPlaneRequest(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/hello?value=1`, {
        headers: { cookie: cookieFrom(redeemed!) },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(session?.status).toBe(200);
    expect(session?.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(session?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(sandbox.httpRequests[0]?.url).toBe("https://tenant.preview.invalid/hello?value=1");
  });

  it.each([
    ["expired", async () => grant({ issuedAt: nowSeconds - 400, expiresAt: nowSeconds - 100 })],
    [
      "tampered",
      async () => {
        const segments = (await grant()).split(".");
        segments[2] = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
        return segments.join(".");
      },
    ],
    ["forged", async () => grant({ privateKey: wrongKeys.privateKey, jti: "wrong-key-test-jti" })],
  ])("rejects %s grants cleanly", async (_label, makeGrant) => {
    const response = await redeem(await makeGrant());
    expect(response?.status).toBe(401);
  });

  it("rejects missing sessions and an unredeemed grant injected as a cookie", async () => {
    const path = `${origin}${PREVIEW_DATA_PREFIX}/${identity}/`;
    const missing = await handlePreviewDataPlaneRequest(new Request(path), env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(missing?.status).toBe(401);
    expect(missing?.headers.get("cross-origin-resource-policy")).toBe("same-site");
    expect(missing?.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    await expect(missing?.json()).resolves.toMatchObject({ code: "preview_auth_required" });

    const token = await grant({ jti: "unredeemed-cookie-jti" });
    const injected = await handlePreviewDataPlaneRequest(
      new Request(path, {
        headers: { cookie: `__Host-nabuflow_preview_${identity}=${token}` },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(injected?.status).toBe(401);
    await expect(injected?.json()).resolves.toMatchObject({
      code: "preview_grant_not_redeemed",
    });
  });

  it("streams every HTTP method and preserves a large request body intact", async () => {
    const token = await grant();
    const redeemed = await redeem(token);
    const cookie = cookieFrom(redeemed!);
    const largeBody = "stream-integrity-".repeat(70_000);
    const methods = ["GET", "POST", "PUT", "DELETE"] as const;
    sandbox.responseFactory = async (request) =>
      Response.json({ method: request.method, body: await request.text() });

    for (const method of methods) {
      const body = method === "GET" ? undefined : method === "POST" ? largeBody : method;
      const response = await handlePreviewDataPlaneRequest(
        new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/echo`, {
          method,
          headers: { cookie },
          body,
          ...(body === undefined ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
        }),
        env,
        { coordinator, sandbox, nowMs: TEST_NOW_MS },
      );
      const reflected = (await response?.json()) as { method: string; body: string };
      expect(reflected.method).toBe(method);
      expect(reflected.body).toBe(body ?? "");
    }
  });

  it("returns an SSE body without consuming or buffering it", async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
      },
    });
    sandbox.responseFactory = () =>
      new Response(stream, { headers: { "content-type": "text/event-stream" } });
    const token = await grant();
    const redeemed = await redeem(token);
    const response = await handlePreviewDataPlaneRequest(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/sse`, {
        headers: { cookie: cookieFrom(redeemed!) },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(response?.headers.get("content-type")).toBe("text/event-stream");
    const reader = response!.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
    expect(first.done).toBe(false);
    streamController!.enqueue(new TextEncoder().encode("data: second\n\n"));
    streamController!.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe("data: second\n\n");
  });

  it("strips platform/control/forwarding headers while preserving app auth and cookies", async () => {
    const token = await grant();
    const redeemed = await redeem(token);
    const sessionCookie = cookieFrom(redeemed!);
    sandbox.responseFactory = (request) => {
      const reflected: Record<string, string> = {};
      request.headers.forEach((value, name) => {
        reflected[name] = value;
      });
      return Response.json(reflected);
    };
    const response = await handlePreviewDataPlaneRequest(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/headers`, {
        headers: {
          authorization: "Bearer tenant-app-token",
          cookie: `${sessionCookie}; __session=platform-secret; theme=dark`,
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.8",
          "x-forwarded-host": "attacker.invalid",
          "x-nabuflow-signature": "control-secret",
          "idempotency-key": "control-key",
        },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    const headers = (await response?.json()) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tenant-app-token");
    expect(headers.cookie).toBe("theme=dark");
    expect(headers["x-forwarded-for"]).toBe("203.0.113.9");
    expect(headers["x-forwarded-host"]).toBe("runtime-staging.example.workers.dev");
    expect(headers["x-nabuflow-signature"]).toBeUndefined();
    expect(headers["idempotency-key"]).toBeUndefined();
  });

  it("rejects an upstream cookie scoped to mustaflow.com", async () => {
    sandbox.responseFactory = () =>
      new Response("ok", {
        headers: { "set-cookie": "tenant_session=secret; Domain=.mustaflow.com; Path=/" },
      });
    const token = await grant();
    const redeemed = await redeem(token);
    const response = await handlePreviewDataPlaneRequest(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/cookie`, {
        headers: { cookie: cookieFrom(redeemed!) },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(response?.headers.get("set-cookie")).toBeNull();
  });

  it("authenticates then round-trips an echo through wsConnect with the untouched Request", async () => {
    const token = await grant();
    const redeemed = await redeem(token);
    const request = new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/socket`, {
      headers: {
        authorization: "Bearer websocket-app-token",
        connection: "Upgrade",
        upgrade: "websocket",
        cookie: `${cookieFrom(redeemed!)}; __session=platform-secret`,
        "x-forwarded-for": "attacker.invalid",
        "x-test-websocket-message": "nabuflow-websocket-test",
      },
    });
    const response = await handlePreviewDataPlaneRequest(request, env, {
      coordinator,
      sandbox,
      nowMs: TEST_NOW_MS,
    });
    expect(response?.headers.get("x-test-websocket")).toBe("connected");
    await expect(response?.text()).resolves.toBe("echo:nabuflow-websocket-test");
    expect(sandbox.wsRequests[0]).toBe(request);
    expect(request.headers.get("cookie")).toContain("__session=platform-secret");
    expect(request.headers.get("authorization")).toBe("Bearer websocket-app-token");
    expect(request.headers.get("x-forwarded-for")).toBe("attacker.invalid");
  });

  it("rejects an unauthenticated WebSocket upgrade before wsConnect", async () => {
    const response = await handlePreviewDataPlaneRequest(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/socket`, {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      }),
      env,
      { coordinator, sandbox, nowMs: TEST_NOW_MS },
    );
    expect(response?.status).toBe(401);
    await expect(response?.json()).resolves.toMatchObject({ code: "preview_auth_required" });
    expect(sandbox.wsRequests).toHaveLength(0);
  });
});
