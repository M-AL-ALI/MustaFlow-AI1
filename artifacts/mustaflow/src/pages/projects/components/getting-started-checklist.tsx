import { useState, useEffect } from "react";
import { CheckCircle2, Circle, X, ChevronDown, ChevronUp, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";

interface ChecklistStep {
  id: string;
  label: string;
  description: string;
  done: boolean;
}

interface GettingStartedChecklistProps {
  projectId: number;
  hasUserMessage: boolean;
  hasBuilt: boolean;
  hasViewed: boolean;
  isPublished: boolean;
  onDismiss: () => void;
  onNavigatePreview?: () => void;
  onNavigatePublishing?: () => void;
}

export function GettingStartedChecklist({
  projectId,
  hasUserMessage,
  hasBuilt,
  hasViewed,
  isPublished,
  onDismiss,
  onNavigatePreview,
  onNavigatePublishing,
}: GettingStartedChecklistProps) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`mustaflow_onboarding_collapsed_${projectId}`) === "1";
    } catch {
      return false;
    }
  });
  const [allDoneVisible, setAllDoneVisible] = useState(false);

  const steps: ChecklistStep[] = [
    {
      id: "describe",
      label: "Describe your app",
      description: "Tell the AI what you want to build in the chat below.",
      done: hasUserMessage,
    },
    {
      id: "build",
      label: "Hit Build",
      description: "Send your first message and watch the AI build it.",
      done: hasBuilt,
    },
    {
      id: "preview",
      label: "Preview it",
      description: "Open the Preview tab to see your app live.",
      done: hasViewed,
    },
    {
      id: "publish",
      label: "Publish and share",
      description: "Go to the Publishing tab to get a shareable public link.",
      done: isPublished,
    },
  ];

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;

  useEffect(() => {
    if (!allDone) return;
    const t = setTimeout(() => setAllDoneVisible(true), 300);
    return () => clearTimeout(t);
  }, [allDone]);

  useEffect(() => {
    try {
      localStorage.setItem(`mustaflow_onboarding_collapsed_${projectId}`, collapsed ? "1" : "0");
    } catch {
      // ignore storage errors
    }
  }, [collapsed, projectId]);

  const progressPct = Math.round((doneCount / steps.length) * 100);

  return (
    <div className="mx-1 mb-2 rounded-xl border border-border bg-muted/30 overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Rocket className="h-3.5 w-3.5 text-primary shrink-0" />
          <span className="text-xs font-semibold text-foreground">Getting started</span>
          <span className="text-[10px] text-muted-foreground shrink-0">
            {doneCount}/{steps.length}
          </span>
        </div>
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? (
            <ChevronDown className="h-3.5 w-3.5" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" />
          )}
        </button>
        <button
          onClick={onDismiss}
          className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded"
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-border/50 mx-3 mb-0.5 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            allDone ? "bg-green-500" : "bg-primary",
          )}
          style={{ width: `${progressPct}%` }}
        />
      </div>

      {/* Steps */}
      {!collapsed && (
        <div className="px-3 py-2 space-y-1">
          {allDoneVisible ? (
            <div className="flex flex-col items-center gap-1.5 py-2 text-center">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="text-xs font-semibold text-foreground">You're all set!</span>
              <span className="text-[11px] text-muted-foreground">
                Your app is built, previewed, and published.
              </span>
              <button
                onClick={onDismiss}
                className="mt-1 text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
              >
                Dismiss this panel
              </button>
            </div>
          ) : (
            steps.map((step, idx) => {
              const isNext = !step.done && steps.slice(0, idx).every((s) => s.done);
              const isActionable = isNext && (step.id === "preview" || step.id === "publish");
              return (
                <div
                  key={step.id}
                  className={cn(
                    "flex items-start gap-2.5 py-1.5 px-2 rounded-lg transition-colors",
                    isNext && "bg-primary/5 border border-primary/15",
                    !isNext && !step.done && "opacity-50",
                  )}
                >
                  <div className="mt-0.5 shrink-0">
                    {step.done ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                    ) : (
                      <Circle
                        className={cn(
                          "h-3.5 w-3.5",
                          isNext ? "text-primary" : "text-muted-foreground/40",
                        )}
                      />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div
                      className={cn(
                        "text-[11px] font-medium leading-tight",
                        step.done
                          ? "text-muted-foreground line-through"
                          : isNext
                            ? "text-foreground"
                            : "text-muted-foreground",
                      )}
                    >
                      {step.label}
                    </div>
                    {isNext && !step.done && (
                      <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                        {step.description}
                      </div>
                    )}
                    {isActionable && (
                      <button
                        onClick={step.id === "preview" ? onNavigatePreview : onNavigatePublishing}
                        className="mt-1 text-[10px] text-primary hover:text-primary/80 font-medium transition-colors"
                      >
                        {step.id === "preview" ? "Open Preview tab" : "Open Publishing tab"}
                        {" →"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
