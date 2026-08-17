import { afterEach, describe, expect, it, vi } from "vitest";
import * as SandboxModule from "@cloudflare/sandbox";
import { RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS } from "@workspace/tenant-runtime-contracts";
import type { StoredRuntime } from "../src/model";
import { CloudflareSandboxBackend } from "../src/runtime-backend";
import { TEST_NOW_MS, fakeEnv } from "./helpers";

const IDENTITY = "nrf-ab8e18ef4ebebedd-p51-production-green";
const setSandboxFactoryForTest = (
  SandboxModule as unknown as {
    setSandboxFactoryForTest: (
      factory: ((namespace: unknown, identity: string, options: unknown) => unknown) | null,
    ) => void;
  }
).setSandboxFactoryForTest;

function capturedRuntime(): StoredRuntime {
  return {
    descriptor: {
      identity: IDENTITY,
      projectId: 51,
      role: "production",
      slot: "green",
      status: "running",
      servicePort: 8080,
      manifestRevision: "prod-accepted-v158",
      deploymentVersion: "worker-version-test-1",
      endpoint: null,
      readyAt: new Date(TEST_NOW_MS).toISOString(),
      lastError: null,
    },
    manifest: {
      revision: "prod-accepted-v158",
      runtime: "node-api",
      buildCommand: ["npm", "run", "build"],
      startCommand: ["node", "src/index.js"],
      servicePort: 8080,
      healthPath: "/healthz",
      resourceProfile: "production",
      public: true,
    },
    artifactRevision: "accepted-v158",
    artifactSha256: "a".repeat(64),
    processId: "tenant-service",
    stdoutLength: 0,
    stderrLength: 0,
    nextLogSequence: 0,
    logs: [],
  };
}

afterEach(() => {
  setSandboxFactoryForTest(null);
});

describe("runtime availability", () => {
  it("probes the captured identity at its manifest health path and port", async () => {
    const getStatus = vi.fn(async () => "running");
    const containerFetch = vi.fn(async (_request: Request, _port: number) =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    const calls: Array<{ identity: string; options: unknown }> = [];
    setSandboxFactoryForTest((_namespace, identity, options) => {
      calls.push({ identity, options });
      return {
        getProcess: vi.fn(async () => ({ getStatus })),
        containerFetch,
      } as never;
    });

    const result = await new CloudflareSandboxBackend(fakeEnv()).availability(capturedRuntime());

    expect(result).toEqual({ ready: true, stage: "health", cause: "ready", status: 204 });
    expect(calls.map((call) => call.identity)).toEqual([IDENTITY, IDENTITY]);
    expect(calls.at(-1)?.options).toMatchObject({ keepAlive: true, transport: "rpc" });
    expect(containerFetch).toHaveBeenCalledTimes(1);
    const [request, port] = containerFetch.mock.calls[0];
    expect(new URL(request.url).pathname).toBe("/healthz");
    expect(port).toBe(8080);
  });

  it("distinguishes an adopted process with a closed health listener from a stopped process", async () => {
    const runningProcess = vi.fn(async () => ({ getStatus: async () => "running" }));
    setSandboxFactoryForTest(
      () =>
        ({
          getProcess: runningProcess,
          containerFetch: vi.fn(async () => {
            throw new TypeError("private transport detail");
          }),
        }) as never,
    );
    const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
    await expect(backend.availability(capturedRuntime())).resolves.toEqual({
      ready: false,
      stage: "health",
      cause: "health_transport",
      status: null,
    });

    setSandboxFactoryForTest(() => ({ getProcess: vi.fn(async () => null) }) as never);
    await expect(backend.availability(capturedRuntime())).resolves.toEqual({
      ready: false,
      stage: "process",
      cause: "process_missing",
      status: null,
    });
  });

  it("does not treat one ambiguous observation as a terminal reconciliation verdict", async () => {
    const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
    const runtime = capturedRuntime();
    runtime.processId = null;
    const persistedAttempts: number[] = [];
    const availability = vi
      .spyOn(backend, "availability")
      .mockResolvedValueOnce({
        ready: false,
        stage: "health",
        cause: "health_transport",
        status: null,
      })
      .mockImplementationOnce(async () => {
        expect(persistedAttempts).toEqual([1]);
        return { ready: true, stage: "health", cause: "ready", status: 200 };
      });

    await expect(
      backend.reconcile(runtime, async (observation) => {
        persistedAttempts.push(observation.attempt);
      }),
    ).resolves.toEqual({
      ready: true,
      stage: "health",
      cause: "ready",
      status: 200,
      attempts: 2,
      conclusive: true,
      processId: "tenant-service",
      trail: [
        {
          attempt: 1,
          observedAt: new Date(TEST_NOW_MS).toISOString(),
          stage: "health",
          cause: "health_transport",
          status: null,
          sources: ["provider-metadata", "process-probe", "health-probe"],
          decisionInputs: {
            storedStatus: "running",
            storedProcessIdentity: "absent",
            providerProcess: "running",
            health: "unknown",
          },
          decision: "ambiguous",
        },
        {
          attempt: 2,
          observedAt: new Date(TEST_NOW_MS).toISOString(),
          stage: "health",
          cause: "ready",
          status: 200,
          sources: ["provider-metadata", "process-probe", "health-probe"],
          decisionInputs: {
            storedStatus: "running",
            storedProcessIdentity: "absent",
            providerProcess: "running",
            health: "ready",
          },
          decision: "ready",
        },
      ],
    });
    expect(availability).toHaveBeenCalledTimes(2);
    expect(persistedAttempts).toEqual([1, 2]);
  });

  it("returns inconclusive after the named ambiguous-observation cap", async () => {
    const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
    const availability = vi.spyOn(backend, "availability").mockResolvedValue({
      ready: false,
      stage: "health",
      cause: "health_timeout",
      status: null,
    });

    await expect(backend.reconcile(capturedRuntime())).resolves.toEqual({
      ready: false,
      stage: "health",
      cause: "health_timeout",
      status: null,
      attempts: RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS,
      conclusive: false,
      processId: null,
      trail: Array.from(
        { length: RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS },
        (_, index) => ({
          attempt: index + 1,
          observedAt: new Date(TEST_NOW_MS).toISOString(),
          stage: "health" as const,
          cause: "health_timeout" as const,
          status: null,
          sources: ["provider-metadata", "process-probe", "health-probe"] as const,
          decisionInputs: {
            storedStatus: "running" as const,
            storedProcessIdentity: "present" as const,
            providerProcess: "running" as const,
            health: "unknown" as const,
          },
          decision: "ambiguous" as const,
        }),
      ),
    });
    expect(availability).toHaveBeenCalledTimes(RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS);
  });
});
