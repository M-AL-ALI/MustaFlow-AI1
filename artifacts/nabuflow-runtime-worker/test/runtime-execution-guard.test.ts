import { describe, expect, it } from "vitest";
import { handleControlRequest } from "../src/worker";
import { RuntimeExecutionRegistry } from "../src/runtime-execution-guard";
import {
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  ensureBody,
  fakeEnv,
  signedRequest,
} from "./helpers";

describe("runtime execution guard", () => {
  it("requires every shared invocation to settle before exclusive cleanup", () => {
    const registry = new RuntimeExecutionRegistry();
    const start = registry.acquire("runtime-a", "start", false)!;
    const upload = registry.acquire("runtime-a", "upload", false)!;
    expect(start).not.toBeNull();
    expect(upload).not.toBeNull();
    expect(registry.acquire("runtime-a", "destroy", true)).toBeNull();
    start.close();
    expect(registry.acquire("runtime-a", "destroy", true)).toBeNull();
    upload.close();
    const destroy = registry.acquire("runtime-a", "destroy", true)!;
    expect(destroy).not.toBeNull();
    expect(registry.acquire("runtime-a", "late-start", false)).toBeNull();
    expect(registry.acquire("runtime-a", "other-destroy", true)).toBeNull();
    destroy.close();
    expect(registry.size).toBe(0);
  });

  it("ignores stale disposal and keeps unrelated project admission independent", () => {
    const registry = new RuntimeExecutionRegistry();
    const old = registry.acquire("runtime-a", "old", true)!;
    old.close();
    const current = registry.acquire("runtime-a", "current", true)!;
    old.close();
    expect(registry.acquire("runtime-a", "start", false)).toBeNull();
    const other = registry.acquire("runtime-b", "start", false)!;
    expect(other).not.toBeNull();
    expect(registry.acquire("runtime-a", "current", true)).toBeNull();
    current.close();
    other.close();
  });

  it("does not unlock an active callback on early disposal and forbids lease reuse", async () => {
    const registry = new RuntimeExecutionRegistry();
    const lease = registry.acquire("runtime-a", "start", false)!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = lease.run(async () => {
      await held;
      return { status: 200, body: { ok: true } };
    });
    lease[Symbol.dispose]();
    expect(registry.acquire("runtime-a", "destroy", true)).toBeNull();
    await expect(lease.run(async () => null)).rejects.toThrow("unavailable");
    release();
    await running;
    const destroy = registry.acquire("runtime-a", "destroy", true)!;
    expect(destroy).not.toBeNull();
    destroy.close();
  });

  it("bounds concurrent admission without affecting other identities", () => {
    const registry = new RuntimeExecutionRegistry();
    const leases = Array.from(
      { length: 128 },
      (_, index) => registry.acquire("runtime-a", String(index), false)!,
    );
    expect(leases.every(Boolean)).toBe(true);
    expect(registry.acquire("runtime-a", "overflow", false)).toBeNull();
    const other = registry.acquire("runtime-b", "start", false)!;
    expect(other).not.toBeNull();
    for (const lease of leases) lease.close();
    other.close();
    expect(registry.size).toBe(0);
  });

  it("releases a callback after exceptions and remains usable", async () => {
    const registry = new RuntimeExecutionRegistry();
    const lease = registry.acquire("runtime-a", "start", false)!;
    await expect(
      lease.run(async () => {
        throw new Error("provider failed");
      }),
    ).rejects.toThrow("provider failed");
    lease.close();
    const destroy = registry.acquire("runtime-a", "destroy", true)!;
    expect(destroy).not.toBeNull();
    destroy.close();
  });

  it("preserves typed endpoint errors and releases the lease", async () => {
    const coordinator = new MemoryCoordinator();
    const response = await handleControlRequest(
      await signedRequest({
        path: "/_nabuflow/control/v1/runtimes/42/preview/primary",
        method: "DELETE",
        body: { locator: ensureBody().locator },
        idempotencyKey: "missing-runtime",
        nonce: "missing-runtime-nonce-0001",
      }),
      fakeEnv(),
      { coordinator, backend: new MockBackend(), nowMs: TEST_NOW_MS },
    );
    expect(response.status).toBe(404);
    expect(coordinator.runtimeExecutions.size).toBe(0);
  });
});
