import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  deriveRuntimeIdentity,
  verifyControlRequestSignature,
} from "@workspace/tenant-runtime-contracts";
import { CloudflareRuntimeProvider } from "./cloudflare-runtime-provider";
import { RuntimeProviderUnavailableError } from "./tenant-runtime-provider";
import { sealRuntimeArtifact } from "./runtime-artifact";
import { sealLayeredRuntimeArtifact, sealRuntimeArtifactLayer } from "./runtime-artifact-layers";

const token = "control-token-with-at-least-thirty-two-characters";
const config = {
  controlUrl: "https://runtime.example.test",
  controlToken: token,
  deploymentNamespace: "staging",
};

function json(
  body: unknown,
  status = 200,
  date = new Date().toUTCString(),
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      date,
      ...Object.fromEntries(new Headers(headers)),
    },
  });
}

describe("CloudflareRuntimeProvider", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it("performs a clock check and signs lifecycle requests", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        json({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          deploymentVersion: "staging-v1",
          provider: "cloudflare",
          supportedRoles: ["preview", "production"],
          features: ["artifact-v1", "manifest-update-v1"],
        }),
      )
      .mockResolvedValueOnce(
        json({
          runtime: {
            identity,
            projectId: 42,
            role: "preview",
            slot: "primary",
            status: "stopped",
            servicePort: 8080,
            manifestRevision: "project-42-runtime-v1",
            deploymentVersion: "staging-v1",
            endpoint: null,
            readyAt: null,
            lastError: null,
          },
        }),
      );

    const provider = new CloudflareRuntimeProvider(config);
    await expect(provider.create(42, "node-api")).resolves.toMatchObject({
      runtimeId: identity,
      servicePort: 8080,
    });

    const request = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
    const init = request[1];
    const headers = new Headers(init.headers);
    const body = String(init.body);
    await expect(
      verifyControlRequestSignature(
        token,
        {
          method: "PUT",
          pathAndQuery: "/_nabuflow/control/v1/runtimes/42/preview/primary",
          timestamp: headers.get("x-nabuflow-timestamp")!,
          nonce: headers.get("x-nabuflow-nonce")!,
          bodySha256: headers.get("x-nabuflow-body-sha256")!,
          idempotencyKey: headers.get("idempotency-key")!,
          signature: headers.get("x-nabuflow-signature")!,
          body,
        },
        { consumeOnce: async () => true },
      ),
    ).resolves.toEqual({ ok: true });
  });

  it("routes syncFiles through sealed begin, raw chunk, commit, and committed start", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    let sealedArtifactSha256 = "";
    let contentSha256 = "";
    const calls: Array<{ path: string; method: string; contentType: string | null }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      calls.push({ path, method, contentType: headers.get("content-type") });
      if (path.endsWith("/version") && init?.headers === undefined) {
        return json({ ok: false }, 401);
      }
      if (path.endsWith("/version")) {
        return json({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          deploymentVersion: "staging-v1",
          provider: "cloudflare",
          supportedRoles: ["preview", "production"],
          features: ["artifact-v1", "manifest-update-v1"],
        });
      }
      if (path.endsWith("/begin")) {
        const body = JSON.parse(String(init?.body)) as {
          envelope: {
            sealedArtifactSha256: string;
            contentSha256: string;
            content: { chunks: string[] };
          };
        };
        sealedArtifactSha256 = body.envelope.sealedArtifactSha256;
        contentSha256 = body.envelope.contentSha256;
        return json({
          ok: true,
          sealedArtifactSha256,
          chunksExpected: body.envelope.content.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return json({ ok: true, sealedArtifactSha256, chunkIndex: 0 });
      }
      if (path.endsWith("/commit")) {
        return json({
          ok: true,
          sealedArtifactSha256,
          contentSha256,
          filesWritten: 1,
          materialized: true,
        });
      }
      return json({
        runtime: {
          identity,
          projectId: 42,
          role: "preview",
          slot: "primary",
          status: method === "POST" ? "running" : "stopped",
          servicePort: 8080,
          manifestRevision: "manifest-1",
          deploymentVersion: "staging-v1",
          endpoint: null,
          readyAt: null,
          lastError: null,
        },
      });
    });

    const provider = new CloudflareRuntimeProvider(config);
    await provider.ensureInfrastructure();
    await provider.syncFiles(identity, 42, [{ path: "server.mjs", content: "safe source" }]);
    await expect(provider.start(identity, 42)).resolves.toBe(true);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "GET /_nabuflow/control/v1/version",
      "GET /_nabuflow/control/v1/version",
      "GET /_nabuflow/control/v1/runtimes/42/preview/primary",
      expect.stringMatching(/^POST .*\/artifacts\/[0-9a-f]{64}\/begin$/u),
      expect.stringMatching(/^PUT .*\/artifacts\/[0-9a-f]{64}\/chunks\/0$/u),
      expect.stringMatching(/^POST .*\/artifacts\/[0-9a-f]{64}\/commit$/u),
      "POST /_nabuflow/control/v1/runtimes/42/preview/primary/start",
    ]);
    expect(calls[4].contentType).toBe("application/octet-stream");
    expect(sealedArtifactSha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("routes additive app and dependency chunks through the layered dock capability", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    const platform = {
      runtime: "node" as const,
      runtimeVersion: "22.18.0",
      nodeAbi: "127",
      os: "linux" as const,
      cpu: "x64" as const,
      libc: "glibc" as const,
      toolchainImageDigest: `sha256:${"1".repeat(64)}`,
    };
    const app = await sealRuntimeArtifact({
      targetRuntimeIdentity: identity,
      manifestRevision: "manifest-1",
      artifactRevision: "app-1",
      sourceRevision: "source-1",
      files: [{ path: "server.mjs", content: "console.log('app')\n" }],
    });
    const layer = await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform,
      files: [{ path: "demo/index.js", content: "export default 42;\n" }],
    });
    const artifact = await sealLayeredRuntimeArtifact({
      app,
      layers: [layer],
      pantryRevision: {
        schemaVersion: 1,
        revisionId: "pantry-2026-08-08.1",
        rootSha256: "4".repeat(64),
        state: "committed",
        stateRevision: 1,
        updatedAt: "2026-08-08T00:00:00.000Z",
      },
      dependencyClosureSha256: "2".repeat(64),
      buildAttestationSha256: "3".repeat(64),
      platform,
      artifactRevision: "layered-1",
    });
    const calls: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      calls.push(`${method} ${path}`);
      if (path.endsWith("/version") && init?.headers === undefined) return json({ ok: false }, 401);
      if (path.endsWith("/version")) {
        return json({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          deploymentVersion: "staging-v1",
          provider: "cloudflare",
          supportedRoles: ["preview", "production"],
          features: ["artifact-v1", "manifest-update-v1", "artifact-layers-v1"],
        });
      }
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          appChunksExpected: 1,
          layersExpected: 1,
          layerContentSha256ToUpload: [
            artifact.envelope.content.layers[0].descriptor.contentSha256,
          ],
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        const layerSha = artifact.envelope.content.layers[0].descriptor.contentSha256;
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          contentSha256: path.includes(`/layers/${layerSha}/`)
            ? layerSha
            : app.envelope.contentSha256,
          chunkIndex: 0,
        });
      }
      if (path.endsWith("/commit")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          contentSha256: artifact.envelope.contentSha256,
          filesWritten: 2,
          layersMaterialized: 1,
          materialized: true,
        });
      }
      return json({
        runtime: {
          identity,
          projectId: 42,
          role: "preview",
          slot: "primary",
          status: "running",
          servicePort: 8080,
          manifestRevision: "manifest-1",
          deploymentVersion: "staging-v1",
          endpoint: null,
          readyAt: null,
          lastError: null,
        },
      });
    });

    const provider = new CloudflareRuntimeProvider(config);
    await provider.ensureInfrastructure();
    await expect(provider.deployLayeredArtifact(identity, 42, artifact)).resolves.toMatchObject({
      filesWritten: 2,
      layersMaterialized: 1,
    });
    await expect(provider.start(identity, 42)).resolves.toBe(true);
    expect(calls).toEqual([
      "GET /_nabuflow/control/v1/version",
      "GET /_nabuflow/control/v1/version",
      expect.stringMatching(/^POST .*\/layered-artifacts\/[0-9a-f]{64}\/begin$/u),
      expect.stringMatching(/^PUT .*\/layered-artifacts\/[0-9a-f]{64}\/app\/chunks\/0$/u),
      expect.stringMatching(
        /^PUT .*\/layered-artifacts\/[0-9a-f]{64}\/layers\/[0-9a-f]{64}\/chunks\/0$/u,
      ),
      expect.stringMatching(/^POST .*\/layered-artifacts\/[0-9a-f]{64}\/commit$/u),
      "POST /_nabuflow/control/v1/runtimes/42/preview/primary/start",
    ]);
  });

  it("refuses a fake credential before any artifact upload begins", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "preview",
      slot: "primary",
    });
    vi.mocked(fetch).mockResolvedValue(
      json({
        runtime: {
          identity,
          projectId: 42,
          role: "preview",
          slot: "primary",
          status: "stopped",
          servicePort: 8080,
          manifestRevision: "manifest-1",
          deploymentVersion: "staging-v1",
          endpoint: null,
          readyAt: null,
          lastError: null,
        },
      }),
    );
    const provider = new CloudflareRuntimeProvider(config);

    await expect(
      provider.syncFiles(identity, 42, [
        { path: "fixture.txt", content: "sk_test_FAKEONLYNOTAREALSECRET1234567890" },
      ]),
    ).rejects.toMatchObject({ code: "artifact_secret_detected" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("/artifacts/");
  });

  it("fails the self-check when the Worker clock is outside the signing window", async () => {
    vi.mocked(fetch).mockResolvedValue(json({}, 200, new Date(Date.now() + 120_000).toUTCString()));
    const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    await expect(provider.runSelfCheck()).resolves.toBe("error");
    expect(provider.getSubsystemStatus()).toBe("error");
  });

  it("preserves explicit control-plane unavailability details", async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      json(
        {
          ok: false,
          code: "sandbox_capacity_unavailable",
          message: "No sandbox capacity is currently available",
          retryable: true,
          requestId: "request-1",
        },
        503,
      ),
    );
    const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    await expect(
      provider.status(
        await deriveRuntimeIdentity({
          namespace: "staging",
          projectId: 7,
          role: "preview",
          slot: "primary",
        }),
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "sandbox_capacity_unavailable",
      retryable: true,
    });
  });

  it("retries raw 1101-class and typed first-start 502 responses with bounded backoff", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 8,
      role: "preview",
      slot: "primary",
    });
    const delays: number[] = [];
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response("<html><title>Worker threw exception</title><h1>Error 1101</h1></html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            code: "runtime_start_failed",
            message: "Tenant service failed to start",
            retryable: true,
            requestId: "request-starting",
          },
          502,
        ),
      )
      .mockResolvedValueOnce(
        json({
          runtime: {
            identity,
            projectId: 8,
            role: "preview",
            slot: "primary",
            status: "running",
            servicePort: 8080,
            manifestRevision: "manifest-1",
            deploymentVersion: "staging-v1",
            endpoint: null,
            readyAt: null,
            lastError: null,
          },
        }),
      );
    const provider = new CloudflareRuntimeProvider(config, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(provider.status(identity)).resolves.toBe("running");
    expect(delays).toEqual([100, 250]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("retries a transient invalid signature during secret propagation", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 9,
      role: "preview",
      slot: "primary",
    });
    const delays: number[] = [];
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        json(
          {
            ok: false,
            code: "invalid_signature",
            message: "The control request signature is invalid",
            retryable: false,
            requestId: "request-propagating",
          },
          401,
        ),
      )
      .mockResolvedValueOnce(
        json({
          runtime: {
            identity,
            projectId: 9,
            role: "preview",
            slot: "primary",
            status: "stopped",
            servicePort: 8080,
            manifestRevision: "manifest-1",
            deploymentVersion: "staging-v1",
            endpoint: null,
            readyAt: null,
            lastError: null,
          },
        }),
      );
    const provider = new CloudflareRuntimeProvider(config, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(provider.status(identity)).resolves.toBe("stopped");
    expect(delays).toEqual([100]);
  });

  it("stops retrying a persistent raw Worker exception after four attempts", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 10,
      role: "preview",
      slot: "primary",
    });
    const delays: number[] = [];
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response("<html><title>Worker threw exception</title><h1>Error 1101</h1></html>", {
          status: 500,
          headers: { "content-type": "text/html" },
        }),
    );
    const provider = new CloudflareRuntimeProvider(config, {
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
    });

    await expect(provider.status(identity)).rejects.toMatchObject({
      status: 500,
      code: "cloudflare_worker_exception",
      retryable: true,
    });
    expect(delays).toEqual([100, 250, 500]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("maps every unsupported capability to an explicit unavailable error", async () => {
    const provider = new CloudflareRuntimeProvider(config);
    const unsupported: Array<[string, () => unknown]> = [
      ["secret-environment-at-create", () => provider.create(1, null, { SECRET: "value" })],
      ["file-write", () => provider.writeFile("runtime", "app.ts", "", 1)],
      ["secret-environment", () => provider.updateEnvironment("runtime", 1, {})],
      ["secret-environment", () => provider.restartWithProjectEnvironment(1, {})],
      ["artifact-provision", () => provider.provision(1, [])],
      ["production-create", () => provider.createProduction(1, {})],
      ["production-deploy", () => provider.deployProduction(1, null, [], {})],
      ["idle-behavior", () => provider.configureIdleBehavior()],
      ["health-sidecar", () => provider.startHealthService()],
      ["health-sidecar", () => provider.stopHealthService()],
    ];

    for (const [capability, operation] of unsupported) {
      await expect(Promise.resolve().then(operation)).rejects.toMatchObject({
        code: "runtime_provider_capability_unavailable",
        capability,
      });
    }
    expect(() => provider.resolveEndpoint()).toThrow(RuntimeProviderUnavailableError);
    expect(() => provider.startLogStream()).toThrow(
      expect.objectContaining({ capability: "log-tail" }),
    );
  });
});
