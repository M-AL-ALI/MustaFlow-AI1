import { useState, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { X, ChevronRight, ChevronLeft, Server, FlaskConical, KeyRound } from "lucide-react";

const STORAGE_PREFIX = "mf-agentic-tour-v1-";

interface TooltipStep {
  title: string;
  description: string;
  icon: React.ElementType;
  targetSelector: string;
}

const AGENTIC_STEPS: TooltipStep[] = [
  {
    title: "Your project is being set up",
    description:
      "MustaFlow automatically provisions a private server and a Postgres database. The status badge here shows the current state — it typically takes under a minute.",
    icon: Server,
    targetSelector: "[data-tour='provisioning-badge']",
  },
  {
    title: "Test before you publish",
    description:
      "Full-stack projects go through a staging review before going live. Start a test preview, verify everything works, then promote to production — all from the Publishing tab.",
    icon: FlaskConical,
    targetSelector: "[data-tab='publishing']",
  },
  {
    title: "Your secrets are in Tools & Files",
    description:
      "DATABASE_URL and other secrets your app needs are stored in Tools & Files → Secrets. They are encrypted at rest and injected securely at runtime — never exposed in your code.",
    icon: KeyRound,
    targetSelector: "[data-tab='tools-files']",
  },
];

const TOOLTIP_W = 320;
const TOOLTIP_H = 220;
const ARROW_SZ = 8;
const GAP = 10;

interface Pos {
  top: number;
  left: number;
  arrowLeft: number;
  arrowUp: boolean;
}

function computePos(el: Element): Pos {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = r.left + r.width / 2 - TOOLTIP_W / 2;
  left = Math.max(12, Math.min(vw - TOOLTIP_W - 12, left));
  const arrowLeft = Math.min(Math.max(r.left + r.width / 2 - left - ARROW_SZ, 16), TOOLTIP_W - 32);

  if (r.bottom + GAP + TOOLTIP_H + 12 <= vh) {
    return { top: r.bottom + GAP, left, arrowLeft, arrowUp: true };
  }
  return { top: Math.max(8, r.top - TOOLTIP_H - GAP), left, arrowLeft, arrowUp: false };
}

function fallbackPos(): Pos {
  return {
    top: window.innerHeight - TOOLTIP_H - 90,
    left: window.innerWidth - TOOLTIP_W - 20,
    arrowLeft: -999,
    arrowUp: false,
  };
}

interface AgenticOnboardingTooltipProps {
  projectId: number;
  isAgenticProject: boolean;
}

export function AgenticOnboardingTooltip({
  projectId,
  isAgenticProject,
}: AgenticOnboardingTooltipProps) {
  const storageKey = `${STORAGE_PREFIX}${projectId}`;
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [pos, setPos] = useState<Pos | null>(null);
  const [highlightRect, setHighlightRect] = useState<DOMRect | null>(null);

  const updatePos = useCallback(() => {
    const current = AGENTIC_STEPS[step];
    if (!current) return;
    const el = document.querySelector(current.targetSelector);
    if (el) {
      setPos(computePos(el));
      setHighlightRect(el.getBoundingClientRect());
    } else {
      setPos(fallbackPos());
      setHighlightRect(null);
    }
  }, [step]);

  useEffect(() => {
    if (!isAgenticProject) return;
    try {
      if (localStorage.getItem(storageKey)) return;
    } catch {
      return;
    }
    const timer = setTimeout(() => setVisible(true), 1400);
    return () => clearTimeout(timer);
  }, [isAgenticProject, storageKey]);

  useEffect(() => {
    if (!visible) return;
    updatePos();
    window.addEventListener("scroll", updatePos, true);
    window.addEventListener("resize", updatePos);
    return () => {
      window.removeEventListener("scroll", updatePos, true);
      window.removeEventListener("resize", updatePos);
    };
  }, [visible, updatePos]);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(storageKey, "1");
    } catch {
      /* ignore */
    }
    setVisible(false);
  }, [storageKey]);

  const next = useCallback(() => {
    if (step < AGENTIC_STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const prev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  if (!visible || !pos) return null;

  const current = AGENTIC_STEPS[step]!;
  const Icon = current.icon;
  const isLast = step === AGENTIC_STEPS.length - 1;

  return createPortal(
    <>
      {highlightRect && (
        <div
          aria-hidden="true"
          className="fixed pointer-events-none z-[60] rounded ring-2 ring-primary animate-pulse"
          style={{
            top: highlightRect.top - 3,
            left: highlightRect.left - 3,
            width: highlightRect.width + 6,
            height: highlightRect.height + 6,
          }}
        />
      )}

      <div
        className="fixed z-[61] overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        style={{ top: pos.top, left: pos.left, width: TOOLTIP_W }}
        role="dialog"
        aria-modal="false"
        aria-label="Full-stack project guide"
      >
        {pos.arrowLeft >= 0 && pos.arrowUp && (
          <div
            aria-hidden="true"
            className="absolute"
            style={{
              top: -ARROW_SZ,
              left: pos.arrowLeft,
              borderLeft: `${ARROW_SZ}px solid transparent`,
              borderRight: `${ARROW_SZ}px solid transparent`,
              borderBottom: `${ARROW_SZ}px solid hsl(var(--border))`,
              width: 0,
              height: 0,
            }}
          />
        )}
        {pos.arrowLeft >= 0 && !pos.arrowUp && (
          <div
            aria-hidden="true"
            className="absolute"
            style={{
              bottom: -ARROW_SZ,
              left: pos.arrowLeft,
              borderLeft: `${ARROW_SZ}px solid transparent`,
              borderRight: `${ARROW_SZ}px solid transparent`,
              borderTop: `${ARROW_SZ}px solid hsl(var(--border))`,
              width: 0,
              height: 0,
            }}
          />
        )}

        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((step + 1) / AGENTIC_STEPS.length) * 100}%` }}
          />
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {step + 1} of {AGENTIC_STEPS.length}
            </span>
            <button
              onClick={dismiss}
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              aria-label="Close guide"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10">
              <Icon className="h-5 w-5 text-primary" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-bold">{current.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{current.description}</p>
            </div>
          </div>

          <div className="flex items-center justify-between pt-1">
            <button
              onClick={prev}
              disabled={step === 0}
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-muted/60 disabled:opacity-0 transition-colors"
            >
              <ChevronLeft className="h-4 w-4" />
              Back
            </button>

            <div className="flex gap-1.5">
              {AGENTIC_STEPS.map((_, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i)}
                  className={`h-1.5 rounded-full transition-all ${
                    i === step ? "w-5 bg-primary" : "w-1.5 bg-muted-foreground/30"
                  }`}
                  aria-label={`Go to step ${i + 1}`}
                />
              ))}
            </div>

            <button
              onClick={next}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
            >
              {isLast ? "Got it" : "Next"}
              {!isLast && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}

export function resetAgenticOnboardingTooltip(projectId: number) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${projectId}`);
  } catch {
    /* ignore */
  }
}
