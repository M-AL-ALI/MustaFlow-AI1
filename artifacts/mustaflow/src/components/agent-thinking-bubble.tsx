import { useEffect, useRef, useState } from "react";
import { useListTaskEvents, getListTaskEventsQueryKey } from "@workspace/api-client-react";
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

const TERMINAL_STATUSES = new Set(["completed", "failed"]);

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
          {expanded ? (
            <ChevronDown className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
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

interface Props {
  projectId: number;
  taskId: number;
  onDismiss: () => void;
}

export function AgentThinkingBubble({ projectId, taskId, onDismiss }: Props) {
  const bubbleRef = useRef<HTMLDivElement>(null);

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

  const groups = groupEventsByNarration(events as StepEvent[]);
  const finishedGroups = groups.slice(0, -1);
  const activeGroup = groups[groups.length - 1] ?? null;

  useEffect(() => {
    if (!isTerminal) return;
    const t = setTimeout(onDismiss, 2500);
    return () => clearTimeout(t);
  }, [isTerminal, onDismiss]);

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
          isFailed
            ? "bg-destructive/10 border-destructive/30"
            : "bg-muted border-border",
        )}
      >
        {/* Header pulse */}
        <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          {isTerminal ? (
            isDone ? (
              <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
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
              "text-[11px] font-semibold",
              isDone
                ? "text-green-400"
                : isFailed
                  ? "text-destructive"
                  : "text-primary",
            )}
          >
            {isDone ? "Build complete" : isFailed ? "Build failed" : "Building"}
          </span>
        </div>

        {/* Groups */}
        <div className="px-3 pb-2.5 space-y-2.5">
          {finishedGroups.map((group) => (
            <FinishedGroupRow key={group.key} group={group} />
          ))}

          {activeGroup && (
            <ActiveGroupRow
              key={activeGroup.key}
              group={activeGroup}
              isTerminal={isTerminal}
            />
          )}

          {groups.length === 0 && !isTerminal && (
            <div className="flex items-center gap-2 text-muted-foreground">
              <div className="animate-spin h-2.5 w-2.5 border border-primary border-t-transparent rounded-full shrink-0" />
              <span className="text-[11px]">Waiting for first event…</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
