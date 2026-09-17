import { ChevronRight, Layers2 } from "lucide-react";

export type QueuedTaskState = {
  id: number;
  projectId: number;
  status: string;
  runMode?: string | null;
};

export function queuedTaskLabel(task: QueuedTaskState | undefined): string {
  if (!task) return "Task status unavailable";
  const background = task.runMode === "background";
  switch (task.status) {
    case "queued":
      return background ? "Task queued in background" : "Task queued";
    case "planning":
    case "building":
    case "refining":
    case "testing":
    case "running":
      return background ? "Background task running" : "Task running";
    case "needs_review":
      return "Task ready for review";
    case "needs_fix":
      return "Task needs attention";
    case "failed":
      return "Task failed";
    case "completed":
      return "View task results";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "Task stopped";
    case "paused":
      return "Task paused";
    default:
      return "View task details";
  }
}

export function TaskQueuedMessage({
  projectId,
  taskId,
  tasks,
  onOpenTask,
}: {
  projectId: number;
  taskId: unknown;
  tasks: readonly QueuedTaskState[];
  onOpenTask: (taskId: number) => void;
}) {
  const task =
    typeof taskId === "number" && Number.isSafeInteger(taskId) && taskId > 0
      ? tasks.find((candidate) => candidate.id === taskId && candidate.projectId === projectId)
      : undefined;
  return (
    <button
      type="button"
      disabled={!task}
      onClick={() => {
        if (task) onOpenTask(task.id);
      }}
      className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/40 bg-muted/30 text-[10px] text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors disabled:cursor-default disabled:opacity-60"
    >
      <Layers2 className="h-3 w-3 text-primary/60 shrink-0" />
      <span>{queuedTaskLabel(task)}</span>
      <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
    </button>
  );
}
