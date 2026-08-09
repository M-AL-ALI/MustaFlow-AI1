import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlDurableObject } from "../src/control-durable-object";
import type { StoredArtifactCommitJob } from "../src/model";
import { fakeEnv } from "./helpers";

class MemoryDurableStorage {
  private readonly values = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const item of key) if (this.values.delete(item)) deleted += 1;
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

  async transaction<T>(callback: (transaction: MemoryDurableStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }
}

function coordinator(storage = new MemoryDurableStorage()): ControlDurableObject {
  return new ControlDurableObject({ storage } as unknown as DurableObjectState, fakeEnv());
}

const claim = {
  key: "artifact-commit-idempotency-1",
  fingerprint: "f".repeat(64),
  kind: "layers-v1" as const,
  runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
  sealedArtifactSha256: "a".repeat(64),
};

afterEach(() => vi.useRealTimers());

describe("artifact commit coordinator leases", () => {
  it("preserves live-owner in-progress semantics and adopts an expired lease at its checkpoint", async () => {
    const durable = coordinator();
    const first = await durable.claimArtifactCommit({ ...claim, ownerId: "owner-1", nowMs: 1_000 });
    expect(first.state).toBe("new");
    if (first.state !== "new") throw new Error("expected a new job");

    await durable.checkpointArtifactCommit({
      jobKey: first.job.jobKey,
      ownerId: "owner-1",
      checkpoint: "verification-complete",
      nowMs: 2_000,
    });
    await expect(
      durable.claimArtifactCommit({ ...claim, ownerId: "owner-2", nowMs: 10_000 }),
    ).resolves.toEqual({ state: "pending" });

    const adopted = await durable.claimArtifactCommit({
      ...claim,
      ownerId: "owner-2",
      nowMs: 17_000,
    });
    expect(adopted.state).toBe("adopted");
    if (adopted.state !== "adopted") throw new Error("expected adoption");
    expect(adopted.job).toMatchObject({
      checkpoint: "verification-complete",
      ownerId: "owner-2",
      attempt: 2,
    });
  });

  it("creates a fresh job when nothing durable exists and rejects a conflicting payload", async () => {
    const durable = coordinator();
    await expect(
      durable.claimArtifactCommit({ ...claim, ownerId: "owner-1", nowMs: 1_000 }),
    ).resolves.toMatchObject({ state: "new", job: { checkpoint: "initialized", attempt: 1 } });
    await expect(
      durable.claimArtifactCommit({
        ...claim,
        fingerprint: "e".repeat(64),
        ownerId: "owner-2",
        nowMs: 17_000,
      }),
    ).resolves.toEqual({ state: "conflict" });
  });

  it("alarms an abandoned job into a typed terminal response without a retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new MemoryDurableStorage();
    const durable = coordinator(storage);
    const first = await durable.claimArtifactCommit({ ...claim, ownerId: "owner-1", nowMs: 1_000 });
    expect(first.state).toBe("new");

    vi.setSystemTime(46_001);
    await durable.alarm();
    const replay = await durable.claimArtifactCommit({
      ...claim,
      ownerId: "owner-2",
      nowMs: 46_001,
    });
    expect(replay).toEqual({
      state: "replay",
      response: {
        status: 503,
        body: {
          ok: false,
          code: "artifact_commit_abandoned",
          message: "The artifact commit owner disappeared before the operation completed",
          retryable: false,
        },
      },
    });
    const jobs = await storage.list<StoredArtifactCommitJob>({ prefix: "artifact-commit-job:" });
    expect([...jobs.values()][0]).toMatchObject({ state: "failed", ownerId: null });
  });
});
