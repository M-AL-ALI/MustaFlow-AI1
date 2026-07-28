export type BuilderQueueTask = {
  id: number;
  status: string;
  createdAt?: string | Date | null;
  completedAt?: string | Date | null;
};

const NOT_STARTED_STATUSES = new Set(["queued", "paused-insufficient-credits"]);

function taskSequenceTimestamp(task: BuilderQueueTask): number {
  const value = task.completedAt ?? task.createdAt;
  if (!value) return task.id;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : task.id;
}

export function selectLingeringCompletedTask<T extends BuilderQueueTask>(
  tasks: T[],
  hasActiveTask: boolean,
): T | undefined {
  if (hasActiveTask) return undefined;
  const mostRecentStartedTask = tasks
    .filter((task) => !NOT_STARTED_STATUSES.has(task.status))
    .sort(
      (a, b) => taskSequenceTimestamp(b) - taskSequenceTimestamp(a) || b.id - a.id,
    )[0];
  return mostRecentStartedTask?.status === "completed" ? mostRecentStartedTask : undefined;
}
