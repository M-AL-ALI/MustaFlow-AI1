import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONTROL_PROTOCOL_VERSION,
  deriveRuntimeIdentity,
  verifyControlRequestSignature,
  type ProductionArtifactRelease,
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

function markArtifactCommittedForStart(
  provider: CloudflareRuntimeProvider,
  identity: string,
): void {
  const state = provider as unknown as {
    deploymentVersion: string | null;
    controlFeatures: Set<string>;
    deployedArtifacts: Map<
      string,
      { artifactRevision: string; sealedArtifactSha256: string; feature: "artifact-v1" }
    >;
  };
  state.deploymentVersion = "staging-v1";
  state.controlFeatures.add("artifact-v1");
  state.controlFeatures.add("manifest-update-v1");
  state.deployedArtifacts.set(identity, {
    artifactRevision: "artifact-start-follow-1",
    sealedArtifactSha256: "a".repeat(64),
    feature: "artifact-v1",
  });
}

function runningRuntime(identity: string, projectId: number): Record<string, unknown> {
  return {
    runtime: {
      identity,
      projectId,
      role: "preview",
      slot: "primary",
      status: "running",
      servicePort: 8080,
      manifestRevision: "manifest-1",
      deploymentVersion: "staging-v1",
      endpoint: null,
      readyAt: "2026-08-09T23:00:00.000Z",
      lastError: null,
    },
  };
}

function acceptedRelease(identity: string) {
  const hash = (digit: string) => digit.repeat(64);
  return {
    format: "nabuflow.accepted-sealed-release/v1" as const,
    state: "accepted" as const,
    acceptedAt: "2026-08-16T10:00:00.000Z",
    sourceRuntimeIdentity: identity,
    sourceRevision: "source-r5",
    manifest: {
      revision: "manifest-1",
      runtime: "node-api" as const,
      buildCommand: ["npm", "run", "build"],
      startCommand: ["node", "src/index.js"],
      servicePort: 8080,
      healthPath: "/healthz",
      resourceProfile: "dev" as const,
      public: false,
    },
    shelfRevisionId: "pantry-2026-08-16.1",
    shelfRootSha256: hash("1"),
    shelfStateRevision: 1,
    dependencyClosureSha256: hash("2"),
    buildId: `pbuild_${"a".repeat(32)}`,
    buildAttestationSha256: hash("3"),
    artifactRevision: "artifact-r5",
    sealedArtifactSha256: hash("4"),
    contentSha256: hash("5"),
    appArtifactSha256: hash("6"),
    layerContentSha256s: [hash("7")],
    declaredCapabilities: ["database" as const],
  };
}

async function v1Artifact(identity: string) {
  return sealRuntimeArtifact({
    targetRuntimeIdentity: identity,
    manifestRevision: "manifest-1",
    artifactRevision: "artifact-operation-follow-1",
    sourceRevision: "source-operation-follow-1",
    files: [{ path: "server.mjs", content: "console.log('follow')\n" }],
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
    expect(JSON.parse(body)).toMatchObject({
      manifest: {
        runtime: "node-api",
        servicePort: 8080,
        healthPath: "/",
      },
    });
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

  it("preserves the sealed health path when ensuring a Cloudflare runtime", async () => {
    const projectId = 44;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
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
      .mockResolvedValueOnce(json(runningRuntime(identity, projectId)));

    const provider = new CloudflareRuntimeProvider(config);
    await provider.create(projectId, "node-api", undefined, {
      servicePort: 8080,
      healthPath: "/healthz",
    });

    const request = vi.mocked(fetch).mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(request[1].body))).toMatchObject({
      manifest: {
        servicePort: 8080,
        healthPath: "/healthz",
      },
    });
  });

  it("recovers the deterministic project runtime without a database-carried identity", async () => {
    const projectId = 43;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    vi.mocked(fetch).mockResolvedValueOnce(json(runningRuntime(identity, projectId)));

    const provider = new CloudflareRuntimeProvider(config);
    await expect(provider.zeroGenerationRuntimeDescriptorForProject(projectId)).resolves.toEqual({
      identity,
      manifestRevision: "manifest-1",
      status: "running",
      endpoint: null,
    });
  });

  it("returns null only for a typed missing deterministic project runtime", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json(
        {
          ok: false,
          code: "runtime_not_found",
          message: "Runtime not found",
          retryable: false,
          requestId: "runtime-descriptor-missing-44",
        },
        404,
      ),
    );

    const provider = new CloudflareRuntimeProvider(config);
    await expect(provider.zeroGenerationRuntimeDescriptorForProject(44)).resolves.toBeNull();
  });

  it("resumes the exact durable accepted release after the local deployment cache is lost", async () => {
    const projectId = 51;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const release = acceptedRelease(identity);
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, path, body });
      if (path.endsWith("/version") && init?.headers === undefined) {
        return json({ code: "unauthorized" }, 401);
      }
      if (path.endsWith("/version")) {
        return json({
          protocolVersion: CONTROL_PROTOCOL_VERSION,
          deploymentVersion: "staging-v1",
          provider: "cloudflare",
          supportedRoles: ["preview", "production"],
          features: ["artifact-layers-v1", "manifest-update-v1"],
        });
      }
      return json({
        runtime: {
          identity,
          projectId,
          role: "preview",
          slot: "primary",
          status: method === "POST" ? "running" : "stopped",
          servicePort: 8080,
          manifestRevision: release.manifest.revision,
          deploymentVersion: "staging-v1",
          endpoint: null,
          readyAt: method === "POST" ? "2026-08-16T10:10:00.000Z" : null,
          lastError: null,
        },
      });
    });

    const provider = new CloudflareRuntimeProvider(config);
    await expect(
      provider.zeroGenerationStartAcceptedSealedRelease({
        projectId,
        acceptedRelease: release,
      }),
    ).resolves.toMatchObject({ identity, status: "running" });

    const startCall = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/preview/primary/start"),
    );
    expect(startCall?.body).toMatchObject({
      artifactRevision: release.artifactRevision,
      artifactSha256: release.sealedArtifactSha256,
    });
    expect(calls.filter((call) => call.path.includes("/layered-artifacts/"))).toHaveLength(0);
  });

  it("fails closed instead of starting a durable runtime with a mismatched manifest", async () => {
    const projectId = 51;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        runtime: {
          ...(runningRuntime(identity, projectId) as { runtime: Record<string, unknown> }).runtime,
          status: "stopped",
          manifestRevision: "different-manifest",
        },
      }),
    );
    const provider = new CloudflareRuntimeProvider(config);
    await expect(
      provider.zeroGenerationStartAcceptedSealedRelease({
        projectId,
        acceptedRelease: acceptedRelease(identity),
      }),
    ).rejects.toMatchObject({ code: "sealed_release_runtime_mismatch", retryable: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("accepts an offset-corrected acceptance clock without changing the production default", async () => {
    const labNow = Date.parse("2026-08-09T23:00:00.000Z");
    const workerNow = labNow - 3 * 60 * 60_000;
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ code: "unauthorized" }, 401, new Date(workerNow).toUTCString()))
      .mockResolvedValueOnce(
        json(
          {
            protocolVersion: CONTROL_PROTOCOL_VERSION,
            deploymentVersion: "staging-v1",
            provider: "cloudflare",
            supportedRoles: ["preview", "production"],
            features: ["artifact-v1", "manifest-update-v1"],
          },
          200,
          new Date(workerNow).toUTCString(),
        ),
      );
    const provider = new CloudflareRuntimeProvider(config, { now: () => workerNow });
    await expect(provider.ensureInfrastructure()).resolves.toBeUndefined();
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
    const commitIdempotencyKeys: string[] = [];
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
        commitIdempotencyKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (commitIdempotencyKeys.length === 1) {
          return json(
            {
              ok: false,
              code: "request_in_progress",
              message: "The idempotent request is still in progress",
              retryable: true,
              requestId: "layered-commit-pending",
            },
            409,
          );
        }
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
      expect.stringMatching(/^POST .*\/layered-artifacts\/[0-9a-f]{64}\/commit$/u),
      "POST /_nabuflow/control/v1/runtimes/42/preview/primary/start",
    ]);
    expect(new Set(commitIdempotencyKeys).size).toBe(1);
    expect(commitIdempotencyKeys[0]).not.toBe("");
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
    const syntheticStripeSecret = `${["sk", "test"].join("_")}_FAKEONLYNOTAREALSECRET1234567890`;

    await expect(
      provider.syncFiles(identity, 42, [{ path: "fixture.txt", content: syntheticStripeSecret }]),
    ).rejects.toMatchObject({ code: "artifact_secret_detected" });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).not.toContain("/artifacts/");
  });

  it("follows a v1 commit beyond one transport window with exactly one operation key", async () => {
    const projectId = 55;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    let monotonicMs = 0;
    const commitKeys: string[] = [];
    const acceptedOperations = new Set<string>();
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: artifact.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      commitKeys.push(key);
      acceptedOperations.add(key);
      if (commitKeys.length === 1) {
        monotonicMs += 30_001;
        throw new DOMException("transport deadline", "TimeoutError");
      }
      if (commitKeys.length === 2) {
        return json(
          {
            ok: false,
            code: "request_in_progress",
            message: "The idempotent request is still in progress",
            retryable: true,
            requestId: "v1-commit-pending",
          },
          409,
        );
      }
      return json({
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256: artifact.envelope.contentSha256,
        filesWritten: 1,
        materialized: true,
      });
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 60_000 }),
    ).resolves.toMatchObject({ materialized: true, filesWritten: 1 });
    expect(commitKeys).toHaveLength(3);
    expect(new Set(commitKeys).size).toBe(1);
    expect(acceptedOperations.size).toBe(1);
  });

  it("records distinguishable sanitized transport causes and leaves only unknown failures as unreachable", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 57,
      role: "preview",
      slot: "primary",
    });
    const cases = [
      {
        error: new DOMException("deadline", "TimeoutError"),
        code: "control_transport_timeout",
        transportCause: "request_timeout",
      },
      {
        error: Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
        code: "control_transport_connection_reset",
        transportCause: "connection_reset",
      },
      {
        error: new TypeError("fetch failed"),
        code: "control_transport_fetch_exception",
        transportCause: "fetch_exception",
      },
      {
        error: new Error("opaque transport failure"),
        code: "control_plane_unreachable",
        transportCause: "unreachable",
      },
    ] as const;
    for (const entry of cases) {
      vi.mocked(fetch).mockReset();
      vi.mocked(fetch).mockRejectedValue(entry.error);
      const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
      await expect(provider.status(identity)).rejects.toMatchObject({
        status: 503,
        code: entry.code,
        retryable: true,
        transportCause: entry.transportCause,
      });
      expect(fetch).toHaveBeenCalledTimes(4);
    }
  });

  it("keeps repeated ambiguous post-dispatch failures in one followed operation", async () => {
    const projectId = 58;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    let monotonicMs = 0;
    const keys: string[] = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      throw new TypeError("fetch failed");
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);
    await expect(
      provider.start(identity, projectId, { operationTimeoutMs: 2_500 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "runtime_start_terminal_unknown",
      attempts: 3,
      lastObservedOperationState: "transport_fetch_exception_after_dispatch",
      successfulObservationCount: 0,
      transportCauseCounts: { fetch_exception: 3 },
    });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it("reports commit observation blackout separately and late re-observation recovers one durable result", async () => {
    const projectId = 60;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    let monotonicMs = 0;
    let transportBlackout = true;
    let preCommitRequests = 0;
    let commitInitiations = 0;
    let droppedObservations = 0;
    const commitKeys: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        preCommitRequests += 1;
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: artifact.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        preCommitRequests += 1;
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      commitKeys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
      if (commitInitiations === 0) {
        commitInitiations += 1;
        return json(
          {
            ok: false,
            code: "request_in_progress",
            message: "The durable artifact commit is in progress",
            retryable: true,
            requestId: "commit-blackout-initiation",
          },
          409,
        );
      }
      if (transportBlackout) {
        droppedObservations += 1;
        throw new TypeError("fetch failed");
      }
      return json({
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256: artifact.envelope.contentSha256,
        filesWritten: 1,
        materialized: true,
      });
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 2_500 }),
    ).rejects.toMatchObject({
      status: 503,
      code: "artifact_commit_terminal_unknown",
      retryable: true,
      attempts: 3,
      successfulObservationCount: 1,
      transportCauseCounts: { fetch_exception: 2 },
    });
    expect(preCommitRequests).toBe(2);
    expect(commitInitiations).toBe(1);
    expect(droppedObservations).toBe(2);
    transportBlackout = false;
    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 2_500 }),
    ).resolves.toMatchObject({ materialized: true, filesWritten: 1 });
    expect(new Set(commitKeys).size).toBe(1);
    expect(commitKeys[0]).not.toBe("");
  });

  it("floors a fractional monotonic remainder and reaches fetch", async () => {
    const projectId = 61;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: artifact.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      return json({
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256: artifact.envelope.contentSha256,
        filesWritten: 1,
        materialized: true,
      });
    });
    let monotonicMs = 100.125;
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => {
        monotonicMs += 0.375;
        return monotonicMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 2_500 }),
    ).resolves.toMatchObject({ materialized: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("keeps a zero-generation control read inside its caller-owned attempt bound", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.mocked(fetch).mockResolvedValue(json({ ok: true, shelf: "fixture" }));
    const provider = new CloudflareRuntimeProvider(config);

    await expect(
      provider.zeroGenerationControlRequest({
        method: "GET",
        path: "/_nabuflow/control/v1/pantry/revisions/by-root/fixture",
        operationTimeoutMs: 30_000,
      }),
    ).resolves.toEqual({ ok: true, shelf: "fixture" });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(7_287);
    expect(fetch).toHaveBeenCalledTimes(1);
    timeout.mockRestore();
  });

  it("fails fast with typed pre-dispatch evidence and no transport retry storm", async () => {
    const projectId = 62;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      throw new RangeError("fixture pre-dispatch failure");
    });
    const provider = new CloudflareRuntimeProvider(config);
    markArtifactCommittedForStart(provider, identity);

    await expect(provider.deployArtifact(identity, projectId, artifact)).rejects.toMatchObject({
      status: 500,
      code: "control_pre_dispatch_error",
      retryable: false,
      errorClass: "RangeError",
      transportCause: null,
    });
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("does not dispatch when the remaining operation budget is below the named minimum", async () => {
    const projectId = 63;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => 100.25,
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 9.75 }),
    ).rejects.toMatchObject({
      status: 504,
      code: "artifact_transfer_timeout",
      attempts: 0,
      lastObservedOperationState: "not_started",
      operationTimeoutMs: 9.75,
    });
    expect(timeout).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    timeout.mockRestore();
  });

  it("propagates a typed terminal v1 commit failure immediately", async () => {
    const projectId = 56;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    let commitAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: artifact.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      commitAttempts += 1;
      return json(
        {
          ok: false,
          code: "artifact_integrity_mismatch",
          message: "Runtime artifact failed integrity verification",
          retryable: false,
          requestId: "v1-commit-terminal",
        },
        422,
      );
    });
    const provider = new CloudflareRuntimeProvider(config);
    markArtifactCommittedForStart(provider, identity);

    await expect(provider.deployArtifact(identity, projectId, artifact)).rejects.toMatchObject({
      status: 422,
      code: "artifact_integrity_mismatch",
      retryable: false,
    });
    expect(commitAttempts).toBe(1);
  });

  it("observes the server commit deadline terminal inside the named provider margin", async () => {
    const projectId = 59;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    let monotonicMs = 0;
    let commitAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: 1,
        });
      }
      if (path.endsWith("/chunks/0")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      commitAttempts += 1;
      if (commitAttempts === 1) {
        monotonicMs = 269_000;
        return json(
          {
            ok: false,
            code: "request_in_progress",
            message: "The durable artifact commit is in progress",
            retryable: true,
            requestId: "commit-boundary-pending",
          },
          409,
        );
      }
      return json(
        {
          ok: false,
          code: "artifact_commit_abandoned",
          message: "The artifact commit reached its server deadline",
          retryable: false,
          requestId: "commit-boundary-terminal",
        },
        503,
      );
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);
    await expect(provider.deployArtifact(identity, projectId, artifact)).rejects.toMatchObject({
      status: 503,
      code: "artifact_commit_abandoned",
      retryable: false,
    });
    expect(monotonicMs).toBe(270_000);
    expect(commitAttempts).toBe(2);
  });

  it("reports the last commit state when the artifact operation bound expires", async () => {
    const projectId = 57;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const artifact = await v1Artifact(identity);
    let monotonicMs = 0;
    let commitAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/begin")) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunksExpected: artifact.chunks.length,
        });
      }
      if (/\/chunks\/0$/u.test(path)) {
        return json({
          ok: true,
          sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
          chunkIndex: 0,
        });
      }
      commitAttempts += 1;
      monotonicMs += 100;
      return json(
        {
          ok: false,
          code: "request_in_progress",
          message: "The idempotent request is still in progress",
          retryable: true,
          requestId: `v1-commit-pending-${commitAttempts}`,
        },
        409,
      );
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.deployArtifact(identity, projectId, artifact, { operationTimeoutMs: 2_500 }),
    ).rejects.toMatchObject({
      status: 504,
      code: "artifact_commit_timeout",
      operation: "artifact.commit",
      elapsedMs: 2_500,
      attempts: 3,
      lastObservedOperationState: "request_in_progress",
    });
    expect(commitAttempts).toBe(3);
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

  it("follows a start beyond one 30-second transport window using one idempotency key", async () => {
    const projectId = 51;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    let monotonicMs = 0;
    const idempotencyKeys: string[] = [];
    let acceptedOperations = 0;
    const seenOperations = new Set<string>();
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      idempotencyKeys.push(key);
      if (!seenOperations.has(key)) {
        seenOperations.add(key);
        acceptedOperations += 1;
      }
      if (idempotencyKeys.length === 1) {
        monotonicMs += 30_001;
        throw new DOMException("transport deadline", "TimeoutError");
      }
      if (idempotencyKeys.length === 2) {
        return json(
          {
            ok: false,
            code: "request_in_progress",
            message: "The idempotent request is still in progress",
            retryable: true,
            requestId: "start-follow-pending",
          },
          409,
        );
      }
      return json(runningRuntime(identity, projectId));
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(provider.start(identity, projectId, { operationTimeoutMs: 60_000 })).resolves.toBe(
      true,
    );
    expect(idempotencyKeys).toHaveLength(3);
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(idempotencyKeys[0]).not.toBe("");
    expect(acceptedOperations).toBe(1);
  });

  it("propagates a typed terminal start failure immediately", async () => {
    const projectId = 52;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    vi.mocked(fetch).mockResolvedValue(
      json(
        {
          ok: false,
          code: "runtime_start_failed",
          message: "Tenant service failed to start",
          retryable: true,
          requestId: "start-follow-terminal",
        },
        502,
      ),
    );
    const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    markArtifactCommittedForStart(provider, identity);

    await expect(provider.start(identity, projectId)).rejects.toMatchObject({
      status: 502,
      code: "runtime_start_failed",
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("observes the durable runtime-start terminal inside the named margin", async () => {
    const projectId = 520;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    let monotonicMs = 0;
    let attempts = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        monotonicMs = 269_000;
        return json(
          {
            ok: false,
            code: "request_in_progress",
            message: "The durable operation is in progress",
            retryable: true,
            requestId: "runtime-start-boundary-pending",
          },
          409,
        );
      }
      return json(
        {
          ok: false,
          code: "runtime_start_timeout",
          message: "Runtime start did not complete before the execution deadline",
          retryable: false,
          requestId: "runtime-start-boundary-terminal",
        },
        504,
      );
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);
    await expect(provider.start(identity, projectId)).rejects.toMatchObject({
      status: 504,
      code: "runtime_start_timeout",
      retryable: false,
    });
    expect(monotonicMs).toBe(270_000);
    expect(attempts).toBe(2);
  });

  it("reports an evidence-rich typed timeout when start remains in progress", async () => {
    const projectId = 53;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    let monotonicMs = 0;
    vi.mocked(fetch).mockImplementation(async () => {
      monotonicMs += 100;
      return json(
        {
          ok: false,
          code: "request_in_progress",
          message: "The idempotent request is still in progress",
          retryable: true,
          requestId: `start-follow-pending-${monotonicMs}`,
        },
        409,
      );
    });
    const provider = new CloudflareRuntimeProvider(config, {
      monotonicNow: () => monotonicMs,
      sleep: async (delayMs) => {
        monotonicMs += delayMs;
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.start(identity, projectId, { operationTimeoutMs: 2_500 }),
    ).rejects.toMatchObject({
      status: 504,
      code: "runtime_start_timeout",
      retryable: true,
      operation: "runtime-start",
      elapsedMs: 2_500,
      attempts: 3,
      lastObservedOperationState: "request_in_progress",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("cancels a followed start without issuing another operation request", async () => {
    const projectId = 54;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const controller = new AbortController();
    vi.mocked(fetch).mockResolvedValue(
      json(
        {
          ok: false,
          code: "request_in_progress",
          message: "The idempotent request is still in progress",
          retryable: true,
          requestId: "start-follow-cancel",
        },
        409,
      ),
    );
    const provider = new CloudflareRuntimeProvider(config, {
      sleep: async () => {
        controller.abort();
      },
    });
    markArtifactCommittedForStart(provider, identity);

    await expect(
      provider.start(identity, projectId, { signal: controller.signal }),
    ).rejects.toMatchObject({
      status: 499,
      code: "runtime_start_cancelled",
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("follows every audited lifecycle and kitchen mutation with a stable operation key", async () => {
    const projectId = 58;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const cases: Array<{
      name: string;
      run(provider: CloudflareRuntimeProvider): Promise<unknown>;
    }> = [
      {
        name: "runtime.ensure",
        run: (provider) => provider.create(projectId, "node-api"),
      },
      {
        name: "runtime.stop",
        run: (provider) => provider.stop(identity, projectId),
      },
      {
        name: "runtime.destroy",
        run: (provider) => provider.destroy(identity, projectId),
      },
      {
        name: "runtime.exec",
        run: (provider) => provider.exec(identity, ["node", "--version"], projectId),
      },
      {
        name: "runtime.manifest-update",
        run: (provider) =>
          provider.updateRuntimeManifest(identity, projectId, {
            expectedManifestRevision: "manifest-1",
            manifest: {
              revision: "manifest-2",
              runtime: "node-api",
              buildCommand: ["npm", "run", "build"],
              startCommand: ["node", "server.mjs"],
              servicePort: 8080,
              healthPath: "/healthz",
              resourceProfile: "dev",
              public: false,
            },
          }),
      },
      {
        name: "pantry.mutation",
        run: (provider) =>
          provider.zeroGenerationControlRequest({
            method: "POST",
            path: "/_nabuflow/control/v1/pantry/stock-requests",
            body: { fixture: true },
            idempotencyKey: "pantry-follow-fixture",
          }),
      },
      {
        name: "trusted-build.mutation",
        run: (provider) =>
          provider.zeroGenerationControlRequest({
            method: "POST",
            path: "/_nabuflow/control/v1/build-plane/builds",
            body: { fixture: true },
            idempotencyKey: "build-follow-fixture",
          }),
      },
    ];

    for (const fixture of cases) {
      vi.mocked(fetch).mockReset();
      const keys: string[] = [];
      vi.mocked(fetch).mockImplementation(async (input, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key") ?? "");
        if (keys.length === 1) {
          return json(
            {
              ok: false,
              code: "request_in_progress",
              message: "The idempotent request is still in progress",
              retryable: true,
              requestId: `${fixture.name}-pending`,
            },
            409,
          );
        }
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/exec")) {
          return json({ ok: true, stdout: "v22\n", stderr: "", exitCode: 0, timedOut: false });
        }
        if (path.includes("/pantry/") || path.includes("/build-plane/")) {
          return json({ ok: true, fixture: fixture.name });
        }
        if (init?.method === "DELETE") return json({ ok: true });
        return json(runningRuntime(identity, projectId));
      });
      const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
      markArtifactCommittedForStart(provider, identity);

      await expect(fixture.run(provider), fixture.name).resolves.toBeDefined();
      expect(keys, fixture.name).toHaveLength(2);
      expect(new Set(keys).size, fixture.name).toBe(1);
      expect(keys[0], fixture.name).not.toBe("");
    }
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

  it("ensures and releases one opaque project-owned production database identity", async () => {
    const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    const state = provider as unknown as {
      deploymentVersion: string | null;
      controlFeatures: Set<string>;
    };
    state.deploymentVersion = "staging-v1";
    state.controlFeatures.add("production-database-v1");
    const calls: Array<{ method: string; path: string; key: string; body: unknown }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as {
        action: "ensure" | "release";
        allocationIdentity: string;
      };
      calls.push({
        method: String(init?.method),
        path,
        key: new Headers(init?.headers).get("idempotency-key") ?? "",
        body,
      });
      return body.action === "ensure"
        ? json({
            ok: true,
            projectId: 42,
            allocationIdentity: body.allocationIdentity,
            state: "ready",
            capability: { provider: "neon-postgres", name: "database" },
            revision: `production-database-${body.allocationIdentity.slice(0, 48)}`,
            providerProjectId: "provider-project-42",
            reused: false,
          })
        : json({
            ok: true,
            projectId: 42,
            allocationIdentity: body.allocationIdentity,
            state: "released",
            providerProjectId: "provider-project-42",
            verifiedGone: true,
          });
    });

    const ensured = await provider.ensureProductionDatabaseCapability({ projectId: 42 });
    await expect(provider.releaseProductionDatabaseCapability({ projectId: 42 })).resolves.toEqual({
      allocationIdentity: ensured.allocationIdentity,
      providerProjectId: "provider-project-42",
      verifiedGone: true,
    });
    expect(calls.map((call) => [call.method, call.path])).toEqual([
      ["PUT", "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation"],
      [
        "DELETE",
        "/_nabuflow/control/v1/capabilities/42/neon-postgres/database/production-allocation",
      ],
    ]);
    expect(calls[0]?.key).toMatch(
      new RegExp(`^production-database:${ensured.allocationIdentity}:ensure:request-[0-9a-f]{64}$`),
    );
    expect(calls[1]?.key).toMatch(
      new RegExp(
        `^production-database:${ensured.allocationIdentity}:release:request-[0-9a-f]{64}$`,
      ),
    );
    expect(JSON.stringify(calls)).not.toMatch(/connectionString|managementKey|credential/iu);
  });

  it("replays an identical publish prerequisite but uses a fresh wire key after a control-version change", async () => {
    const projectId = 43;
    const seen = new Map<string, string>();
    const calls: Array<{ key: string; body: string }> = [];
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      const body = String(init?.body ?? "");
      const previousBody = seen.get(key);
      calls.push({ key, body });
      if (previousBody !== undefined && previousBody !== body) {
        return json(
          {
            code: "idempotency_conflict",
            message: "The idempotency key was used for a different request",
            retryable: false,
            requestId: "request-conflict",
          },
          409,
        );
      }
      seen.set(key, body);
      const parsed = JSON.parse(body) as { allocationIdentity: string };
      return json({
        ok: true,
        projectId,
        allocationIdentity: parsed.allocationIdentity,
        state: "ready",
        capability: { provider: "neon-postgres", name: "database" },
        revision: `production-database-${parsed.allocationIdentity.slice(0, 48)}`,
        providerProjectId: "provider-project-43",
        reused: calls.length > 1,
      });
    });

    const providerForVersion = (deploymentVersion: string): CloudflareRuntimeProvider => {
      const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
      const state = provider as unknown as {
        deploymentVersion: string | null;
        controlFeatures: Set<string>;
      };
      state.deploymentVersion = deploymentVersion;
      state.controlFeatures.add("production-database-v1");
      return provider;
    };

    const firstProvider = providerForVersion("production-worker-v1");
    await expect(
      firstProvider.ensureProductionDatabaseCapability({ projectId }),
    ).resolves.toMatchObject({ reused: false });
    await expect(
      firstProvider.ensureProductionDatabaseCapability({ projectId }),
    ).resolves.toMatchObject({ reused: true });

    const rotatedProvider = providerForVersion("production-worker-v2");
    await expect(
      rotatedProvider.ensureProductionDatabaseCapability({ projectId }),
    ).resolves.toMatchObject({ reused: true });

    expect(calls).toHaveLength(3);
    expect(calls[0]?.key).toBe(calls[1]?.key);
    expect(calls[0]?.body).toBe(calls[1]?.body);
    expect(calls[2]?.key).not.toBe(calls[0]?.key);
    expect(calls[2]?.body).not.toBe(calls[0]?.body);
    expect(new Set(calls.map((call) => call.key)).size).toBe(2);
  });

  it("promotes, starts, then activates one durable production identity with stable phase keys", async () => {
    const projectId = 84;
    const promotionIdentity = "9".repeat(64);
    const sourceIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "preview",
      slot: "primary",
    });
    const targetIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "production",
      slot: "green",
    });
    const targetRevision = `prod-${promotionIdentity.slice(0, 48)}`;
    const platform = {
      runtime: "node" as const,
      runtimeVersion: "22.18.0",
      nodeAbi: "127",
      os: "linux" as const,
      cpu: "x64" as const,
      libc: "glibc" as const,
      toolchainImageDigest: `sha256:${"8".repeat(64)}`,
    };
    const sourceApp = await sealRuntimeArtifact({
      targetRuntimeIdentity: sourceIdentity,
      manifestRevision: "accepted-manifest-1",
      artifactRevision: "accepted-app-1",
      sourceRevision: "accepted-source-1",
      files: [{ path: "server.mjs", content: "export default { port: 8080 };\n" }],
    });
    const layer = await sealRuntimeArtifactLayer({
      mountPath: "node_modules",
      platform,
      files: [{ path: "express/index.js", content: "export default {};\n" }],
    });
    const sourceArtifact = await sealLayeredRuntimeArtifact({
      app: sourceApp,
      layers: [layer],
      pantryRevision: {
        schemaVersion: 1,
        revisionId: "pantry-2026-08-14.1",
        rootSha256: "4".repeat(64),
        state: "committed",
        stateRevision: 1,
        updatedAt: "2026-08-14T00:00:00.000Z",
      },
      dependencyClosureSha256: "2".repeat(64),
      buildAttestationSha256: "3".repeat(64),
      platform,
      artifactRevision: "accepted-layered-1",
    });
    const targetApp = await sealRuntimeArtifact({
      targetRuntimeIdentity: targetIdentity,
      manifestRevision: targetRevision,
      artifactRevision: `production-${promotionIdentity.slice(0, 48)}`,
      sourceRevision: "accepted-source-1",
      files: [{ path: "server.mjs", content: "export default { port: 8080 };\n" }],
    });
    const targetArtifact = await sealLayeredRuntimeArtifact({
      app: targetApp,
      layers: [layer],
      pantryRevision: sourceArtifact.envelope.content.pantryRevision,
      dependencyClosureSha256: sourceArtifact.envelope.content.dependencyClosureSha256,
      buildAttestationSha256: sourceArtifact.envelope.content.buildAttestationSha256,
      platform,
      artifactRevision: `production-${promotionIdentity.slice(0, 48)}`,
    });
    const acceptedRelease = {
      format: "nabuflow.accepted-sealed-release/v1" as const,
      declaredCapabilities: [],
      state: "accepted" as const,
      acceptedAt: "2026-08-14T12:00:00.000Z",
      sourceRuntimeIdentity: sourceIdentity,
      sourceRevision: "accepted-source-1",
      manifest: {
        revision: "accepted-manifest-1",
        runtime: "node",
        buildCommand: ["npm", "run", "build"],
        startCommand: ["node", "server.mjs"],
        servicePort: 8080,
        healthPath: "/healthz",
        resourceProfile: "dev" as const,
        public: false,
      },
      shelfRevisionId: "pantry-2026-08-14.1",
      shelfRootSha256: "4".repeat(64),
      shelfStateRevision: 1,
      dependencyClosureSha256: "2".repeat(64),
      buildId: `pbuild_zero_${"5".repeat(64)}`,
      buildAttestationSha256: "3".repeat(64),
      artifactRevision: sourceArtifact.envelope.artifactRevision,
      sealedArtifactSha256: sourceArtifact.envelope.sealedArtifactSha256,
      contentSha256: sourceArtifact.envelope.contentSha256,
      appArtifactSha256: sourceArtifact.envelope.content.appArtifact.sealedArtifactSha256,
      layerContentSha256s: sourceArtifact.envelope.content.layers.map(
        (entry) => entry.descriptor.contentSha256,
      ),
    };
    const calls: Array<{ method: string; path: string; key: string; body: string }> = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      calls.push({ method, path, key, body: String(init?.body ?? "") });
      const runtime = {
        identity: targetIdentity,
        projectId,
        role: "production",
        slot: "green",
        status: path.endsWith("/start") ? "running" : "stopped",
        servicePort: 8080,
        manifestRevision: targetRevision,
        deploymentVersion: "staging-v1",
        endpoint: null,
        readyAt: path.endsWith("/start") ? "2026-08-14T12:01:00.000Z" : null,
        lastError: null,
      };
      if (path.endsWith("/promotions/layered")) {
        return json({
          ok: true,
          promotionIdentity,
          sourceSealedArtifactSha256: sourceArtifact.envelope.sealedArtifactSha256,
          targetSealedArtifactSha256: targetArtifact.envelope.sealedArtifactSha256,
          targetContentSha256: targetArtifact.envelope.contentSha256,
          artifactRevision: targetArtifact.envelope.artifactRevision,
          appChunksCopied: targetArtifact.appChunks.length,
          layersReused: 1,
          envelope: targetArtifact.envelope,
        });
      }
      if (path.includes("/routes/") && path.endsWith("/activate")) {
        return json({
          ok: true,
          route: {
            hostname: "canary.apps.mustaflow.com",
            projectId,
            role: "production",
            activeSlot: "green",
            manifestRevision: targetRevision,
            servicePort: 8080,
            sandboxIdentity: targetIdentity,
          },
        });
      }
      return json({ runtime });
    });
    const provider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    const internals = provider as unknown as {
      deploymentVersion: string | null;
      controlFeatures: Set<string>;
    };
    internals.deploymentVersion = "staging-v1";
    internals.controlFeatures.add("artifact-v1");
    internals.controlFeatures.add("manifest-update-v1");
    internals.controlFeatures.add("artifact-layers-v1");
    internals.controlFeatures.add("artifact-promotion-v1");

    const promoted = await provider.promoteProductionArtifact({
      projectId,
      sourceVersionId: 118,
      acceptedRelease,
      targetSlot: "green",
      hostname: "canary.apps.mustaflow.com",
      promotionIdentity,
      expectedPreviousManifestRevision: "prod-previous",
      previousRelease: null,
      operationTimeoutMs: 5_000,
    });
    expect(promoted).toMatchObject({
      runtime: { runtimeId: targetIdentity, status: "running" },
      release: { state: "active", promotionIdentity, targetSlot: "green" },
    });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /_nabuflow/control/v1/runtimes/84/production/green",
      "POST /_nabuflow/control/v1/runtimes/84/production/green/promotions/layered",
      "POST /_nabuflow/control/v1/runtimes/84/production/green/start",
      "POST /_nabuflow/control/v1/routes/canary.apps.mustaflow.com/activate",
    ]);
    expect(
      calls.every((call) => call.key.startsWith(`production-publish:${promotionIdentity}:`)),
    ).toBe(true);
    expect(new Set(calls.map((call) => call.key)).size).toBe(4);

    const previousIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "production",
      slot: "blue",
    });
    const previousRelease: ProductionArtifactRelease = {
      ...promoted.release,
      promotionIdentity: "7".repeat(64),
      targetRuntimeIdentity: previousIdentity,
      targetSlot: "blue",
      targetManifest: { ...promoted.release.targetManifest, revision: "prod-previous" },
      promotedAt: "2026-08-14T11:00:00.000Z",
      activatedAt: "2026-08-14T11:01:00.000Z",
    };
    await expect(
      provider.rollbackProductionArtifactActivation({
        activatedRelease: promoted.release,
        previousRelease,
      }),
    ).resolves.toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: "/_nabuflow/control/v1/routes/canary.apps.mustaflow.com/activate",
    });
    expect(calls.at(-1)?.key).toMatch(
      new RegExp(`^production-publish:${promotionIdentity}:rollback:request-[0-9a-f]{64}$`),
    );
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({
      route: {
        activeSlot: "blue",
        sandboxIdentity: previousIdentity,
        manifestRevision: "prod-previous",
      },
      expectedPreviousManifestRevision: targetRevision,
    });

    calls.length = 0;
    let activationCalls = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const key = new Headers(init?.headers).get("idempotency-key") ?? "";
      calls.push({ method, path, key, body: String(init?.body ?? "") });
      const runtime = {
        identity: targetIdentity,
        projectId,
        role: "production",
        slot: "green",
        status: path.endsWith("/start") ? "running" : "stopped",
        servicePort: 8080,
        manifestRevision: targetRevision,
        deploymentVersion: "staging-v1",
        endpoint: null,
        readyAt: path.endsWith("/start") ? "2026-08-14T12:01:00.000Z" : null,
        lastError: null,
      };
      if (path.endsWith("/promotions/layered")) {
        return json({
          ok: true,
          promotionIdentity,
          sourceSealedArtifactSha256: sourceArtifact.envelope.sealedArtifactSha256,
          targetSealedArtifactSha256: targetArtifact.envelope.sealedArtifactSha256,
          targetContentSha256: targetArtifact.envelope.contentSha256,
          artifactRevision: targetArtifact.envelope.artifactRevision,
          appChunksCopied: targetArtifact.appChunks.length,
          layersReused: 1,
          envelope: targetArtifact.envelope,
        });
      }
      if (path.includes("/routes/") && path.endsWith("/activate")) {
        activationCalls += 1;
        return activationCalls === 1
          ? json(
              {
                ok: false,
                code: "invalid_route_identity",
                message: "Published route identity is invalid for this deployment",
                retryable: false,
                requestId: "activation-failure",
              },
              400,
            )
          : json(
              {
                ok: false,
                code: "route_activation_conflict",
                message: "The published route changed before activation",
                retryable: false,
                requestId: "rollback-conflict",
              },
              409,
            );
      }
      if (method === "DELETE") return json({ ok: true });
      return json({ runtime });
    });
    const failedProvider = new CloudflareRuntimeProvider(config, { sleep: async () => undefined });
    const failedInternals = failedProvider as unknown as {
      deploymentVersion: string | null;
      controlFeatures: Set<string>;
    };
    failedInternals.deploymentVersion = "staging-v1";
    failedInternals.controlFeatures.add("artifact-v1");
    failedInternals.controlFeatures.add("manifest-update-v1");
    failedInternals.controlFeatures.add("artifact-layers-v1");
    failedInternals.controlFeatures.add("artifact-promotion-v1");

    await expect(
      failedProvider.promoteProductionArtifact({
        projectId,
        sourceVersionId: 118,
        acceptedRelease,
        targetSlot: "green",
        hostname: "canary.apps.mustaflow.com",
        promotionIdentity,
        expectedPreviousManifestRevision: "prod-previous",
        previousRelease,
        operationTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "invalid_route_identity" });
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      "PUT /_nabuflow/control/v1/runtimes/84/production/green",
      "POST /_nabuflow/control/v1/runtimes/84/production/green/promotions/layered",
      "POST /_nabuflow/control/v1/runtimes/84/production/green/start",
      "POST /_nabuflow/control/v1/routes/canary.apps.mustaflow.com/activate",
      "POST /_nabuflow/control/v1/routes/canary.apps.mustaflow.com/activate",
      "DELETE /_nabuflow/control/v1/runtimes/84/production/green",
    ]);
    expect(calls.at(-1)?.key).toMatch(
      new RegExp(
        `^production-publish:${promotionIdentity}:discard-candidate:request-[0-9a-f]{64}$`,
      ),
    );
  });
});
