import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  configured: vi.fn(),
  enqueue: vi.fn(),
  readiness: vi.fn(),
  register: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("./asset-r2", () => ({ assetR2Configured: mocks.configured }));
vi.mock("./automatic-preview-storage", () => ({ runAutomaticProjectPreview: mocks.run }));
vi.mock("./preview-version-provenance", () => ({ bindPreviewVersion: vi.fn() }));
vi.mock("./durable-queue", () => ({
  durableEnqueueRawResult: mocks.enqueue,
  getDurableWorkerReadiness: mocks.readiness,
  registerRequiredWorker: mocks.register,
}));
import {
  automaticPreviewRollout,
  notifyAutomaticPreviewForTask,
  reconcileAutomaticProjectPreviews,
  startAutomaticPreviewWorkerAfterMigrations,
  stopAutomaticPreviewReconciliation,
  QUEUE_AUTOMATIC_PROJECT_PREVIEW,
} from "./automatic-preview-dispatch";

const ready = {
  queue: QUEUE_AUTOMATIC_PROJECT_PREVIEW,
  status: "ready",
  code: "durable_worker_ready",
  attempts: 1,
};
const failed = { ...ready, status: "failed", code: "durable_worker_registration_failed" };
const row = (id: number, end = id) => ({
  project_id: id + 1000,
  version_id: id,
  scan_id: id,
  scan_end: end,
});
const isCleanup = (sql: string) => sql.includes("FROM assets a JOIN projects");

beforeEach(() => {
  vi.resetAllMocks();
  stopAutomaticPreviewReconciliation();
  vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED", "true");
  vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_SINCE", "2026-01-01T00:00:00Z");
  mocks.configured.mockReturnValue(true);
  mocks.readiness.mockReturnValue(ready);
  mocks.query.mockImplementation(async (sql: string) => ({
    rows: isCleanup(sql) ? [] : [row(100)],
  }));
  mocks.enqueue.mockResolvedValue({ status: "enqueued" });
});
afterEach(() => {
  stopAutomaticPreviewReconciliation();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("automatic preview durable dispatch", () => {
  it("requires opt-in and a literal valid epoch", () => {
    const now = Date.parse("2026-09-09T00:00:00Z");
    expect(automaticPreviewRollout({}, now)).toBeNull();
    expect(
      automaticPreviewRollout({ NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED: "true" }, now),
    ).toBeNull();
    expect(
      automaticPreviewRollout(
        {
          NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED: "true",
          NABUFLOW_AUTOMATIC_PREVIEWS_SINCE: "2026-01-01T00:00:00Z",
        },
        now,
      )?.toISOString(),
    ).toBe("2026-01-01T00:00:00.000Z");
  });
  it("retains cleanup but creates no new capture on a disabled rollout", async () => {
    vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED", "false");
    mocks.query.mockResolvedValueOnce({ rows: [row(10)] });
    expect(await reconcileAutomaticProjectPreviews()).toBe(1);
    notifyAutomaticPreviewForTask(1);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue.mock.calls[0]![1]).toEqual({
      projectId: 1010,
      versionId: 10,
      cleanupOnly: true,
    });
    expect(mocks.enqueue.mock.calls[0]![2]).toMatch(/:cleanup$/u);
  });
  it.each(["failed", "unavailable", "registering"])(
    "does not dispatch with %s readiness",
    async (status) => {
      mocks.readiness.mockReturnValue({ status });
      expect(await reconcileAutomaticProjectPreviews()).toBe(0);
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
  it("does not dispatch without storage", async () => {
    mocks.configured.mockReturnValue(false);
    expect(await reconcileAutomaticProjectPreviews()).toBe(0);
    expect(mocks.query).not.toHaveBeenCalled();
  });
  it("recovers successful terminals while cleanup ignores supersession and hibernation", async () => {
    expect(await reconcileAutomaticProjectPreviews()).toBe(1);
    const [cleanup] = mocks.query.mock.calls[0]!;
    for (const excluded of ["container_status", "MAX(current.id)", "created_at", "COUNT(*)"]) {
      expect(cleanup).not.toContain(excluded);
    }
    for (const required of [
      "p.deleted_at IS NULL",
      "a.owner_user_id=p.owner_id",
      "o.state='deleting'",
    ]) {
      expect(cleanup).toContain(required);
    }
    const [capture, parameters] = mocks.query.mock.calls[1]!;
    for (const required of [
      "task.terminal->>'outcome'='mutation_succeeded'",
      "v.created_at >= $1",
      "p.container_status='running'",
      "MAX(current.id)",
      "LIMIT 20",
    ])
      expect(capture).toContain(required);
    expect(parameters.slice(4)).toEqual([0, null]);
    expect(mocks.enqueue).toHaveBeenCalledWith(
      QUEUE_AUTOMATIC_PROJECT_PREVIEW,
      { projectId: 1100, versionId: 100 },
      expect.stringMatching(/^[a-f0-9]{64}$/u),
      expect.objectContaining({ dedupeMode: "active", retryLimit: 3 }),
    );
  });
  it("reaches project 21 despite twenty persistent not-ready candidates, then wraps", async () => {
    const pages: unknown[][] = [];
    mocks.query.mockImplementation(async (sql: string, params: unknown[]) => {
      if (isCleanup(sql)) return { rows: [] };
      pages.push(params);
      const after = params[4] as number;
      return {
        rows: after === 0 ? Array.from({ length: 20 }, (_, i) => row(i + 1, 21)) : [row(21, 21)],
      };
    });
    await reconcileAutomaticProjectPreviews();
    await reconcileAutomaticProjectPreviews();
    await reconcileAutomaticProjectPreviews();
    expect(pages.map((p) => p.slice(4))).toEqual([
      [0, null],
      [20, 21],
      [0, null],
    ]);
    expect(mocks.enqueue.mock.calls.some((c) => c[1].versionId === 21)).toBe(true);
  });
  it("gives cleanup an independent bounded sweep", async () => {
    vi.stubEnv("NABUFLOW_AUTOMATIC_PREVIEWS_ENABLED", "false");
    mocks.query
      .mockResolvedValueOnce({ rows: Array.from({ length: 20 }, (_, i) => row(i + 1, 30)) })
      .mockResolvedValueOnce({ rows: [row(30, 30)] });
    await reconcileAutomaticProjectPreviews();
    await reconcileAutomaticProjectPreviews();
    expect(mocks.query.mock.calls[1]![1]).toEqual(["automatic-preview", 20, 30]);
  });
  it("does not count duplicate deliveries", async () => {
    mocks.enqueue.mockResolvedValue({ status: "duplicate" });
    expect(await reconcileAutomaticProjectPreviews()).toBe(0);
  });
  it("retries failed registration on the next cycle without duplicate ready handlers", async () => {
    vi.useFakeTimers();
    mocks.readiness.mockReturnValue(failed);
    mocks.register.mockResolvedValueOnce(failed).mockImplementationOnce(async () => {
      mocks.readiness.mockReturnValue(ready);
      return ready;
    });
    expect((await startAutomaticPreviewWorkerAfterMigrations())?.status).toBe("failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.register).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    await startAutomaticPreviewWorkerAfterMigrations();
    expect(mocks.register).toHaveBeenCalledTimes(2);
  });
  it("recovers thrown registration failures and coalesces concurrent starts", async () => {
    vi.useFakeTimers();
    mocks.readiness.mockReturnValue(failed);
    mocks.register
      .mockRejectedValueOnce(new Error("queue temporarily down"))
      .mockImplementationOnce(async () => {
        mocks.readiness.mockReturnValue(ready);
        return ready;
      });
    const first = startAutomaticPreviewWorkerAfterMigrations();
    const second = startAutomaticPreviewWorkerAfterMigrations();
    expect(first).toBe(second);
    expect(await first).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.register).toHaveBeenCalledTimes(2);
    const handler = mocks.register.mock.calls[1]![1];
    await handler({ projectId: 81, versionId: 100, cleanupOnly: true });
    expect(mocks.run).toHaveBeenCalledWith({ projectId: 81, versionId: 100, cleanupOnly: true });
  });
  it("does not retry registration after shutdown", async () => {
    vi.useFakeTimers();
    mocks.readiness.mockReturnValue(failed);
    mocks.register.mockResolvedValue(failed);
    await startAutomaticPreviewWorkerAfterMigrations();
    stopAutomaticPreviewReconciliation();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(mocks.register).toHaveBeenCalledTimes(1);
  });
});
