import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerError = vi.hoisted(() => vi.fn());

vi.mock("./logger", () => ({
  logger: {
    error: loggerError,
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  PROJECT_PURGE_RUNTIME_BATCH_LIMIT,
  PROJECT_PURGE_RUNTIME_INTERVAL_MS,
  runProjectPurgeRuntimePass,
  startProjectPurgeRuntimeAfterMigrations,
  stopProjectPurgeRuntime,
  type ProjectPurgeRuntimeDependencies,
} from "./project-purge-bootstrap";

function schedulerResult() {
  return {
    legacyInspected: 2,
    legacyScheduled: ["legacy-a"],
    dueInspected: 3,
    acceptedAndEnqueued: ["due-a", "due-b"],
    enqueueFailures: [],
    notificationInspected: 4,
    notificationsDelivered: [
      { operationId: "notification-a", milestone: "trash" },
      { operationId: "notification-b", milestone: "completed" },
    ],
    notificationFailures: [],
  };
}

function dependencies(
  overrides: Partial<ProjectPurgeRuntimeDependencies> = {},
): ProjectPurgeRuntimeDependencies {
  return {
    resumeOperations: vi.fn(async () => 3),
    runScheduler: vi.fn(async () => schedulerResult()),
    retryNotifications: vi.fn(async () => ({ inspected: 2, sent: 1, stillUnsent: 1 })),
    ...overrides,
  };
}

describe("project purge runtime bootstrap", () => {
  beforeEach(() => {
    stopProjectPurgeRuntime();
    loggerError.mockReset();
  });

  it("runs bounded resume, expiry, milestone, and email-retry work in one pass", async () => {
    const deps = dependencies();

    await expect(runProjectPurgeRuntimePass(deps)).resolves.toEqual({
      resumed: 3,
      legacyInspected: 2,
      legacyScheduled: 1,
      dueInspected: 3,
      acceptedAndEnqueued: 2,
      notificationInspected: 4,
      notificationsDelivered: 2,
      notificationRetryInspected: 2,
      notificationRetrySent: 1,
      failedSteps: [],
    });
    expect(PROJECT_PURGE_RUNTIME_BATCH_LIMIT).toBe(50);
    expect(deps.resumeOperations).toHaveBeenCalledOnce();
    expect(deps.runScheduler).toHaveBeenCalledOnce();
    expect(deps.retryNotifications).toHaveBeenCalledOnce();
  });

  it("isolates step failures so notification trouble cannot block deletion recovery", async () => {
    const deps = dependencies({
      resumeOperations: vi.fn(async () => {
        throw new Error("database unavailable");
      }),
      retryNotifications: vi.fn(async () => {
        throw new TypeError("email unavailable");
      }),
    });

    const receipt = await runProjectPurgeRuntimePass(deps);

    expect(receipt.failedSteps).toEqual(["resume", "notification_retry"]);
    expect(receipt.acceptedAndEnqueued).toBe(2);
    expect(deps.runScheduler).toHaveBeenCalledOnce();
    expect(loggerError).toHaveBeenCalledTimes(2);
    expect(loggerError.mock.calls.map(([details]) => details)).toEqual([
      { errorClass: "Error" },
      { errorClass: "TypeError" },
    ]);
  });

  it("starts one timer and skips overlapping passes", async () => {
    let resolveResume!: (count: number) => void;
    const resumeOperations = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          resolveResume = resolve;
        }),
    );
    const deps = dependencies({ resumeOperations });
    const timerCapture: { tick?: () => void } = {};
    const timer = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalFn = vi.fn((callback: () => void, intervalMs: number) => {
      timerCapture.tick = callback;
      expect(intervalMs).toBe(PROJECT_PURGE_RUNTIME_INTERVAL_MS);
      return timer;
    });
    const clearIntervalFn = vi.fn();

    const first = startProjectPurgeRuntimeAfterMigrations(deps, {
      setIntervalFn,
      clearIntervalFn,
    });
    const second = startProjectPurgeRuntimeAfterMigrations(deps, {
      setIntervalFn,
      clearIntervalFn,
    });

    expect(second).toBe(first);
    expect(setIntervalFn).toHaveBeenCalledOnce();
    expect(timer.unref).toHaveBeenCalledOnce();
    timerCapture.tick?.();
    await Promise.resolve();
    expect(resumeOperations).toHaveBeenCalledOnce();

    resolveResume(1);
    await first.initialPass;
    expect(deps.runScheduler).toHaveBeenCalledOnce();
    expect(deps.retryNotifications).toHaveBeenCalledOnce();

    first.stop();
    first.stop();
    expect(clearIntervalFn).toHaveBeenCalledOnce();
  });

  it("registers the worker only after migrations and dispatches terminal notifications", () => {
    const appSource = readFileSync(path.join(process.cwd(), "src/app.ts"), "utf8");
    const indexSource = readFileSync(path.join(process.cwd(), "src/index.ts"), "utf8");
    const purgeRun = appSource.indexOf("await runProjectPurgeOperation(operationId)");
    const purgeNotification = appSource.indexOf(
      "await dispatchProjectPurgeNotificationsOnce()",
      purgeRun,
    );
    const retirementRun = appSource.indexOf("await runProjectRetirementOperation(operationId)");
    const trashNotification = appSource.indexOf(
      "await dispatchProjectPurgeNotificationsOnce()",
      retirementRun,
    );

    expect(appSource).toContain("QUEUE_PROJECT_PURGE");
    expect(appSource).toContain("startProjectPurgeWorkerAfterMigrations");
    expect(purgeRun).toBeGreaterThan(-1);
    expect(purgeNotification).toBeGreaterThan(purgeRun);
    expect(trashNotification).toBeGreaterThan(retirementRun);
    expect(indexSource).toContain(
      "const purgeWorker = await startProjectPurgeWorkerAfterMigrations()",
    );
    expect(indexSource).toContain('if (purgeWorker.status === "ready")');
    expect(indexSource).toContain("startProjectPurgeRuntimeAfterMigrations()");
    expect(indexSource).toContain("await purgeRuntime.initialPass");
  });
});
