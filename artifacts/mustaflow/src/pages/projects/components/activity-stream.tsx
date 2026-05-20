import { useEffect, useRef, useState } from "react";
import { useListTaskEvents, getListTaskEventsQueryKey } from "@workspace/api-client-react";
import {
  Clock,
  BrainCircuit,
  FolderOpen,
  Code2,
  FilePen,
  FlaskConical,
  Wrench,
  RefreshCw,
  Save,
  CheckCircle2,
  XCircle,
  ChevronDown,
  X,
  Search,
  BookOpen,
  GitBranch,
  ShieldCheck,
  Database,
  GraduationCap,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";

type EventType =
  | "queued"
  | "analyzing_request"
  | "loading_context"
  | "planning"
  | "planning_changes"
  | "reading_files"
  | "generating_code"
  | "editing_files"
  | "validating_output"
  | "testing"
  | "fixing_errors"
  | "saving_files"
  | "updating_preview"
  | "saving_version"
  | "writing_lessons"
  | "completed"
  | "failed";

const EVENT_META: Record<EventType, { icon: React.ElementType; color: string; label: string }> = {
  queued: { icon: Clock, color: "text-muted-foreground", label: "Queued" },
  analyzing_request: {
    icon: Search,
    color: "text-violet-400",
    label: "Analysing request",
  },
  loading_context: {
    icon: BookOpen,
    color: "text-blue-300",
    label: "Loading context",
  },
  planning: { icon: BrainCircuit, color: "text-violet-400", label: "Planning" },
  planning_changes: {
    icon: GitBranch,
    color: "text-violet-300",
    label: "Planning changes",
  },
  reading_files: {
    icon: FolderOpen,
    color: "text-blue-400",
    label: "Reading files",
  },
  generating_code: {
    icon: Code2,
    color: "text-primary",
    label: "Generating code",
  },
  editing_files: {
    icon: FilePen,
    color: "text-yellow-400",
    label: "Editing files",
  },
  validating_output: {
    icon: ShieldCheck,
    color: "text-cyan-300",
    label: "Validating output",
  },
  testing: {
    icon: FlaskConical,
    color: "text-cyan-400",
    label: "Testing",
  },
  fixing_errors: {
    icon: Wrench,
    color: "text-orange-400",
    label: "Fixing errors",
  },
  saving_files: {
    icon: Database,
    color: "text-yellow-300",
    label: "Saving files",
  },
  updating_preview: {
    icon: RefreshCw,
    color: "text-sky-400",
    label: "Updating preview",
  },
  saving_version: {
    icon: Save,
    color: "text-secondary",
    label: "Saving version",
  },
  writing_lessons: {
    icon: GraduationCap,
    color: "text-emerald-400",
    label: "Writing lessons",
  },
  completed: {
    icon: CheckCircle2,
    color: "text-green-400",
    label: "Completed",
  },
  failed: { icon: XCircle, color: "text-destructive", label: "Failed" },
};

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

interface Props {
  projectId: number;
  taskId: number;
  onDismiss: () => void;
}

export function ActivityStream({ projectId, taskId, onDismiss }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [autoDismissed, setAutoDismissed] = useState(false);

  const { data: events = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data || !Array.isArray(data)) return 1500;
        const last = data[data.length - 1];
        if (last && TERMINAL_STATUSES.has(last.eventType as string)) return false;
        return 1500;
      },
    },
  });

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent ? TERMINAL_STATUSES.has(lastEvent.eventType as string) : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";

  // Auto-scroll to bottom on new events
  useEffect(() => {
    if (!collapsed && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events, collapsed]);

  // Auto-dismiss 6 s after completion
  useEffect(() => {
    if (!isDone || autoDismissed) return;
    const t = setTimeout(() => {
      setAutoDismissed(true);
      onDismiss();
    }, 6000);
    return () => clearTimeout(t);
  }, [isDone, autoDismissed, onDismiss]);

  if (autoDismissed) return null;

  return (
    <div
      className={cn(
        "w-full bg-card/95 backdrop-blur-xl border border-border rounded-2xl shadow-2xl overflow-hidden transition-all duration-300",
        collapsed ? "max-h-10" : "max-h-72",
      )}
    >
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 border-b border-border cursor-pointer select-none"
        onClick={() => setCollapsed((v) => !v)}
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          {isTerminal ? (
            isDone ? (
              <CheckCircle2 className="h-3.5 w-3.5 text-green-400 shrink-0" />
            ) : (
              <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
            )
          ) : (
            <span className="relative flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
            </span>
          )}
          <span className="text-xs font-semibold text-foreground truncate">
            {isDone
              ? "Build complete"
              : isFailed
                ? "Build failed"
                : (lastEvent?.message ?? "Initializing…")}
          </span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {events.length} step{events.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((v) => !v);
            }}
            className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", collapsed && "rotate-180")}
            />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Event list */}
      {!collapsed && (
        <div ref={scrollRef} className="overflow-y-auto max-h-56 p-2 space-y-0.5 hide-scrollbar">
          {events.map((event, idx) => {
            const meta = EVENT_META[event.eventType as EventType] ?? EVENT_META.queued;
            const Icon = meta.icon;
            const isLast = idx === events.length - 1;
            const isActive = isLast && !isTerminal;

            return (
              <div
                key={event.id}
                className={cn(
                  "flex items-start gap-2.5 px-2 py-1.5 rounded-lg text-xs transition-colors",
                  isActive ? "bg-primary/10" : "hover:bg-muted/30",
                )}
              >
                {/* Icon */}
                <div className="shrink-0 mt-px">
                  <Icon
                    className={cn(
                      "h-3.5 w-3.5",
                      isActive ? meta.color + " animate-pulse" : meta.color,
                      !isActive && "opacity-70",
                    )}
                  />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div
                    className={cn(
                      "truncate leading-tight",
                      isActive ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                  >
                    {event.message}
                  </div>
                  {event.filePath && (
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/60 truncate">
                      {event.filePath}
                    </div>
                  )}
                </div>

                {/* Timestamp dot */}
                <div className="shrink-0 mt-1.5">
                  <span
                    className={cn(
                      "block w-1 h-1 rounded-full",
                      isActive ? "bg-primary" : "bg-border",
                    )}
                  />
                </div>
              </div>
            );
          })}

          {events.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
              Waiting for first event…
            </div>
          )}
        </div>
      )}

      {/* Completion footer */}
      {!collapsed && isDone && (
        <div className="px-3 py-1.5 border-t border-border bg-green-500/5 text-[10px] text-green-400 font-medium">
          Auto-dismissing in a few seconds — or click X to close now.
        </div>
      )}
      {!collapsed && isFailed && (
        <div className="px-3 py-1.5 border-t border-border bg-destructive/5 text-[10px] text-destructive font-medium">
          Task failed. Check the chat for details.
        </div>
      )}
    </div>
  );
}

/**
 * Inline live activity feed — renders build events as sequential chat-style
 * rows directly inside the messages scroll area, giving a Replit-agent-style
 * live progress view. Shows the last four events with the current one
 * highlighted and animated. Auto-dismisses 1.5 s after completion so the
 * real assistant message can take its place.
 */
export function InlineLiveActivity({ projectId, taskId, onDismiss }: Props) {
  const { data: events = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      refetchInterval: (query) => {
        const data = query.state.data;
        if (!data || !Array.isArray(data)) return 700;
        const last = (data as Array<{ eventType: string }>)[data.length - 1];
        if (last && TERMINAL_STATUSES.has(last.eventType)) return false;
        return 700;
      },
    },
  });

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent ? TERMINAL_STATUSES.has(lastEvent.eventType as string) : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";

  useEffect(() => {
    if (!isTerminal) return;
    const t = setTimeout(onDismiss, 2000);
    return () => clearTimeout(t);
  }, [isTerminal, onDismiss]);

  if (events.length === 0) {
    return (
      <div className="flex justify-start">
        <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2 max-w-[92%]">
          <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
          <span className="text-muted-foreground">Starting up…</span>
        </div>
      </div>
    );
  }

  const visibleEvents = events.slice(-4);

  return (
    <div className="flex flex-col gap-1">
      {visibleEvents.map((event, idx) => {
        const meta = EVENT_META[event.eventType as EventType] ?? EVENT_META.queued;
        const Icon = meta.icon;
        const isLast = idx === visibleEvents.length - 1;
        const isActive = isLast && !isTerminal;
        const opacity =
          visibleEvents.length > 1 && !isLast
            ? idx === visibleEvents.length - 2
              ? "opacity-50"
              : idx === visibleEvents.length - 3
                ? "opacity-30"
                : "opacity-20"
            : "";

        return (
          <div key={event.id} className={cn("flex justify-start", opacity)}>
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 rounded-xl rounded-bl-sm text-xs max-w-[92%] transition-all duration-300",
                isActive && !isFailed
                  ? "bg-muted border border-border text-foreground"
                  : isFailed && isLast
                    ? "bg-destructive/10 border border-destructive/20 text-destructive"
                    : "text-muted-foreground",
              )}
            >
              {isActive && !isTerminal ? (
                <Loader2 className={cn("h-3 w-3 shrink-0 animate-spin", meta.color)} />
              ) : isDone && isLast ? (
                <CheckCircle2 className="h-3 w-3 shrink-0 text-green-400" />
              ) : isFailed && isLast ? (
                <XCircle className="h-3 w-3 shrink-0 text-destructive" />
              ) : (
                <Icon className={cn("h-3 w-3 shrink-0", meta.color, "opacity-60")} />
              )}
              <span>{event.message}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
