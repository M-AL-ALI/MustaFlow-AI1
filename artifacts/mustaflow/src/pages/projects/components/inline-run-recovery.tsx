import { ArrowRight } from "lucide-react";
import { InlineBuilderError } from "./inline-builder-error";
import { InlineRecoveryLoop, type InlineRecoveryStep } from "./inline-recovery-loop";
import { terminalPresentationFor, terminalTaskStatus } from "@/lib/zero-terminal";

export type CommandFailure = {
  id: number;
  runId: string;
  argv: string[];
  exitCode: number;
  label: string;
  detail: string;
};

export type RecoveryEvent = {
  id: number;
  eventType: string;
  message?: string | null;
};

export type RecoveryReport = {
  architectReview?: {
    autoFixQueued?: boolean;
    autoFixTaskId?: number | null;
  } | null;
} | null;

export type RecoveryTask = {
  id: number;
  title: string;
  status: string;
  completionKind?: string | null;
  result?: string | null;
  report?: RecoveryReport;
  terminal?: unknown;
};

export type TaskQueuedSignal =
  | {
      kind?: string;
      taskId?: number;
    }
  | null
  | undefined;

type CommandOutputPayload = {
  runId?: unknown;
  status?: unknown;
  argv?: unknown;
  exitCode?: unknown;
  stderr?: unknown;
  output?: unknown;
};

function parseCommandOutput(message: string): CommandOutputPayload | null {
  try {
    const payload = JSON.parse(message) as unknown;
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as CommandOutputPayload)
      : null;
  } catch {
    return null;
  }
}

function commandLabel(argv: string[]): string {
  const command = argv.join(" ").toLowerCase();
  if (command.includes("typecheck") || command.includes("tsc")) return "TypeScript check";
  if (command.includes("vitest") || command.includes("npm test")) return "Test check";
  if (command.includes("eslint") || command.includes(" lint")) return "Lint check";
  if (command.includes("vite build") || command.includes("npm run build")) return "Build check";
  return `${argv[0] ?? "Command"} command`;
}

function commandFailureDetail(payload: CommandOutputPayload): string {
  const output = [payload.stderr, payload.output]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  if (output.includes("ERR_ACCESS_DENIED") && output.includes("ChildProcess")) {
    return "The isolated check runner blocked a child process the type checker needed.";
  }
  if (output.includes("npx canceled due to missing packages")) {
    return "The requested type checker was not available inside the isolated workspace.";
  }
  return "The command returned a non-zero result.";
}

export function commandFailureForEvent(event: RecoveryEvent): CommandFailure | null {
  if (event.eventType !== "command_output" || typeof event.message !== "string") return null;
  const payload = parseCommandOutput(event.message);
  if (
    !payload ||
    payload.status !== "final" ||
    !Array.isArray(payload.argv) ||
    !payload.argv.every((value) => typeof value === "string") ||
    typeof payload.exitCode !== "number" ||
    payload.exitCode === 0
  ) {
    return null;
  }

  const argv = payload.argv as string[];
  const executable = argv[0]?.toLowerCase();
  const output =
    typeof payload.stderr === "string"
      ? payload.stderr
      : typeof payload.output === "string"
        ? payload.output
        : "";
  // grep/rg use exit 1 for "no match"; that is an observation, not a broken check.
  if ((executable === "grep" || executable === "rg") && payload.exitCode === 1 && !output.trim()) {
    return null;
  }

  return {
    id: event.id,
    runId: typeof payload.runId === "string" ? payload.runId : `${event.id}:${argv.join(" ")}`,
    argv,
    exitCode: payload.exitCode,
    label: commandLabel(argv),
    detail: commandFailureDetail(payload),
  };
}

export function commandFailuresForEvents(events: readonly RecoveryEvent[]): CommandFailure[] {
  const byRunId = new Map<string, CommandFailure>();
  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const failure = commandFailureForEvent(event);
    if (failure) byRunId.set(failure.runId, failure);
  }
  return [...byRunId.values()];
}

export function appendCommandFailure(
  current: CommandFailure[],
  next: CommandFailure,
): CommandFailure[] {
  if (current.some((failure) => failure.runId === next.runId)) return current;
  return [...current, next].sort((left, right) => left.id - right.id).slice(-6);
}

export function linkedRecoveryTaskId(report: RecoveryReport): number | null {
  const review = report?.architectReview;
  if (
    review?.autoFixQueued !== true ||
    typeof review.autoFixTaskId !== "number" ||
    !Number.isInteger(review.autoFixTaskId)
  ) {
    return null;
  }
  return review.autoFixTaskId;
}

export function resolveLinkedRecoveryTask(
  sourceReport: RecoveryReport,
  tasks: readonly RecoveryTask[],
): RecoveryTask | null {
  const taskId = linkedRecoveryTaskId(sourceReport);
  if (taskId === null) return null;
  return tasks.find((task) => task.id === taskId) ?? null;
}

export function refreshSourceReportsForTaskQueuedSignals(
  signals: readonly TaskQueuedSignal[],
  seenTaskIds: Set<number>,
  refetch: () => void,
): boolean {
  let sawNewQueuedTask = false;
  for (const signal of signals) {
    if (
      signal?.kind === "task-queued" &&
      typeof signal.taskId === "number" &&
      !seenTaskIds.has(signal.taskId)
    ) {
      seenTaskIds.add(signal.taskId);
      sawNewQueuedTask = true;
    }
  }
  if (sawNewQueuedTask) refetch();
  return sawNewQueuedTask;
}

export function plainRecoveryTitle(title: string): string {
  const issue = title
    .replace(/^architect auto-fix:\s*/i, "")
    .replace(/^auto-fix:\s*/i, "")
    .trim();
  const check = issue.match(/^(.+?)\s+check\s+failed$/i);
  if (check?.[1]) return `${check[1]} check`;
  return issue || "Failed check";
}

function completionReason(completionKind?: string | null): string {
  switch (completionKind) {
    case "step_cap":
      return "This run used all its available steps before it could repair the issue.";
    case "wall_clock":
      return "This run reached its time limit before it could repair the issue.";
    case "repeated_error":
      return "The same failure repeated, so this run stopped safely.";
    case "checks_failed":
      return "Required checks did not pass.";
    default:
      return "The run finished before this issue was repaired.";
  }
}

function recoveryTaskStep(task: RecoveryTask): InlineRecoveryStep {
  const title = plainRecoveryTitle(task.title);
  const terminal = terminalPresentationFor(task);
  const status = terminalTaskStatus(task, task.status);
  if (status === "completed") {
    return {
      id: task.id,
      phase: "adapt",
      message: terminal?.message ?? `The ${title} fix completed.`,
      status: terminal?.tone === "warning" || terminal?.tone === "unknown" ? "failed" : "passed",
    };
  }
  if (["failed", "canceled", "discarded"].includes(status)) {
    return {
      id: task.id,
      phase: "adapt",
      message: terminal?.message ?? `The ${title} fix could not finish.`,
      status: "failed",
    };
  }
  return {
    id: task.id,
    phase: "adapt",
    message:
      status === "queued"
        ? `A fix for the ${title} is queued.`
        : `Zero is fixing the ${title} in the background.`,
    status: "running",
  };
}

export function InlineRunRecoveryStory({
  failures,
  completionKind,
  linkedTask,
  live = false,
  onOpenTask,
  onRetry,
}: {
  failures: CommandFailure[];
  completionKind?: string | null;
  linkedTask?: RecoveryTask | null;
  live?: boolean;
  onOpenTask?: (taskId: number) => void;
  onRetry?: () => void;
}) {
  const failure = failures.at(-1);
  if (!failure) return null;

  const steps: InlineRecoveryStep[] = [
    {
      id: failure.id * 10,
      phase: "try",
      message: `Ran the ${failure.label}.`,
      status: "passed",
    },
    {
      id: failure.id * 10 + 1,
      phase: "observe",
      message: `${failure.label} exited with code ${failure.exitCode}.`,
      status: "failed",
    },
    linkedTask
      ? recoveryTaskStep(linkedTask)
      : live
        ? {
            id: failure.id * 10 + 2,
            phase: "adapt",
            message: "Zero is continuing through the remaining checks.",
            status: "running",
          }
        : {
            id: failure.id * 10 + 2,
            phase: "adapt",
            message: "No automatic follow-up is linked yet. You can ask Zero to try again.",
            status: "failed",
          },
  ];
  const linkedTaskStatus = linkedTask ? terminalTaskStatus(linkedTask, linkedTask.status) : null;
  const linkedTaskLive =
    linkedTask !== null &&
    linkedTask !== undefined &&
    !["completed", "failed", "canceled", "discarded"].includes(linkedTaskStatus ?? "");
  const linkedTaskFailed =
    linkedTask !== null &&
    linkedTask !== undefined &&
    ["failed", "canceled", "discarded"].includes(linkedTaskStatus ?? "");

  return (
    <section
      className="space-y-2.5 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
      data-testid="inline-run-recovery-story"
      data-recovery-task-id={linkedTask?.id}
    >
      <InlineBuilderError
        title="A check needs attention."
        message={`${failure.label} exited with code ${failure.exitCode}. ${failure.detail} ${
          live ? "Zero is still working through this run." : completionReason(completionKind)
        }`}
      />
      <InlineRecoveryLoop
        steps={steps}
        live={live || linkedTaskLive}
        onRetry={!linkedTask || linkedTaskFailed ? onRetry : undefined}
      />
      {linkedTask && onOpenTask && (
        <button
          type="button"
          onClick={() => onOpenTask(linkedTask.id)}
          className="ml-5 inline-flex items-center gap-1 rounded-sm text-[10px] font-medium text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          Open fix run
          <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
