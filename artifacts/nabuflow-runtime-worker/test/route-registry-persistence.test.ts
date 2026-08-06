import { deriveRuntimeIdentity, type RouteRecord } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { ControlDurableObject } from "../src/control-durable-object";
import { fakeEnv } from "./helpers";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
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
});
