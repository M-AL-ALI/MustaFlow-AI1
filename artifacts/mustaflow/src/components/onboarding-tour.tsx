import { useState, useEffect, useCallback } from "react";
import {
  X,
  ChevronRight,
  ChevronLeft,
  Zap,
  FolderKanban,
  Eye,
  BookOpen,
  Terminal,
  GitBranch,
  Key,
  ShieldCheck,
} from "lucide-react";

const TOUR_STORAGE_KEY = "mf-onboarding-tour-v1-seen";

// Custom DOM event name dispatched by the workspace when the user sends their first
// message in the AI builder chat. The event detail carries the message text so the
// tour can decide which path to show.
export const FIRST_WS_MESSAGE_EVENT = "mf:first-workspace-message";

interface TourStep {
  title: string;
  description: string;
  icon: React.ElementType;
}

const MAKER_STEPS: TourStep[] = [
  {
    title: "Welcome to MustaFlow AI",
    description:
      "You're about to build something great. MustaFlow turns plain English descriptions into working web apps — no coding required. This quick tour shows you the basics.",
    icon: Zap,
  },
  {
    title: "Create a Project",
    description:
      "Every app starts as a project. Click the Projects link in the sidebar, then use the New Project button to describe what you want to build. NabuFlow will generate it for you.",
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

const DEVELOPER_STEPS: TourStep[] = [
  {
    title: "Welcome, developer",
    description:
      "MustaFlow is a full development environment in your browser. Describe or write what you need — the AI handles the boilerplate while you keep full control over the code.",
    icon: Terminal,
  },
  {
    title: "Code editor & terminal",
    description:
      "Open the Code tab to view and edit every generated file. The Terminal tab gives you a real shell — run commands, install packages, tail logs, and inspect the running process.",
    icon: Terminal,
  },
  {
    title: "GitHub integration",
    description:
      "Connect your GitHub account in Settings to push your project to a repo, open pull requests, and sync changes back — all without leaving the workspace.",
    icon: GitBranch,
  },
  {
    title: "API tokens & REST access",
    description:
      "Generate a personal access token in Settings to call the full platform REST API at /api/v1. Automate builds, manage projects, and integrate MustaFlow into your own pipelines.",
    icon: Key,
  },
  {
    title: "Security & quality checks",
    description:
      "Every build runs Semgrep SAST and dependency CVE scanning automatically. Open the Checks tab to review findings, suppress false positives, and track your security posture over time.",
    icon: ShieldCheck,
  },
];

// Detect whether a message text looks like it came from a developer
export function isDeveloperMessage(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();

  // Code fences
  if (/```/.test(text)) return true;

  // File extensions
  if (/\.(js|ts|py|go|rs|rb|java|cs|cpp|sh|yml|yaml|json|toml)\b/.test(lower)) return true;

  // Framework/language names
  const frameworkKeywords = [
    "react",
    "express",
    "fastapi",
    "django",
    "flask",
    "nextjs",
    "next.js",
    "vue",
    "angular",
    "svelte",
    "rails",
    "laravel",
    "spring",
    "gin",
    "fiber",
    "graphql",
    "grpc",
    "rest api",
    "microservice",
    "docker",
    "kubernetes",
    "postgres",
    "postgresql",
    "mysql",
    "mongodb",
    "redis",
    "prisma",
    "drizzle",
    "typescript",
    "javascript",
    "python",
    "golang",
    "rust",
    "ruby",
    "node.js",
    "nodejs",
    "bun",
    "deno",
    "webpack",
    "vite",
    "esbuild",
    "ci/cd",
    "github actions",
    "webhook",
    "jwt",
    "oauth",
    "openapi",
    "swagger",
  ];
  if (frameworkKeywords.some((kw) => lower.includes(kw))) return true;

  // Error keywords
  const errorKeywords = [
    "typeerror",
    "traceback",
    " 500",
    "segfault",
    "null pointer",
    "undefined is not",
    "cannot read",
    "econnrefused",
    "timeout",
  ];
  if (errorKeywords.some((kw) => lower.includes(kw))) return true;

  return false;
}

export function OnboardingTour() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [steps, setSteps] = useState<TourStep[]>(MAKER_STEPS);

  useEffect(() => {
    // Skip entirely if already seen
    try {
      if (localStorage.getItem(TOUR_STORAGE_KEY)) return;
    } catch {
      /* ignore */
    }

    // Listen for the first workspace message event dispatched by the AI builder chat.
    // We select the tour path based on the message content, then show the tour.
    const handleFirstMessage = (e: Event) => {
      const messageText = (e as CustomEvent<string>).detail ?? "";
      const tourSteps = isDeveloperMessage(messageText) ? DEVELOPER_STEPS : MAKER_STEPS;
      setSteps(tourSteps);
      // Small delay so the UI isn't interrupted mid-send
      setTimeout(() => setVisible(true), 800);
    };

    window.addEventListener(FIRST_WS_MESSAGE_EVENT, handleFirstMessage, { once: true });
    return () => {
      window.removeEventListener(FIRST_WS_MESSAGE_EVENT, handleFirstMessage);
    };
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
    if (step < steps.length - 1) {
      setStep((s) => s + 1);
    } else {
      dismiss();
    }
  }, [step, steps.length, dismiss]);

  const prev = useCallback(() => {
    if (step > 0) setStep((s) => s - 1);
  }, [step]);

  if (!visible) return null;

  const current = steps[step]!;
  const Icon = current.icon;
  const isLast = step === steps.length - 1;

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
            style={{ width: `${((step + 1) / steps.length) * 100}%` }}
          />
        </div>

        <div className="p-6 space-y-5">
          {/* Close */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {step + 1} of {steps.length}
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
              {steps.map((_, i) => (
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
