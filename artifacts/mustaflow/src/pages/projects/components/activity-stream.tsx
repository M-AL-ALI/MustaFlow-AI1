import { useEffect, useRef, useState } from "react";
import { useTaskEventStream } from "@/hooks/use-task-event-stream";
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
  Cpu,
  Zap,
  Navigation,
  Layers,
  WifiOff,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { getBuilderCompletionMessage } from "@/lib/builder-completion";
import { selectBlueprintFailureError } from "@/lib/user-visible-errors";
import { isBlueprintInstallFailureMessage } from "@workspace/ora-contracts";
import { terminalPresentationFor } from "@/lib/zero-terminal";

// ─── Types ────────────────────────────────────────────────────────────────────

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
  | "architecture_chosen"
  | "narration"
  | "qa_step"
  | "qa_done"
  | "qa_timeout"
  | "preview_refresh_requested"
  | "preview_server_reachable"
  | "preview_unreachable_503"
  | "preview_ready"
  | "github_sync"
  | "completed"
  | "failed";

// ─── Event metadata ───────────────────────────────────────────────────────────

const EVENT_META: Record<
  EventType,
  {
    icon: React.ElementType;
    color: string;
    label: string;
    pillStyle: "terminal" | "brain" | "check" | "save" | "done" | "fail" | "narrate" | "warn";
  }
> = {
  queued: { icon: Clock, color: "text-muted-foreground", label: "Queued", pillStyle: "narrate" },
  analyzing_request: {
    icon: Search,
    color: "text-violet-400",
    label: "Analysing",
    pillStyle: "brain",
  },
  loading_context: {
    icon: BookOpen,
    color: "text-blue-300",
    label: "Loading context",
    pillStyle: "brain",
  },
  planning: { icon: BrainCircuit, color: "text-violet-400", label: "Planning", pillStyle: "brain" },
  planning_changes: {
    icon: GitBranch,
    color: "text-violet-300",
    label: "Planning changes",
    pillStyle: "brain",
  },
  reading_files: {
    icon: FolderOpen,
    color: "text-blue-400",
    label: "Reading files",
    pillStyle: "terminal",
  },
  generating_code: {
    icon: Code2,
    color: "text-primary",
    label: "Generating code",
    pillStyle: "terminal",
  },
  editing_files: {
    icon: FilePen,
    color: "text-yellow-400",
    label: "Editing files",
    pillStyle: "terminal",
  },
  validating_output: {
    icon: ShieldCheck,
    color: "text-cyan-300",
    label: "Validating",
    pillStyle: "check",
  },
  testing: { icon: FlaskConical, color: "text-cyan-400", label: "Testing", pillStyle: "check" },
  fixing_errors: {
    icon: Wrench,
    color: "text-orange-400",
    label: "Fixing errors",
    pillStyle: "terminal",
  },
  saving_files: {
    icon: Database,
    color: "text-yellow-300",
    label: "Saving files",
    pillStyle: "save",
  },
  updating_preview: {
    icon: RefreshCw,
    color: "text-sky-400",
    label: "Updating preview",
    pillStyle: "save",
  },
  saving_version: {
    icon: Save,
    color: "text-secondary",
    label: "Saving version",
    pillStyle: "save",
  },
  writing_lessons: {
    icon: GraduationCap,
    color: "text-emerald-400",
    label: "Writing lessons",
    pillStyle: "save",
  },
  architecture_chosen: {
    icon: Layers,
    color: "text-violet-400",
    label: "Architecture",
    pillStyle: "brain",
  },
  narration: { icon: Zap, color: "text-primary", label: "Update", pillStyle: "narrate" },
  qa_step: {
    icon: CheckCircle2,
    color: "text-cyan-300",
    label: "QA step",
    pillStyle: "check",
  },
  qa_done: {
    icon: CheckCircle2,
    color: "text-green-400",
    label: "QA done",
    pillStyle: "done",
  },
  qa_timeout: {
    icon: FlaskConical,
    color: "text-yellow-400",
    label: "QA timeout",
    pillStyle: "narrate",
  },
  preview_refresh_requested: {
    icon: RefreshCw,
    color: "text-sky-400",
    label: "Checking preview",
    pillStyle: "save",
  },
  preview_server_reachable: {
    icon: CheckCircle2,
    color: "text-green-400",
    label: "Preview reachable",
    pillStyle: "done",
  },
  preview_unreachable_503: {
    icon: WifiOff,
    color: "text-amber-400",
    label: "Preview unreachable",
    pillStyle: "warn",
  },
  preview_ready: {
    icon: CheckCircle2,
    color: "text-green-400",
    label: "Preview receipt verified",
    pillStyle: "done",
  },
  github_sync: {
    icon: GitBranch,
    color: "text-emerald-400",
    label: "GitHub sync",
    pillStyle: "done",
  },
  completed: { icon: CheckCircle2, color: "text-green-400", label: "Completed", pillStyle: "done" },
  failed: { icon: XCircle, color: "text-destructive", label: "Failed", pillStyle: "fail" },
};

const PILL_STYLE_CLASSES: Record<string, string> = {
  terminal: "bg-muted/60 border-border text-muted-foreground",
  brain: "bg-violet-500/10 border-violet-500/20 text-violet-400",
  check: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400",
  save: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
  done: "bg-green-500/10 border-green-500/20 text-green-400",
  fail: "bg-destructive/10 border-destructive/20 text-destructive",
  narrate: "bg-muted/40 border-border text-muted-foreground",
  warn: "bg-amber-500/10 border-amber-500/20 text-amber-400",
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled", "cancelled", "discarded"]);

// ─── Agent badge ──────────────────────────────────────────────────────────────

const AGENT_BADGE: Record<string, { label: string; icon: React.ElementType; className: string }> = {
  planning: {
    label: "Planning Agent",
    icon: Navigation,
    className: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  },
  task: {
    label: "Legacy review",
    icon: Cpu,
    className: "text-amber-400 bg-amber-500/10 border-amber-500/20",
  },
  main: {
    label: "Main Agent",
    icon: Zap,
    className: "text-green-400 bg-green-500/10 border-green-500/20",
  },
};

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId: number;
  taskId: number;
  taskStatus?: string;
  completionKind?: string | null;
  agentIdentity?: string;
  onDismiss: () => void;
}

// ─── ActivityStream ───────────────────────────────────────────────────────────

export function ActivityStream({
  projectId,
  taskId,
  taskStatus,
  completionKind,
  agentIdentity,
  onDismiss,
}: Props) {
  const pillRowRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [autoDismissed, setAutoDismissed] = useState(false);

  const { events } = useTaskEventStream(projectId, taskId);

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent ? TERMINAL_STATUSES.has(lastEvent.eventType) : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";
  const isAdmissionFailure =
    isFailed &&
    (completionKind === "admission_blocked" || completionKind === "admission_unavailable");
  const isNeedsReview = taskStatus === "needs_review" || taskStatus === "needs_fix";
  const terminal = lastEvent ? terminalPresentationFor(lastEvent) : null;
  const isWarning = terminal?.tone === "warning" || terminal?.tone === "unknown";
  const completionText = terminal?.message ?? getBuilderCompletionMessage(completionKind);

  // Auto-scroll pill row to the right as new events arrive
  useEffect(() => {
    if (pillRowRef.current) {
      pillRowRef.current.scrollLeft = pillRowRef.current.scrollWidth;
    }
  }, [events]);

  // Auto-scroll detail list to bottom
  useEffect(() => {
    if (expanded && detailRef.current) {
      detailRef.current.scrollTop = detailRef.current.scrollHeight;
    }
  }, [events, expanded]);

  // Auto-dismiss 6 s after completion, except when staged output needs a decision.
  useEffect(() => {
    if (!isDone || autoDismissed || isNeedsReview) return;
    const t = setTimeout(() => {
      setAutoDismissed(true);
      onDismiss();
    }, 6000);
    return () => clearTimeout(t);
  }, [isDone, autoDismissed, onDismiss, isNeedsReview]);

  if (autoDismissed) return null;

  // Pill list: show at most MAX_PILLS; if over cap keep first 4 + last (MAX-4)
  const MAX_PILLS = 18;
  const pills = events.map((e, idx) => {
    const meta = EVENT_META[e.eventType as EventType] ?? EVENT_META.queued;
    const Icon = meta.icon;
    const isLast = idx === events.length - 1;
    const isActive = isLast && !isTerminal;
    return { id: e.id, Icon, meta, isActive, isLast };
  });

  let visiblePills: typeof pills;
  if (pills.length <= MAX_PILLS) {
    visiblePills = pills;
  } else {
    const head = pills.slice(0, 4);
    const tail = pills.slice(pills.length - (MAX_PILLS - 4));
    visiblePills = [...head, ...tail];
  }

  const statusText = isWarning
    ? completionText
    : isNeedsReview
      ? "Review required"
      : isDone
        ? completionText
        : isFailed
          ? isAdmissionFailure
            ? completionText
            : "Build failed"
          : (lastEvent?.message ?? "Initializing…");

  return (
    <div
      className={cn(
        "w-full bg-card/95 backdrop-blur-xl border border-border rounded-2xl shadow-2xl overflow-hidden transition-all duration-300",
        expanded ? "max-h-80" : "max-h-[3.25rem]",
      )}
    >
      {/* ── Compact timeline header ── */}
      <div
        className="flex items-center gap-2 px-2.5 py-2 cursor-pointer select-none"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Pill icon row */}
        <div
          ref={pillRowRef}
          className="flex items-center gap-0.5 overflow-x-auto shrink-0 max-w-[52%]"
          style={{ scrollbarWidth: "none" }}
          onClick={(e) => e.stopPropagation()}
        >
          {visiblePills.map((p, i) => {
            const Icon = p.Icon;
            const styleClass = PILL_STYLE_CLASSES[p.meta.pillStyle] ?? PILL_STYLE_CLASSES.terminal;
            const age = visiblePills.length - 1 - i;
            const ageOpacity =
              age === 0 ? "" : age === 1 ? "opacity-60" : age === 2 ? "opacity-40" : "opacity-20";
            return (
              <span
                key={p.id}
                title={p.meta.label}
                className={cn(
                  "inline-flex items-center justify-center h-5 w-5 rounded-[5px] border shrink-0 transition-all duration-150",
                  styleClass,
                  p.isActive && "ring-1 ring-primary/40 scale-110",
                  ageOpacity,
                )}
              >
                {isWarning && p.isLast ? (
                  <AlertTriangle className="h-2.5 w-2.5 text-amber-400" />
                ) : p.isActive && !isTerminal ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : (
                  <Icon className="h-2.5 w-2.5" />
                )}
              </span>
            );
          })}
          {events.length === 0 && (
            <span className="inline-flex items-center justify-center h-5 w-5 rounded-[5px] border border-border bg-muted/40 shrink-0">
              <Loader2 className="h-2.5 w-2.5 animate-spin text-primary" />
            </span>
          )}
        </div>

        {/* Live status text */}
        <span
          className={cn(
            "text-[11px] font-medium truncate flex-1 min-w-0",
            isWarning
              ? "text-amber-400"
              : isDone && !isNeedsReview
                ? "text-green-400"
                : isFailed
                  ? "text-destructive"
                  : "text-foreground",
          )}
        >
          {statusText}
        </span>

        {/* Right side: count + agent badge + chevron + close */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {events.length} {events.length === 1 ? "action" : "actions"}
          </span>

          {agentIdentity &&
            AGENT_BADGE[agentIdentity] &&
            (() => {
              const badge = AGENT_BADGE[agentIdentity]!;
              const BadgeIcon = badge.icon;
              return (
                <span
                  className={cn(
                    "flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded border font-medium",
                    badge.className,
                  )}
                >
                  <BadgeIcon className="h-2 w-2" />
                  {badge.label}
                </span>
              );
            })()}

          <button
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
            className="p-0.5 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
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

      {/* ── Expanded detail list ── */}
      {expanded && (
        <div
          ref={detailRef}
          className="overflow-y-auto max-h-52 px-2 pb-2 space-y-0.5 border-t border-border pt-2"
          style={{ scrollbarWidth: "none" }}
        >
          {events.map((event, idx) => {
            const meta = EVENT_META[event.eventType as EventType] ?? EVENT_META.queued;
            const Icon = meta.icon;
            const isLast = idx === events.length - 1;
            const isActive = isLast && !isTerminal;
            const message =
              event.eventType === "failed" && isBlueprintInstallFailureMessage(event.message)
                ? selectBlueprintFailureError(event.message)
                : event.message;
            return (
              <div
                key={event.id}
                className={cn(
                  "flex items-start gap-2 px-2 py-1 rounded-lg text-xs transition-colors",
                  isActive ? "bg-primary/8" : "hover:bg-muted/20",
                )}
              >
                <div className="shrink-0 mt-px">
                  {isActive && !isTerminal ? (
                    <Loader2 className={cn("h-3 w-3 animate-spin", meta.color)} />
                  ) : (
                    <Icon className={cn("h-3 w-3", meta.color, !isActive && "opacity-50")} />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span
                    className={cn(
                      "leading-tight",
                      isActive ? "text-foreground font-medium" : "text-muted-foreground",
                    )}
                  >
                    {message}
                  </span>
                  {event.filePath && (
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground/50 truncate">
                      {event.filePath}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {events.length === 0 && (
            <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin text-primary" />
              Waiting for first event…
            </div>
          )}
        </div>
      )}

      {/* ── Footer banners ── */}
      {expanded && isDone && !isNeedsReview && (
        <div
          className={cn(
            "px-3 py-1.5 border-t border-border text-[10px] font-medium",
            isWarning ? "bg-amber-500/5 text-amber-400" : "bg-green-500/5 text-green-400",
          )}
        >
          Auto-dismissing in a few seconds — or click X to close now.
        </div>
      )}
      {expanded && isDone && isNeedsReview && (
        <div className="px-3 py-1.5 border-t border-border bg-amber-500/5 text-[10px] text-amber-400 font-medium flex items-center gap-1.5">
          <Cpu className="h-3 w-3 shrink-0" />
          Changes are waiting for review - see the chat to Apply or Discard.
        </div>
      )}
      {expanded && isFailed && (
        <div className="px-3 py-1.5 border-t border-border bg-destructive/5 text-[10px] text-destructive font-medium">
          {isWarning
            ? completionText
            : isAdmissionFailure
              ? completionText
              : "Task failed. Check the chat for details."}
        </div>
      )}
    </div>
  );
}

// ─── InlineLiveActivity ───────────────────────────────────────────────────────

/**
 * Inline live activity feed — renders a compact icon-timeline row directly
 * inside the chat scroll area. Connects via SSE so every event appears
 * the instant the agent emits it — no polling delay.
 */
export function InlineLiveActivity({ projectId, taskId, completionKind, onDismiss }: Props) {
  const pillRowRef = useRef<HTMLDivElement>(null);

  const { events } = useTaskEventStream(projectId, taskId);

  const lastEvent = events[events.length - 1];
  const isTerminal = lastEvent ? TERMINAL_STATUSES.has(lastEvent.eventType) : false;
  const isDone = lastEvent?.eventType === "completed";
  const isFailed = lastEvent?.eventType === "failed";
  const isAdmissionFailure =
    isFailed &&
    (completionKind === "admission_blocked" || completionKind === "admission_unavailable");
  const terminal = lastEvent ? terminalPresentationFor(lastEvent) : null;
  const isWarning = terminal?.tone === "warning" || terminal?.tone === "unknown";
  const completionText = terminal?.message ?? getBuilderCompletionMessage(completionKind);

  // Auto-scroll pill row right
  useEffect(() => {
    if (pillRowRef.current) {
      pillRowRef.current.scrollLeft = pillRowRef.current.scrollWidth;
    }
  }, [events]);

  // Auto-dismiss 2 s after terminal
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

  const currentMeta = EVENT_META[lastEvent?.eventType as EventType] ?? EVENT_META.queued;
  const CurrentIcon = currentMeta.icon;

  // Show last 20 pills maximum
  const pillsToShow = events.slice(-20);

  return (
    <div className="flex justify-start max-w-[96%]">
      <div className="bg-muted/60 border border-border rounded-xl rounded-bl-sm px-2.5 py-2 flex items-center gap-2 min-w-0 w-full">
        {/* Icon trail */}
        <div
          ref={pillRowRef}
          className="flex items-center gap-0.5 overflow-x-auto shrink-0"
          style={{ maxWidth: "55%", scrollbarWidth: "none" }}
        >
          {pillsToShow.map((event, idx) => {
            const meta = EVENT_META[event.eventType as EventType] ?? EVENT_META.queued;
            const Icon = meta.icon;
            const isLast = idx === pillsToShow.length - 1;
            const isActive = isLast && !isTerminal;
            const styleClass = PILL_STYLE_CLASSES[meta.pillStyle] ?? PILL_STYLE_CLASSES.terminal;
            const age = pillsToShow.length - 1 - idx;
            const ageOpacity =
              age === 0 ? "" : age === 1 ? "opacity-60" : age === 2 ? "opacity-40" : "opacity-20";

            return (
              <span
                key={event.id}
                title={meta.label}
                className={cn(
                  "inline-flex items-center justify-center h-5 w-5 rounded-[5px] border shrink-0 transition-all duration-150",
                  styleClass,
                  isActive && "ring-1 ring-primary/50 scale-110",
                  ageOpacity,
                )}
              >
                {isWarning && isLast ? (
                  <AlertTriangle className="h-2.5 w-2.5 text-amber-400" />
                ) : isActive && !isTerminal ? (
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                ) : isDone && isLast ? (
                  <CheckCircle2 className="h-2.5 w-2.5 text-green-400" />
                ) : isFailed && isLast ? (
                  <XCircle className="h-2.5 w-2.5 text-destructive" />
                ) : (
                  <Icon className="h-2.5 w-2.5" />
                )}
              </span>
            );
          })}
        </div>

        {/* Separator */}
        <span className="shrink-0 w-px h-3.5 bg-border" />

        {/* Current action text */}
        <span
          className={cn(
            "text-xs truncate flex-1 min-w-0",
            isWarning
              ? "text-amber-400 font-medium"
              : isDone
                ? "text-green-400 font-medium"
                : isFailed
                  ? "text-destructive font-medium"
                  : "text-foreground",
          )}
        >
          {isWarning
            ? completionText
            : isDone
              ? completionText
              : isFailed
                ? isAdmissionFailure
                  ? completionText
                  : "Build failed"
                : (lastEvent?.message ?? "Working…")}
        </span>

        {/* Action count + current icon */}
        <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
          {events.length}
        </span>
        {isWarning ? (
          <AlertTriangle className="h-3 w-3 shrink-0 text-amber-400" />
        ) : (
          <CurrentIcon className={cn("h-3 w-3 shrink-0 opacity-50", currentMeta.color)} />
        )}
      </div>
    </div>
  );
}
