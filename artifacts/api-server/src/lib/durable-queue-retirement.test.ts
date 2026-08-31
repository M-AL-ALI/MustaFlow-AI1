import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pgBossHarness = vi.hoisted(() => {
  type SendCall = {
    queue: string;
    options: Record<string, unknown>;
  };
  return {
    createAttempts: new Map<string, number>(),
    createFailuresRemaining: new Map<string, number>(),
    policies: new Map<string, string>(),
    activeSingletons: new Set<string>(),
    jobIds: new Set<string>(),
    sendCalls: [] as SendCall[],
    errorHandler: null as ((error: Error) => void) | null,
    reset() {
      this.createAttempts.clear();
      this.createFailuresRemaining.clear();
      this.policies.clear();
      this.activeSingletons.clear();
      this.jobIds.clear();
      this.sendCalls.length = 0;
      this.errorHandler = null;
    },
  };
});

vi.mock("pg-boss", () => ({
  PgBoss: class {
    on(event: string, handler: (error: Error) => void): void {
      if (event === "error") pgBossHarness.errorHandler = handler;
    }

    async start(): Promise<this> {
      return this;
    }

    async createQueue(queue: string, options: Record<string, unknown>): Promise<void> {
      pgBossHarness.createAttempts.set(queue, (pgBossHarness.createAttempts.get(queue) ?? 0) + 1);
      const failures = pgBossHarness.createFailuresRemaining.get(queue) ?? 0;
      if (failures > 0) {
        pgBossHarness.createFailuresRemaining.set(queue, failures - 1);
        throw new Error("registration-weather");
      }
      if (!pgBossHarness.policies.has(queue)) {
        pgBossHarness.policies.set(queue, String(options.policy ?? "standard"));
      }
    }

    async getQueue(queue: string): Promise<Record<string, unknown> | null> {
      const policy = pgBossHarness.policies.get(queue);
      return policy ? { name: queue, policy } : null;
    }

    async work(): Promise<string> {
      return "worker-id";
    }

    async send(
      queue: string,
      _payload: Record<string, unknown>,
      options: Record<string, unknown>,
    ): Promise<string | null> {
      pgBossHarness.sendCalls.push({ queue, options });
      const requestedId = typeof options.id === "string" ? options.id : null;
      if (requestedId) {
        if (pgBossHarness.jobIds.has(requestedId)) return null;
        pgBossHarness.jobIds.add(requestedId);
      }
      const singletonKey = typeof options.singletonKey === "string" ? options.singletonKey : null;
      const identity = singletonKey ? `${queue}:${singletonKey}` : null;
      if (pgBossHarness.policies.get(queue) === "exclusive" && identity) {
        if (pgBossHarness.activeSingletons.has(identity)) return null;
        pgBossHarness.activeSingletons.add(identity);
      }
      return requestedId ?? `job-${pgBossHarness.sendCalls.length}`;
    }

    async stop(): Promise<void> {}
  },
}));

import {
  durableEnqueueRawResult,
  durableEnqueueRaw,
  durableQueueJobId,
  getDurableWorkerReadiness,
  isDurableWorkerReady,
  QUEUE_CVE_AUTOPROTECT,
  QUEUE_EAS_BUILD,
  QUEUE_PROJECT_RETIREMENT,
  registerRequiredWorker,
  startDurableQueue,
  stopDurableQueue,
} from "./durable-queue";

const handler = async (): Promise<void> => undefined;

async function startQueue(): Promise<void> {
  process.env.DATABASE_URL = "postgres://queue.test.invalid/test";
  delete process.env.DURABLE_QUEUE_ENABLED;
  await startDurableQueue(handler);
}

const retirementWorkerOptions = {
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  queuePolicy: "exclusive" as const,
  registrationAttempts: 3,
  registrationDelayMs: 0,
};

describe("required project-retirement durable worker", () => {
  beforeEach(async () => {
    await stopDurableQueue();
    pgBossHarness.reset();
  });

  afterEach(async () => {
    await stopDurableQueue();
    delete process.env.DATABASE_URL;
  });

  it("uses pg-boss singletonKey and an exclusive queue so periodic resume mints one job", async () => {
    await startQueue();
    const receipt = await registerRequiredWorker(
      QUEUE_PROJECT_RETIREMENT,
      handler,
      retirementWorkerOptions,
    );

    expect(receipt).toMatchObject({ status: "ready", attempts: 1 });
    const first = await durableEnqueueRaw(
      QUEUE_PROJECT_RETIREMENT,
      { operationId: "operation-1" },
      "operation-1",
      { retryLimit: 4, retryDelay: 30, retryBackoff: true, dedupeMode: "active" },
    );
    const repeatedResume = await durableEnqueueRaw(
      QUEUE_PROJECT_RETIREMENT,
      { operationId: "operation-1" },
      "operation-1",
      { retryLimit: 4, retryDelay: 30, retryBackoff: true, dedupeMode: "active" },
    );

    expect(first).toBe("job-1");
    expect(repeatedResume).toBeNull();
    expect(pgBossHarness.sendCalls).toHaveLength(2);
    expect(pgBossHarness.sendCalls[0]?.options).toMatchObject({
      singletonKey: "operation-1",
    });
    expect(pgBossHarness.sendCalls[0]?.options).not.toHaveProperty("id");
    expect(pgBossHarness.sendCalls[0]?.options).not.toHaveProperty("key");
    expect(pgBossHarness.policies.get(QUEUE_PROJECT_RETIREMENT)).toBe("exclusive");

    pgBossHarness.activeSingletons.delete(`${QUEUE_PROJECT_RETIREMENT}:operation-1`);
    const recovery = await durableEnqueueRaw(
      QUEUE_PROJECT_RETIREMENT,
      { operationId: "operation-1" },
      "operation-1",
      { retryLimit: 4, retryDelay: 30, retryBackoff: true, dedupeMode: "active" },
    );
    expect(recovery).toBe("job-3");
  });

  it("derives stable queue-scoped Postgres UUIDs for canonical work", () => {
    const first = durableQueueJobId("mustaflow.queue-a", "entity-7");
    expect(first).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(durableQueueJobId("mustaflow.queue-a", "entity-7")).toBe(first);
    expect(durableQueueJobId("mustaflow.queue-b", "entity-7")).not.toBe(first);
    expect(durableQueueJobId("mustaflow.queue-a", "entity-8")).not.toBe(first);
  });

  it("deduplicates canonical keyed work even on a legacy standard queue", async () => {
    await startQueue();
    await registerRequiredWorker("mustaflow.canonical-work", handler, {
      ...retirementWorkerOptions,
      queuePolicy: "standard",
    });

    const first = await durableEnqueueRawResult(
      "mustaflow.canonical-work",
      { entityId: 7 },
      "entity-7",
    );
    const duplicate = await durableEnqueueRawResult(
      "mustaflow.canonical-work",
      { entityId: 7 },
      "entity-7",
    );
    const intentionalRepeat = await durableEnqueueRawResult("mustaflow.canonical-work", {
      entityId: 7,
    });

    expect(first).toMatchObject({
      status: "enqueued",
      jobId: durableQueueJobId("mustaflow.canonical-work", "entity-7"),
    });
    expect(duplicate).toEqual({
      status: "duplicate",
      code: "durable_queue_duplicate_suppressed",
      jobId: null,
    });
    expect(intentionalRepeat).toMatchObject({ status: "enqueued", jobId: "job-3" });
  });

  it.each([
    [QUEUE_EAS_BUILD, "eas-42"],
    [QUEUE_CVE_AUTOPROTECT, "cve-42"],
    ["mustaflow.asset-alt-text", "asset-alt-42"],
  ])("mints one canonical job for %s", async (queue, key) => {
    await startQueue();
    await registerRequiredWorker(queue, handler, {
      ...retirementWorkerOptions,
      queuePolicy: "standard",
    });

    const first = await durableEnqueueRawResult(queue, { entityId: 42 }, key);
    const duplicate = await durableEnqueueRawResult(queue, { entityId: 42 }, key);

    expect(first).toMatchObject({ status: "enqueued", jobId: durableQueueJobId(queue, key) });
    expect(duplicate).toMatchObject({ status: "duplicate", jobId: null });
  });

  it("retries registration only to the typed bound and then becomes ready", async () => {
    await startQueue();
    pgBossHarness.createFailuresRemaining.set(QUEUE_PROJECT_RETIREMENT, 2);

    const receipt = await registerRequiredWorker(
      QUEUE_PROJECT_RETIREMENT,
      handler,
      retirementWorkerOptions,
    );

    expect(receipt).toEqual({
      queue: QUEUE_PROJECT_RETIREMENT,
      status: "ready",
      code: "durable_worker_ready",
      attempts: 3,
    });
    expect(pgBossHarness.createAttempts.get(QUEUE_PROJECT_RETIREMENT)).toBe(3);
    expect(isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)).toBe(true);
  });

  it("does not make one ambiguous pg-boss transport event permanently sticky", async () => {
    await startQueue();
    await registerRequiredWorker(QUEUE_PROJECT_RETIREMENT, handler, retirementWorkerOptions);

    expect(isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)).toBe(true);
    pgBossHarness.errorHandler?.(new Error("one-transient-transport-event"));
    expect(isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)).toBe(true);

    await expect(
      durableEnqueueRawResult(
        QUEUE_PROJECT_RETIREMENT,
        { operationId: "operation-after-weather" },
        "operation-after-weather",
        { retryLimit: 3, retryDelay: 30, dedupeMode: "active" },
      ),
    ).resolves.toMatchObject({ status: "enqueued" });
  });

  it("exposes a typed failed receipt after the bounded registration cap", async () => {
    await startQueue();
    pgBossHarness.createFailuresRemaining.set(QUEUE_PROJECT_RETIREMENT, 10);

    const receipt = await registerRequiredWorker(
      QUEUE_PROJECT_RETIREMENT,
      handler,
      retirementWorkerOptions,
    );

    expect(receipt).toEqual({
      queue: QUEUE_PROJECT_RETIREMENT,
      status: "failed",
      code: "durable_worker_registration_failed",
      attempts: 3,
    });
    expect(pgBossHarness.createAttempts.get(QUEUE_PROJECT_RETIREMENT)).toBe(3);
    expect(isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)).toBe(false);
  });

  it("refuses readiness when an existing queue has a weaker policy", async () => {
    await startQueue();
    pgBossHarness.policies.set(QUEUE_PROJECT_RETIREMENT, "standard");

    const receipt = await registerRequiredWorker(
      QUEUE_PROJECT_RETIREMENT,
      handler,
      retirementWorkerOptions,
    );

    expect(receipt).toEqual({
      queue: QUEUE_PROJECT_RETIREMENT,
      status: "failed",
      code: "durable_worker_queue_policy_mismatch",
      attempts: 3,
    });
    expect(isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)).toBe(false);
  });

  it("reports unavailable without attempting registration when the durable queue is absent", async () => {
    delete process.env.DATABASE_URL;
    const receipt = await registerRequiredWorker(
      QUEUE_PROJECT_RETIREMENT,
      handler,
      retirementWorkerOptions,
    );

    expect(receipt).toEqual({
      queue: QUEUE_PROJECT_RETIREMENT,
      status: "unavailable",
      code: "durable_queue_unavailable",
      attempts: 0,
    });
    expect(getDurableWorkerReadiness(QUEUE_PROJECT_RETIREMENT)).toEqual(receipt);
    expect(pgBossHarness.createAttempts.get(QUEUE_PROJECT_RETIREMENT)).toBeUndefined();
  });

  it("fails Trash closed before mutation and never labels a null enqueue as scheduled", () => {
    const source = readFileSync(new URL("../routes/projects.ts", import.meta.url), "utf8");
    const start = source.indexOf('router.delete("/projects/:id"');
    const end = source.indexOf("// ── GET /api/projects/:id/container-health", start);
    const route = source.slice(start, end);

    const readiness = route.indexOf("isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)");
    const acceptance = route.indexOf("acceptProjectRetirement({");
    expect(readiness).toBeGreaterThan(-1);
    expect(acceptance).toBeGreaterThan(readiness);
    expect(route).toContain('code: "project_retirement_worker_unavailable"');
    expect(route).toContain("deleted: false");
    expect(route).toContain('code: "project_retirement_cleanup_pending"');
    expect(route).toContain("cleanupScheduled: false");
    expect(route).toContain("cleanupScheduled: true");
  });

  it("registers the required worker only after migrations pass, with a pinned policy", () => {
    const appSource = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const indexSource = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    const registration = appSource.slice(
      appSource.indexOf("export function startProjectRetirementWorkerAfterMigrations"),
      appSource.indexOf("// Kick off the domain renewal scheduler"),
    );

    expect(appSource).toContain("export const durableQueueWorkerStartup = startDurableQueue");
    expect(registration).toContain("await registerRequiredWorker(");
    expect(registration).toContain('queuePolicy: "exclusive"');
    expect(registration).toContain("registrationAttempts: 3");
    expect(indexSource).toContain("if (!migrationsPassed)");
    expect(indexSource).toContain("if (isProjectRetirementExecutionEnabled())");
    expect(indexSource.indexOf("startProjectRetirementWorkerAfterMigrations()")).toBeGreaterThan(
      indexSource.indexOf("if (isProjectRetirementExecutionEnabled())"),
    );
    expect(indexSource.indexOf("startProjectRetirementWorkerAfterMigrations()")).toBeLessThan(
      indexSource.indexOf("resumeProjectRetirementOperations()"),
    );
    expect(appSource).not.toContain("void registerWorker(\n    QUEUE_PROJECT_RETIREMENT");
  });

  it("audits keyed callers so suppression never launches duplicate fallback work", () => {
    const jobs = readFileSync(new URL("./jobs.ts", import.meta.url), "utf8");
    const tasks = readFileSync(new URL("../routes/tasks.ts", import.meta.url), "utf8");
    const assets = readFileSync(new URL("./asset-alt-text-analysis.ts", import.meta.url), "utf8");

    for (const startMarker of [
      "export function enqueueEasJob",
      "export function enqueueCveAutoProtectJob",
    ]) {
      const start = jobs.indexOf(startMarker);
      const end = jobs.indexOf("\n}\n", start) + 3;
      const block = jobs.slice(start, end);
      expect(block).toContain("durableEnqueueRawResult");
      expect(block).toContain('outcome.status === "duplicate"');
      expect(block.indexOf('outcome.status === "duplicate"')).toBeLessThan(
        block.indexOf("setImmediate"),
      );
    }

    const testingStart = tasks.indexOf("// Kick off tests via the durable queue");
    const testingEnd = tasks.indexOf("res.json({ queued: true", testingStart);
    const testingBlock = tasks.slice(testingStart, testingEnd);
    expect(testingBlock).toContain("durableEnqueueRawResult");
    expect(testingBlock).not.toContain("testing-${params.data.taskId}");
    expect(testingBlock).toContain("Rerun is an intentional repeat action");

    const assetStart = assets.indexOf("export async function enqueueAutomaticAssetAltText");
    const assetEnd = assets.indexOf("export async function registerAssetAltTextWorker", assetStart);
    const assetBlock = assets.slice(assetStart, assetEnd);
    expect(assetBlock).toContain("durableEnqueueRawResult");
    expect(assetBlock).toContain('outcome.status === "unavailable" || outcome.status === "failed"');
    expect(assetBlock).not.toContain('outcome.status === "duplicate"');
  });
});
