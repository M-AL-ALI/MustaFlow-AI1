import { afterEach, describe, expect, it, vi } from "vitest";
import { ZERO_GENERATION_ASSEMBLY_RESERVE_MS } from "@workspace/tenant-runtime-contracts";
import { TrustedBuildDurableObject } from "../src/trusted-build-durable-object";
import {
  TRUSTED_BUILD_OPERATION_BOUND_MS,
  TRUSTED_BUILD_QUEUE_WATCHDOG_MS,
  TRUSTED_BUILD_TERMINAL_OBSERVATION_MARGIN_MS,
  type StoredTrustedBuild,
  type TrustedBuildQueueMessage,
  type TrustedBuildWorkerBindings,
} from "../src/trusted-build-model";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;

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

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    let deleted = false;
    for (const key of typeof keyOrKeys === "string" ? [keyOrKeys] : keyOrKeys) {
      deleted = this.values.delete(key) || deleted;
    }
    return deleted;
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const prefix = options?.prefix ?? "";
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }
}

function fixture(): {
  coordinator: TrustedBuildDurableObject;
  queue: TrustedBuildQueueMessage[];
  storage: MemoryDurableStorage;
} {
  const queue: TrustedBuildQueueMessage[] = [];
  const storage = new MemoryDurableStorage();
  const env = {
    TRUSTED_BUILD_QUEUE: {
      async send(message: TrustedBuildQueueMessage) {
        queue.push(structuredClone(message));
      },
    },
    TRUSTED_BUILD_SANDBOX: {},
  } as unknown as TrustedBuildWorkerBindings;
  return {
    coordinator: new TrustedBuildDurableObject({ storage } as unknown as DurableObjectState, env),
    queue,
    storage,
  };
}

const BUILD_ID = `pbuild_${"a".repeat(64)}`;
const REQUEST_ID = `pbuildreq_${"b".repeat(64)}`;
const START_MS = Date.parse("2026-08-16T00:00:00.000Z");

async function begin(coordinator: TrustedBuildDurableObject): Promise<StoredTrustedBuild> {
  const result = await coordinator.begin(
    {
      buildId: BUILD_ID,
      requestId: REQUEST_ID,
      requestSha256: "c".repeat(64),
      createdAt: new Date(START_MS).toISOString(),
      updatedAt: new Date(START_MS).toISOString(),
      requestObjectSha256: "d".repeat(64),
      sourceObjectSha256: "e".repeat(64),
      sourceBytes: 1,
    },
    1,
  );
  if (result.state !== "created") throw new Error("expected a new build");
  return result.build;
}

afterEach(() => vi.useRealTimers());

describe("trusted build absolute deadline", () => {
  it("fits inside the kitchen reserve with a named observation margin", () => {
    expect(TRUSTED_BUILD_OPERATION_BOUND_MS + TRUSTED_BUILD_TERMINAL_OBSERVATION_MARGIN_MS).toBe(
      ZERO_GENERATION_ASSEMBLY_RESERVE_MS,
    );
  });

  it("persists a typed terminal by alarm after every request and consumer dies", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { coordinator, queue, storage } = fixture();
    const created = await begin(coordinator);
    const deadlineAt = START_MS + TRUSTED_BUILD_OPERATION_BOUND_MS;
    expect(created.deadlineAt).toBe(new Date(deadlineAt).toISOString());
    expect(await storage.getAlarm()).toBe(START_MS + TRUSTED_BUILD_QUEUE_WATCHDOG_MS);

    const claimed = await coordinator.claim(
      BUILD_ID,
      new Date(START_MS).toISOString(),
      new Date(deadlineAt + 60_000).toISOString(),
    );
    expect(claimed.state).toBe("claimed");
    await coordinator.transition(
      BUILD_ID,
      1,
      "resolving",
      "building",
      new Date(START_MS + 1).toISOString(),
    );
    await coordinator.bindCell(BUILD_ID, 1, "nbb-dead-consumer");

    vi.setSystemTime(deadlineAt);
    await coordinator.alarm();

    const terminal = await coordinator.get(BUILD_ID);
    expect(terminal).toMatchObject({
      state: "failed",
      attempt: 1,
      leaseUntil: null,
      cellId: null,
      failure: {
        code: "build_timeout",
        status: 504,
        retryable: true,
        failedAt: new Date(deadlineAt).toISOString(),
      },
      attempts: [
        {
          attempt: 1,
          failingStage: { pass: null, stage: "orchestration" },
          error: { code: "build_timeout", status: 504, retryable: true },
        },
      ],
    });
    expect(queue).toEqual([]);
    await expect(
      coordinator.succeed(BUILD_ID, 1, "f".repeat(64), new Date(deadlineAt + 1).toISOString()),
    ).resolves.toBe("conflict");
  });

  it("fails an unconsumed queued build when a late delivery tries to claim it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(START_MS);
    const { coordinator } = fixture();
    await begin(coordinator);
    const deadlineAt = START_MS + TRUSTED_BUILD_OPERATION_BOUND_MS;

    const claim = await coordinator.claim(
      BUILD_ID,
      new Date(deadlineAt).toISOString(),
      new Date(deadlineAt + 60_000).toISOString(),
    );

    expect(claim).toMatchObject({
      state: "terminal",
      build: { state: "failed", failure: { code: "build_timeout", status: 504 } },
    });
  });
});
