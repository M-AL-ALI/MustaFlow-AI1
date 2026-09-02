import { logger } from "./logger";
import {
  databaseProjectPurgeNotificationStore,
  deliverProjectPurgeMilestone,
  retryProjectPurgeEmailDeliveries,
} from "./project-purge-notifications";
import {
  databaseProjectPurgeSchedulerStore,
  dispatchProjectPurgeMilestones,
  runProjectPurgeScheduler,
  type ProjectPurgeSchedulerResult,
} from "./project-purge-scheduler";

export const PROJECT_PURGE_RUNTIME_INTERVAL_MS = 60_000;
export const PROJECT_PURGE_RUNTIME_BATCH_LIMIT = 50;

type EmailRetryResult = { inspected: number; sent: number; stillUnsent: number };

export type ProjectPurgeRuntimeDependencies = {
  resumeOperations(): Promise<number>;
  runScheduler(): Promise<ProjectPurgeSchedulerResult>;
  retryNotifications(): Promise<EmailRetryResult>;
};

export type ProjectPurgeRuntimePassReceipt = {
  resumed: number | null;
  legacyInspected: number | null;
  legacyScheduled: number | null;
  dueInspected: number | null;
  acceptedAndEnqueued: number | null;
  notificationInspected: number | null;
  notificationsDelivered: number | null;
  notificationRetryInspected: number | null;
  notificationRetrySent: number | null;
  failedSteps: Array<"resume" | "scheduler" | "notification_retry">;
};

function safeErrorClass(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

async function enqueueOrThrow(operationId: string): Promise<void> {
  const { enqueueProjectPurgeOperation } = await import("./project-purge");
  if (!(await enqueueProjectPurgeOperation(operationId))) {
    throw new Error("project_purge_worker_unavailable");
  }
}

async function deliverMilestone(
  input: Parameters<typeof deliverProjectPurgeMilestone>[0],
): Promise<void> {
  await deliverProjectPurgeMilestone(input, {
    store: databaseProjectPurgeNotificationStore,
  });
}

const defaultDependencies: ProjectPurgeRuntimeDependencies = {
  resumeOperations: async () => {
    const { resumeProjectPurgeOperations } = await import("./project-purge");
    return resumeProjectPurgeOperations();
  },
  runScheduler: () =>
    runProjectPurgeScheduler(
      {
        store: databaseProjectPurgeSchedulerStore,
        enqueue: enqueueOrThrow,
        deliverMilestone,
      },
      PROJECT_PURGE_RUNTIME_BATCH_LIMIT,
    ),
  retryNotifications: () =>
    retryProjectPurgeEmailDeliveries(
      { store: databaseProjectPurgeNotificationStore },
      PROJECT_PURGE_RUNTIME_BATCH_LIMIT,
    ),
};

/**
 * One bounded pass. The three durable concerns are isolated so a transient
 * notification failure cannot prevent accepted deletion work from resuming.
 */
export async function runProjectPurgeRuntimePass(
  dependencies: ProjectPurgeRuntimeDependencies = defaultDependencies,
): Promise<ProjectPurgeRuntimePassReceipt> {
  const receipt: ProjectPurgeRuntimePassReceipt = {
    resumed: null,
    legacyInspected: null,
    legacyScheduled: null,
    dueInspected: null,
    acceptedAndEnqueued: null,
    notificationInspected: null,
    notificationsDelivered: null,
    notificationRetryInspected: null,
    notificationRetrySent: null,
    failedSteps: [],
  };

  try {
    receipt.resumed = await dependencies.resumeOperations();
  } catch (error) {
    receipt.failedSteps.push("resume");
    logger.error(
      { errorClass: safeErrorClass(error) },
      "project purge accepted-operation resume failed",
    );
  }

  try {
    const scheduled = await dependencies.runScheduler();
    receipt.legacyInspected = scheduled.legacyInspected;
    receipt.legacyScheduled = scheduled.legacyScheduled.length;
    receipt.dueInspected = scheduled.dueInspected;
    receipt.acceptedAndEnqueued = scheduled.acceptedAndEnqueued.length;
    receipt.notificationInspected = scheduled.notificationInspected;
    receipt.notificationsDelivered = scheduled.notificationsDelivered.length;
  } catch (error) {
    receipt.failedSteps.push("scheduler");
    logger.error({ errorClass: safeErrorClass(error) }, "project purge scheduler pass failed");
  }

  try {
    const retried = await dependencies.retryNotifications();
    receipt.notificationRetryInspected = retried.inspected;
    receipt.notificationRetrySent = retried.sent;
  } catch (error) {
    receipt.failedSteps.push("notification_retry");
    logger.error(
      { errorClass: safeErrorClass(error) },
      "project purge notification retry pass failed",
    );
  }

  return receipt;
}

/**
 * Invoked after a retirement or permanent-purge worker reaches its durable
 * terminal write. Uniqueness lives in the notification store, so this and the
 * periodic poll may race without sending duplicate in-product receipts.
 */
export async function dispatchProjectPurgeNotificationsOnce(): Promise<void> {
  await dispatchProjectPurgeMilestones(
    {
      store: databaseProjectPurgeSchedulerStore,
      deliverMilestone,
    },
    PROJECT_PURGE_RUNTIME_BATCH_LIMIT,
  );
}

export type ProjectPurgeRuntimeController = {
  initialPass: Promise<ProjectPurgeRuntimePassReceipt | null>;
  stop(): void;
};

type TimerHandle = ReturnType<typeof setInterval>;
type TimerDependencies = {
  setIntervalFn(callback: () => void, intervalMs: number): TimerHandle;
  clearIntervalFn(handle: TimerHandle): void;
};

const defaultTimers: TimerDependencies = {
  setIntervalFn: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearIntervalFn: (handle) => clearInterval(handle),
};

let activeController: ProjectPurgeRuntimeController | null = null;

/** Starts exactly one non-overlapping poller after migrations and worker readiness. */
export function startProjectPurgeRuntimeAfterMigrations(
  dependencies: ProjectPurgeRuntimeDependencies = defaultDependencies,
  timers: TimerDependencies = defaultTimers,
): ProjectPurgeRuntimeController {
  if (activeController) return activeController;

  let stopped = false;
  let running = false;
  const run = async (): Promise<ProjectPurgeRuntimePassReceipt | null> => {
    if (stopped || running) return null;
    running = true;
    try {
      return await runProjectPurgeRuntimePass(dependencies);
    } finally {
      running = false;
    }
  };

  const initialPass = run();
  const timer = timers.setIntervalFn(() => {
    void run();
  }, PROJECT_PURGE_RUNTIME_INTERVAL_MS);
  timer.unref?.();

  const controller: ProjectPurgeRuntimeController = {
    initialPass,
    stop() {
      if (stopped) return;
      stopped = true;
      timers.clearIntervalFn(timer);
      if (activeController === controller) activeController = null;
    },
  };
  activeController = controller;
  return controller;
}

export function stopProjectPurgeRuntime(): void {
  activeController?.stop();
}
