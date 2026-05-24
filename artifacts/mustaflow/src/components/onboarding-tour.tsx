import { useState, useEffect, useCallback } from "react";
import { X, ChevronRight, ChevronLeft, Zap, FolderKanban, Eye, BookOpen } from "lucide-react";

const TOUR_STORAGE_KEY = "mf-onboarding-tour-v1-seen";

interface TourStep {
  title: string;
  description: string;
  icon: React.ElementType;
}

const STEPS: TourStep[] = [
  {
    title: "Welcome to MustaFlow AI",
    description:
      "You're about to build something great. MustaFlow turns plain English descriptions into working web apps — no coding required. This quick tour shows you the basics.",
    icon: Zap,
  },
  {
    title: "Create a Project",
    description:
      "Every app starts as a project. Click the Projects link in the sidebar, then use the New Project button to describe what you want to build. The AI Builder will generate it for you.",
    icon: FolderKanban,
  },
  {
    title: "Refine with Chat",
    description:
      "Once your app is generated, use the chat at the bottom of the workspace to make changes. Just describe what you want differently — 'make the header blue' or 'add a login form'.",
    icon: Zap,
  },
  {
    title: "Preview & Publish",
    description:
      "Use the Preview tab to see your app live. When you're ready, go to the Publishing tab to share it with a public URL — or export it as a ZIP to host it yourself.",
    icon: Eye,
  },
  {
    title: "Learn as You Build",
    description:
      "The Knowledge Vault records what the AI learned from your sessions. Over time, it builds a shared library of best practices that makes future builds smarter and faster.",
    icon: BookOpen,
  },
];

export function OnboardingTour() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Only show the tour to users who haven't seen it
    let cleanup: (() => void) | undefined;
    try {
      const seen = localStorage.getItem(TOUR_STORAGE_KEY);
      if (!seen) {
        // Small delay so the app finishes loading before the tour appears
        const t = setTimeout(() => setVisible(true), 1200);
        cleanup = () => clearTimeout(t);
      }
    } catch {
      // localStorage may be blocked in some envs — skip silently
    }
    return cleanup;
  }, []);

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem(TOUR_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setDismissed(true);
    setTimeout(() => setVisible(false), 200);
  }, []);

  const next = useCallback(() => {
    if (step < STEPS.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const prev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  if (!visible) return null;

  const current = STEPS[step]!;
  const Icon = current.icon;
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className={`fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200 ${
        dismissed ? "opacity-0 pointer-events-none" : "opacity-100"
      }`}
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tour"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={dismiss}
        aria-hidden="true"
      />

      {/* Card */}
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-border bg-card shadow-2xl overflow-hidden">
        {/* Progress bar */}
        <div className="h-1 bg-muted">
          <div
            className="h-full bg-primary transition-all duration-300"
            style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="p-6 space-y-5">
          {/* Close */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {step + 1} of {STEPS.length}
            </span>
            <button
              onClick={dismiss}
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              aria-label="Close tour"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Icon + content */}
          <div className="space-y-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <Icon className="h-6 w-6 text-primary" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-bold">{current.title}</h2>
              <p className="text-sm text-muted-foreground leading-relaxed">{current.description}</p>
            </div>
          </div>

          {/* Navigation */}
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
              {STEPS.map((_, i) => (
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
              {isLast ? "Get started" : "Next"}
              {!isLast && <ChevronRight className="h-4 w-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Allow users to restart the tour from settings or help
export function resetOnboardingTour() {
  try {
    localStorage.removeItem(TOUR_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
