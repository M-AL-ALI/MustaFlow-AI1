import { afterEach, describe, expect, it, vi } from "vitest";
import * as SandboxModule from "@cloudflare/sandbox";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import type { StoredRuntime } from "../src/model";
import { CloudflareSandboxBackend } from "../src/runtime-backend";
import { runtimeStopStage } from "../src/runtime-stop-failure";
import { handleControlRequest } from "../src/worker";
import { MemoryCoordinator, TEST_NOW_MS, fakeEnv, signedRequest } from "./helpers";

const setSandboxFactoryForTest = (
  SandboxModule as unknown as {
    setSandboxFactoryForTest: (
      factory: ((namespace: unknown, identity: string, options: unknown) => unknown) | null,
    ) => void;
  }
).setSandboxFactoryForTest;

afterEach(() => {
  setSandboxFactoryForTest(null);
  vi.restoreAllMocks();
});

async function fixture() {
  const locator = { projectId: 42, role: "preview" as const, slot: "primary" as const };
  const identity = await deriveRuntimeIdentity({ namespace: "staging", ...locator });
  const runtime: StoredRuntime = {
    descriptor: {
      identity,
      ...locator,
      status: "running",
      servicePort: 8080,
      manifestRevision: "stop-stage-test",
      deploymentVersion: "worker-version-test-1",
      endpoint: null,
      readyAt: new Date(TEST_NOW_MS).toISOString(),
      lastError: null,
    },
    manifest: {
      revision: "stop-stage-test",
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: ["node", "server.mjs"],
      servicePort: 8080,
      healthPath: "/health",
      resourceProfile: "dev",
      public: false,
    },
    artifactRevision: "stop-stage-artifact",
    artifactSha256: "a".repeat(64),
    processId: "tenant-service",
    stdoutLength: 0,
    stderrLength: 0,
    nextLogSequence: 0,
    logs: [],
  };
  const coordinator = new MemoryCoordinator();
  coordinator.runtimes.set(identity, runtime);
  const env = fakeEnv();
  const backend = new CloudflareSandboxBackend(env);
  return { locator, identity, runtime, coordinator, env, backend };
}

describe("runtime stop failure diagnostics", () => {
  it.each([
    {
      stage: "configuration",
      failingMethod: "configure",
      code: "runtime_stop_configuration_failed",
    },
    {
      stage: "processes",
      failingMethod: "killAllProcesses",
      code: "runtime_stop_process_cleanup_failed",
    },
    { stage: "container", failingMethod: "stop", code: "runtime_stop_container_failed" },
  ] as const)(
    "classifies $stage failure through the signed HTTP handler and replays it",
    async ({ stage, failingMethod, code }) => {
      const f = await fixture();
      const stub = {
        configure: vi.fn(async () => undefined),
        setKeepAlive: vi.fn(async () => undefined),
        killAllProcesses: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        destroy: vi.fn(async () => undefined),
      };
      stub[failingMethod].mockRejectedValue(new Error("PRIVATE_PROVIDER_DETAIL"));
      setSandboxFactoryForTest((_namespace, identity) => {
        expect(identity).toBe(f.identity);
        return stub;
      });
      const stop = vi.spyOn(f.backend, "stop");
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const invoke = async (suffix: string) =>
        handleControlRequest(
          await signedRequest({
            path: "/_nabuflow/control/v1/runtimes/42/preview/primary/stop",
            method: "POST",
            nonce: `stop-stage-${stage}-${suffix}`,
            idempotencyKey: `stop-stage-${stage}`,
            body: { locator: f.locator },
          }),
          f.env,
          { coordinator: f.coordinator, backend: f.backend, nowMs: TEST_NOW_MS },
        );

      const response = await invoke("initial");
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({
        ok: false,
        code,
        retryable: true,
        requestId: expect.any(String),
      });
      expect(JSON.stringify(body)).not.toContain("PRIVATE_PROVIDER_DETAIL");
      expect((await invoke("replay")).status).toBe(503);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stub.destroy).not.toHaveBeenCalled();
      if (stage === "configuration") expect(stub.killAllProcesses).not.toHaveBeenCalled();
      if (stage !== "container") expect(stub.stop).not.toHaveBeenCalled();
    },
  );

  it("preserves successful stop order and targets only its own sandbox", async () => {
    const f = await fixture();
    const calls: string[] = [];
    setSandboxFactoryForTest((_namespace, identity) => {
      expect(identity).toBe(f.identity);
      return {
        configure: async () => {
          calls.push("configure");
        },
        setKeepAlive: async (value: boolean) => {
          expect(value).toBe(false);
          calls.push("keepalive");
        },
        killAllProcesses: async () => {
          calls.push("processes");
        },
        stop: async () => {
          calls.push("container");
        },
      };
    });
    await expect(f.backend.stop(f.runtime)).resolves.toBeUndefined();
    expect(calls).toEqual(["configure", "keepalive", "processes", "container"]);
  });

  it("sanitizes non-Error rejections without calling their conversion hooks", async () => {
    const toString = vi.fn(() => {
      throw new Error("unsafe conversion");
    });
    await expect(
      runtimeStopStage("container", async () => {
        throw { toString };
      }),
    ).rejects.toMatchObject({
      name: "RuntimeStopFailure",
      stage: "container",
      code: "runtime_stop_container_failed",
    });
    expect(toString).not.toHaveBeenCalled();
  });
});
