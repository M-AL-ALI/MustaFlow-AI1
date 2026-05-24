import { useState } from "react";
import {
  ListChecks,
  ChevronDown,
  ChevronRight,
  Zap,
  ServerCog,
  Clock,
  FileText,
  ArrowRight,
  Loader2,
  X,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";

export type PlanBuildStep = {
  stepNumber: number;
  title: string;
  description: string;
  prompt: string;
  files: string[];
  dependsOn: number[];
  estimatedSeconds: number;
};

export type DecomposeResult = {
  steps: PlanBuildStep[];
  totalEstimatedSeconds: number;
  summary: string;
};

type StepStatus = "pending" | "building" | "done" | "error";

interface PlanDecomposeViewProps {
  projectId: number;
  plan: Record<string, unknown>;
  agentMode: string;
  onBuildStep: (prompt: string, agentMode: string, background: boolean) => void;
  onClose: () => void;
}

export function PlanDecomposeView({
  projectId,
  plan,
  agentMode,
  onBuildStep,
  onClose,
}: PlanDecomposeViewProps) {
  const [result, setResult] = useState<DecomposeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stepStatuses, setStepStatuses] = useState<Record<number, StepStatus>>({});
  const [expandedStep, setExpandedStep] = useState<number | null>(null);

  const decompose = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/plans/decompose`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ plan, agentMode }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? "Decomposition failed");
      }
      const data = (await res.json()) as DecomposeResult;
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  };

  const buildStep = (step: PlanBuildStep, background: boolean) => {
    setStepStatuses((prev) => ({ ...prev, [step.stepNumber]: "building" }));
    try {
      onBuildStep(
        `[Step ${step.stepNumber}/${result?.steps.length ?? "?"}: ${step.title}]\n\n${step.prompt}`,
        agentMode,
        background,
      );
      setStepStatuses((prev) => ({ ...prev, [step.stepNumber]: "done" }));
    } catch {
      setStepStatuses((prev) => ({ ...prev, [step.stepNumber]: "error" }));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm">
      <div
        className="bg-background border border-border rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Build in Steps"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0">
          <ListChecks className="h-4 w-4 text-primary shrink-0" />
          <span className="font-semibold text-sm flex-1">Build in steps</span>
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {!result && !loading && !error && (
            <div className="p-6 text-center space-y-4">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto">
                <ListChecks className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground mb-1">
                  Break this plan into steps
                </p>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  The AI will split your plan into 3–6 ordered build steps. You can kick off each
                  step individually, review the result, and then continue to the next.
                </p>
              </div>
              <button
                onClick={() => void decompose()}
                className="mx-auto flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <ListChecks className="h-3.5 w-3.5" />
                Generate step plan
              </button>
            </div>
          )}

          {loading && (
            <div className="flex items-center justify-center h-40 gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Breaking plan into steps…
            </div>
          )}

          {error && (
            <div className="p-4 text-center space-y-3">
              <p className="text-sm text-destructive">{error}</p>
              <button
                onClick={() => void decompose()}
                className="text-xs text-primary hover:underline"
              >
                Try again
              </button>
            </div>
          )}

          {result && (
            <div className="p-3 space-y-2">
              {/* Summary */}
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-muted/50">
                <Clock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-[11px] text-muted-foreground">
                  {result.steps.length} steps · ~{Math.round(result.totalEstimatedSeconds / 60)} min
                  total · {result.summary}
                </span>
              </div>

              {/* Steps */}
              {result.steps.map((step) => {
                const status = stepStatuses[step.stepNumber] ?? "pending";
                const isExpanded = expandedStep === step.stepNumber;
                const isDone = status === "done";
                const isBuilding = status === "building";
                const prevDone =
                  step.dependsOn.length === 0 ||
                  step.dependsOn.every((n) => stepStatuses[n] === "done");

                return (
                  <div
                    key={step.stepNumber}
                    className={cn(
                      "border rounded-lg overflow-hidden transition-colors",
                      isDone ? "border-green-500/30 bg-green-500/5" : "border-border",
                    )}
                  >
                    <div
                      className={cn(
                        "flex items-start gap-2 px-3 py-2 cursor-pointer hover:bg-muted/30 transition-colors",
                        isDone && "hover:bg-green-500/10",
                      )}
                      onClick={() => setExpandedStep(isExpanded ? null : step.stepNumber)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ")
                          setExpandedStep(isExpanded ? null : step.stepNumber);
                      }}
                    >
                      {/* Step number badge */}
                      <div
                        className={cn(
                          "w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 mt-0.5",
                          isDone
                            ? "bg-green-500/20 text-green-400"
                            : isBuilding
                              ? "bg-primary/20 text-primary"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {isDone ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : isBuilding ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          step.stepNumber
                        )}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              "text-xs font-medium truncate",
                              isDone ? "text-green-400" : "text-foreground",
                            )}
                          >
                            {step.title}
                          </span>
                          {isExpanded ? (
                            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          ) : (
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="text-[10px] text-muted-foreground">
                            {step.description}
                          </span>
                          {step.estimatedSeconds > 0 && (
                            <span className="text-[9px] text-muted-foreground/50 shrink-0">
                              ~{step.estimatedSeconds}s
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="border-t border-border px-3 py-2 space-y-2 bg-muted/10">
                        {/* Files */}
                        {step.files.length > 0 && (
                          <div>
                            <div className="flex items-center gap-1 mb-1">
                              <FileText className="h-3 w-3 text-muted-foreground" />
                              <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Files
                              </span>
                            </div>
                            <div className="flex flex-wrap gap-1">
                              {step.files.map((f, i) => (
                                <span
                                  key={i}
                                  className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground"
                                >
                                  {f}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Build prompt preview */}
                        <div>
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                            Build instruction
                          </div>
                          <div className="text-[11px] text-muted-foreground/80 bg-muted/30 rounded-lg p-2 leading-relaxed max-h-16 overflow-y-auto">
                            {step.prompt}
                          </div>
                        </div>

                        {/* Actions */}
                        {!isDone && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => buildStep(step, false)}
                              disabled={!prevDone || isBuilding}
                              className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 h-7 text-[11px] font-medium rounded-lg transition-colors",
                                prevDone && !isBuilding
                                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                                  : "bg-muted text-muted-foreground cursor-not-allowed",
                              )}
                              title={!prevDone ? "Complete previous steps first" : undefined}
                            >
                              {isBuilding ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Zap className="h-3 w-3" />
                              )}
                              {isBuilding ? "Building…" : "Build now"}
                            </button>
                            <button
                              onClick={() => buildStep(step, true)}
                              disabled={!prevDone || isBuilding}
                              className={cn(
                                "flex-1 flex items-center justify-center gap-1.5 h-7 text-[11px] font-medium rounded-lg border transition-colors",
                                prevDone && !isBuilding
                                  ? "border-border text-foreground hover:bg-muted/50"
                                  : "border-border text-muted-foreground cursor-not-allowed",
                              )}
                            >
                              <ServerCog className="h-3 w-3" />
                              Background
                            </button>
                          </div>
                        )}
                        {isDone && (
                          <div className="flex items-center gap-1.5 text-[11px] text-green-400">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            Step complete — check the preview before continuing
                          </div>
                        )}
                        {step.dependsOn.length > 0 && !prevDone && (
                          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <ArrowRight className="h-3 w-3 shrink-0" />
                            Complete step{step.dependsOn.length > 1 ? "s" : ""}{" "}
                            {step.dependsOn.join(", ")} first
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
