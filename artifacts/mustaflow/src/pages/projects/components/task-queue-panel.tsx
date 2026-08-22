import { useState, useCallback, useRef } from "react";
import {
  useListTasks,
  useCancelTask,
  useForceStartTask,
  useReorderTasks,
  getListTasksQueryKey,
  resumePausedQueue,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  AlertTriangle,
  Loader2,
  Square,
  Trash2,
  ListChecks,
  Clock,
  Play,
  GripVertical,
  Zap,
} from "lucide-react";
import { getBuilderTaskQueueLabel } from "@/lib/builder-completion";
import { selectLingeringCompletedTask } from "@/lib/builder-task-queue";
import { parseNabuflowGateError, type NabuflowGateError } from "@/lib/nabuflow-billing";
import { cn } from "@/lib/utils";
import { terminalPresentationFor, terminalTaskStatus } from "@/lib/zero-terminal";

interface TaskQueuePanelProps {
  projectId: number;
  onStop: () => void;
  /** Bubble a NabuFlow billing block up to the workspace's calm blocked card. */
  onBillingBlock?: (gate: NabuflowGateError) => void;
}

const ACTIVE_STATUSES = [
  "answering",
  "planning",
  "building",
  "testing",
  "needs_review",
  "needs_fix",
] as const;
const WAITING_STATUSES = new Set(["needs_review", "needs_fix"]);
const PAUSED_STATUS = "paused-insufficient-credits";

export function TaskQueuePanel({ projectId, onStop, onBillingBlock }: TaskQueuePanelProps) {
  const queryClient = useQueryClient();

  const { data: tasks = [] } = useListTasks(projectId, {
    query: {
      refetchInterval: 3000,
      staleTime: 0,
      queryKey: getListTasksQueryKey(projectId),
    },
  });
  const terminalAwareTasks = tasks.map((task) => ({
    ...task,
    status: terminalTaskStatus(
      task as typeof task & { terminal?: unknown },
      task.status,
    ) as typeof task.status,
  }));

  const cancelTask = useCancelTask();
  const forceStartTask = useForceStartTask();
  const reorderTasks = useReorderTasks();

  const [confirmRunNowId, setConfirmRunNowId] = useState<number | null>(null);

  // Drag-to-reorder state
  const [localOrder, setLocalOrder] = useState<number[]>([]);
  const [dragOverId, setDragOverId] = useState<number | null>(null);
  const draggingIdRef = useRef<number | null>(null);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
  }, [projectId, queryClient]);

  const handleResume = useCallback(() => {
    resumePausedQueue(projectId)
      .then((data) => {
        if (data && (data.resumed ?? 0) > 0) {
          invalidate();
        }
      })
      .catch((err) => {
        // NabuFlow billing gate — bubble the calm blocked card up to the
        // workspace instead of swallowing the failure.
        const gate = parseNabuflowGateError(err);
        if (gate && onBillingBlock) onBillingBlock(gate);
      });
  }, [projectId, invalidate, onBillingBlock]);

  const activeTask = terminalAwareTasks.find((t) =>
    (ACTIVE_STATUSES as readonly string[]).includes(t.status),
  );
  const activeTaskIsWaiting = activeTask ? WAITING_STATUSES.has(activeTask.status) : false;
  const rawQueuedTasks = terminalAwareTasks.filter((t) => t.status === "queued");
  const pausedTasks = terminalAwareTasks.filter((t) => (t.status as string) === PAUSED_STATUS);
  const lingeringCompletedTask = selectLingeringCompletedTask(
    terminalAwareTasks,
    activeTask != null,
  );
  const lingeringTerminal = lingeringCompletedTask
    ? terminalPresentationFor(
        lingeringCompletedTask as typeof lingeringCompletedTask & { terminal?: unknown },
      )
    : null;

  // Apply local ordering optimistically; fall back to server order when localOrder is stale
  const queuedTaskIds = rawQueuedTasks.map((t) => t.id);
  const localIds = localOrder.filter((id) => queuedTaskIds.includes(id));
  const orderedQueuedTasks =
    localIds.length === queuedTaskIds.length
      ? localIds.map((id) => rawQueuedTasks.find((t) => t.id === id)!)
      : rawQueuedTasks;

  const hasActivity =
    activeTask != null ||
    lingeringCompletedTask != null ||
    rawQueuedTasks.length > 0 ||
    pausedTasks.length > 0;

  const summaryParts = [
    activeTask ? (activeTaskIsWaiting ? "1 waiting" : "1 active") : null,
    lingeringCompletedTask
      ? lingeringTerminal?.tone === "unknown"
        ? "1 outcome unavailable"
        : "1 completed"
      : null,
    rawQueuedTasks.length > 0 ? `${rawQueuedTasks.length} queued` : null,
    pausedTasks.length > 0 ? `${pausedTasks.length} paused` : null,
  ].filter(Boolean);

  // Drag handlers
  const handleDragStart = (taskId: number) => {
    draggingIdRef.current = taskId;
    if (localOrder.length === 0) {
      setLocalOrder(orderedQueuedTasks.map((t) => t.id));
    }
  };

  const handleDragOver = (e: React.DragEvent, taskId: number) => {
    e.preventDefault();
    if (draggingIdRef.current === null || draggingIdRef.current === taskId) return;
    setDragOverId(taskId);
  };

  const handleDrop = (e: React.DragEvent, targetId: number) => {
    e.preventDefault();
    const sourceId = draggingIdRef.current;
    if (sourceId === null || sourceId === targetId) {
      setDragOverId(null);
      return;
    }

    const current = localOrder.length > 0 ? localOrder : orderedQueuedTasks.map((t) => t.id);
    const sourceIdx = current.indexOf(sourceId);
    const targetIdx = current.indexOf(targetId);
    if (sourceIdx === -1 || targetIdx === -1) {
      setDragOverId(null);
      return;
    }

    const newOrder = [...current];
    newOrder.splice(sourceIdx, 1);
    newOrder.splice(targetIdx, 0, sourceId);
    setLocalOrder(newOrder);
    setDragOverId(null);
    draggingIdRef.current = null;

    reorderTasks.mutate({ id: projectId, data: { taskIds: newOrder } }, { onSettled: invalidate });
  };

  const handleDragEnd = () => {
    draggingIdRef.current = null;
    setDragOverId(null);
  };

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
            {activeTaskIsWaiting ? (
              <Clock className="h-3 w-3 text-amber-400 shrink-0" />
            ) : (
              <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
            )}
            <span className="flex-1 text-[11px] text-foreground truncate min-w-0">
              {activeTask.title}
            </span>
            {activeTaskIsWaiting ? (
              <span className="h-5 px-1.5 rounded-md flex items-center text-[10px] font-medium bg-amber-500/15 text-amber-300 shrink-0">
                {activeTask.status === "needs_fix" ? "Needs fix" : "Awaiting apply"}
              </span>
            ) : (
              <button
                onClick={onStop}
                title="Stop current task"
                className="h-5 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-medium bg-destructive/80 text-destructive-foreground hover:bg-destructive transition-colors shrink-0"
              >
                <Square className="h-2.5 w-2.5 fill-current" />
                Stop
              </button>
            )}
          </div>
        )}

        {lingeringCompletedTask && (
          <div className="px-3 py-2 flex items-center gap-2">
            {lingeringTerminal?.tone === "warning" || lingeringTerminal?.tone === "unknown" ? (
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
            )}
            <span className="flex-1 text-[11px] text-foreground truncate min-w-0">
              {lingeringCompletedTask.title}
            </span>
            <span
              className={cn(
                "h-5 px-1.5 rounded-md flex items-center text-[10px] font-medium shrink-0",
                lingeringTerminal?.tone === "warning" || lingeringTerminal?.tone === "unknown"
                  ? "bg-amber-500/10 text-amber-400"
                  : "bg-green-500/10 text-green-400",
              )}
            >
              {lingeringTerminal?.title ??
                getBuilderTaskQueueLabel(
                  lingeringCompletedTask.status,
                  lingeringCompletedTask.completionKind,
                )}
            </span>
          </div>
        )}

        {orderedQueuedTasks.map((task) => {
          const isConfirming = confirmRunNowId === task.id;
          const isDragOver = dragOverId === task.id;
          const showDragHandle = orderedQueuedTasks.length > 1;

          return (
            <div
              key={task.id}
              draggable={showDragHandle}
              onDragStart={() => handleDragStart(task.id)}
              onDragOver={(e) => handleDragOver(e, task.id)}
              onDrop={(e) => handleDrop(e, task.id)}
              onDragEnd={handleDragEnd}
              className={cn(
                "px-3 py-1.5 flex items-center gap-2 transition-colors",
                isDragOver && "bg-primary/10",
              )}
            >
              {showDragHandle && (
                <span title="Drag to reorder">
                  <GripVertical className="h-3 w-3 text-muted-foreground/40 shrink-0 cursor-grab active:cursor-grabbing" />
                </span>
              )}
              <Clock className="h-3 w-3 text-muted-foreground/50 shrink-0" />
              <span className="flex-1 text-[11px] text-muted-foreground truncate min-w-0">
                {task.title}
              </span>

              {isConfirming ? (
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[10px] text-muted-foreground">Stop build?</span>
                  <button
                    onClick={() => {
                      setConfirmRunNowId(null);
                      forceStartTask.mutate(
                        { id: projectId, taskId: task.id },
                        { onSuccess: invalidate, onError: invalidate },
                      );
                    }}
                    className="h-5 px-1.5 rounded-md text-[10px] font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmRunNowId(null)}
                    className="h-5 px-1.5 rounded-md text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    No
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => {
                      if (activeTask) {
                        setConfirmRunNowId(task.id);
                      } else {
                        forceStartTask.mutate(
                          { id: projectId, taskId: task.id },
                          { onSuccess: invalidate, onError: invalidate },
                        );
                      }
                    }}
                    title="Run this task now"
                    className="h-5 px-1.5 rounded-md flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  >
                    <Zap className="h-2.5 w-2.5" />
                    Run Now
                  </button>
                  <button
                    onClick={() =>
                      cancelTask.mutate(
                        { id: projectId, taskId: task.id },
                        { onSuccess: invalidate, onError: invalidate },
                      )
                    }
                    title="Cancel this task"
                    className="h-5 w-5 flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                    aria-label="Cancel task"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>
          );
        })}

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
