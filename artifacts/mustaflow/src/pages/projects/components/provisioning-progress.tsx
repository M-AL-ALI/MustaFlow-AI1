import { useState } from "react";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Moon,
  Server,
  Database,
  Plug,
  ChevronDown,
  ChevronUp,
  Info,
  AlertTriangle,
  RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ProvisioningStatus = "idle" | "provisioning" | "ready" | "hibernated" | "error";
type ProvisioningStep = "create_container" | "create_database" | "connect_and_test" | null;

interface StepDef {
  key: ProvisioningStep;
  label: string;
  shortLabel: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const STEPS: StepDef[] = [
  { key: "create_container", label: "Creating server", shortLabel: "Server", Icon: Server },
  { key: "create_database", label: "Creating database", shortLabel: "Database", Icon: Database },
  { key: "connect_and_test", label: "Connecting and testing", shortLabel: "Testing", Icon: Plug },
];

function stepIndex(step: ProvisioningStep): number {
  if (!step) return -1;
  return STEPS.findIndex((s) => s.key === step);
}

function formatEta(seconds: number): string {
  if (seconds <= 0) return "almost done";
  if (seconds < 60) return `~${Math.ceil(seconds)}s remaining`;
  return `~${Math.ceil(seconds / 60)}m remaining`;
}

interface ProvisioningProgressProps {
  status: ProvisioningStatus;
  step: ProvisioningStep;
  error: string | null;
  estimatedSecondsRemaining: number | null;
  elapsedSeconds: number;
  retrying: boolean;
  onRetry: () => void;
  onLogsClick: () => void;
}

export function ProvisioningProgress({
  status,
  step,
  error,
  estimatedSecondsRemaining,
  elapsedSeconds,
  retrying,
  onRetry,
  onLogsClick,
}: ProvisioningProgressProps) {
  const [expanded, setExpanded] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);

  if (status === "idle") return null;

  const currentStepIdx = stepIndex(step);
  const isProvisioning = status === "provisioning";
  const isReady = status === "ready";
  const isError = status === "error";
  const isHibernated = status === "hibernated";
  const showTimeout = isProvisioning && elapsedSeconds > 180;

  const badgeColor = isReady
    ? "bg-green-500/10 text-green-400 border-green-500/20"
    : isProvisioning
      ? "bg-primary/10 text-primary border-primary/20"
      : isHibernated
        ? "bg-muted text-muted-foreground border-border"
        : "bg-destructive/10 text-destructive border-destructive/20";

  return (
    <div className="relative flex flex-col" data-tour="provisioning-badge">
      {/* ── Badge row ── */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => (isProvisioning || isError) && setExpanded((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0 transition-colors",
            badgeColor,
            (isProvisioning || isError) && "cursor-pointer hover:opacity-80",
          )}
          title={
            isHibernated
              ? "Container is hibernated (auto-stopped). It will wake on next use."
              : undefined
          }
        >
          {isProvisioning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : isReady ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : isHibernated ? (
            <Moon className="h-3 w-3" />
          ) : (
            <XCircle className="h-3 w-3" />
          )}
          <span>
            {isReady
              ? "Running"
              : isProvisioning
                ? step
                  ? (STEPS[currentStepIdx]?.shortLabel ?? "Setting up")
                  : "Setting up"
                : isHibernated
                  ? "Hibernated"
                  : "Error"}
          </span>
          {isProvisioning && estimatedSecondsRemaining != null && estimatedSecondsRemaining > 0 && (
            <span className="opacity-60 ml-0.5">{formatEta(estimatedSecondsRemaining)}</span>
          )}
          {(isProvisioning || isError) &&
            (expanded ? (
              <ChevronUp className="h-2.5 w-2.5 ml-0.5" />
            ) : (
              <ChevronDown className="h-2.5 w-2.5 ml-0.5" />
            ))}
        </button>

        {/* Inline timeout warning — visible even when collapsed */}
        {showTimeout && !expanded && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-400 font-medium">
            <AlertTriangle className="h-2.5 w-2.5" />
            Slow
          </span>
        )}

        {/* "What is this?" tooltip trigger */}
        <div className="relative">
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            onMouseEnter={() => setTooltipVisible(true)}
            onMouseLeave={() => setTooltipVisible(false)}
            onFocus={() => setTooltipVisible(true)}
            onBlur={() => setTooltipVisible(false)}
            aria-label="What is provisioning?"
          >
            <Info className="h-3 w-3" />
          </button>
          {tooltipVisible && (
            <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 z-50 w-52 bg-popover border border-border rounded-lg p-2.5 text-[11px] text-muted-foreground leading-relaxed shadow-lg">
              <p className="font-semibold text-foreground mb-1">What is this?</p>
              <p>
                We&apos;re creating a private server and database just for this project. This lets
                your app run real backend code and store data.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Expanded step list ── */}
      {expanded && (isProvisioning || isError) && (
        <div className="absolute top-full left-0 mt-2 z-50 w-64 bg-popover border border-border rounded-xl shadow-lg p-3 space-y-2">
          <div className="text-[11px] font-semibold text-foreground mb-1">Environment setup</div>
          <div className="space-y-1.5">
            {STEPS.map((s, idx) => {
              const done = currentStepIdx > idx || (isReady && idx <= 2);
              const active = isProvisioning && currentStepIdx === idx;
              const failed = isError && currentStepIdx === idx;
              const StepIcon = s.Icon;
              return (
                <div key={s.key} className="flex items-center gap-2">
                  <div className="relative shrink-0">
                    {active ? (
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    ) : done ? (
                      <CheckCircle2 className="h-4 w-4 text-green-400" />
                    ) : failed ? (
                      <XCircle className="h-4 w-4 text-destructive" />
                    ) : (
                      <StepIcon className="h-4 w-4 text-muted-foreground/40" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-[11px] font-medium",
                        active
                          ? "text-foreground"
                          : done
                            ? "text-green-400"
                            : failed
                              ? "text-destructive"
                              : "text-muted-foreground/50",
                      )}
                    >
                      {s.label}
                    </div>
                    <div className="text-[9px] text-muted-foreground/60 uppercase tracking-wide">
                      {idx + 1}/{STEPS.length}
                    </div>
                  </div>
                  {active && (
                    <span className="text-[9px] text-primary animate-pulse font-medium">
                      running
                    </span>
                  )}
                  {done && <span className="text-[9px] text-green-400/70 font-medium">done</span>}
                </div>
              );
            })}
          </div>

          {/* Error card */}
          {isError && error && (
            <div className="mt-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 space-y-2">
              <div className="flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
                <p className="text-[11px] text-destructive/90 leading-relaxed">{error}</p>
              </div>
              <button
                type="button"
                onClick={onRetry}
                disabled={retrying}
                title="This will re-attempt creating your server and database. Your project data is safe."
                className="flex items-center gap-1 text-[11px] font-semibold text-destructive border border-destructive/30 bg-destructive/10 hover:bg-destructive/20 px-2 py-1 rounded-md transition-colors disabled:opacity-60"
              >
                {retrying ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RotateCcw className="h-3 w-3" />
                )}
                {retrying ? "Retrying…" : "Retry setup"}
              </button>
            </div>
          )}

          {/* Timeout warning */}
          {showTimeout && (
            <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/8 px-2.5 py-1.5">
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
              <p className="text-[10px] text-amber-300/80 flex-1">Taking longer than expected.</p>
              <button
                type="button"
                onClick={onLogsClick}
                className="text-[10px] font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2 shrink-0"
              >
                View logs
              </button>
            </div>
          )}

          {/* ETA line */}
          {isProvisioning &&
            estimatedSecondsRemaining != null &&
            estimatedSecondsRemaining > 0 &&
            !showTimeout && (
              <p className="text-[10px] text-muted-foreground text-center pt-0.5">
                {formatEta(estimatedSecondsRemaining)}
              </p>
            )}
        </div>
      )}
    </div>
  );
}
