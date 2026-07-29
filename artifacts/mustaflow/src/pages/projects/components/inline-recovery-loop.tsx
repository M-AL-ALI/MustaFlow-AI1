import { AlertTriangle, Check, Loader, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";

export type InlineRecoveryStep = {
  id: number;
  phase: "try" | "adapt" | "observe";
  message: string;
  status: "running" | "passed" | "failed";
};

type RecoveryEvent = {
  id: number;
  eventType: string;
  message?: string;
  data?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function recoveryStepForEvent(event: RecoveryEvent): InlineRecoveryStep | null {
  const message = event.message?.trim() ?? "";
  if (
    event.eventType === "qa_step" &&
    isRecord(event.data) &&
    event.data.phase === "repair" &&
    (event.data.status === "running" ||
      event.data.status === "passed" ||
      event.data.status === "failed")
  ) {
    return {
      id: event.id,
      phase: event.data.status === "running" ? "try" : "observe",
      message,
      status: event.data.status,
    };
  }
  if (event.eventType === "editing_files" && /^repairing\b/i.test(message)) {
    return {
      id: event.id,
      phase: "adapt",
      message: message.replace(/^repairing\b/i, "Adjusted"),
      status: "running",
    };
  }
  return null;
}

export function appendRecoveryStep(
  current: InlineRecoveryStep[],
  next: InlineRecoveryStep,
): InlineRecoveryStep[] {
  if (current.some((step) => step.id === next.id)) return current;
  return [...current, next].sort((left, right) => left.id - right.id).slice(-8);
}

export function InlineRecoveryLoop({
  steps,
  live = false,
  onRetry,
  className,
}: {
  steps: InlineRecoveryStep[];
  live?: boolean;
  onRetry?: () => void;
  className?: string;
}) {
  if (steps.length === 0) return null;
  const lastStep = steps.at(-1);
  const recoveryFailed = lastStep?.status === "failed";

  return (
    <section
      className={cn("space-y-1.5 text-xs", className)}
      data-testid="inline-recovery-loop"
      aria-label="Recovery progress"
      aria-live={live ? "polite" : undefined}
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        <span>Recovery</span>
      </div>
      <div className="ml-5 space-y-1">
        {steps.map((step, index) => {
          const active = live && index === steps.length - 1 && step.status === "running";
          const failed = step.status === "failed";
          const Icon = active ? Loader : failed ? AlertTriangle : Check;

          return (
            <div
              key={step.id}
              className="flex items-start gap-1.5 text-[11px] leading-relaxed motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
              data-phase={step.phase}
              data-testid="inline-recovery-step"
            >
              <Icon
                className={cn(
                  "mt-0.5 h-3 w-3 shrink-0 text-muted-foreground",
                  active && "motion-safe:animate-pulse",
                )}
                aria-hidden="true"
              />
              <span className="w-11 shrink-0 font-medium capitalize text-foreground">
                {step.phase}
              </span>
              <span className="text-muted-foreground">{step.message}</span>
            </div>
          );
        })}
      </div>
      {recoveryFailed && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-5 inline-flex items-center gap-1 rounded-sm text-[10px] font-medium text-foreground outline-none transition-colors hover:text-primary focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          <RotateCcw className="h-3 w-3" aria-hidden="true" />
          Try another fix
        </button>
      )}
    </section>
  );
}
