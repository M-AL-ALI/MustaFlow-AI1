import { useState, useEffect, useCallback, useRef } from "react";
import { X, ChevronRight, ChevronLeft, Map } from "lucide-react";
import { cn } from "@/lib/utils";

interface TourStep {
  targetSelector: string;
  title: string;
  description: string;
  placement?: "top" | "bottom" | "left" | "right";
}

const TOUR_STEPS: TourStep[] = [
  {
    targetSelector: "[data-tour='chat-input']",
    title: "AI Builder",
    description:
      "Describe what you want to build here. The AI will generate your app's code in seconds — just write naturally.",
    placement: "top",
  },
  {
    targetSelector: "[data-tab='preview']",
    title: "Preview tab",
    description:
      "See your app running live after every build. Click here any time to switch to the interactive preview.",
    placement: "bottom",
  },
  {
    targetSelector: "[data-tab='publishing']",
    title: "Publishing tab",
    description:
      "When your app is ready, publish it here to get a shareable public link — no server setup needed.",
    placement: "bottom",
  },
  {
    targetSelector: "[data-tour='getting-started']",
    title: "Getting started checklist",
    description:
      "Track your progress here. You can replay this tour any time from this panel or the Help menu.",
    placement: "right",
  },
];

const PADDING = 10;
const TOOLTIP_WIDTH = 280;
const TOOLTIP_HEIGHT_ESTIMATE = 140;
const BUILD_ACTIVITY_STATUSES = new Set(["planning", "building", "testing", "completed"]);

interface BuildTourLifecycleOptions {
  projectId: number;
  taskStatuses: string[];
  onComplete: () => void;
}

export function useCompleteWorkspaceTourOnBuild({
  projectId,
  taskStatuses,
  onComplete,
}: BuildTourLifecycleOptions) {
  const hasBuildActivity = taskStatuses.some((status) => BUILD_ACTIVITY_STATUSES.has(status));

  useEffect(() => {
    if (!hasBuildActivity) return;

    onComplete();
    try {
      localStorage.setItem(`mustaflow_tour_seen_${projectId}`, "1");
    } catch {
      // Storage can be unavailable in private browsing; closing the tour still succeeds.
    }
  }, [hasBuildActivity, onComplete, projectId]);
}

function getSpotlightRect(el: Element) {
  const r = el.getBoundingClientRect();
  return {
    x: r.left - PADDING,
    y: r.top - PADDING,
    w: r.width + PADDING * 2,
    h: r.height + PADDING * 2,
  };
}

function computeTooltipStyle(
  rect: { x: number; y: number; w: number; h: number },
  placement: TourStep["placement"],
  vw: number,
  vh: number,
): React.CSSProperties {
  const TOOLTIP_GAP = 14;
  let top: number | undefined;
  let left: number | undefined;
  let right: number | undefined;

  if (placement === "bottom") {
    top = rect.y + rect.h + TOOLTIP_GAP;
    left = Math.min(Math.max(rect.x + rect.w / 2 - TOOLTIP_WIDTH / 2, 12), vw - TOOLTIP_WIDTH - 12);
  } else if (placement === "top") {
    top = rect.y - TOOLTIP_HEIGHT_ESTIMATE - TOOLTIP_GAP;
    left = Math.min(Math.max(rect.x + rect.w / 2 - TOOLTIP_WIDTH / 2, 12), vw - TOOLTIP_WIDTH - 12);
    if (top < 12) {
      top = rect.y + rect.h + TOOLTIP_GAP;
    }
  } else if (placement === "right") {
    top = Math.min(
      Math.max(rect.y + rect.h / 2 - TOOLTIP_HEIGHT_ESTIMATE / 2, 12),
      vh - TOOLTIP_HEIGHT_ESTIMATE - 12,
    );
    left = rect.x + rect.w + TOOLTIP_GAP;
    if (left + TOOLTIP_WIDTH > vw - 12) {
      left = undefined;
      right = 12;
    }
  } else {
    top = Math.min(
      Math.max(rect.y + rect.h / 2 - TOOLTIP_HEIGHT_ESTIMATE / 2, 12),
      vh - TOOLTIP_HEIGHT_ESTIMATE - 12,
    );
    left = rect.x - TOOLTIP_WIDTH - TOOLTIP_GAP;
    if (left < 12) left = 12;
  }

  return {
    position: "fixed",
    top,
    left,
    right,
    width: TOOLTIP_WIDTH,
    zIndex: 10001,
  };
}

interface WorkspaceTourProps {
  active: boolean;
  onClose: () => void;
  initialStep?: number;
}

export function WorkspaceTour({ active, onClose, initialStep = 0 }: WorkspaceTourProps) {
  const [step, setStep] = useState(initialStep);
  const [spotlightRect, setSpotlightRect] = useState<{
    x: number;
    y: number;
    w: number;
    h: number;
  } | null>(null);
  const [vw, setVw] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  const [vh, setVh] = useState(() => (typeof window !== "undefined" ? window.innerHeight : 800));
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const raf = useRef<number | null>(null);

  const currentStep = TOUR_STEPS[step];

  const measureTarget = useCallback(() => {
    if (!currentStep) return;
    const el = document.querySelector(currentStep.targetSelector);
    if (el) {
      setSpotlightRect(getSpotlightRect(el));
    } else {
      setSpotlightRect(null);
    }
  }, [currentStep]);

  useEffect(() => {
    if (!active) {
      setStep(initialStep);
      setSpotlightRect(null);
      setTooltipVisible(false);
      return;
    }
    setTooltipVisible(false);
    measureTarget();
    const timeout = setTimeout(() => setTooltipVisible(true), 200);
    return () => clearTimeout(timeout);
  }, [active, step, measureTarget, initialStep]);

  useEffect(() => {
    if (!active) return;
    const onResize = () => {
      setVw(window.innerWidth);
      setVh(window.innerHeight);
      measureTarget();
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [active, measureTarget]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && step < TOUR_STEPS.length - 1) setStep((s) => s + 1);
      if (e.key === "ArrowLeft" && step > 0) setStep((s) => s - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, step, onClose]);

  useEffect(() => {
    if (!active) return;
    let frame: number;
    const tick = () => {
      measureTarget();
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    raf.current = frame;
    return () => cancelAnimationFrame(frame);
  }, [active, measureTarget]);

  if (!active) return null;

  const sr = spotlightRect;
  const placement = currentStep?.placement ?? "bottom";
  const tooltipStyle = sr
    ? computeTooltipStyle(sr, placement, vw, vh)
    : {
        position: "fixed" as const,
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        width: TOOLTIP_WIDTH,
        zIndex: 10001,
      };

  const clipPath = sr
    ? `polygon(
        0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
        ${sr.x}px ${sr.y}px,
        ${sr.x}px ${sr.y + sr.h}px,
        ${sr.x + sr.w}px ${sr.y + sr.h}px,
        ${sr.x + sr.w}px ${sr.y}px,
        ${sr.x}px ${sr.y}px
      )`
    : undefined;

  return (
    <>
      {/* Dimmed overlay with spotlight hole */}
      <div
        data-testid="workspace-tour-overlay"
        className="fixed inset-0 transition-all duration-300"
        style={{
          zIndex: 10000,
          background: "rgba(0,0,0,0.65)",
          clipPath,
          pointerEvents: "none",
        }}
      />

      {/* Spotlight border ring */}
      {sr && (
        <div
          className="fixed pointer-events-none rounded-xl border-2 border-primary/70 shadow-[0_0_0_4px_rgba(var(--primary)/0.15)] transition-all duration-300"
          style={{
            zIndex: 10000,
            top: sr.y,
            left: sr.x,
            width: sr.w,
            height: sr.h,
          }}
        />
      )}

      {/* Tooltip */}
      <div
        style={tooltipStyle}
        className={cn(
          "bg-card border border-border rounded-xl shadow-2xl p-4 transition-all duration-200",
          tooltipVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-1",
        )}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <div className="w-5 h-5 rounded bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
              <Map className="h-3 w-3 text-primary" />
            </div>
            <span className="text-xs font-semibold text-foreground">{currentStep?.title}</span>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0 p-0.5 rounded"
            title="Skip tour"
            aria-label="Skip tour"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Description */}
        <p className="text-xs text-muted-foreground leading-relaxed mb-4">
          {currentStep?.description}
        </p>

        {/* Footer: step dots + nav buttons */}
        <div className="flex items-center gap-2">
          {/* Step dots */}
          <div className="flex items-center gap-1 flex-1">
            {TOUR_STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => setStep(i)}
                className={cn(
                  "rounded-full transition-all duration-200",
                  i === step
                    ? "w-4 h-1.5 bg-primary"
                    : "w-1.5 h-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60",
                )}
                title={`Go to step ${i + 1}`}
              />
            ))}
          </div>

          {/* Nav buttons */}
          <div className="flex items-center gap-1.5 shrink-0">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <ChevronLeft className="h-3 w-3" />
                Back
              </button>
            )}
            {step < TOUR_STEPS.length - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-medium hover:bg-primary/90 transition-colors"
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </button>
            ) : (
              <button
                onClick={onClose}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-green-500/15 border border-green-500/30 text-green-400 text-xs font-medium hover:bg-green-500/25 transition-colors"
              >
                Done
              </button>
            )}
          </div>
        </div>

        {/* Step counter */}
        <div className="mt-2 text-[10px] text-muted-foreground/50 text-right">
          {step + 1} of {TOUR_STEPS.length}
        </div>
      </div>

      {/* Transparent target overlay is visual-only; real workspace controls remain clickable. */}
      {sr && (
        <div
          data-testid="workspace-tour-target-overlay"
          className="fixed pointer-events-none rounded-xl"
          style={{
            zIndex: 10000,
            top: sr.y,
            left: sr.x,
            width: sr.w,
            height: sr.h,
          }}
          aria-hidden="true"
        />
      )}
    </>
  );
}
