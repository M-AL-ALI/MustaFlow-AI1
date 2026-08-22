import { authFetch } from "@/lib/api-fetch";
import { useState, useEffect, useCallback } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  Circle,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Ban,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getBuilderTaskQueueLabel } from "@/lib/builder-completion";
import { terminalPresentationFor, terminalTaskStatus } from "@/lib/zero-terminal";

type TaskStatus =
  | "queued"
  | "answering"
  | "planning"
  | "building"
  | "testing"
  | "needs_approval"
  | "needs_review"
  | "needs_fix"
  | "paused-insufficient-credits"
  | "completed"
  | "failed"
  | "canceled"
  | "cancelled"
  | "discarded";

interface BatchTask {
  id: number;
  title: string;
  status: TaskStatus;
  prompt: string | null;
  queueIndex: number | null;
  completionKind?: string | null;
  terminal?: unknown;
}

interface BatchState {
  batchId: string;
  projectId: number;
  tasks: BatchTask[];
  totalCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  unknownCount?: number;
}

interface QueueProgressStripProps {
  projectId: number;
  batchId: string;
  onComplete: () => void;
  onRetry: (remainingMessages: string[], agentMode: string) => void;
}

const ACTIVE_STATUSES: Set<string> = new Set([
  "queued",
  "answering",
  "planning",
  "building",
  "testing",
  "needs_approval",
  "needs_review",
  "needs_fix",
]);

function TaskStepIcon({ status, warning }: { status: TaskStatus; warning: boolean }) {
  if (warning) {
    return <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
  }
  if (status === "completed") {
    return <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />;
  }
  if (status === "failed") {
    return <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />;
  }
  if (status === "canceled" || status === "cancelled" || status === "discarded") {
    return <Ban className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />;
  }
  if (ACTIVE_STATUSES.has(status) && status !== "queued") {
    return <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0" />;
  }
  return <Circle className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />;
}

export function QueueProgressStrip({
  projectId,
  batchId,
  onComplete,
  onRetry,
}: QueueProgressStripProps) {
  const [batch, setBatch] = useState<BatchState | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [done, setDone] = useState(false);

  const fetchBatch = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/queue/${batchId}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      const received = (await res.json()) as BatchState;
      const tasks = received.tasks.map((task) => ({
        ...task,
        status: terminalTaskStatus(task, task.status) as TaskStatus,
      }));
      const data = {
        ...received,
        tasks,
        completedCount: tasks.filter((task) => task.status === "completed").length,
        failedCount: tasks.filter((task) => task.status === "failed").length,
        cancelledCount: tasks.filter((task) =>
          ["canceled", "cancelled", "discarded"].includes(task.status),
        ).length,
        unknownCount: tasks.filter((task) => terminalPresentationFor(task)?.tone === "unknown")
          .length,
      };
      setBatch(data);

      const allDone = data.tasks.every((t) => !ACTIVE_STATUSES.has(t.status));
      if (allDone) {
        setDone(true);
        setTimeout(() => {
          onComplete();
        }, 4000);
      }
    } catch {
      // ignore
    }
  }, [projectId, batchId, onComplete]);

  useEffect(() => {
    void fetchBatch();
    const interval = setInterval(() => {
      if (!done) void fetchBatch();
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchBatch, done]);

  const handleCancel = useCallback(async () => {
    setCancelling(true);
    try {
      await authFetch(`/api/projects/${projectId}/queue/${batchId}`, {
        method: "DELETE",
        credentials: "include",
      });
      void fetchBatch();
    } catch {
      // ignore
    } finally {
      setCancelling(false);
    }
  }, [projectId, batchId, fetchBatch]);

  const handleRetry = useCallback(() => {
    if (!batch) return;
    const failedIdx = batch.tasks.findIndex((t) => t.status === "failed");
    const retryTasks = batch.tasks.filter(
      (t, idx) =>
        idx >= failedIdx &&
        (t.status === "failed" || t.status === "queued" || t.status === "canceled"),
    );
    const messages = retryTasks.map((t) => t.prompt ?? t.title).filter(Boolean);
    if (messages.length > 0) {
      onRetry(messages, "power");
    }
  }, [batch, onRetry]);

  if (!batch) return null;

  const runningTask = batch.tasks.find(
    (t) => ACTIVE_STATUSES.has(t.status) && t.status !== "queued",
  );
  const hasFailure = batch.failedCount > 0;
  const hasUnknown = (batch.unknownCount ?? 0) > 0;
  const allDone = batch.tasks.every((t) => !ACTIVE_STATUSES.has(t.status));
  const hasQueued = batch.tasks.some((t) => t.status === "queued");

  return (
    <div
      className={cn(
        "shrink-0 border-t border-border/50 bg-muted/30 transition-all duration-200",
        done && "opacity-60",
      )}
    >
      <div className="px-3 py-2 flex items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {!allDone && !hasFailure && (
            <Loader2 className="h-3 w-3 text-primary animate-spin shrink-0" />
          )}
          {allDone && !hasFailure && !hasUnknown && (
            <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
          )}
          {allDone && !hasFailure && hasUnknown && (
            <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
          )}
          {hasFailure && <XCircle className="h-3 w-3 text-destructive shrink-0" />}
          <span className="text-[11px] font-semibold text-foreground truncate">
            {allDone
              ? hasFailure
                ? `Queue paused — task failed`
                : hasUnknown
                  ? "Queue finished — some outcomes are unavailable"
                  : `Queue complete — ${batch.completedCount} task${batch.completedCount !== 1 ? "s" : ""} done`
              : runningTask
                ? `Running task ${(runningTask.queueIndex ?? 0) + 1} of ${batch.totalCount}…`
                : `Queue: ${batch.completedCount} of ${batch.totalCount} done`}
          </span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {hasFailure && (
            <button
              onClick={handleRetry}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 transition-colors"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Retry from here
            </button>
          )}
          {hasQueued && !allDone && (
            <button
              onClick={() => void handleCancel()}
              disabled={cancelling}
              className="flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-muted-foreground border border-border hover:text-destructive hover:border-destructive/40 transition-colors disabled:opacity-50"
            >
              <Ban className="h-2.5 w-2.5" />
              Cancel remaining
            </button>
          )}
          <button
            onClick={() => setCollapsed((v) => !v)}
            className="w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground transition-colors"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronUp className="h-3.5 w-3.5" />
            )}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="px-3 pb-2 flex flex-col gap-1">
          {batch.tasks.map((task, idx) => {
            const terminal = terminalPresentationFor(task);
            const warning = terminal?.tone === "warning" || terminal?.tone === "unknown";
            return (
              <div
                key={task.id}
                className={cn(
                  "flex items-center gap-2 px-2 py-1 rounded-lg transition-colors",
                  warning && "bg-amber-500/5",
                  task.status === "failed" && "bg-destructive/5",
                  ACTIVE_STATUSES.has(task.status) && task.status !== "queued" && "bg-primary/5",
                )}
              >
                <TaskStepIcon status={task.status} warning={warning} />
                <span className="text-[9px] font-bold text-muted-foreground/50 w-3 shrink-0">
                  {idx + 1}
                </span>
                <span
                  className={cn(
                    "flex-1 text-[11px] truncate",
                    warning && "text-amber-300",
                    !warning && task.status === "completed" && "text-muted-foreground",
                    task.status === "failed" && "text-destructive",
                    task.status === "canceled" && "text-muted-foreground/40 line-through",
                    ACTIVE_STATUSES.has(task.status) &&
                      task.status !== "queued" &&
                      "text-foreground font-medium",
                  )}
                >
                  {task.prompt ?? task.title}
                </span>
                <span
                  className={cn(
                    "text-[9px] shrink-0 capitalize font-medium",
                    warning && "text-amber-400",
                    !warning && task.status === "completed" && "text-green-400",
                    task.status === "failed" && "text-destructive",
                    task.status === "canceled" && "text-muted-foreground/40",
                    task.status === "queued" && "text-muted-foreground/50",
                    ACTIVE_STATUSES.has(task.status) && task.status !== "queued" && "text-primary",
                  )}
                >
                  {terminal?.title ??
                    (task.status === "building" || task.status === "planning"
                      ? "running"
                      : getBuilderTaskQueueLabel(task.status, task.completionKind))}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
