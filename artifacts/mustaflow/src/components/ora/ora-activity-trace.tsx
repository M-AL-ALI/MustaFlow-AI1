import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { currentOraActivityStep, type OraActivityTraceStep } from "@/lib/ora-activity";

/**
 * OraActivityTrace — the living, animated activity line rendered under the
 * in-progress reply (website mirror of the mobile OraThinkingRow activity
 * label). Each step fades in as it starts; when the next step begins the
 * previous one fades out and is removed; a failed step shows briefly in a
 * muted destructive tint before it fades. Only the current (and just-finished)
 * step is visible — a living trace, not a growing log.
 *
 * Visually subtle by design: small muted text matching the existing
 * "Thinking…" styling. All wording arrives via the shared copy map in
 * @workspace/ora-contracts, so web and mobile show identical text.
 */

const FADE_MS = 220;

function OraActivityStepLabel({
  step,
  leaving = false,
}: {
  step: OraActivityTraceStep;
  leaving?: boolean;
}) {
  // Entering labels mount hidden then transition visible; the leaving ghost
  // mounts visible then transitions hidden. The small timeout guarantees the
  // initial style is committed before the transition target applies.
  const [shown, setShown] = useState(leaving);
  useEffect(() => {
    const t = setTimeout(() => setShown(!leaving), 20);
    return () => clearTimeout(t);
  }, [leaving]);

  return (
    <span
      className={cn(
        "block text-[11px] font-medium leading-4 transition-all ease-out",
        leaving && "absolute inset-x-0 top-0",
        step.phase === "fail" ? "text-destructive/70" : "text-muted-foreground",
      )}
      style={{
        transitionDuration: `${FADE_MS}ms`,
        opacity: shown ? 1 : 0,
        transform: shown ? "translateY(0)" : "translateY(3px)",
      }}
      data-activity-tool={step.tool}
      data-activity-phase={step.phase}
    >
      {step.text}
    </span>
  );
}

export function OraActivityTrace({ steps }: { steps: OraActivityTraceStep[] }) {
  const current = currentOraActivityStep(steps);
  // The step that was just replaced, kept mounted briefly for its fade-out.
  const [ghost, setGhost] = useState<OraActivityTraceStep | null>(null);
  const lastRef = useRef<OraActivityTraceStep | null>(null);

  useEffect(() => {
    const last = lastRef.current;
    lastRef.current = current;
    if (last && current && last.id !== current.id) {
      setGhost(last);
      const t = setTimeout(() => setGhost(null), FADE_MS + 40);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [current]);

  if (!current && !ghost) return null;

  return (
    <span className="relative block min-h-4" aria-live="polite">
      {ghost && <OraActivityStepLabel key={`ghost-${ghost.id}`} step={ghost} leaving />}
      {current && (
        // Keyed by id + phase so an in-place ok/fail update re-fades the label,
        // giving terminal states their own brief moment before the answer lands.
        <OraActivityStepLabel key={`${current.id}:${current.phase}`} step={current} />
      )}
    </span>
  );
}
