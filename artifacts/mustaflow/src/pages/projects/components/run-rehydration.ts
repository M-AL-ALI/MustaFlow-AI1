export type RehydratableTask = {
  id: number;
  status: string;
};

const REHYDRATABLE_TASK_STATUSES = new Set(["planning", "building", "testing", "needs_approval"]);

export function isRehydratableTaskStatus(status: string | undefined): boolean {
  return !!status && REHYDRATABLE_TASK_STATUSES.has(status);
}

export function selectRehydratableTaskId(tasks: RehydratableTask[]): number | null {
  return tasks.find((task) => isRehydratableTaskStatus(task.status))?.id ?? null;
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
