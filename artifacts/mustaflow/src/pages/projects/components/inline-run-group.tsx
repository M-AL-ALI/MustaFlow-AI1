import { useEffect, useMemo, useRef, useState } from "react";
import {
  getListTaskEventsQueryKey,
  getListTasksQueryKey,
  useListTaskEvents,
  useListTasks,
} from "@workspace/api-client-react";
import { ChevronDown, ChevronRight, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { extractQATapeSteps, type QATapeEvent } from "@/lib/qa-video-tape";
import {
  appendActivityEntry,
  InlineActivityStream,
  taskActivityForEvent,
  type InlineActivityEntry,
} from "./inline-activity-stream";
import {
  appendNarrationEntry,
  InlineNarrationStream,
  narrationForTaskEvent,
  type InlineNarrationEntry,
} from "./inline-narration-stream";
import { QATapeStepsInline } from "./qa-tape-inline";
import {
  appendRecoveryStep,
  InlineRecoveryLoop,
  recoveryStepForEvent,
  type InlineRecoveryStep,
} from "./inline-recovery-loop";
import type { RunLoopProgress } from "./run-rehydration";
import type { ThreadDensity } from "./thread-density";
import {
  commandFailuresForEvents,
  InlineRunRecoveryStory,
  linkedRecoveryTaskId,
  resolveLinkedRecoveryTask,
  type RecoveryReport,
  type RecoveryTask,
} from "./inline-run-recovery";
import { buildRunStepIdSet } from "./run-step-count";

type ReplayEvent = QATapeEvent & {
  taskId?: number;
  createdAt?: string;
};

export type RunReplayModel = {
  activities: InlineActivityEntry[];
  narrations: InlineNarrationEntry[];
  qaEvents: QATapeEvent[];
  recoverySteps: InlineRecoveryStep[];
  stepCount: number;
};

export function buildRunReplayModel(events: ReplayEvent[]): RunReplayModel {
  let activities: InlineActivityEntry[] = [];
  let narrations: InlineNarrationEntry[] = [];
  let recoverySteps: InlineRecoveryStep[] = [];
  const qaEvents: QATapeEvent[] = [];
  const chronologicalEvents = [...events].sort((left, right) => left.id - right.id);

  for (const event of chronologicalEvents) {
    const activity = taskActivityForEvent(event.id, event.eventType, event.message);
    if (activity) {
      activities = appendActivityEntry(activities, activity);
    }
    const narration = narrationForTaskEvent(event.eventType, event.message);
    if (narration) {
      narrations = appendNarrationEntry(narrations, {
        id: event.id,
        text: narration,
      });
    }
    if (event.eventType === "qa_step") {
      qaEvents.push(event);
    }
    const recovery = recoveryStepForEvent(event);
    if (recovery) recoverySteps = appendRecoveryStep(recoverySteps, recovery);
  }

  const stepIds = buildRunStepIdSet(chronologicalEvents);

  return { activities, narrations, qaEvents, recoverySteps, stepCount: stepIds.size };
}

type InlineRunGroupProps = {
  stepCount: number;
  live: boolean;
  children: React.ReactNode;
  className?: string;
  onStop?: () => void;
  progress?: RunLoopProgress | null;
  density?: ThreadDensity;
};

export function InlineRunGroup({
  stepCount,
  live,
  children,
  className,
  onStop,
  progress,
  density = "standard",
}: InlineRunGroupProps) {
  const [expanded, setExpanded] = useState(live && density !== "minimal");
  const wasLiveRef = useRef(live);
  const previousDensityRef = useRef(density);

  useEffect(() => {
    if (wasLiveRef.current && !live) setExpanded(false);
    if (!wasLiveRef.current && live) setExpanded(density !== "minimal");
    if (live && previousDensityRef.current !== density) {
      setExpanded(density !== "minimal");
    }
    wasLiveRef.current = live;
    previousDensityRef.current = density;
  }, [density, live]);

  const countLabel = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
  const replayLabel = live
    ? stepCount > 0
      ? `${countLabel} so far`
      : "Starting"
    : `${countLabel} · ${expanded ? "collapse replay" : "expand to replay"}`;

  return (
    <section
      className={cn("space-y-2", className)}
      data-testid="inline-run-group"
      aria-label={live ? "Active build activity" : "Completed build activity"}
    >
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
          data-testid="inline-run-toggle"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3" aria-hidden="true" />
          ) : (
            <ChevronRight className="h-3 w-3" aria-hidden="true" />
          )}
          <span>{replayLabel}</span>
        </button>
        <div className="flex items-center gap-2">
          {live && progress && density !== "minimal" && density !== "detailed" && (
            <span
              className="text-[9px] tabular-nums text-muted-foreground/70"
              data-testid="inline-run-progress"
              aria-label={`Build progress: step ${progress.stepIndex} of ${progress.stepCap}`}
            >
              step {progress.stepIndex} of {progress.stepCap}
            </span>
          )}
          {live && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
              data-testid="inline-run-stop"
            >
              <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
              Stop
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div
          className="space-y-2 pl-1 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
          data-testid="inline-run-replay"
        >
          {children}
        </div>
      )}
    </section>
  );
}

export function PersistedRunReplay({
  projectId,
  taskId,
  onRetry,
  onOpenTask,
  className,
}: {
  projectId: number;
  taskId: number;
  onRetry?: () => void;
  onOpenTask?: (taskId: number) => void;
  className?: string;
}) {
  const { data: events = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      staleTime: Number.POSITIVE_INFINITY,
      // The live QA observer can seed this shared key with an early, partial
      // snapshot. A completed replay must replace it with authoritative history
      // instead of treating that partial cache entry as fresh forever.
      refetchOnMount: "always",
    },
  });
  const { data: tasks = [] } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      refetchOnMount: "always",
      refetchInterval: (query) => {
        const currentTasks = (query.state.data ?? []) as RecoveryTask[];
        const sourceTask = currentTasks.find((task) => task.id === taskId);
        const linkedId = linkedRecoveryTaskId(sourceTask?.report as RecoveryReport);
        const linkedTask =
          linkedId === null ? null : currentTasks.find((task) => task.id === linkedId);
        return linkedTask &&
          !["completed", "failed", "canceled", "discarded"].includes(linkedTask.status)
          ? 2_500
          : false;
      },
    },
  });
  const replay = useMemo(() => buildRunReplayModel(events as unknown as ReplayEvent[]), [events]);
  const commandFailures = useMemo(
    () => commandFailuresForEvents(events as unknown as ReplayEvent[]),
    [events],
  );
  const recoveryTasks = tasks as unknown as RecoveryTask[];
  const sourceTask = recoveryTasks.find((task) => task.id === taskId);
  const linkedTask = resolveLinkedRecoveryTask(sourceTask?.report as RecoveryReport, recoveryTasks);
  const qaSteps = useMemo(
    () => extractQATapeSteps(replay.qaEvents).filter((step) => step.phase !== "repair"),
    [replay.qaEvents],
  );

  if (replay.stepCount === 0) return null;

  return (
    <div
      id={`task-run-${taskId}`}
      className={cn("space-y-2", className)}
      data-run-task-id={taskId}
      tabIndex={-1}
    >
      <InlineRunRecoveryStory
        failures={commandFailures}
        completionKind={sourceTask?.completionKind}
        linkedTask={linkedTask}
        onOpenTask={onOpenTask}
        onRetry={onRetry}
      />
      <InlineRunGroup stepCount={replay.stepCount} live={false}>
        <InlineActivityStream entries={replay.activities} showAvatar={false} />
        <InlineNarrationStream entries={replay.narrations} />
        <InlineRecoveryLoop steps={replay.recoverySteps} onRetry={onRetry} />
        <QATapeStepsInline steps={qaSteps} />
      </InlineRunGroup>
    </div>
  );
}
