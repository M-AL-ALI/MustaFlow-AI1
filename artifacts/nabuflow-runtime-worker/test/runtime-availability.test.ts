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
      repairAction: "reregister-and-rebind",
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
          repairAction: "none",
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
          repairAction: "reregister-and-rebind",
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
      repairAction: "none",
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
          repairAction: "none" as const,
        }),
      ),
    });
    expect(availability).toHaveBeenCalledTimes(RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS);
  });

  it("maps the exact e0ecf724 trail to a governed restart under v3", async () => {
    const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
    const runtime = capturedRuntime();
    runtime.descriptor = {
      ...runtime.descriptor,
      identity: "nrf-ab8e18ef4ebebedd-p51-preview-primary",
      role: "preview",
      slot: "primary",
      status: "error",
      manifestRevision:
        "zero-node-v1-f8dd2e2df3487cc3c3c5e8f008266ef4ce0b61ac8dbb7bb56849389784b7e039",
      readyAt: null,
      lastError: "Runtime availability failed (health:health_transport)",
    };
    runtime.manifest.revision = runtime.descriptor.manifestRevision;
    runtime.processId = null;
    const availability = vi.spyOn(backend, "availability").mockResolvedValue({
      ready: false,
      stage: "health",
      cause: "health_transport",
      status: null,
    });

    const result = await backend.reconcile(runtime);

    expect(result).toMatchObject({
      ready: false,
      stage: "health",
      cause: "health_transport",
      attempts: 3,
      conclusive: true,
      processId: null,
      repairAction: "restart-and-rebind",
    });
    expect(result.trail).toEqual([
      expect.objectContaining({ attempt: 1, decision: "ambiguous", repairAction: "none" }),
      expect.objectContaining({ attempt: 2, decision: "ambiguous", repairAction: "none" }),
      expect.objectContaining({
        attempt: 3,
        decision: "repair-required",
        repairAction: "restart-and-rebind",
        decisionInputs: {
          storedStatus: "error",
          storedProcessIdentity: "absent",
          providerProcess: "running",
          health: "unknown",
        },
      }),
    ]);
    expect(availability).toHaveBeenCalledTimes(3);
  });

  it("distinguishes an explicitly stopped preview as healthy idle", async () => {
    const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
    const runtime = capturedRuntime();
    runtime.descriptor.role = "preview";
    runtime.descriptor.slot = "primary";
    runtime.descriptor.status = "stopped";
    runtime.descriptor.readyAt = null;
    runtime.processId = null;
    vi.spyOn(backend, "availability").mockResolvedValue({
      ready: false,
      stage: "process",
      cause: "process_missing",
      status: null,
    });

    await expect(backend.reconcile(runtime)).resolves.toMatchObject({
      conclusive: true,
      repairAction: "settle-idle",
      trail: [expect.objectContaining({ decision: "healthy-idle", repairAction: "settle-idle" })],
    });
  });

  it("requires a governed start for missing processes in damaged preview and both production slots", async () => {
    for (const locator of [
      { role: "preview", slot: "primary" },
      { role: "production", slot: "blue" },
      { role: "production", slot: "green" },
    ] as const) {
      const backend = new CloudflareSandboxBackend(fakeEnv(), () => TEST_NOW_MS);
      const runtime = capturedRuntime();
      runtime.descriptor.role = locator.role;
      runtime.descriptor.slot = locator.slot;
      runtime.descriptor.status = "error";
      runtime.descriptor.readyAt = null;
      runtime.processId = null;
      vi.spyOn(backend, "availability").mockResolvedValue({
        ready: false,
        stage: "process",
        cause: "process_missing",
        status: null,
      });

      await expect(backend.reconcile(runtime)).resolves.toMatchObject({
        conclusive: true,
        repairAction: "restart-and-rebind",
        trail: [
          expect.objectContaining({
            decision: "repair-required",
            repairAction: "restart-and-rebind",
          }),
        ],
      });
    }
  });
});
