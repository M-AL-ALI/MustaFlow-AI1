import { describe, expect, it } from "vitest";
import {
  RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
  type RuntimeReconciliationAuditRecord,
  type RuntimeReconciliationObservation,
} from "@workspace/tenant-runtime-contracts";
import { ControlDurableObject } from "../src/control-durable-object";
import { fakeEnv } from "./helpers";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) {
      this.values.set(key, structuredClone(entry));
    }
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) if (this.values.delete(item)) deleted += 1;
      return deleted;
    }
    return this.values.delete(key);
  }

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

function coordinator(storage: MemoryDurableStorage): ControlDurableObject {
  return new ControlDurableObject({ storage } as unknown as DurableObjectState, fakeEnv());
}

function observation(attempt: number, cause: "health_transport" | "ready") {
  return {
    attempt,
    observedAt: new Date(1_785_859_200_000 + attempt).toISOString(),
    stage: "health",
    cause,
    status: cause === "ready" ? 200 : null,
    sources: ["provider-metadata", "process-probe", "health-probe"],
    decisionInputs: {
      storedStatus: "error",
      storedProcessIdentity: "absent",
      providerProcess: "running",
      health: cause === "ready" ? "ready" : "unknown",
    },
    decision: cause === "ready" ? "ready" : "ambiguous",
  } satisfies RuntimeReconciliationObservation;
}

describe("runtime reconciliation durable observation records", () => {
  it("persists each attempt and its typed terminal across coordinator restarts", async () => {
    const storage = new MemoryDurableStorage();
    const initial: RuntimeReconciliationAuditRecord = {
      requestId: "wall14-durable-request",
      reconciliationId: "wall-14-preview",
      semanticsVersion: RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
      locator: { projectId: 51, role: "preview", slot: "primary" },
      createdAt: "2026-08-17T10:00:00.000Z",
      updatedAt: "2026-08-17T10:00:00.000Z",
      trail: [],
      terminal: null,
    };
    await coordinator(storage).beginRuntimeReconciliation(initial);
    await coordinator(storage).appendRuntimeReconciliationObservation(
      initial.requestId,
      observation(1, "health_transport"),
    );

    const restarted = coordinator(storage);
    await expect(restarted.getRuntimeReconciliation(initial.requestId)).resolves.toMatchObject({
      trail: [{ attempt: 1, cause: "health_transport" }],
      terminal: null,
    });
    await restarted.appendRuntimeReconciliationObservation(
      initial.requestId,
      observation(2, "ready"),
    );
    await restarted.completeRuntimeReconciliation(initial.requestId, {
      at: "2026-08-17T10:00:02.000Z",
      status: 200,
      code: "ok",
      retryable: false,
    });

    await expect(coordinator(storage).getRuntimeReconciliation(initial.requestId)).resolves.toEqual(
      {
        ...initial,
        updatedAt: "2026-08-17T10:00:02.000Z",
        trail: [observation(1, "health_transport"), observation(2, "ready")],
        terminal: {
          at: "2026-08-17T10:00:02.000Z",
          status: 200,
          code: "ok",
          retryable: false,
        },
      },
    );
  });
});
