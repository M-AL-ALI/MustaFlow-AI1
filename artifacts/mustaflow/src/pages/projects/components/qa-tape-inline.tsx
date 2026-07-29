import { getListTaskEventsQueryKey, useListTaskEvents } from "@workspace/api-client-react";
import {
  extractQATapeSteps,
  type QATapeEvent,
  type QATapeStep,
} from "@/lib/qa-video-tape";
import { cn } from "@/lib/utils";
import { AlertTriangle, Camera, Check, Eye, Loader } from "lucide-react";

type QATapeInlineProps = {
  projectId: number;
  taskId: number;
  liveEvents?: QATapeEvent[];
  live?: boolean;
  hideRepairSteps?: boolean;
  className?: string;
};

function mergeEvents(history: QATapeEvent[], live: QATapeEvent[]): QATapeEvent[] {
  const byId = new Map<number, QATapeEvent>();
  for (const event of history) byId.set(event.id, event);
  for (const event of live) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
}

export function QATapeStepsInline({
  steps,
  live = false,
  className,
}: {
  steps: QATapeStep[];
  live?: boolean;
  className?: string;
}) {
  if (steps.length === 0) return null;

  return (
    <div
      className={cn("space-y-1.5 text-xs", className)}
      data-testid="qa-tape-steps"
      aria-live={live ? "polite" : undefined}
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Testing what I built</span>
      </div>
      {steps.map((step, index) => (
        <div
          key={`${index}-${step.phase}-${step.message}`}
          className="ml-5 space-y-1.5"
          data-status={step.status}
          data-testid="qa-tape-step"
        >
          <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {step.status === "running" ? (
              <Loader className="mt-0.5 h-3 w-3 shrink-0 animate-pulse" aria-hidden="true" />
            ) : step.status === "failed" ? (
              <AlertTriangle
                className="mt-0.5 h-3 w-3 shrink-0 text-destructive"
                aria-hidden="true"
              />
            ) : step.screenshot ? (
              <Camera className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            ) : (
              <Check className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            )}
            <p>{step.message}</p>
          </div>
          {step.screenshot && (
            <img
              src={`data:${step.screenshot.mimeType};base64,${step.screenshot.base64}`}
              alt={step.screenshot.label}
              className="block max-h-40 max-w-full rounded-md border border-border object-contain"
              data-testid="qa-tape-screenshot"
            />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * Minimal Wave D chat treatment for the existing QA tape. Persisted task
 * events make the lines survive reloads; live SSE events make them appear
 * immediately without introducing a second stream.
 */
export function QATapeInline({
  projectId,
  taskId,
  liveEvents = [],
  live = false,
  hideRepairSteps = false,
  className,
}: QATapeInlineProps) {
  const { data: persistedEvents = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      staleTime: live ? 0 : Number.POSITIVE_INFINITY,
    },
  });
  const history = persistedEvents as unknown as QATapeEvent[];
  const steps = extractQATapeSteps(mergeEvents(history, liveEvents)).filter(
    (step) => !hideRepairSteps || step.phase !== "repair",
  );

  if (steps.length === 0) return null;

  return (
    <div data-testid={`qa-tape-${taskId}`}>
      <QATapeStepsInline steps={steps} live={live} className={className} />
    </div>
  );
}
