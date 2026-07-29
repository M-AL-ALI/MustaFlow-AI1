import { useEffect, useMemo, useRef, useState } from "react";
import { getListTaskEventsQueryKey, useListTaskEvents } from "@workspace/api-client-react";
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
  const stepIds = new Set<number>();

  for (const event of [...events].sort((left, right) => left.id - right.id)) {
    const activity = taskActivityForEvent(event.id, event.eventType, event.message);
    if (activity) {
      activities = appendActivityEntry(activities, activity);
      stepIds.add(event.id);
    }
    if (event.eventType === "narration" && event.message.trim()) {
      narrations = appendNarrationEntry(narrations, {
        id: event.id,
        text: event.message,
      });
      stepIds.add(event.id);
    }
    if (event.eventType === "qa_step") {
      qaEvents.push(event);
      stepIds.add(event.id);
    }
    const recovery = recoveryStepForEvent(event);
    if (recovery) recoverySteps = appendRecoveryStep(recoverySteps, recovery);
  }

  return { activities, narrations, qaEvents, recoverySteps, stepCount: stepIds.size };
}

type InlineRunGroupProps = {
  stepCount: number;
  live: boolean;
  children: React.ReactNode;
  className?: string;
  onStop?: () => void;
  progress?: RunLoopProgress | null;
};

export function InlineRunGroup({
  stepCount,
  live,
  children,
  className,
  onStop,
  progress,
}: InlineRunGroupProps) {
  const [expanded, setExpanded] = useState(live);
  const wasLiveRef = useRef(live);

  useEffect(() => {
    if (wasLiveRef.current && !live) setExpanded(false);
    if (!wasLiveRef.current && live) setExpanded(true);
    wasLiveRef.current = live;
  }, [live]);

  const countLabel = `${stepCount} ${stepCount === 1 ? "step" : "steps"}`;
  const replayLabel = live
    ? stepCount > 0
      ? `${countLabel} so far`
      : "Starting"
    : `${countLabel} · ${expanded ? "collapse replay" : "expand to replay"}`;

  return (
    <section className={cn("space-y-2", className)} data-testid="inline-run-group">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          className="flex items-center gap-1.5 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
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
          {live && progress && (
            <span
              className="text-[9px] tabular-nums text-muted-foreground/70"
              data-testid="inline-run-progress"
            >
              step {progress.stepIndex} of {progress.stepCap}
            </span>
          )}
          {live && onStop && (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded-sm px-1 py-0.5 text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="inline-run-stop"
            >
              <Square className="h-2.5 w-2.5 fill-current" aria-hidden="true" />
              Stop
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="space-y-2 pl-1" data-testid="inline-run-replay">
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
  className,
}: {
  projectId: number;
  taskId: number;
  onRetry?: () => void;
  className?: string;
}) {
  const { data: events = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      staleTime: Number.POSITIVE_INFINITY,
    },
  });
  const replay = useMemo(() => buildRunReplayModel(events as unknown as ReplayEvent[]), [events]);
  const qaSteps = useMemo(
    () => extractQATapeSteps(replay.qaEvents).filter((step) => step.phase !== "repair"),
    [replay.qaEvents],
  );

  if (replay.stepCount === 0) return null;

  return (
    <InlineRunGroup stepCount={replay.stepCount} live={false} className={className}>
      <InlineActivityStream entries={replay.activities} showAvatar={false} />
      <InlineNarrationStream entries={replay.narrations} />
      <InlineRecoveryLoop steps={replay.recoverySteps} onRetry={onRetry} />
      <QATapeStepsInline steps={qaSteps} />
    </InlineRunGroup>
  );
}
