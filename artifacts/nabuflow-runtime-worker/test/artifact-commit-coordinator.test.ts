import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlDurableObject } from "../src/control-durable-object";
import type { StoredArtifactCommitJob } from "../src/model";
import { MemoryArtifactCommitQueue, fakeEnv } from "./helpers";

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

function coordinator(storage = new MemoryDurableStorage(), env = fakeEnv()): ControlDurableObject {
  return new ControlDurableObject({ storage } as unknown as DurableObjectState, env);
}

const claim = {
  key: "artifact-commit-idempotency-1",
  fingerprint: "f".repeat(64),
  kind: "layers-v1" as const,
  runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
  sealedArtifactSha256: "a".repeat(64),
  expectedDeploymentVersion: "worker-version-test-1",
};

afterEach(() => vi.useRealTimers());

describe("artifact commit coordinator leases", () => {
  it("preserves live-owner in-progress semantics and adopts an expired lease at its checkpoint", async () => {
    const durable = coordinator();
    const first = await durable.registerArtifactCommit({ ...claim, nowMs: 1_000 });
    expect(first.state).toBe("new");
    if (first.state !== "new") throw new Error("expected a new job");
    const owner = await durable.claimArtifactCommitDriver(first.job.jobKey, "owner-1", 1_000);
    expect(owner.state).toBe("claimed");

    await durable.checkpointArtifactCommit({
      jobKey: first.job.jobKey,
      ownerId: "owner-1",
      checkpoint: "verification-complete",
      nowMs: 2_000,
    });
    await expect(
      durable.claimArtifactCommitDriver(first.job.jobKey, "owner-2", 10_000),
    ).resolves.toMatchObject({ state: "busy", job: { ownerId: "owner-1" } });

    const adopted = await durable.claimArtifactCommitDriver(first.job.jobKey, "owner-2", 17_000);
    expect(adopted.state).toBe("adopted");
    if (adopted.state !== "adopted") throw new Error("expected adoption");
    expect(adopted.job).toMatchObject({
      checkpoint: "verification-complete",
      ownerId: "owner-2",
      attempt: 2,
      events: expect.arrayContaining([
        expect.objectContaining({ event: "lease-expired" }),
        expect.objectContaining({ event: "driver-adopted" }),
      ]),
    });
  });

  it("creates a fresh job when nothing durable exists and rejects a conflicting payload", async () => {
    const durable = coordinator();
    await expect(durable.registerArtifactCommit({ ...claim, nowMs: 1_000 })).resolves.toMatchObject(
      { state: "new", job: { checkpoint: "initialized", attempt: 0 } },
    );
    await expect(
      durable.registerArtifactCommit({
        ...claim,
        fingerprint: "e".repeat(64),
        nowMs: 17_000,
      }),
    ).resolves.toEqual({ state: "conflict" });
  });

  it("keeps the persisted diagnostic trail bounded while retaining monotonic sequence numbers", async () => {
    const durable = coordinator();
    const registered = await durable.registerArtifactCommit({ ...claim, nowMs: 1_000 });
    expect(registered.state).toBe("new");
    if (registered.state !== "new") throw new Error("expected a new job");
    for (let index = 0; index < 160; index += 1) {
      await durable.recordArtifactCommitNudge(registered.job.jobKey, 2_000 + index);
    }
    const job = await durable.getArtifactCommit(registered.job.jobKey);
    expect(job?.events).toHaveLength(128);
    expect(job?.events[0].sequence).toBeGreaterThan(1);
    expect(job?.events.at(-1)?.sequence).toBe(161);
  });

  it("alarms an abandoned job into a typed terminal response without a retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new MemoryDurableStorage();
    const env = fakeEnv();
    const durable = coordinator(storage, env);
    const first = await durable.registerArtifactCommit({ ...claim, nowMs: 1_000 });
    expect(first.state).toBe("new");

    vi.setSystemTime(6_001);
    await durable.alarm();
    const queue = env.ARTIFACT_COMMIT_QUEUE as unknown as MemoryArtifactCommitQueue;
    expect(queue.messages).toHaveLength(1);

    vi.setSystemTime(271_001);
    await durable.alarm();
    const replay = await durable.registerArtifactCommit({
      ...claim,
      nowMs: 271_001,
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
    const jobs = await storage.list<StoredArtifactCommitJob>({
      prefix: "durable-operation-job:",
    });
    expect([...jobs.values()][0]).toMatchObject({ state: "failed", ownerId: null });
  });

  it("terminalizes an abandoned runtime start before the provider observation boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new MemoryDurableStorage();
    const env = fakeEnv();
    const durable = coordinator(storage, env);
    const registration = {
      key: "runtime-start-idempotency-1",
      fingerprint: "d".repeat(64),
      kind: "runtime-start" as const,
      runtimeIdentity: claim.runtimeIdentity,
      subjectKey: "start" as const,
      request: {
        locator: { projectId: 42, role: "preview" as const, slot: "primary" as const },
        expectedDeploymentVersion: "worker-version-test-1",
        artifactRevision: "runtime-start-alarm-proof",
        artifactSha256: "b".repeat(64),
      },
      expectedDeploymentVersion: "worker-version-test-1",
    };
    await expect(
      durable.registerDurableOperation({ ...registration, nowMs: 1_000 }),
    ).resolves.toMatchObject({ state: "new" });
    vi.setSystemTime(6_001);
    await durable.alarm();
    const queue = env.DURABLE_OPERATION_QUEUE as unknown as MemoryArtifactCommitQueue;
    expect(queue.messages).toHaveLength(1);
    vi.setSystemTime(271_001);
    await durable.alarm();
    await expect(
      durable.registerDurableOperation({ ...registration, nowMs: 271_001 }),
    ).resolves.toEqual({
      state: "replay",
      response: {
        status: 504,
        body: {
          ok: false,
          code: "runtime_start_timeout",
          message: "Runtime start did not complete before the execution deadline",
          retryable: false,
        },
      },
    });
    expect(271_001 - 1_000).toBeLessThan(300_000);
  });

  it("adopts a production promotion from its last durable checkpoint and terminalizes before observation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const storage = new MemoryDurableStorage();
    const env = fakeEnv();
    const durable = coordinator(storage, env);
    const registration = {
      key: "production-promotion-idempotency-1",
      fingerprint: "6".repeat(64),
      kind: "layered-artifact-promotion" as const,
      runtimeIdentity: "nrf-e919a75364398a44-p42-production-green",
      subjectKey: "9".repeat(64),
      request: {
        sourceLocator: { projectId: 42, role: "preview" as const, slot: "primary" as const },
        targetLocator: { projectId: 42, role: "production" as const, slot: "green" as const },
        expectedDeploymentVersion: "worker-version-test-1",
        sourceSealedArtifactSha256: "a".repeat(64),
        targetManifest: {
          revision: "production-manifest-1",
          runtime: "node",
          buildCommand: ["npm", "run", "build"],
          startCommand: ["node", "server.mjs"],
          servicePort: 8080,
          healthPath: "/healthz",
          resourceProfile: "production" as const,
          public: true,
        },
        targetArtifactRevision: "production-artifact-1",
        promotionIdentity: "9".repeat(64),
      },
      expectedDeploymentVersion: "worker-version-test-1",
    };
    const registered = await durable.registerDurableOperation({ ...registration, nowMs: 1_000 });
    expect(registered).toMatchObject({ state: "new", job: { checkpoint: "initialized" } });
    if (registered.state !== "new") throw new Error("expected promotion job");
    const first = await durable.claimDurableOperationDriver(
      registered.job.jobKey,
      "owner-1",
      1_000,
    );
    expect(first.state).toBe("claimed");
    await durable.checkpointDurableOperation({
      jobKey: registered.job.jobKey,
      ownerId: "owner-1",
      ownerGeneration: 1,
      checkpoint: "source-verified",
      nowMs: 2_000,
    });
    const adopted = await durable.claimDurableOperationDriver(
      registered.job.jobKey,
      "owner-2",
      17_000,
    );
    expect(adopted).toMatchObject({
      state: "adopted",
      job: { attempt: 2, checkpoint: "source-verified" },
    });

    vi.setSystemTime(271_001);
    await durable.alarm();
    await expect(
      durable.registerDurableOperation({ ...registration, nowMs: 271_001 }),
    ).resolves.toEqual({
      state: "replay",
      response: {
        status: 504,
        body: {
          ok: false,
          code: "artifact_promotion_timeout",
          message: "Artifact promotion did not complete before the execution deadline",
          retryable: false,
        },
      },
    });
  });

  it("uses the shared leased job chassis for acceptance cleanup and adopts a killed consumer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const durable = coordinator();
    const registration = await durable.registerDurableOperation({
      key: "acceptance-destroy-idempotency-1",
      fingerprint: "c".repeat(64),
      kind: "acceptance-lease",
      runtimeIdentity: `acceptance:nal_${"a".repeat(40)}`,
      subjectKey: "destroy",
      request: {
        leaseId: `nal_${"a".repeat(40)}`,
        operation: "destroy",
        ownerSubjectHash: "b".repeat(64),
      },
      expectedDeploymentVersion: "acceptance-test-v1",
      nowMs: 1_000,
    });
    expect(registration.state).toBe("new");
    if (registration.state !== "new") throw new Error("expected a new acceptance job");
    const killed = await durable.claimDurableOperationDriver(
      registration.job.jobKey,
      "killed-consumer",
      1_000,
    );
    expect(killed.state).toBe("claimed");
    const adopted = await durable.claimDurableOperationDriver(
      registration.job.jobKey,
      "janitor-consumer",
      17_000,
    );
    expect(adopted).toMatchObject({
      state: "adopted",
      job: { kind: "acceptance-lease", attempt: 2, checkpoint: "initialized" },
    });
    if (adopted.state !== "adopted") throw new Error("expected acceptance adoption");
    for (const checkpoint of [
      "scope-verified",
      "provider-complete",
      "vault-complete",
      "verified-gone",
      "finalized",
    ] as const) {
      await durable.checkpointDurableOperation({
        jobKey: registration.job.jobKey,
        ownerId: "janitor-consumer",
        ownerGeneration: adopted.job.attempt,
        checkpoint,
        nowMs: 17_001,
      });
    }
    await expect(
      durable.completeDurableOperation(
        registration.job.jobKey,
        "janitor-consumer",
        adopted.job.attempt,
        { status: 200, body: { ok: true, state: "destroyed" } },
        17_002,
      ),
    ).resolves.toBe("completed");
  });

  it("fences stale adoption generations without replacing the live owner or typed terminal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const durable = coordinator();
    const registration = await durable.registerArtifactCommit({ ...claim, nowMs: 1_000 });
    expect(registration.state).toBe("new");
    if (registration.state !== "new") throw new Error("expected a new job");
    const first = await durable.claimDurableOperationDriver(
      registration.job.jobKey,
      "owner-1",
      1_000,
    );
    expect(first.state).toBe("claimed");
    const second = await durable.claimDurableOperationDriver(
      registration.job.jobKey,
      "owner-2",
      17_000,
    );
    expect(second.state).toBe("adopted");
    if (second.state !== "adopted") throw new Error("expected adoption");

    await expect(
      durable.failDurableOperation(
        registration.job.jobKey,
        "owner-1",
        1,
        { status: 502, body: { ok: false, code: "stale" } },
        18_000,
      ),
    ).resolves.toBe("not_owner");
    await expect(durable.getDurableOperation(registration.job.jobKey)).resolves.toMatchObject({
      state: "active",
      ownerId: "owner-2",
      attempt: 2,
    });

    vi.setSystemTime(271_001);
    await durable.alarm();
    await expect(
      durable.failDurableOperation(
        registration.job.jobKey,
        "owner-2",
        2,
        { status: 502, body: { ok: false, code: "late" } },
        271_001,
      ),
    ).resolves.toBe("already_terminal");
    await expect(durable.getDurableOperation(registration.job.jobKey)).resolves.toMatchObject({
      state: "failed",
      response: { body: { code: "artifact_commit_abandoned" } },
    });
  });

  it("does not adopt a live initialized driver whose renewable lease is current", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const durable = coordinator();
    const registration = await durable.registerArtifactCommit({ ...claim, nowMs: 1_000 });
    if (registration.state !== "new") throw new Error("expected a new job");
    const driver = await durable.claimDurableOperationDriver(
      registration.job.jobKey,
      "live-owner",
      1_000,
    );
    expect(driver.state).toBe("claimed");
    await expect(
      durable.renewDurableOperation(registration.job.jobKey, "live-owner", 1, 14_000),
    ).resolves.toBe("renewed");
    vi.setSystemTime(17_000);
    await durable.alarm();
    await expect(durable.getDurableOperation(registration.job.jobKey)).resolves.toMatchObject({
      state: "active",
      checkpoint: "initialized",
      ownerId: "live-owner",
      attempt: 1,
    });
  });
});
