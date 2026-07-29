import { getListTaskEventsQueryKey, useListTaskEvents } from "@workspace/api-client-react";
import { extractQATapeSteps, type QATapeEvent } from "@/lib/qa-video-tape";
import { cn } from "@/lib/utils";

type QATapeInlineProps = {
  projectId: number;
  taskId: number;
  liveEvents?: QATapeEvent[];
  live?: boolean;
  className?: string;
};

function mergeEvents(history: QATapeEvent[], live: QATapeEvent[]): QATapeEvent[] {
  const byId = new Map<number, QATapeEvent>();
  for (const event of history) byId.set(event.id, event);
  for (const event of live) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id);
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
  className,
}: QATapeInlineProps) {
  const { data: persistedEvents = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      staleTime: live ? 0 : Number.POSITIVE_INFINITY,
    },
  });
  const history = persistedEvents as unknown as QATapeEvent[];
  const steps = extractQATapeSteps(mergeEvents(history, liveEvents));

  if (steps.length === 0) return null;

  return (
    <div
      className={cn("space-y-2", className)}
      data-testid={`qa-tape-${taskId}`}
      aria-live={live ? "polite" : undefined}
    >
      {steps.map((step, index) => (
        <div
          key={`${index}-${step.phase}-${step.message}`}
          className="space-y-1.5"
          data-testid="qa-tape-step"
        >
          <p className="text-[11px] leading-relaxed text-muted-foreground">{step.message}</p>
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
