import { useCallback } from "react";
import {
  useListTasks,
  useCancelTask,
  getListTasksQueryKey,
  resumePausedQueue,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Square, X, ListChecks, Clock, Play } from "lucide-react";
import { cn } from "@/lib/utils";

interface TaskQueuePanelProps {
  projectId: number;
  onStop: () => void;
}

const ACTIVE_STATUSES = ["planning", "building", "testing"] as const;
const PAUSED_STATUS = "paused-insufficient-credits";

export function TaskQueuePanel({ projectId, onStop }: TaskQueuePanelProps) {
  const queryClient = useQueryClient();

  const { data: tasks = [] } = useListTasks(projectId, {
    query: {
      refetchInterval: 3000,
      staleTime: 0,
      queryKey: getListTasksQueryKey(projectId),
    },
  });

  const cancelTask = useCancelTask();

  const handleResume = useCallback(() => {
    resumePausedQueue(projectId)
      .then((data) => {
        if (data && (data.resumed ?? 0) > 0) {
          void queryClient.invalidateQueries({
            queryKey: getListTasksQueryKey(projectId),
          });
        }
      })
      .catch(() => {});
  }, [projectId, queryClient]);

  const activeTask = tasks.find((t) => (ACTIVE_STATUSES as readonly string[]).includes(t.status));
  const queuedTasks = tasks.filter((t) => t.status === "queued");
  const pausedTasks = tasks.filter((t) => (t.status as string) === PAUSED_STATUS);

  const hasActivity = activeTask != null || queuedTasks.length > 0 || pausedTasks.length > 0;

  const summaryParts = [
    activeTask ? "1 active" : null,
    queuedTasks.length > 0 ? `${queuedTasks.length} queued` : null,
    pausedTasks.length > 0 ? `${pausedTasks.length} paused` : null,
  ].filter(Boolean);

  // When the queue is idle, render a compact collapsed summary row
  if (!hasActivity) {
    return (
      <div className="mx-3 mb-2 px-3 py-1.5 flex items-center gap-1.5 rounded-xl border border-border/40 bg-background/40">
        <ListChecks className="h-3 w-3 text-muted-foreground/50 shrink-0" />
        <span className="text-[10px] text-muted-foreground/50">Queue idle</span>
      </div>
    );
  }

  return (
    <div className="mx-3 mb-2 rounded-xl border border-border bg-background/60 overflow-hidden">
      <div className="px-3 py-1.5 flex items-center gap-1.5 border-b border-border/50">
        <ListChecks className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          Task Queue
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {summaryParts.join(" · ")}
        </span>
      </div>

      <div className="divide-y divide-border/40">
        {activeTask && (
          <div className="px-3 py-2 flex items-center gap-2">
            <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
            <span className="flex-1 text-[11px] text-foreground truncate min-w-0">
              {activeTask.title}
            </span>
            <button
              onClick={onStop}
              title="Stop current task"
              className="h-5 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-medium bg-destructive/80 text-destructive-foreground hover:bg-destructive transition-colors shrink-0"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
              Stop
            </button>
          </div>
        )}

        {queuedTasks.map((task) => (
          <div key={task.id} className="px-3 py-1.5 flex items-center gap-2">
            <Clock className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            <span className="flex-1 text-[11px] text-muted-foreground truncate min-w-0">
              {task.title}
            </span>
            <button
              onClick={() => cancelTask.mutate({ id: projectId, taskId: task.id })}
              title="Cancel this task"
              className="h-5 w-5 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors shrink-0"
              aria-label="Cancel task"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}

        {pausedTasks.length > 0 && (
          <div className="px-3 py-2 flex items-center gap-2">
            <span className="flex-1 text-[11px] text-amber-400/80">
              {pausedTasks.length} task
              {pausedTasks.length !== 1 ? "s" : ""} paused — out of credits
            </span>
            <button
              onClick={handleResume}
              title="Resume paused tasks"
              className={cn(
                "h-5 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-medium",
                "bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors shrink-0",
              )}
            >
              <Play className="h-2.5 w-2.5 fill-current" />
              Resume
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
