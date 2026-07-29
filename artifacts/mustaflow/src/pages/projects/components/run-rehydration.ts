export type RehydratableTask = {
  id: number;
  status: string;
  kind?: string;
};

const REHYDRATABLE_TASK_STATUSES = new Set([
  "queued",
  "planning",
  "building",
  "running",
  "in_progress",
  "testing",
  "needs_approval",
  "needs_review",
  "needs_fix",
]);

export function isRehydratableTaskStatus(status: string | undefined): boolean {
  return !!status && REHYDRATABLE_TASK_STATUSES.has(status);
}

export function selectRehydratableTaskId(tasks: RehydratableTask[]): number | null {
  return tasks.find((task) => isRehydratableTaskStatus(task.status))?.id ?? null;
}

/**
 * Select the foreground task created by the current synchronous message send.
 *
 * Production task timestamps can come from a different clock than the browser,
 * so wall-clock comparisons are not reliable here. The task id baseline is
 * captured immediately before the POST and lets polling identify the new row
 * without depending on timestamp parity.
 */
export function selectPendingRunTaskId(
  tasks: RehydratableTask[],
  taskIdsBeforeSend: ReadonlySet<number>,
): number | null {
  const candidates = tasks.filter(
    (task) =>
      task.kind !== "background" &&
      !taskIdsBeforeSend.has(task.id) &&
      isRehydratableTaskStatus(task.status),
  );

  return candidates.reduce<number | null>(
    (latestId, task) => (latestId === null || task.id > latestId ? task.id : latestId),
    null,
  );
}

export type RunLoopProgress = {
  stepIndex: number;
  stepCap: number;
};

export function parseRunLoopProgress(
  eventType: string,
  message: string | undefined,
): RunLoopProgress | null {
  if (eventType !== "loop:step" || !message?.startsWith("{")) return null;
  try {
    const payload = JSON.parse(message) as Partial<RunLoopProgress>;
    if (
      typeof payload.stepIndex !== "number" ||
      !Number.isFinite(payload.stepIndex) ||
      typeof payload.stepCap !== "number" ||
      !Number.isFinite(payload.stepCap) ||
      payload.stepIndex < 1 ||
      payload.stepCap < 1
    ) {
      return null;
    }
    return {
      stepIndex: Math.floor(payload.stepIndex),
      stepCap: Math.floor(payload.stepCap),
    };
  } catch {
    return null;
  }
}
