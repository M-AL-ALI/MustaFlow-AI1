import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { activityIconForKind, type InlineActivityEntry } from "./inline-activity-stream";
import type { RunLoopProgress } from "./run-rehydration";
import type { ThreadDensity } from "./thread-density";
import { ZeroAvatar } from "./zero-avatar";

export function WorkingAnchor({
  activity,
  progress,
  density,
  live = true,
  className,
}: {
  activity?: InlineActivityEntry | null;
  progress?: RunLoopProgress | null;
  density: ThreadDensity;
  live?: boolean;
  className?: string;
}) {
  const fallback: InlineActivityEntry = {
    id: -1,
    kind: "thinking",
    label: "Getting started",
  };
  const current = activity ?? fallback;
  const Icon = live ? activityIconForKind(current.kind) : Check;
  const label = live ? current.label : (current.resolvedLabel ?? current.label);

  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-1 text-[10px] text-muted-foreground",
        className,
      )}
      role="status"
      aria-live="polite"
      data-testid="working-anchor"
    >
      <ZeroAvatar active={live} />
      <Icon
        className={cn("h-3 w-3 shrink-0", live && "motion-safe:animate-pulse")}
        aria-hidden="true"
      />
      <span className="shrink-0 font-medium text-foreground">
        {live ? "Zero is working" : "Zero finished"}
      </span>
      <span aria-hidden="true">·</span>
      <span className="min-w-0 truncate">{label}</span>
      {density === "detailed" && live && progress && (
        <span
          className="ml-auto shrink-0 tabular-nums text-muted-foreground/70"
          data-testid="working-anchor-progress"
        >
          step {progress.stepIndex} of {progress.stepCap}
        </span>
      )}
    </div>
  );
}
