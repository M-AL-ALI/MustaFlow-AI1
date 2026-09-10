import { Buffer } from "node:buffer";
import { deriveRuntimeIdentity, sha256Hex } from "@workspace/tenant-runtime-contracts";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerBindings } from "../src/bindings";
import type { StoredRuntime } from "../src/model";
import { handleWorkerRequest } from "../src/worker";
import {
  PREVIEW_CAPTURE_HEADER,
  PREVIEW_CAPTURE_PORT_HEADER,
  PREVIEW_CAPTURE_FORWARD_ORIGIN,
  PREVIEW_CAPTURE_MAX_PNG_BYTES,
  PREVIEW_CAPTURE_PROVIDER_TIMEOUT_MS,
  PREVIEW_CAPTURE_TTL_MS,
  signCaptureCredential,
  verifyCaptureCredential,
  type PreviewCaptureClaims,
  type PreviewCaptureInput,
} from "../src/preview-capture-policy";
import { MemoryCoordinator, TEST_NOW_MS, TEST_SECRET, fakeEnv, signedRequest } from "./helpers";

const origin = "https://runtime.example";
const endpoint = "/_nabuflow/control/v1/projects/42/preview-capture";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aht8AAAAASUVORK5CYII=",
  "base64",
);
const pngResponse = () => new Response(png, { headers: { "content-type": "image/png" } });
const htmlResponse = () =>
  new Response(
    '<html><head><link rel="stylesheet" href="/assets/main.css"></head><body>Private preview<img src="/assets/logo.svg"></body></html>',
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": "__session=never-forward; Path=/",
        "x-nabuflow-secret": "never-forward",
        link: "<https://external.example/x>; rel=preload",
        "report-to": '{"url":"https://external.example/report"}',
      },
    },
  );

function headersRecord(headers?: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {};
  new Headers(headers).forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

describe("private project preview capture", () => {
  let env: WorkerBindings;
  let coordinator: MemoryCoordinator;
  let input: PreviewCaptureInput;
  let runtime: StoredRuntime;
  let forward: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>;
  let browser: ReturnType<
    typeof vi.fn<(action: "screenshot", options: BrowserRunScreenshotOptions) => Promise<Response>>
  >;
  let hook: (options: BrowserRunScreenshotOptions) => Promise<void>;
  let providerResponse: () => Response;
  let lastCredential: string;

  async function browserRequest(
    options: BrowserRunScreenshotOptions,
    path: string,
    init: RequestInit = {},
  ) {
    return handleWorkerRequest(
      new Request(origin + path, {
        ...init,
        headers: {
          ...options.setExtraHTTPHeaders,
          ...headersRecord(init.headers),
        },
      }),
      env,
      { coordinator, nowMs: TEST_NOW_MS },
    );
  }

  async function capture(
    body: unknown = input,
    options: { path?: string; idempotencyKey?: string; secret?: string; method?: string } = {},
  ) {
    const request = await signedRequest({
      path: options.path ?? endpoint,
      method: options.method ?? "POST",
      body,
      nonce: crypto.randomUUID(),
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
      secret: options.secret,
    });
    return handleWorkerRequest(request, env, { coordinator, nowMs: TEST_NOW_MS });
  }

  beforeEach(async () => {
    env = fakeEnv();
    coordinator = new MemoryCoordinator();
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    input = {
      runtimeIdentity: identity,
      manifestRevision: "capture-1",
      sealedArtifactSha256: "a".repeat(64),
      route: "/",
      viewport: { width: 1, height: 1 },
    };
    runtime = {
      descriptor: {
        identity,
        projectId: 42,
        role: "preview",
        slot: "primary",
        status: "running",
        servicePort: 8080,
        manifestRevision: input.manifestRevision,
        deploymentVersion: "worker-version-test-1",
        endpoint: null,
        readyAt: new Date(TEST_NOW_MS).toISOString(),
        lastError: null,
      },
      manifest: {
        revision: input.manifestRevision,
        runtime: "node",
        buildCommand: ["node", "--version"],
        startCommand: ["node", "server.mjs"],
        servicePort: 8080,
        healthPath: "/health",
        resourceProfile: "dev",
        public: false,
      },
      artifactRevision: "artifact-1",
      artifactSha256: input.sealedArtifactSha256,
      artifactKind: "v1",
      processId: "tenant-service",
      stdoutLength: 0,
      stderrLength: 0,
      nextLogSequence: 0,
      logs: [],
    };
    await coordinator.putRuntime(identity, runtime);
    coordinator.artifacts.set(identity + ":" + input.sealedArtifactSha256, {
      runtimeIdentity: identity,
      state: "committed",
      expiresAtMs: null,
      receivedChunks: [],
      envelope: {
        targetRuntimeIdentity: identity,
        manifestRevision: input.manifestRevision,
        sealedArtifactSha256: input.sealedArtifactSha256,
        contentSha256: "b".repeat(64),
        artifactRevision: "artifact-1",
        sourceRevision: "source-1",
        scan: { policyVersion: "test", zeroMatches: true },
        content: {
          format: "nabu-artifact/v1",
          payloadBytes: 0,
          chunkBytes: 1048576,
          chunks: [],
          files: [],
        },
      },
    });
    forward = vi.fn(async (request: Request) => {
      expect(new URL(request.url).origin).toBe(PREVIEW_CAPTURE_FORWARD_ORIGIN);
      expect(request.headers.get(PREVIEW_CAPTURE_PORT_HEADER)).toBe("8080");
      return htmlResponse();
    });
    env.NABUFLOW_SANDBOX = {
      idFromName: (value: string) => ({ value }),
      get: (id: { value: string }) => {
        expect(id.value).toBe(identity);
        return { fetch: forward };
      },
    } as unknown as WorkerBindings["NABUFLOW_SANDBOX"];
    hook = async () => undefined;
    providerResponse = pngResponse;
    lastCredential = "";
    browser = vi.fn(async (_action: "screenshot", options: BrowserRunScreenshotOptions) => {
      lastCredential = options.setExtraHTTPHeaders?.[PREVIEW_CAPTURE_HEADER] ?? "";
      await browserRequest(options, input.route, {
        headers: { "sec-fetch-dest": "document", accept: "text/html" },
      });
      await hook(options);
      return providerResponse();
    });
    env.BROWSER = { quickAction: browser } as unknown as WorkerBindings["BROWSER"];
  });

  afterEach(() => vi.useRealTimers());

  it("requires the existing signed control authentication", async () => {
    const unsigned = await handleWorkerRequest(
      new Request(origin + endpoint, { method: "POST", body: JSON.stringify(input) }),
      env,
      { coordinator, nowMs: TEST_NOW_MS },
    );
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ ok: false, code: "unauthorized" });
    const bad = await capture(input, { secret: "x".repeat(32) });
    expect(bad.status).toBe(401);
    expect(browser).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it("requires a transport idempotency key but never stores captures in idempotency or audit", async () => {
    expect((await capture(input, { idempotencyKey: "" })).status).toBe(400);
    const key = "capture-api-dedupes";
    for (let index = 0; index < 2; index++) {
      const response = await capture(input, { idempotencyKey: key });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        ok: true,
        capture: {
          mimeType: "image/png",
          base64: png.toString("base64"),
          sha256: await sha256Hex(png),
          width: 1,
          height: 1,
          route: "/",
          runtimeIdentity: input.runtimeIdentity,
          manifestRevision: input.manifestRevision,
          sealedArtifactSha256: input.sealedArtifactSha256,
        },
      });
    }
    expect(browser).toHaveBeenCalledTimes(2);
    expect(coordinator.idempotency.size).toBe(0);
    const audit = JSON.stringify(coordinator.audits);
    expect(audit).not.toContain(png.toString("base64"));
    expect(audit).not.toContain(lastCredential);
    expect(audit).not.toContain(TEST_SECRET);
    expect(coordinator.audits.at(-1)).toMatchObject({
      endpoint: "previewCapture",
      projectId: 42,
      outcome: "ok",
    });
    expect(
      (
        await handleWorkerRequest(
          new Request(origin + "/", { headers: { [PREVIEW_CAPTURE_HEADER]: lastCredential } }),
          env,
          { coordinator, nowMs: TEST_NOW_MS },
        )
      ).status,
    ).toBe(401);
  });

  it.each([
    ["external URL", { route: "https://external.example/" }],
    ["credentials", { route: "//user:password@external.example/" }],
    ["encoded path", { route: "/%5f%6eabuflow/control" }],
    ["platform path", { route: "/_nabuflow/preview/another-runtime/" }],
    ["project path", { route: "/projects/43/" }],
    ["project query", { route: "/?projectId=43" }],
    ["traversal", { route: "/a/../_nabuflow/" }],
    ["oversized viewport", { viewport: { width: 1281, height: 900 } }],
    ["oversized height", { viewport: { width: 1280, height: 901 } }],
    ["fractional viewport", { viewport: { width: 1.5, height: 1 } }],
    ["extra browser option", { html: "<html>untrusted caller</html>" }],
    ["extra viewport option", { viewport: { width: 1, height: 1, deviceScaleFactor: 2 } }],
    ["malformed identity", { runtimeIdentity: "unknown-runtime" }],
    ["invalid hash", { sealedArtifactSha256: "invalid" }],
  ])("rejects %s before browser dispatch", async (_label, change) => {
    expect((await capture({ ...input, ...change })).status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    { namespace: "other", projectId: 42, role: "preview", slot: "primary" },
    { namespace: "staging", projectId: 43, role: "preview", slot: "primary" },
    { namespace: "staging", projectId: 42, role: "production", slot: "blue" },
  ] as const)("rejects namespace/project/role selectors %j", async (selector) => {
    const response = await capture({
      ...input,
      runtimeIdentity: await deriveRuntimeIdentity(selector),
    });
    expect(await response.json()).toMatchObject({
      ok: false,
      code: "preview_capture_selector_mismatch",
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["manifestRevision", "sealedArtifactSha256"] as const)(
    "rejects a mismatched %s",
    async (field) => {
      const response = await capture({
        ...input,
        [field]: field === "manifestRevision" ? "other" : "c".repeat(64),
      });
      expect(response.status).toBe(409);
      expect(browser).not.toHaveBeenCalled();
    },
  );

  it("rejects control query parameters, wrong method and non-HTTPS origins", async () => {
    expect((await capture(input, { path: endpoint + "?v=1" })).status).toBe(400);
    expect((await capture(input, { method: "PUT" })).status).toBe(405);
    const signed = await signedRequest({
      path: endpoint,
      method: "POST",
      body: input,
      nonce: crypto.randomUUID(),
      idempotencyKey: "http-origin",
    });
    // Sign the origin-form path first, then change only the transport origin.
    const insecureRequest = new Request(new URL(endpoint, "http://runtime.example"), {
      method: signed.method,
      headers: signed.headers,
      body: await signed.text(),
    });
    const response = await handleWorkerRequest(insecureRequest, env, {
      coordinator,
      nowMs: TEST_NOW_MS,
    });
    expect(response.status).toBe(400);
    expect(browser).not.toHaveBeenCalled();
  });

  it("rejects absent, stopped and uncommitted witnesses without wake or browser dispatch", async () => {
    coordinator.runtimes.delete(input.runtimeIdentity);
    expect((await capture()).status).toBe(409);
    runtime.descriptor.status = "stopped";
    await coordinator.putRuntime(input.runtimeIdentity, runtime);
    expect((await capture()).status).toBe(409);
    runtime.descriptor.status = "running";
    await coordinator.putRuntime(input.runtimeIdentity, runtime);
    coordinator.artifacts.get(input.runtimeIdentity + ":" + input.sealedArtifactSha256)!.state =
      "pending";
    expect((await capture()).status).toBe(409);
    expect(forward).not.toHaveBeenCalled();
    expect(browser).not.toHaveBeenCalled();
  });

  it("keeps root CSS/assets in the same sandbox and removes every credential and response escape header", async () => {
    hook = async (options) => {
      forward.mockImplementationOnce(async (request) => {
        const headers = headersRecord(request.headers);
        expect(headers).toEqual({
          accept: "text/css",
          "accept-encoding": "identity",
          [PREVIEW_CAPTURE_PORT_HEADER]: "8080",
        });
        expect(new URL(request.url).pathname + new URL(request.url).search).toBe(
          "/assets/main.css?v=1",
        );
        return new Response("body { color: red }", {
          headers: { "content-type": "text/css", "set-cookie": "tenant=secret" },
        });
      });
      const css = await browserRequest(options, "/assets/main.css?v=1", {
        headers: {
          accept: "text/css",
          "sec-fetch-dest": "style",
          authorization: "Bearer user-token",
          cookie: "__session=clerk; tenant=secret",
          "x-nabuflow-signature": "control-secret",
          "cf-connecting-ip": "192.0.2.1",
          "x-forwarded-host": "external.example",
          "x-api-key": "secret",
          "idempotency-key": "caller-key",
        },
      });
      expect(css.status).toBe(200);
      expect(await css.text()).toContain("color: red");
      expect(css.headers.get("set-cookie")).toBeNull();
      forward.mockImplementationOnce(
        async () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      );
      expect(
        (
          await browserRequest(options, "/assets/logo.svg", {
            headers: { "sec-fetch-dest": "image" },
          })
        ).status,
      ).toBe(200);
      const document = await browserRequest(options, "/", {
        headers: { "sec-fetch-dest": "document" },
      });
      for (const header of ["set-cookie", "link", "report-to", "x-nabuflow-secret"])
        expect(document.headers.get(header)).toBeNull();
      expect(document.headers.get("content-security-policy")).toContain("worker-src 'none'");
      expect(document.headers.get("content-security-policy")).toContain("connect-src " + origin);
    };
    expect((await capture()).status).toBe(200);
    const options = browser.mock.calls[0][1];
    expect(options).toMatchObject({
      cacheTTL: 0,
      cookies: [],
      bestAttempt: false,
      viewport: { deviceScaleFactor: 1 },
    });
    const allowed = new RegExp(options.allowRequestPattern![0]);
    expect(allowed.test(origin + "/assets/main.css")).toBe(true);
    for (const url of [
      "https://runtimeXexample/",
      origin + ".external.example/",
      "https://runtime.example@external.example/",
      "wss://runtime.example/",
      "https://external.example/",
    ]) {
      expect(allowed.test(url)).toBe(false);
    }
    expect(options.rejectResourceTypes).toEqual(
      expect.arrayContaining(["websocket", "eventsource", "ping", "prefetch"]),
    );
    expect(Object.keys(options.setExtraHTTPHeaders!)).toEqual([PREVIEW_CAPTURE_HEADER]);
  });

  it.each<[string, string, RequestInit]>([
    ["write", "/assets/file", { method: "POST" }],
    ["upgrade", "/", { headers: { upgrade: "websocket", connection: "Upgrade" } }],
    ["eventsource", "/", { headers: { accept: "text/event-stream" } }],
    ["worker", "/worker.js", { headers: { "sec-fetch-dest": "serviceworker" } }],
    ["control", "/_nabuflow/control/v1/version", {}],
    ["cross-project", "/projects/43/", {}],
  ])("intercepts and blocks %s without ordinary dispatch", async (_label, path, init) => {
    hook = async (options) => {
      const calls = forward.mock.calls.length;
      const response = await browserRequest(options, path, init);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(forward).toHaveBeenCalledTimes(calls);
    };
    const result = await capture();
    expect(await result.json()).toMatchObject({ ok: false, code: "preview_capture_render_failed" });
  });

  it("rejects expired, tampered, wrong-purpose and wrong-audience credentials", () => {
    const claims: PreviewCaptureClaims = {
      runtimeIdentity: input.runtimeIdentity,
      manifestRevision: input.manifestRevision,
      sealedArtifactSha256: input.sealedArtifactSha256,
      route: "/",
      projectId: 42,
      purpose: "nabuflow-preview-capture",
      namespace: "staging",
      origin,
      port: 8080,
      witnessSha256: "d".repeat(64),
      jti: crypto.randomUUID(),
      iat: TEST_NOW_MS,
      exp: TEST_NOW_MS + PREVIEW_CAPTURE_TTL_MS,
    };
    const token = signCaptureCredential(TEST_SECRET, claims);
    expect(verifyCaptureCredential(TEST_SECRET, token, origin, "staging", TEST_NOW_MS)).toEqual(
      claims,
    );
    expect(() =>
      verifyCaptureCredential(TEST_SECRET, token, origin, "staging", claims.exp),
    ).toThrow();
    expect(() =>
      verifyCaptureCredential(TEST_SECRET, "x" + token.slice(1), origin, "staging", TEST_NOW_MS),
    ).toThrow();
    expect(() =>
      verifyCaptureCredential(
        TEST_SECRET,
        token,
        "https://another.example",
        "staging",
        TEST_NOW_MS,
      ),
    ).toThrow();
    expect(() =>
      verifyCaptureCredential(TEST_SECRET, token, origin, "production", TEST_NOW_MS),
    ).toThrow();
    const wrongPurpose = signCaptureCredential(TEST_SECRET, {
      ...claims,
      purpose: "other",
    } as unknown as PreviewCaptureClaims);
    expect(() =>
      verifyCaptureCredential(TEST_SECRET, wrongPurpose, origin, "staging", TEST_NOW_MS),
    ).toThrow();
  });

  it("blocks upstream external redirects and fails even if the browser returns PNG", async () => {
    hook = async (options) => {
      forward.mockImplementationOnce(async (request) => {
        expect(request.redirect).toBe("manual");
        return Response.redirect("https://external.example/steal", 302);
      });
      const response = await browserRequest(options, "/assets/main.css");
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({ code: "preview_capture_redirect_blocked" });
    };
    expect(await (await capture()).json()).toMatchObject({
      ok: false,
      code: "preview_capture_render_failed",
    });
  });

  it("fails preflight for non-HTML documents and never invokes the browser", async () => {
    forward.mockImplementation(
      async () => new Response("not html", { headers: { "content-type": "text/plain" } }),
    );
    expect(await (await capture()).json()).toMatchObject({
      code: "preview_capture_document_unavailable",
    });
    expect(browser).not.toHaveBeenCalled();
  });

  it("fails when browser binding is missing", async () => {
    delete env.BROWSER;
    expect(await (await capture()).json()).toMatchObject({
      ok: false,
      code: "preview_capture_browser_unavailable",
    });
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([
    "exception",
    "status",
    "mime",
    "signature",
    "dimensions",
    "size",
    "missing-document",
  ] as const)("fails provider result %s without an image placeholder", async (failure) => {
    if (failure === "exception")
      browser.mockRejectedValue(new Error("provider failed with sensitive details"));
    if (failure === "status") providerResponse = () => new Response("error", { status: 503 });
    if (failure === "mime")
      providerResponse = () => new Response(png, { headers: { "content-type": "text/plain" } });
    if (failure === "signature")
      providerResponse = () =>
        new Response("not png", { headers: { "content-type": "image/png" } });
    if (failure === "dimensions") input.viewport = { width: 1280, height: 900 };
    if (failure === "size")
      providerResponse = () =>
        new Response(new Uint8Array(PREVIEW_CAPTURE_MAX_PNG_BYTES + 1), {
          headers: { "content-type": "image/png" },
        });
    if (failure === "missing-document") browser.mockImplementation(async () => pngResponse());
    const response = await capture();
    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.capture).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("sensitive details");
    expect(coordinator.idempotency.size).toBe(0);
  });

  it("bounds provider duration and closes its credential", async () => {
    vi.useFakeTimers();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    browser.mockImplementation(async (_action, options) => {
      lastCredential = options.setExtraHTTPHeaders![PREVIEW_CAPTURE_HEADER];
      entered();
      return new Promise<Response>(() => undefined);
    });
    const pending = capture();
    await started;
    await vi.advanceTimersByTimeAsync(PREVIEW_CAPTURE_PROVIDER_TIMEOUT_MS + 1);
    const response = await pending;
    expect(await response.json()).toMatchObject({ code: "preview_capture_timeout" });
    expect(
      (
        await handleWorkerRequest(
          new Request(origin + "/", { headers: { [PREVIEW_CAPTURE_HEADER]: lastCredential } }),
          env,
          { coordinator, nowMs: TEST_NOW_MS },
        )
      ).status,
    ).toBe(401);
  });

  it("rejects a changed witness after capture", async () => {
    hook = async () => {
      runtime.manifest.startCommand = ["node", "different.mjs"];
      await coordinator.putRuntime(input.runtimeIdentity, runtime);
    };
    expect(await (await capture()).json()).toMatchObject({
      ok: false,
      code: "preview_capture_witness_changed",
    });
  });

  it("remembers a subrequest witness failure even if the witness is restored before completion", async () => {
    hook = async (options) => {
      const original = structuredClone(runtime);
      runtime.artifactSha256 = "c".repeat(64);
      await coordinator.putRuntime(input.runtimeIdentity, runtime);
      expect((await browserRequest(options, "/assets/main.css")).status).toBe(409);
      await coordinator.putRuntime(input.runtimeIdentity, original);
    };
    expect(await (await capture()).json()).toMatchObject({
      ok: false,
      code: "preview_capture_render_failed",
    });
  });
});
