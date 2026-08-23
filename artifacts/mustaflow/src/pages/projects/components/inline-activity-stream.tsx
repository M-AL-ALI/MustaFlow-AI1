import type { ComponentType } from "react";
import {
  AlertTriangle,
  Check,
  Code,
  Eye,
  GitCommit,
  Globe,
  Lightbulb,
  ListChecks,
  Loader,
  Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ZeroAvatar } from "./zero-avatar";
import { type ThreadDensity, visibleThreadEntries } from "./thread-density";
import { terminalPresentationFor } from "@/lib/zero-terminal";

export type InlineActivityKind =
  | "thinking"
  | "reading"
  | "writing"
  | "planning"
  | "brainstorming"
  | "checking"
  | "checkpoint"
  | "preview"
  | "publishing"
  | "error"
  | "done";

export type InlineActivityEntry = {
  id: number;
  kind: InlineActivityKind;
  label: string;
  resolvedLabel?: string;
  sourceEventType?: string;
  completionEvidence?:
    | { source: "task-event"; eventType: string }
    | { source: "surface-status"; status: "completed" };
  terminal?: boolean;
};

export type InlineSurfaceActivityUpdate = {
  status: "running" | "completed" | "failed";
  label: string;
};

type ActivityDefinition = Omit<InlineActivityEntry, "id">;

const EVENT_ACTIVITY: Record<string, ActivityDefinition> = {
  queued: { kind: "thinking", label: "Getting started", resolvedLabel: "Started" },
  started: { kind: "thinking", label: "Thinking", resolvedLabel: "Ready to work" },
  thinking: { kind: "thinking", label: "Thinking", resolvedLabel: "Thought it through" },
  analyzing_request: {
    kind: "thinking",
    label: "Understanding your request",
    resolvedLabel: "Understood your request",
  },
  loading_context: {
    kind: "reading",
    label: "Reading your project",
    resolvedLabel: "Read your project",
  },
  reading_files: {
    kind: "reading",
    label: "Reading your project",
    resolvedLabel: "Read your project",
  },
  planning: { kind: "planning", label: "Planning", resolvedLabel: "Planned the change" },
  planning_changes: {
    kind: "planning",
    label: "Planning the change",
    resolvedLabel: "Planned the change",
  },
  generating_blueprint: {
    kind: "planning",
    label: "Planning the app",
    resolvedLabel: "Planned the app",
  },
  generating_code: {
    kind: "writing",
    label: "Writing code",
    resolvedLabel: "Wrote the code",
  },
  editing_files: {
    kind: "writing",
    label: "Writing code",
    resolvedLabel: "Wrote the code",
  },
  file_diff: {
    kind: "writing",
    label: "Writing code",
    resolvedLabel: "Wrote the code",
  },
  saving_files: {
    kind: "writing",
    label: "Saving changes",
    resolvedLabel: "Saved the changes",
  },
  project_files_changed: {
    kind: "writing",
    label: "Saving changes",
    resolvedLabel: "Saved the changes",
    completionEvidence: { source: "task-event", eventType: "project_files_changed" },
  },
  validating_output: {
    kind: "checking",
    label: "Checking the work",
    resolvedLabel: "Checked the work",
  },
  testing: {
    kind: "checking",
    label: "Testing what I built",
    resolvedLabel: "Tested the app",
  },
  qa_step: {
    kind: "checking",
    label: "Testing what I built",
    resolvedLabel: "Tested the app",
  },
  qa_done: {
    kind: "checking",
    label: "Finishing browser checks",
    resolvedLabel: "Browser checks finished",
    completionEvidence: { source: "task-event", eventType: "qa_done" },
  },
  command_output: {
    kind: "checking",
    label: "Running a check",
    resolvedLabel: "Ran the check",
  },
  check_deferred: {
    kind: "checking",
    label: "Choosing available checks",
    resolvedLabel: "Chose available checks",
    completionEvidence: { source: "task-event", eventType: "check_deferred" },
  },
  check_result: {
    kind: "checking",
    label: "Checking the work",
    resolvedLabel: "Checked the work",
    completionEvidence: { source: "task-event", eventType: "check_result" },
  },
  review_context: {
    kind: "checking",
    label: "Preparing the review",
    resolvedLabel: "Prepared the review",
  },
  typecheck_result: {
    kind: "checking",
    label: "Checking TypeScript",
    resolvedLabel: "Checked TypeScript",
    completionEvidence: { source: "task-event", eventType: "typecheck_result" },
  },
  build_result: {
    kind: "checking",
    label: "Checking the build",
    resolvedLabel: "Checked the build",
    completionEvidence: { source: "task-event", eventType: "build_result" },
  },
  test_result: {
    kind: "checking",
    label: "Running tests",
    resolvedLabel: "Ran the tests",
    completionEvidence: { source: "task-event", eventType: "test_result" },
  },
  health_check_result: {
    kind: "checking",
    label: "Checking the preview",
    resolvedLabel: "Checked the preview",
    completionEvidence: { source: "task-event", eventType: "health_check_result" },
  },
  saving_version: {
    kind: "checkpoint",
    label: "Saving a checkpoint",
    resolvedLabel: "Checkpoint saved",
  },
  updating_preview: {
    kind: "preview",
    label: "Refreshing the preview",
    resolvedLabel: "Preview refreshed",
  },
  preview_ready: {
    kind: "preview",
    label: "Finishing the preview",
    resolvedLabel: "Preview receipt verified",
    completionEvidence: { source: "task-event", eventType: "preview_ready" },
  },
  finalized: { kind: "done", label: "Done", terminal: true },
  completed: { kind: "done", label: "Done", terminal: true },
  failed: { kind: "error", label: "Something needs attention", terminal: true },
  aborted: { kind: "error", label: "Run stopped", terminal: true },
  cancelled: { kind: "done", label: "Stopped", terminal: true },
  preflight_error: { kind: "error", label: "Setup needs attention", terminal: true },
  container_unavailable: {
    kind: "error",
    label: "Preview is unavailable",
    terminal: true,
  },
  qa_timeout: { kind: "error", label: "Browser check timed out", terminal: true },
};

const ACTIVITY_ICON: Record<InlineActivityKind, ComponentType<{ className?: string }>> = {
  thinking: Loader,
  reading: Eye,
  writing: Code,
  planning: ListChecks,
  brainstorming: Lightbulb,
  checking: Eye,
  checkpoint: GitCommit,
  preview: Globe,
  publishing: Rocket,
  error: AlertTriangle,
  done: Check,
};

export function activityIconForKind(
  kind: InlineActivityKind,
): ComponentType<{ className?: string }> {
  return ACTIVITY_ICON[kind];
}

const MAX_ACTIVITY_ROWS = 12;

function activityForToolName(toolName: string, subagentRole?: string): ActivityDefinition | null {
  switch (toolName.toLowerCase()) {
    case "read_file":
    case "list_files":
    case "search_files":
      return {
        kind: "reading",
        label: "Reading your project",
        resolvedLabel: "Read your project",
      };
    case "apply_patch":
    case "write_file":
      return {
        kind: "writing",
        label: "Writing code",
        resolvedLabel: "Wrote the code",
      };
    case "run_command":
      return {
        kind: "checking",
        label: "Running a check",
        resolvedLabel: "Ran the check",
      };
    case "dispatch_subagent":
      return subagentRole?.toLowerCase() === "reviewer"
        ? {
            kind: "checking",
            label: "Reviewing the change",
            resolvedLabel: "Reviewed the change",
          }
        : {
            kind: "thinking",
            label: "Working through the next step",
            resolvedLabel: "Completed the step",
          };
    case "plan_subtasks":
      return {
        kind: "planning",
        label: "Planning the next steps",
        resolvedLabel: "Planned the next steps",
      };
    case "take_screenshot":
      return {
        kind: "checking",
        label: "Checking the preview",
        resolvedLabel: "Checked the preview",
      };
    default:
      return null;
  }
}

function activityForStructuredToolEvent(
  eventType: string,
  message: string,
): ActivityDefinition | null {
  if (!message.startsWith("{")) return null;
  try {
    const payload = JSON.parse(message) as {
      tool?: unknown;
      toolName?: unknown;
      args?: { role?: unknown };
    };
    const toolName = eventType === "tool_call" ? payload.tool : payload.toolName;
    const subagentRole = typeof payload.args?.role === "string" ? payload.args.role : undefined;
    return typeof toolName === "string" ? activityForToolName(toolName, subagentRole) : null;
  } catch {
    return null;
  }
}

export function taskActivityForEvent(
  id: number,
  eventType: string,
  message = "",
  terminal?: unknown,
): InlineActivityEntry | null {
  const terminalPresentation = terminalPresentationFor({ terminal, status: eventType });
  if (terminalPresentation) {
    return {
      id,
      kind:
        terminalPresentation.tone === "success"
          ? "done"
          : terminalPresentation.tone === "warning"
            ? "checking"
            : "error",
      label: terminalPresentation.message,
      sourceEventType: eventType.toLowerCase(),
      terminal: true,
    };
  }
  const normalizedEventType = eventType.toLowerCase();
  if (normalizedEventType === "editing_files" && /^repairing\b/i.test(message.trim())) {
    return {
      id,
      kind: "writing",
      label: "Adapting the fix",
      resolvedLabel: "Adapted the fix",
      sourceEventType: normalizedEventType,
    };
  }
  if (normalizedEventType === "tool_call" || normalizedEventType === "loop:step") {
    const toolActivity = activityForStructuredToolEvent(normalizedEventType, message);
    if (toolActivity) return { id, ...toolActivity, sourceEventType: normalizedEventType };
  }
  const definition = EVENT_ACTIVITY[normalizedEventType];
  if (!definition) return null;
  if (normalizedEventType === "command_output" && message.startsWith("{")) {
    try {
      const payload: unknown = JSON.parse(message);
      if (
        typeof payload === "object" &&
        payload !== null &&
        "status" in payload &&
        payload.status === "final"
      ) {
        return {
          id,
          ...definition,
          sourceEventType: normalizedEventType,
          completionEvidence: { source: "task-event", eventType: "command_output:final" },
        };
      }
    } catch {
      // The event still describes a running check, but cannot prove that it finished.
    }
  }
  return { id, ...definition, sourceEventType: normalizedEventType };
}

export function surfaceActivityEntry(
  id: number,
  kind: "brainstorming" | "publishing",
  update: InlineSurfaceActivityUpdate,
): InlineActivityEntry {
  if (update.status === "failed") {
    return { id, kind: "error", label: update.label, terminal: true };
  }
  const completionEvidence: InlineActivityEntry["completionEvidence"] =
    update.status === "completed" ? { source: "surface-status", status: "completed" } : undefined;
  return {
    id,
    kind,
    label: update.label,
    resolvedLabel: update.label,
    completionEvidence,
    terminal: update.status === "completed",
  };
}

const CONFIRMED_PREDECESSOR_EVENTS: Readonly<Record<string, readonly string[]>> = {
  project_files_changed: [
    "generating_code",
    "editing_files",
    "file_diff",
    "saving_files",
    "saving_version",
  ],
  check_result: ["validating_output", "review_context"],
  qa_done: ["testing", "qa_step"],
  preview_ready: ["updating_preview"],
};

export function appendActivityEntry(
  current: InlineActivityEntry[],
  next: InlineActivityEntry,
): InlineActivityEntry[] {
  if (current.some((entry) => entry.id === next.id)) return current;
  const confirmedPredecessors = next.sourceEventType
    ? CONFIRMED_PREDECESSOR_EVENTS[next.sourceEventType]
    : undefined;
  const evidencedCurrent =
    confirmedPredecessors && next.completionEvidence
      ? current.map((entry) =>
          entry.sourceEventType && confirmedPredecessors.includes(entry.sourceEventType)
            ? { ...entry, completionEvidence: entry.completionEvidence ?? next.completionEvidence }
            : entry,
        )
      : current;
  const last = evidencedCurrent.at(-1);
  if (
    last &&
    !next.terminal &&
    last.kind === next.kind &&
    last.label === next.label &&
    !last.terminal
  ) {
    return [...evidencedCurrent.slice(0, -1), next].slice(-MAX_ACTIVITY_ROWS);
  }
  return [...evidencedCurrent, next]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_ACTIVITY_ROWS);
}

export function activityLabelForDisplay(entry: InlineActivityEntry): string {
  return entry.completionEvidence ? (entry.resolvedLabel ?? entry.label) : entry.label;
}

type InlineActivityStreamProps = {
  entries: InlineActivityEntry[];
  live?: boolean;
  showAvatar?: boolean;
  className?: string;
  density?: ThreadDensity;
};

export function InlineActivityStream({
  entries,
  live = false,
  showAvatar = true,
  className,
  density = "detailed",
}: InlineActivityStreamProps) {
  if (entries.length === 0) return null;

  const lastEntry = entries.at(-1);

  return (
    <div
      className={cn("flex items-start gap-2", className)}
      data-testid="inline-activity-stream"
      role="log"
      aria-live={live ? "polite" : undefined}
      aria-relevant="additions text"
    >
      {showAvatar && <ZeroAvatar active={live && !lastEntry?.terminal} className="mt-0.5" />}
      <div className="min-w-0 flex-1 space-y-0.5 pt-0.5 text-xs">
        {visibleThreadEntries(entries, density).map((entry) => {
          const confirmed = entry.completionEvidence !== undefined;
          const active = live && entry.id === lastEntry?.id && !entry.terminal && !confirmed;
          const failed = entry.kind === "error";
          const Icon = active ? ACTIVITY_ICON[entry.kind] : failed ? AlertTriangle : Check;
          const label = activityLabelForDisplay(entry);

          return (
            <div
              key={entry.id}
              className={cn(
                "flex min-w-0 items-center gap-1.5 leading-5",
                "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200",
                active || failed ? "text-foreground" : "text-muted-foreground",
              )}
              data-active={active ? "true" : "false"}
              data-kind={entry.kind}
              data-testid="inline-activity-row"
            >
              <Icon
                aria-hidden="true"
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  active && "motion-safe:animate-pulse",
                  failed && "text-muted-foreground",
                )}
                data-testid={active ? "active-activity-icon" : "resolved-activity-icon"}
              />
              <span className="truncate">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
