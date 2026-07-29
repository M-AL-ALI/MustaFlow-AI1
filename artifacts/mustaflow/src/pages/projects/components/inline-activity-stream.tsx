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
  },
  command_output: {
    kind: "checking",
    label: "Running a check",
    resolvedLabel: "Ran the check",
  },
  check_result: {
    kind: "checking",
    label: "Checking the work",
    resolvedLabel: "Checked the work",
  },
  typecheck_result: {
    kind: "checking",
    label: "Checking TypeScript",
    resolvedLabel: "Checked TypeScript",
  },
  build_result: {
    kind: "checking",
    label: "Checking the build",
    resolvedLabel: "Checked the build",
  },
  test_result: {
    kind: "checking",
    label: "Running tests",
    resolvedLabel: "Ran the tests",
  },
  health_check_result: {
    kind: "checking",
    label: "Checking the preview",
    resolvedLabel: "Checked the preview",
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
    resolvedLabel: "Preview ready",
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

const MAX_ACTIVITY_ROWS = 12;

export function taskActivityForEvent(
  id: number,
  eventType: string,
): InlineActivityEntry | null {
  const definition = EVENT_ACTIVITY[eventType.toLowerCase()];
  return definition ? { id, ...definition } : null;
}

export function surfaceActivityEntry(
  id: number,
  kind: "brainstorming" | "publishing",
  update: InlineSurfaceActivityUpdate,
): InlineActivityEntry {
  if (update.status === "failed") {
    return { id, kind: "error", label: update.label, terminal: true };
  }
  return {
    id,
    kind,
    label: update.label,
    resolvedLabel: update.label,
    terminal: update.status === "completed",
  };
}

export function appendActivityEntry(
  current: InlineActivityEntry[],
  next: InlineActivityEntry,
): InlineActivityEntry[] {
  if (current.some((entry) => entry.id === next.id)) return current;
  const last = current.at(-1);
  if (
    last &&
    !next.terminal &&
    last.kind === next.kind &&
    last.label === next.label &&
    !last.terminal
  ) {
    return [...current.slice(0, -1), next].slice(-MAX_ACTIVITY_ROWS);
  }
  return [...current, next]
    .sort((left, right) => left.id - right.id)
    .slice(-MAX_ACTIVITY_ROWS);
}

type InlineActivityStreamProps = {
  entries: InlineActivityEntry[];
  live?: boolean;
  className?: string;
};

export function InlineActivityStream({
  entries,
  live = false,
  className,
}: InlineActivityStreamProps) {
  if (entries.length === 0) return null;

  const lastEntry = entries.at(-1);

  return (
    <div className={cn("flex items-start gap-2", className)} data-testid="inline-activity-stream">
      <ZeroAvatar active={live && !lastEntry?.terminal} className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-0.5 pt-0.5 text-xs">
        {entries.map((entry) => {
          const active = live && entry.id === lastEntry?.id && !entry.terminal;
          const failed = entry.kind === "error";
          const Icon = active ? ACTIVITY_ICON[entry.kind] : failed ? AlertTriangle : Check;
          const label = active ? entry.label : (entry.resolvedLabel ?? entry.label);

          return (
            <div
              key={entry.id}
              className={cn(
                "flex min-w-0 items-center gap-1.5 leading-5",
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
                  active && "animate-pulse",
                  failed && "text-destructive",
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
