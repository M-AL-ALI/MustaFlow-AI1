import { PREVIEW_DATA_PREFIX } from "@workspace/tenant-runtime-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePreviewDataPlaneRequest } from "../src/preview-data-plane";
import type { StoredRuntime } from "../src/model";
import { MemoryCoordinator, fakeEnv } from "./helpers";
import { PREVIEW_GRANT_COMPATIBILITY_VECTOR as vector } from "../../../lib/tenant-runtime-contracts/test/preview-grant-vector";

// Exercise the real ordinary WS adapter to the raw Durable Object fetch boundary.
// The Node suite cannot establish a native workerd 101 WebSocket connection.
describe("ordinary preview WebSocket credential isolation", () => {
  const identity = vector.claims.sub;
  const origin = vector.claims.aud;
  const port = vector.claims.port;
  const nowMs = vector.claims.iat * 1_000;
  const cookieName = `__Host-nabuflow_preview_${identity}`;
  const socketUrl = `${origin}${PREVIEW_DATA_PREFIX}/${identity}/socket?channel=app`;
  const appCookies = "theme=dark; tenant_session=a=b; __Host-tenant_session=app-secret";
  const platformCookies = [
    "__prs",
    "__Host-__prs",
    "__session",
    "__session_instance",
    "__client_uat",
    "__client_uat_instance",
    "__client",
    "__refresh",
    "__clerk_db_jwt",
    "__Host-__clerk_handshake",
    "__Secure-__clerk_handshake",
    "__cf_bm",
    "cf_clearance",
    "mustaflow_auth",
    "nabuflow_auth",
    "b5_session",
    "__b5_gate",
    "__Host-b5_session",
    "__Host-nabuflow_preview_other-runtime",
    "__Secure-nabuflow_preview_other-runtime",
    "nabuflow_preview_other-runtime",
  ]
    .map((name) => `${name}=platform-secret`)
    .join("; ");
  const platformHeaders: Record<string, string> = {
    "proxy-authorization": "Basic proxy-secret",
    "x-clerk-auth-token": "clerk-secret",
    "x-clerk-auth-status": "signed-in",
    "x-b5-relay-auth": "b5-relay-secret",
    "x-b5-preview-host": "p42.preview.mustaflow.com",
    "x-b5-preview-path": "/private",
    "x-nabuflow-signature": "control-secret",
    "x-nrf-token": "runtime-secret",
    "x-mustaflow-token": "platform-secret",
    "idempotency-key": "control-key",
    "cf-access-jwt-assertion": "access-secret",
    "cf-container-target-port": "9999",
    "cf-ray": "incoming-ray",
    "cdn-loop": "cloudflare",
  };
  let coordinator: MemoryCoordinator;
  let env: ReturnType<typeof fakeEnv>;
  let wsRequests: Request[];
  let httpRequests: { request: Request; port: number }[];
  let wsResponse: Response;
  let resolveSandbox: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    coordinator = new MemoryCoordinator();
    env = fakeEnv();
    env.CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY = vector.publicKeyPem;
    wsRequests = [];
    httpRequests = [];
    wsResponse = new Response("ws-dispatched", {
      headers: { "sec-websocket-protocol": "vite-hmr" },
    });
    const sandbox = {
      async fetch(request: Request) {
        wsRequests.push(request);
        return wsResponse;
      },
      async containerFetch(request: Request, targetPort: number) {
        httpRequests.push({ request, port: targetPort });
        return new Response("http-dispatched", {
          headers: {
            "content-type": "text/plain",
            "content-security-policy": "default-src 'self'",
            "set-cookie": "theme=dark; Path=/",
          },
        });
      },
    };
    resolveSandbox = vi.fn(() => sandbox);
    env.NABUFLOW_SANDBOX = {
      idFromName(value: string) {
        return { value, toString: () => `container:${value}` };
      },
      get: resolveSandbox,
    } as never;
    await coordinator.putRuntime(identity, {
      descriptor: {
        identity,
        projectId: 424_242,
        role: "preview",
        slot: "primary",
        status: "running",
        servicePort: port,
        manifestRevision: "preview-ws-test",
        deploymentVersion: "worker-version-test-1",
        endpoint: null,
        readyAt: new Date(nowMs).toISOString(),
        lastError: null,
      },
      manifest: {
        revision: "preview-ws-test",
        runtime: "node",
        buildCommand: ["node", "--version"],
        startCommand: ["node", "server.mjs"],
        servicePort: port,
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
    } satisfies StoredRuntime);
  });

  function dispatch(request: Request, requestNowMs = nowMs) {
    // Deliberately omit dependencies.sandbox: exercise runtimeSandbox and its
    // runtimeSandboxWebSocketConnect port-routing wrapper, not a fake wsConnect.
    return handlePreviewDataPlaneRequest(request, env, {
      coordinator,
      nowMs: requestNowMs,
    });
  }

  async function redeem() {
    const response = await dispatch(
      new Request(
        `${origin}${PREVIEW_DATA_PREFIX}/${identity}/?__nfg=${encodeURIComponent(vector.token)}`,
      ),
    );
    expect(response?.status).toBe(302);
    expect(resolveSandbox).not.toHaveBeenCalled();
    const cookie = response!.headers.get("set-cookie")!.split(";", 1)[0];
    expect(cookie).toBe(`${cookieName}=${vector.token}`);
    return cookie;
  }

  it.each(["Upgrade", "Upgrade, x-hop, Authorization, x-b5-relay-auth, Sec-WebSocket-Protocol"])(
    "sanitizes the actual raw-stub handshake with Connection: %s",
    async (connection) => {
      const cookie = await redeem();
      const request = new Request(socketUrl, {
        headers: {
          ...platformHeaders,
          Authorization: "Bearer platform-token",
          Cookie: `${cookie}; ${platformCookies}; ${appCookies}; malformed`,
          Connection: connection,
          Upgrade: "WebSocket",
          "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version": "13",
          "Sec-WebSocket-Protocol": "vite-hmr, tenant-chat.v1",
          "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits",
          Origin: "https://mustaflow.com",
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "198.51.100.8",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "http",
          Forwarded: "for=attacker.invalid",
          "keep-alive": "timeout=5",
          "x-hop": "hop-value",
          "x-tenant-channel": "notifications",
        },
      });
      const incomingCookie = request.headers.get("cookie");
      expect(await dispatch(request)).toBe(wsResponse);
      expect(wsRequests).toHaveLength(1);
      expect(httpRequests).toHaveLength(0);
      const upstream = wsRequests[0];
      expect(upstream).not.toBe(request);
      expect(upstream.url).toBe(request.url);
      expect(upstream.method).toBe("GET");
      expect(upstream.headers.get("authorization")).toBeNull();
      for (const name of Object.keys(platformHeaders)) {
        if (name !== "cf-container-target-port") expect(upstream.headers.get(name)).toBeNull();
      }
      expect(upstream.headers.get("cf-container-target-port")).toBe(String(port));
      expect(upstream.headers.get("cookie")).toBe(appCookies);
      expect(upstream.headers.get("connection")).toBe("Upgrade");
      expect(upstream.headers.get("upgrade")).toBe("websocket");
      for (const name of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
        "origin",
        "x-tenant-channel",
      ])
        expect(upstream.headers.get(name)).toBe(request.headers.get(name));
      expect(upstream.headers.get("keep-alive")).toBeNull();
      expect(upstream.headers.get("x-hop")).toBe(connection === "Upgrade" ? "hop-value" : null);
      expect(upstream.headers.get("cf-connecting-ip")).toBeNull();
      expect(upstream.headers.get("x-forwarded-for")).toBe("203.0.113.9");
      expect(upstream.headers.get("x-forwarded-host")).toBe(new URL(origin).host);
      expect(upstream.headers.get("x-forwarded-proto")).toBe("https");
      expect(upstream.headers.get("forwarded")).toContain('for="203.0.113.9"');
      expect(request.headers.get("cookie")).toBe(incomingCookie);
      expect(request.headers.get("authorization")).toBe("Bearer platform-token");
    },
  );

  it("removes platform-only cookies and untrusted forwarding without a connecting IP", async () => {
    const cookie = await redeem();
    await dispatch(
      new Request(socketUrl, {
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          cookie: `${cookie}; ${platformCookies}`,
          "x-forwarded-for": "attacker.invalid",
          forwarded: "for=attacker.invalid",
        },
      }),
    );
    expect(wsRequests).toHaveLength(1);
    expect(wsRequests[0].headers.get("cookie")).toBeNull();
    expect(wsRequests[0].headers.get("x-forwarded-for")).toBeNull();
    expect(wsRequests[0].headers.get("forwarded")).toBeNull();
  });

  it.each([
    "missing",
    "duplicate",
    "unredeemed",
    "tampered",
    "expired",
    "wrong-audience",
    "other-runtime-only",
  ])("rejects %s admission before ordinary WebSocket dispatch", async (failure) => {
    if (failure !== "unredeemed") await redeem();
    let cookie = `${cookieName}=${vector.token}`;
    let requestUrl = socketUrl;
    let requestNowMs = nowMs;
    if (failure === "missing") cookie = appCookies;
    if (failure === "duplicate") cookie = `${cookie}; ${cookie}`;
    if (failure === "tampered") {
      const segments = vector.token.split(".");
      segments[2] = `${segments[2].startsWith("A") ? "B" : "A"}${segments[2].slice(1)}`;
      cookie = `${cookieName}=${segments.join(".")}`;
    }
    if (failure === "expired") requestNowMs = (vector.claims.exp + 6) * 1_000;
    if (failure === "wrong-audience") {
      const otherAudience = new URL(socketUrl);
      otherAudience.hostname = "other-gateway.invalid";
      requestUrl = otherAudience.toString();
    }
    if (failure === "other-runtime-only") {
      cookie = `__Host-nabuflow_preview_other-runtime=${vector.token}; __prs=b5-gate`;
    }
    const response = await dispatch(
      new Request(requestUrl, {
        headers: { connection: "Upgrade", upgrade: "websocket", cookie },
      }),
      requestNowMs,
    );
    expect(response?.status).toBe(401);
    expect(resolveSandbox).not.toHaveBeenCalled();
    expect(wsRequests).toHaveLength(0);
    expect(httpRequests).toHaveLength(0);
  });

  it("retains HTTP app authorization, cookies, body, routing and response hygiene", async () => {
    const cookie = await redeem();
    const body = "tenant-body=a=b";
    const response = await dispatch(
      new Request(`${origin}${PREVIEW_DATA_PREFIX}/${identity}/echo?channel=app`, {
        method: "POST",
        headers: {
          ...platformHeaders,
          authorization: "Bearer tenant-app-token",
          cookie: `${cookie}; ${platformCookies}; ${appCookies}`,
          connection: "keep-alive, x-hop",
          "x-hop": "hop-secret",
          "cf-connecting-ip": "203.0.113.9",
          "x-forwarded-for": "attacker.invalid",
        },
        body,
      }),
    );
    expect(wsRequests).toHaveLength(0);
    expect(httpRequests).toHaveLength(1);
    const upstream = httpRequests[0];
    expect(upstream.port).toBe(port);
    expect(upstream.request.url).toBe("https://tenant.preview.invalid/echo?channel=app");
    expect(upstream.request.method).toBe("POST");
    await expect(upstream.request.text()).resolves.toBe(body);
    expect(upstream.request.headers.get("authorization")).toBe("Bearer tenant-app-token");
    expect(upstream.request.headers.get("cookie")).toBe(appCookies);
    for (const name of Object.keys(platformHeaders)) {
      expect(upstream.request.headers.get(name)).toBeNull();
    }
    expect(upstream.request.headers.get("connection")).toBeNull();
    expect(upstream.request.headers.get("upgrade")).toBeNull();
    expect(upstream.request.headers.get("x-hop")).toBeNull();
    expect(upstream.request.headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("set-cookie")).toBe("theme=dark; Path=/");
    expect(response?.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors");
    await expect(response?.text()).resolves.toBe("http-dispatched");
  });
});
