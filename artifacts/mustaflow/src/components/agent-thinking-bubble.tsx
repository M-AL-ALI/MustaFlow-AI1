import { useEffect, useRef, useState } from "react";
import {
  useListTaskEvents,
  getListTaskEventsQueryKey,
  useListTasks,
  getListTasksQueryKey,
  useListVersions,
  getListVersionsQueryKey,
  usePatchVersion,
  useCancelTask,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Brain,
  BookOpen,
  Wrench,
  Code2,
  Save,
  ShieldCheck,
  GraduationCap,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  Search,
  GitBranch,
  FilePen,
  Database,
  Camera,
  Globe,
  Palette,
  Sparkles,
  AlertCircle,
  Timer,
  Bookmark,
  Pencil,
  Check,
  X,
  ExternalLink,
  Square,
} from "lucide-react";
import { cn } from "@/lib/utils";

type StepEvent = {
  id: number;
  eventType: string;
  message: string;
  filePath?: string | null;
};

type StepGroup = {
  key: string;
  narration: string;
  steps: StepEvent[];
  isFinished: boolean;
};

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

const STEP_ICON: Record<string, React.ElementType> = {
  queued: Clock,
  analyzing_request: Search,
  loading_context: BookOpen,
  planning: Brain,
  planning_changes: GitBranch,
  reading_files: BookOpen,
  generating_code: Code2,
  editing_files: FilePen,
  saving_files: Database,
  validating_output: ShieldCheck,
  testing: ShieldCheck,
  fixing_errors: Wrench,
  updating_preview: RefreshCw,
  saving_version: Save,
  writing_lessons: GraduationCap,
  page_map_updated: RefreshCw,
  generating_blueprint: Brain,
  restoring_files: BookOpen,
  completed: CheckCircle2,
  failed: XCircle,
  take_screenshot: Camera,
  web_fetch: Globe,
  web_search: Search,
  extract_branding: Palette,
  read_diagnostics: AlertCircle,
  generate_image: Sparkles,
  generate_video: Sparkles,
  generate_audio: Sparkles,
  remove_image_background: Sparkles,
};

const STEP_COLOR: Record<string, string> = {
  queued: "text-muted-foreground",
  analyzing_request: "text-violet-400",
  loading_context: "text-blue-300",
  planning: "text-violet-400",
  planning_changes: "text-violet-300",
  reading_files: "text-blue-400",
  generating_code: "text-primary",
  editing_files: "text-yellow-400",
  saving_files: "text-yellow-300",
  validating_output: "text-cyan-300",
  testing: "text-cyan-400",
  fixing_errors: "text-orange-400",
  updating_preview: "text-sky-400",
  saving_version: "text-secondary",
  writing_lessons: "text-emerald-400",
  page_map_updated: "text-sky-300",
  generating_blueprint: "text-violet-400",
  restoring_files: "text-blue-400",
  completed: "text-green-400",
  failed: "text-destructive",
};

function getStepIcon(eventType: string): React.ElementType {
  return STEP_ICON[eventType] ?? Code2;
}

function getStepColor(eventType: string): string {
  return STEP_COLOR[eventType] ?? "text-muted-foreground";
}

function groupEventsByNarration(events: StepEvent[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let groupIndex = 0;

  for (const event of events) {
    if (event.eventType === "queued") continue;

    if (event.eventType === "narration") {
      if (groups.length > 0) {
        groups[groups.length - 1].isFinished = true;
      }
      groups.push({
        key: `group-${groupIndex++}`,
        narration: event.message,
        steps: [],
        isFinished: false,
      });
    } else {
      if (groups.length === 0) {
        groups.push({
          key: `group-${groupIndex++}`,
          narration: "",
          steps: [],
          isFinished: false,
        });
      }
      groups[groups.length - 1].steps.push(event);
    }
  }

  return groups;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds !== 1 ? "s" : ""}`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (secs === 0) return `${mins} min`;
  return `${mins} min ${secs} sec`;
}

function useWordReveal(text: string, active: boolean): string {
  const [revealed, setRevealed] = useState(0);
  const prevTextRef = useRef("");

  useEffect(() => {
    if (text !== prevTextRef.current) {
      prevTextRef.current = text;
      setRevealed(0);
    }
  }, [text]);

  useEffect(() => {
    if (!active || !text) return;
    const words = text.split(" ");
    if (revealed >= words.length) return;

    const delay = revealed === 0 ? 0 : 55;
    const t = setTimeout(() => {
      setRevealed((r) => Math.min(r + 1, words.length));
    }, delay);
    return () => clearTimeout(t);
  }, [active, text, revealed]);

  if (!text) return "";
  const words = text.split(" ");
  return words.slice(0, revealed).join(" ");
}

function NarrationText({
  text,
  isActive,
  isFinished,
}: {
  text: string;
  isActive: boolean;
  isFinished: boolean;
}) {
  const displayed = useWordReveal(text, isActive && !isFinished);

  if (!text) return null;

  return (
    <p
      className={cn(
        "text-xs leading-snug font-medium",
        isActive ? "text-foreground" : "text-muted-foreground/80",
      )}
    >
      {isActive && !isFinished ? displayed : text}
    </p>
  );
}

function IconStrip({
  steps,
  isGroupActive,
  isTerminal,
}: {
  steps: StepEvent[];
  isGroupActive: boolean;
  isTerminal: boolean;
}) {
  if (steps.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1 mt-1.5">
      {steps.map((step, idx) => {
        const Icon = getStepIcon(step.eventType);
        const color = getStepColor(step.eventType);
        const isLast = idx === steps.length - 1;
        const isActive = isGroupActive && isLast && !isTerminal;

        return (
          <div
            key={step.id}
            title={step.message + (step.filePath ? ` — ${step.filePath}` : "")}
            className={cn(
              "flex items-center justify-center rounded p-0.5 transition-all duration-200",
              isActive ? "bg-primary/10" : "",
            )}
          >
            <Icon
              className={cn(
                "h-3 w-3 shrink-0",
                color,
                isActive && "animate-pulse",
                !isActive && "opacity-50",
              )}
            />
          </div>
        );
      })}
    </div>
  );
}

function FinishedGroupRow({ group }: { group: StepGroup }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-1">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 group text-left"
      >
        <div className="shrink-0 mt-0.5 text-muted-foreground/40 group-hover:text-muted-foreground transition-colors">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </div>
        <div className="flex-1 min-w-0">
          {group.narration && (
            <p className="text-[11px] text-muted-foreground/70 leading-snug truncate">
              {group.narration}
            </p>
          )}
          <div className="flex items-center gap-2 mt-0.5">
            <div className="flex items-center gap-0.5">
              {group.steps.slice(0, 10).map((step) => {
                const Icon = getStepIcon(step.eventType);
                const color = getStepColor(step.eventType);
                return <Icon key={step.id} className={cn("h-2.5 w-2.5", color, "opacity-40")} />;
              })}
            </div>
            <span className="text-[10px] text-muted-foreground/50">
              {group.steps.length} action{group.steps.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      </button>

      {expanded && (
        <div className="ml-5 space-y-0.5 border-l border-border/40 pl-2">
          {group.steps.map((step) => {
            const Icon = getStepIcon(step.eventType);
            const color = getStepColor(step.eventType);
            return (
              <div key={step.id} className="flex items-start gap-1.5 py-0.5">
                <Icon className={cn("h-3 w-3 shrink-0 mt-px", color, "opacity-60")} />
                <div className="min-w-0">
                  <span className="text-[11px] text-muted-foreground leading-tight block truncate">
                    {step.message}
                  </span>
                  {step.filePath && (
                    <span className="text-[10px] font-mono text-muted-foreground/50 truncate block">
                      {step.filePath}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ActiveGroupRow({ group, isTerminal }: { group: StepGroup; isTerminal: boolean }) {
  const lastStep = group.steps[group.steps.length - 1];
  const statusLabel = lastStep?.message ?? (isTerminal ? "Done" : "Working…");

  return (
    <div className="space-y-1">
      <NarrationText text={group.narration} isActive={true} isFinished={isTerminal} />
      <IconStrip steps={group.steps} isGroupActive={true} isTerminal={isTerminal} />
      {group.steps.length > 0 && (
        <p
          className={cn(
            "text-[10px] truncate leading-tight",
            isTerminal ? "text-muted-foreground/50" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </p>
      )}
    </div>
  );
}

function BuildTimingRow({
  elapsedSeconds,
  isFailed,
  groupsExpanded,
  onToggle,
}: {
  elapsedSeconds: number;
  isFailed: boolean;
  groupsExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className={cn(
        "w-full flex items-center gap-2 group text-left py-1 rounded transition-colors",
        isFailed ? "hover:bg-destructive/5" : "hover:bg-background/30",
      )}
    >
      <div className="shrink-0 text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
        {groupsExpanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
      </div>
      <Timer
        className={cn(
          "h-3 w-3 shrink-0",
          isFailed ? "text-destructive/70" : "text-muted-foreground/60",
        )}
      />
      <span
        className={cn(
          "text-[11px] font-medium",
          isFailed ? "text-destructive/80" : "text-muted-foreground/70",
        )}
      >
        {isFailed ? "Failed after" : "Worked for"} {formatElapsed(elapsedSeconds)}
      </span>
    </button>
  );
}

function CheckpointRow({
  projectId,
  versionId,
  versionLabel,
  onViewHistory,
}: {
  projectId: number;
  versionId: number;
  versionLabel: string;
  onViewHistory?: () => void;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(versionLabel);
  const [savedLabel, setSavedLabel] = useState(versionLabel);
  const inputRef = useRef<HTMLInputElement>(null);
  const patchVersion = usePatchVersion();

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const save = () => {
    const trimmed = draft.trim();
    if (!trimmed || trimmed === savedLabel) {
      setDraft(savedLabel);
      setEditing(false);
      return;
    }
    patchVersion.mutate(
      { id: projectId, versionId, data: { label: trimmed } },
      {
        onSuccess: () => {
          setSavedLabel(trimmed);
          setDraft(trimmed);
          void queryClient.invalidateQueries({
            queryKey: getListVersionsQueryKey(projectId),
          });
        },
        onError: () => {
          setDraft(savedLabel);
        },
        onSettled: () => {
          setEditing(false);
        },
      },
    );
  };

  const cancel = () => {
    setDraft(savedLabel);
    setEditing(false);
  };

  return (
    <div className="flex items-center gap-2 py-1 px-0.5 animate-in fade-in slide-in-from-bottom-1 duration-300">
      <Bookmark className="h-3 w-3 shrink-0 text-secondary/70" />
      <span className="text-[10px] text-muted-foreground/60 shrink-0">Checkpoint</span>
      {editing ? (
        <div className="flex items-center gap-1 flex-1 min-w-0">
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") cancel();
            }}
            onBlur={save}
            className="flex-1 min-w-0 bg-background border border-border rounded px-1.5 py-0.5 text-[11px] text-foreground outline-none focus:border-primary"
          />
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              save();
            }}
            className="shrink-0 text-green-400 hover:text-green-300 transition-colors"
          >
            <Check className="h-3 w-3" />
          </button>
          <button
            onMouseDown={(e) => {
              e.preventDefault();
              cancel();
            }}
            className="shrink-0 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <span className="text-[11px] text-foreground/80 truncate" title={savedLabel}>
            {patchVersion.isPending ? draft : savedLabel}
          </span>
          <button
            onClick={() => setEditing(true)}
            className="shrink-0 text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors"
            title="Rename checkpoint"
          >
            <Pencil className="h-2.5 w-2.5" />
          </button>
          {onViewHistory && (
            <button
              onClick={onViewHistory}
              className="shrink-0 flex items-center gap-0.5 text-[10px] text-primary/60 hover:text-primary transition-colors ml-auto"
              title="View in history"
            >
              <ExternalLink className="h-2.5 w-2.5" />
              <span>History</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface Props {
  projectId: number;
  taskId: number;
  startedAt?: Date | null;
  onDismiss: () => void;
  onViewHistory?: (versionId: number) => void;
}

export function AgentThinkingBubble({
  projectId,
  taskId,
  startedAt,
  onDismiss,
  onViewHistory,
}: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  const mountTimeRef = useRef(Date.now());
  const [elapsedSeconds, setElapsedSeconds] = useState<number | null>(null);
  const [groupsExpanded, setGroupsExpanded] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const cancelTask = useCancelTask();

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
  const isCancelled = lastEvent?.eventType === "cancelled";

  const handleCancel = () => {
    if (cancelling || isTerminal) return;
    setCancelling(true);
    cancelTask.mutate(
      { id: projectId, taskId },
      {
        onSettled: () => {
          setCancelling(false);
        },
      },
    );
  };

  const { data: tasks } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      enabled: isTerminal && isDone,
      staleTime: 0,
    },
  });

  const completedTask = tasks?.find((t) => t.id === taskId);
  const versionId =
    (completedTask?.report as { versionId?: number | null } | null | undefined)?.versionId ?? null;

  const { data: versions } = useListVersions(projectId, {
    query: {
      queryKey: getListVersionsQueryKey(projectId),
      enabled: isTerminal && isDone && !!versionId,
      staleTime: 0,
    },
  });

  const versionLabel =
    versionId != null ? (versions?.find((v) => v.id === versionId)?.label ?? null) : null;

  useEffect(() => {
    if (!isTerminal) return;
    // Prefer the authoritative server-calculated value (from startedAt → completedAt).
    // Fall back to client-side wall-clock if the task isn't in the list yet.
    const serverElapsed = completedTask?.elapsedSeconds ?? null;
    if (serverElapsed != null) {
      setElapsedSeconds(Math.max(1, serverElapsed));
    } else {
      const origin = startedAt ?? new Date(mountTimeRef.current);
      setElapsedSeconds(Math.max(1, Math.round((Date.now() - origin.getTime()) / 1000)));
    }
  }, [isTerminal, startedAt, completedTask?.elapsedSeconds]);

  const groups = groupEventsByNarration(events as StepEvent[]);
  const finishedGroups = groups.slice(0, -1);
  const activeGroup = groups[groups.length - 1] ?? null;

  useEffect(() => {
    if (!isTerminal) return;
    const delay = isCancelled ? 1500 : 2500;
    const t = setTimeout(onDismiss, delay);
    return () => clearTimeout(t);
  }, [isTerminal, isCancelled, onDismiss]);

  useEffect(() => {
    if (bubbleRef.current) {
      bubbleRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [events.length]);

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

  return (
    <div ref={bubbleRef} className="flex justify-start">
      <div
        className={cn(
          "max-w-[92%] rounded-xl rounded-bl-sm border text-xs overflow-hidden transition-colors duration-300",
          isFailed ? "bg-destructive/10 border-destructive/30" : "bg-muted border-border",
        )}
      >
        {/* Header pulse */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          {isTerminal ? (
            isDone ? (
              <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
            ) : isCancelled ? (
              <Square className="h-3 w-3 text-muted-foreground shrink-0" />
            ) : (
              <XCircle className="h-3 w-3 text-destructive shrink-0" />
            )
          ) : (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
          )}
          <span
            className={cn(
              "text-[11px] font-semibold flex-1",
              isDone
                ? "text-green-400"
                : isCancelled
                  ? "text-muted-foreground"
                  : isFailed
                    ? "text-destructive"
                    : "text-primary",
            )}
          >
            {isDone
              ? "Build complete"
              : isCancelled
                ? "Cancelled"
                : isFailed
                  ? "Build failed"
                  : cancelling
                    ? "Cancelling…"
                    : "Building"}
          </span>
          {!isTerminal && (
            <button
              onClick={handleCancel}
              disabled={cancelling}
              title="Cancel build"
              className={cn(
                "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors shrink-0",
                cancelling
                  ? "text-muted-foreground border-border cursor-not-allowed opacity-50"
                  : "text-muted-foreground border-border hover:text-destructive hover:border-destructive/50",
              )}
            >
              {cancelling ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <Square className="h-2.5 w-2.5" />
              )}
              Cancel
            </button>
          )}
        </div>

        {/* Build timing row (shown when terminal) */}
        {isTerminal && elapsedSeconds !== null && (
          <div className="px-3 pb-1">
            <BuildTimingRow
              elapsedSeconds={elapsedSeconds}
              isFailed={isFailed}
              groupsExpanded={groupsExpanded}
              onToggle={() => setGroupsExpanded((v) => !v)}
            />
          </div>
        )}

        {/* Groups (collapsible via timing row toggle) */}
        {groupsExpanded && (
          <div className="px-3 pb-2.5 space-y-2.5">
            {finishedGroups.map((group) => (
              <FinishedGroupRow key={group.key} group={group} />
            ))}

            {activeGroup && (
              <ActiveGroupRow key={activeGroup.key} group={activeGroup} isTerminal={isTerminal} />
            )}

            {groups.length === 0 && !isTerminal && (
              <div className="flex items-center gap-2 text-muted-foreground">
                <div className="animate-spin h-2.5 w-2.5 border border-primary border-t-transparent rounded-full shrink-0" />
                <span className="text-[11px]">Waiting for first event…</span>
              </div>
            )}
          </div>
        )}

        {/* Checkpoint row (shown on success when versionId is known) */}
        {isTerminal && isDone && versionId != null && versionLabel != null && (
          <div className="px-3 pb-2.5 border-t border-border/40 pt-1.5">
            <CheckpointRow
              projectId={projectId}
              versionId={versionId}
              versionLabel={versionLabel}
              onViewHistory={versionId != null ? () => onViewHistory?.(versionId) : undefined}
            />
          </div>
        )}
      </div>
    </div>
  );
}
