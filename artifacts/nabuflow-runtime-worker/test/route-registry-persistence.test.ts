import { deriveRuntimeIdentity, type RouteRecord } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { ControlDurableObject } from "../src/control-durable-object";
import {
  ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP,
  ROUTE_POLICY_RECONCILIATION_LEASE_MS,
  ROUTE_POLICY_RECONCILIATION_RETRY_MS,
} from "../src/model";
import { fakeEnv } from "./helpers";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private alarmAt: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<boolean> {
    if (Array.isArray(key)) {
      let deleted = false;
      for (const item of key) deleted = this.values.delete(item) || deleted;
      return deleted;
    }
    return this.values.delete(key);
  }

  async list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(atMs: number): Promise<void> {
    this.alarmAt = atMs;
  }

  fireAlarm(): void {
    this.alarmAt = null;
  }

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

class KeepAliveBackend {
  readonly calls: Array<{ identity: string; keepAlive: boolean }> = [];
  readonly state = new Map<string, boolean>();
  fail = false;

  async setKeepAlive(identity: string, keepAlive: boolean): Promise<void> {
    this.calls.push({ identity, keepAlive });
    if (this.fail) throw new Error("raw-provider-failure-must-not-persist");
    this.state.set(identity, keepAlive);
  }
}

const NOW_MS = 1_788_112_800_000;

async function productionRouteFixture() {
  const projectId = 84;
  const identities = {
    blue: await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "production",
      slot: "blue",
    }),
    green: await deriveRuntimeIdentity({
      namespace: "staging",
      projectId,
      role: "production",
      slot: "green",
    }),
  };
  const route: RouteRecord = {
    hostname: "project-84.apps.mustaflow.com",
    projectId,
    role: "production",
    activeSlot: "blue",
    manifestRevision: "published-manifest-1",
    servicePort: 8080,
    sandboxIdentity: identities.blue,
  };
  return { identities, route };
}

describe("published route Durable Object registry", () => {
  it("survives a fresh Durable Object instance and invalidates deletion immediately", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 84,
      role: "production",
      slot: "blue",
    });
    const route: RouteRecord = {
      hostname: "project-84.apps.mustaflow.com",
      projectId: 84,
      role: "production",
      activeSlot: "blue",
      manifestRevision: "published-manifest-1",
      servicePort: 8080,
      sandboxIdentity: identity,
    };

    const firstInstance = new ControlDurableObject(state, fakeEnv());
    await expect(firstInstance.activateRoute(route, null)).resolves.toBe("activated");
    await expect(firstInstance.getRoute(route.hostname)).resolves.toEqual(route);

    const restartedInstance = new ControlDurableObject(state, fakeEnv());
    await expect(restartedInstance.getRoute(route.hostname)).resolves.toEqual(route);
    await expect(
      restartedInstance.deactivateRoute(
        route.hostname,
        route.manifestRevision,
        route.sandboxIdentity,
      ),
    ).resolves.toBe("deactivated");
    await expect(restartedInstance.getRoute(route.hostname)).resolves.toBeNull();

    const afterDeleteRestart = new ControlDurableObject(state, fakeEnv());
    await expect(afterDeleteRestart.getRoute(route.hostname)).resolves.toBeNull();
  });

  it("converges after a crash immediately after route CAS and before any provider write", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const backend = new KeepAliveBackend();
    const { identities, route } = await productionRouteFixture();
    let nowMs = NOW_MS;
    const firstInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });

    await expect(
      firstInstance.activateRoute(route, null, {
        identities: [identities.blue, identities.green],
        nowMs,
      }),
    ).resolves.toBe("activated");
    expect(backend.calls).toEqual([]);

    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    const restartedInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });
    await restartedInstance.alarm();

    expect(backend.state.get(identities.blue)).toBe(true);
    expect(backend.state.get(identities.green)).toBe(false);
    await expect(
      restartedInstance.getRoutePolicyReconciliation(route.hostname),
    ).resolves.toMatchObject({ state: "completed", terminal: null });
  });

  it("retries idempotently after a crash following the first provider write", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const backend = new KeepAliveBackend();
    const { identities, route } = await productionRouteFixture();
    let nowMs = NOW_MS;
    const crashingInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
      afterRoutePolicyProviderWrite: async () => {
        throw new Error("simulated-isolate-loss");
      },
    });
    await crashingInstance.activateRoute(route, null, {
      identities: [identities.blue, identities.green],
      nowMs,
    });
    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    await expect(crashingInstance.alarm()).rejects.toThrow("simulated-isolate-loss");

    nowMs += ROUTE_POLICY_RECONCILIATION_LEASE_MS;
    storage.fireAlarm();
    const restartedInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });
    await restartedInstance.alarm();

    expect(backend.state.get(identities.blue)).toBe(true);
    expect(backend.state.get(identities.green)).toBe(false);
    await expect(
      restartedInstance.getRoutePolicyReconciliation(route.hostname),
    ).resolves.toMatchObject({ state: "completed", terminal: null });
  });

  it("converges both production slots to sleepable after a deactivate crash", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const backend = new KeepAliveBackend();
    const { identities, route } = await productionRouteFixture();
    let nowMs = NOW_MS;
    const firstInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });
    await firstInstance.activateRoute(route, null, {
      identities: [identities.blue, identities.green],
      nowMs,
    });
    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    await firstInstance.alarm();
    expect(backend.state.get(identities.blue)).toBe(true);

    nowMs += 1;
    await firstInstance.deactivateRoute(route.hostname, route.manifestRevision, identities.blue, {
      identities: [identities.blue, identities.green],
      nowMs,
    });
    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    const restartedInstance = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });
    await restartedInstance.alarm();

    expect(backend.state.get(identities.blue)).toBe(false);
    expect(backend.state.get(identities.green)).toBe(false);
    await expect(
      restartedInstance.getRoutePolicyReconciliation(route.hostname),
    ).resolves.toMatchObject({ state: "completed", terminal: null });
  });

  it("terminalizes sanitized evidence at the retry cap without infinite provider calls", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const backend = new KeepAliveBackend();
    backend.fail = true;
    const { identities, route } = await productionRouteFixture();
    let nowMs = NOW_MS;
    const durable = new ControlDurableObject(state, fakeEnv(), {
      routePolicyBackend: backend,
      nowMs: () => nowMs,
    });
    await durable.activateRoute(route, null, {
      identities: [identities.blue, identities.green],
      nowMs,
    });

    for (let attempt = 0; attempt < ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP; attempt += 1) {
      nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
      storage.fireAlarm();
      await durable.alarm();
    }
    const terminal = await durable.getRoutePolicyReconciliation(route.hostname);
    expect(terminal).toMatchObject({
      state: "failed",
      attempt: ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP,
      terminal: {
        schemaVersion: 1,
        code: "route_policy_reconciliation_exhausted",
        cause: "provider_write_failed",
        attempts: ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP,
        maxAttempts: ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP,
      },
    });
    expect(JSON.stringify(terminal)).not.toContain("raw-provider-failure");
    expect(backend.calls).toHaveLength(ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP);

    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    await durable.alarm();
    expect(backend.calls).toHaveLength(ROUTE_POLICY_RECONCILIATION_ATTEMPT_CAP);

    const failedGeneration = terminal?.generation;
    backend.fail = false;
    nowMs += 1;
    await expect(
      durable.activateRoute(route, route.manifestRevision, {
        identities: [identities.blue, identities.green],
        nowMs,
      }),
    ).resolves.toBe("replay");
    const successor = await durable.getRoutePolicyReconciliation(route.hostname);
    expect(successor).toMatchObject({
      state: "pending",
      generation: (failedGeneration ?? 0) + 1,
      attempt: 0,
      terminal: null,
    });

    nowMs += ROUTE_POLICY_RECONCILIATION_RETRY_MS;
    storage.fireAlarm();
    await durable.alarm();
    const completed = await durable.getRoutePolicyReconciliation(route.hostname);
    expect(completed).toMatchObject({ state: "completed", generation: successor?.generation });

    nowMs += 1;
    await durable.activateRoute(route, route.manifestRevision, {
      identities: [identities.blue, identities.green],
      nowMs,
    });
    await expect(durable.getRoutePolicyReconciliation(route.hostname)).resolves.toMatchObject({
      state: "completed",
      generation: successor?.generation,
    });
  });

  it("persists and conditionally invalidates platform container bindings", async () => {
    const storage = new MemoryDurableStorage();
    const state = { storage } as unknown as DurableObjectState;
    const firstInstance = new ControlDurableObject(state, fakeEnv());
    await firstInstance.bindContainer("container-platform-id-0001", "nrf-runtime-a");

    const restartedInstance = new ControlDurableObject(state, fakeEnv());
    await expect(restartedInstance.getContainerBinding("container-platform-id-0001")).resolves.toBe(
      "nrf-runtime-a",
    );
    await expect(
      restartedInstance.unbindContainer("container-platform-id-0001", "nrf-runtime-b"),
    ).resolves.toBe(false);
    await expect(restartedInstance.getContainerBinding("container-platform-id-0001")).resolves.toBe(
      "nrf-runtime-a",
    );
    await expect(
      restartedInstance.unbindContainer("container-platform-id-0001", "nrf-runtime-a"),
    ).resolves.toBe(true);
    await expect(
      restartedInstance.getContainerBinding("container-platform-id-0001"),
    ).resolves.toBeNull();
  });
});
