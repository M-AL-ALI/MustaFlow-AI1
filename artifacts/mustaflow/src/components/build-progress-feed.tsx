import { useEffect, useRef, useState } from "react";
import {
  useListTaskEvents,
  getListTaskEventsQueryKey,
} from "@workspace/api-client-react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  BrainCircuit,
  FolderOpen,
  Code2,
  FilePen,
  FlaskConical,
  Wrench,
  RefreshCw,
  Save,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

type EventType =
  | "queued"
  | "planning"
  | "reading_files"
  | "generating_code"
  | "editing_files"
  | "testing"
  | "fixing_errors"
  | "updating_preview"
  | "saving_version"
  | "generating_blueprint"
  | "restoring_files"
  | "completed"
  | "failed";

const EVENT_META: Record<
  EventType,
  { icon: React.ElementType; color: string }
> = {
  queued: { icon: Clock, color: "text-muted-foreground" },
  planning: { icon: BrainCircuit, color: "text-violet-400" },
  reading_files: { icon: FolderOpen, color: "text-blue-400" },
  generating_code: { icon: Code2, color: "text-primary" },
  editing_files: { icon: FilePen, color: "text-yellow-400" },
  testing: { icon: FlaskConical, color: "text-cyan-400" },
  fixing_errors: { icon: Wrench, color: "text-orange-400" },
  updating_preview: { icon: RefreshCw, color: "text-sky-400" },
  saving_version: { icon: Save, color: "text-secondary" },
  generating_blueprint: { icon: Zap, color: "text-violet-400" },
  restoring_files: { icon: FolderOpen, color: "text-blue-400" },
  completed: { icon: CheckCircle2, color: "text-green-400" },
  failed: { icon: XCircle, color: "text-destructive" },
};

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

const EXPECTED_STEP_COUNT = 8;
const MILESTONE_TYPES = new Set([
  "queued",
  "planning",
  "reading_files",
  "generating_code",
  "saving_version",
  "updating_preview",
  "generating_blueprint",
  "restoring_files",
  "completed",
  "failed",
]);

interface Props {
  projectId: number;
  taskId: number | null;
  taskStartedAt: Date | null;
}

export function BuildProgressFeed({ projectId, taskId, taskStartedAt }: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [visible, setVisible] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: events = [] } = useListTaskEvents(
    projectId,
    taskId ?? 0,
    {
      query: {
        enabled: taskId !== null && taskId > 0,
        queryKey: getListTaskEventsQueryKey(projectId, taskId ?? 0),
        refetchInterval: (query) => {
          const data = query.state.data;
          if (!data || !Array.isArray(data)) return 1500;
          const last = data[data.length - 1];
          if (last && TERMINAL_STATUSES.has(last.eventType as string))
            return false;
          return 1500;
        },
      },
    },
  );

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent
    ? TERMINAL_STATUSES.has(lastEvent.eventType as string)
    : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";

  useEffect(() => {
    if (isTerminal) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [isTerminal]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const elapsedMs = taskStartedAt ? now - taskStartedAt.getTime() : 0;
  const elapsedSec = elapsedMs / 1000;
  const showReassurance = elapsedSec > 30 && !isTerminal;

  const milestoneCount = events.filter((e) =>
    MILESTONE_TYPES.has(e.eventType as string),
  ).length;
  const rawPct = isDone
    ? 100
    : Math.min(95, (milestoneCount / EXPECTED_STEP_COUNT) * 100);

  const deduped = events.reduce<typeof events>((acc, ev) => {
    const prevSameType = acc.findLast((e) => e.eventType === ev.eventType);
    if (
      prevSameType &&
      ev.eventType !== "editing_files" &&
      ev.eventType !== "completed" &&
      ev.eventType !== "failed"
    ) {
      return acc.map((e) => (e.id === prevSameType.id ? ev : e));
    }
    return [...acc, ev];
  }, []);

  if (!visible) return null;

  return (
    <div
      className={cn(
        "px-3 py-2 space-y-2 transition-opacity duration-500",
        isTerminal && !visible && "opacity-0",
      )}
    >
      {/* Step list */}
      <div
        ref={scrollRef}
        className="space-y-0.5 max-h-40 overflow-y-auto hide-scrollbar"
      >
        {taskId === null && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="font-semibold text-primary">Building</span>
            <span className="text-muted-foreground">Initializing…</span>
          </div>
        )}

        {deduped.map((event, idx) => {
          const meta =
            EVENT_META[event.eventType as EventType] ?? EVENT_META.queued;
          const Icon = meta.icon;
          const isLast = idx === deduped.length - 1;
          const isActive = isLast && !isTerminal;
          const isPast = !isLast || isTerminal;

          const stepElapsedSec = taskStartedAt
            ? (new Date(event.createdAt).getTime() -
                taskStartedAt.getTime()) /
              1000
            : null;

          return (
            <div
              key={event.id}
              className={cn(
                "flex items-start gap-2 px-2 py-1 rounded-lg text-[11px] transition-all duration-300",
                isActive ? "bg-primary/10" : "",
              )}
            >
              {isPast && !isActive ? (
                <CheckCircle2
                  className={cn(
                    "h-3 w-3 shrink-0 mt-px",
                    event.eventType === "failed"
                      ? "text-destructive"
                      : event.eventType === "completed"
                      ? "text-green-400"
                      : "text-green-500/60",
                  )}
                />
              ) : (
                <Icon
                  className={cn(
                    "h-3 w-3 shrink-0 mt-px",
                    meta.color,
                    isActive && "animate-pulse",
                  )}
                />
              )}
              <span
                className={cn(
                  "flex-1 truncate leading-tight",
                  isActive
                    ? "text-foreground font-medium"
                    : "text-muted-foreground",
                )}
              >
                {event.message}
              </span>
              {stepElapsedSec !== null && (
                <span className="shrink-0 text-muted-foreground/50 tabular-nums">
                  {stepElapsedSec.toFixed(1)}s
                </span>
              )}
            </div>
          );
        })}

        {deduped.length === 0 && taskId !== null && (
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] text-muted-foreground">
            <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full shrink-0" />
            <span>Waiting for first event…</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      {!isTerminal && (
        <div className="h-0.5 bg-border/50 rounded-full overflow-hidden">
          <div
            className="h-full bg-primary/60 rounded-full transition-all duration-700"
            style={{ width: `${rawPct}%` }}
          />
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-2">
        {isTerminal ? (
          isDone ? (
            <CheckCircle2 className="h-2.5 w-2.5 text-green-400 shrink-0" />
          ) : (
            <XCircle className="h-2.5 w-2.5 text-destructive shrink-0" />
          )
        ) : (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
          </span>
        )}
        <span
          className={cn(
            "text-[11px] font-semibold",
            isDone
              ? "text-green-400"
              : isFailed
              ? "text-destructive"
              : "text-primary",
          )}
        >
          {isDone
            ? "Build complete"
            : isFailed
            ? "Build failed"
            : "Building"}
        </span>
        <span className="text-[10px] text-muted-foreground/60 tabular-nums ml-auto">
          {elapsedSec.toFixed(0)}s
        </span>
      </div>

      {showReassurance && (
        <div className="text-[10px] text-muted-foreground/60 italic px-2">
          Still working — large builds can take a minute…
        </div>
      )}
    </div>
  );
}
