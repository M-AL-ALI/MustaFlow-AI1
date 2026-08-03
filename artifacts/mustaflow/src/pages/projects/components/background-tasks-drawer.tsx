import { ReactNode } from "react";
import { useListTaskEvents, getListTaskEventsQueryKey } from "@workspace/api-client-react";
import {
  X,
  Layers2,
  Loader2,
  CheckCircle2,
  XCircle,
  Circle,
  Clock,
  RotateCcw,
  FileCode2,
  Ban,
  PauseCircle,
  CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TaskReport = {
  versionId?: number | null;
  filesCreated?: string[];
  filesChanged?: string[];
  filesRemoved?: string[];
};

type TaskEvent = {
  id: number;
  eventType: string;
  message: string;
  createdAt: string;
};

export type BgTask = {
  id: number;
  title: string;
  status: string;
  kind: string;
  prompt: string | null;
  result: string | null;
  report: Record<string, unknown> | null;
  createdAt: string;
  completedAt: string | null;
};

const ACTIVE_STATUSES = new Set(["planning", "building", "testing", "needs_review", "needs_fix"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "cancelled", "discarded"]);
const PAUSED_STATUS = "paused-insufficient-credits";

function LiveEvents({ projectId, taskId }: { projectId: number; taskId: number }) {
  const { data: raw = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      refetchInterval: 700,
    },
  });
  const events = raw as TaskEvent[];
  const last3 = events.slice(-3);

  if (last3.length === 0) {
    return (
      <div className="flex items-center gap-1.5 mt-1.5">
        <Loader2 className="h-2.5 w-2.5 animate-spin text-primary/60 shrink-0" />
        <span className="text-[10px] text-muted-foreground/60">Starting up…</span>
      </div>
    );
  }

  const lastEv = last3[last3.length - 1];
  const isTerminal = lastEv ? TERMINAL_STATUSES.has(lastEv.eventType) : false;

  return (
    <div className="mt-1.5 space-y-0.5">
      {last3.map((ev, i) => {
        const isLast = i === last3.length - 1;
        return (
          <div
            key={ev.id}
            className={cn(
              "flex items-center gap-1.5 text-[10px]",
              isLast && !isTerminal ? "text-foreground/80" : "text-muted-foreground/40",
            )}
          >
            {isLast && !isTerminal ? (
              <Loader2 className="h-2.5 w-2.5 animate-spin shrink-0 text-primary" />
            ) : (
              <span className="w-2.5 shrink-0" />
            )}
            <span className="truncate">{ev.message}</span>
          </div>
        );
      })}
    </div>
  );
}

function TaskCard({
  projectId,
  task,
  onRollback,
  onViewCode,
}: {
  projectId: number;
  task: BgTask;
  onRollback: (versionId: number) => void;
  onViewCode: () => void;
}) {
  const isActive = ACTIVE_STATUSES.has(task.status);
  const isQueued = task.status === "queued";
  const isCompleted = task.status === "completed";
  const isFailed = task.status === "failed";
  const isCanceled = task.status === "canceled";
  const isPaused = task.status === PAUSED_STATUS;

  const report = task.report as TaskReport | null;
  const versionId = report?.versionId;
  const fileCount =
    (report?.filesCreated?.length ?? 0) +
    (report?.filesChanged?.length ?? 0) +
    (report?.filesRemoved?.length ?? 0);

  const title = (task.prompt ?? task.title).replace(/^(Build|Change): /, "");

  return (
    <div
      className={cn(
        "rounded-lg border p-3 text-xs space-y-1.5 transition-colors",
        isCompleted
          ? "border-green-500/20 bg-green-500/5"
          : isFailed
            ? "border-destructive/20 bg-destructive/5"
            : isActive
              ? "border-primary/20 bg-primary/5"
              : isPaused
                ? "border-amber-500/20 bg-amber-500/5"
                : isCanceled
                  ? "border-border/30 bg-muted/10"
                  : "border-border bg-muted/30",
      )}
    >
      <div className="flex items-start gap-2">
        {isCompleted ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0 mt-0.5" />
        ) : isFailed ? (
          <XCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
        ) : isCanceled ? (
          <Ban className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
        ) : isPaused ? (
          <PauseCircle className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
        ) : isActive ? (
          <Loader2 className="h-3.5 w-3.5 text-primary animate-spin shrink-0 mt-0.5" />
        ) : (
          <Circle className="h-3.5 w-3.5 text-muted-foreground/30 shrink-0 mt-0.5" />
        )}
        <div className="flex-1 min-w-0">
          <div className="font-medium text-foreground leading-tight line-clamp-2">{title}</div>
          <div className="text-[10px] text-muted-foreground/70 mt-0.5">
            {isQueued
              ? "Waiting to start…"
              : isActive
                ? "Running…"
                : isPaused
                  ? "Paused — needs credits"
                  : isCompleted
                    ? `Done${fileCount > 0 ? ` · ${fileCount} file${fileCount !== 1 ? "s" : ""}` : ""}`
                    : isFailed
                      ? "Failed"
                      : isCanceled
                        ? "Canceled"
                        : task.status}
          </div>
        </div>
      </div>

      {isActive && <LiveEvents projectId={projectId} taskId={task.id} />}

      {isCompleted && (
        <div className="flex items-center gap-1.5 pt-1.5 border-t border-border/40 mt-1">
          <p className="text-[10px] text-muted-foreground/70 flex-1 min-w-0">Changes applied.</p>
          <button
            onClick={onViewCode}
            className="flex items-center gap-1 px-2 py-1 rounded bg-muted border border-border text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors shrink-0"
          >
            <FileCode2 className="h-2.5 w-2.5" />
            Files
          </button>
          {versionId && (
            <button
              onClick={() => onRollback(versionId)}
              className="flex items-center gap-1 px-2 py-1 rounded bg-muted border border-border text-[10px] text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors shrink-0"
            >
              <RotateCcw className="h-2.5 w-2.5" />
              Undo
            </button>
          )}
        </div>
      )}

      {isFailed && task.result && (
        <p className="text-[10px] text-destructive/80 leading-relaxed pt-1 border-t border-destructive/20">
          {task.result.slice(0, 120)}
        </p>
      )}
    </div>
  );
}

interface BackgroundTasksDrawerProps {
  projectId: number;
  isOpen: boolean;
  onClose: () => void;
  tasks: BgTask[];
  onRollback: (versionId: number) => void;
  onViewCode: () => void;
  children?: ReactNode;
}

export function BackgroundTasksDrawer({
  projectId,
  isOpen,
  onClose,
  tasks,
  onRollback,
  onViewCode,
  children,
}: BackgroundTasksDrawerProps) {
  const activeCount = tasks.filter((t) => !TERMINAL_STATUSES.has(t.status)).length;
  const pausedCount = tasks.filter((t) => t.status === PAUSED_STATUS).length;

  return (
    <>
      {isOpen && <div className="fixed inset-0 z-40" onClick={onClose} />}
      <div
        className={cn(
          "fixed top-0 right-0 h-full w-80 bg-background border-l border-border shadow-2xl z-50 flex flex-col transition-transform duration-300 ease-in-out",
          isOpen ? "translate-x-0" : "translate-x-full",
        )}
      >
        <div className="shrink-0 px-4 py-3 border-b border-border flex items-center gap-2">
          <Layers2 className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold">Background Tasks</span>
          {activeCount > 0 && (
            <span className="ml-1 text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium border border-primary/20">
              {activeCount} running
            </span>
          )}
          <button
            onClick={onClose}
            className="ml-auto p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {pausedCount > 0 && (
          <div className="shrink-0 border-b border-amber-500/20 bg-amber-500/5 px-4 py-3 flex items-start gap-2.5">
            <PauseCircle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-foreground">Queue paused — out of credits</p>
              <p className="text-[10px] text-muted-foreground/80 mt-0.5 leading-relaxed">
                {pausedCount} task{pausedCount !== 1 ? "s" : ""} waiting. Review your plan or
                spending limit to resume the queue.
              </p>
              <a
                href="/billing"
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/30 text-[11px] font-medium text-amber-200 transition-colors"
              >
                <CreditCard className="h-3 w-3" />
                Open Billing &amp; Usage
              </a>
            </div>
          </div>
        )}

        {children && <div className="shrink-0 border-b border-border">{children}</div>}

        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {tasks.length === 0 && !children ? (
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <Clock className="h-8 w-8 text-muted-foreground/20" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">No background tasks yet</p>
                <p className="text-xs text-muted-foreground/60 mt-1 leading-relaxed max-w-[180px]">
                  Enable background mode in the chat to run tasks here
                </p>
              </div>
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard
                key={task.id}
                projectId={projectId}
                task={task}
                onRollback={onRollback}
                onViewCode={onViewCode}
              />
            ))
          )}
        </div>

        <div className="shrink-0 px-4 py-2.5 border-t border-border">
          <p className="text-[10px] text-muted-foreground/40 text-center">
            Tasks run sequentially without blocking chat
          </p>
        </div>
      </div>
    </>
  );
}
