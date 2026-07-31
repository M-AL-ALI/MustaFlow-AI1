import { useLocation, Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AgentIcon } from "@/components/agent-icon";
import {
  Monitor,
  LayoutDashboard,
  Zap,
  Database,
  MessageSquare,
  Sparkles,
  ArrowRight,
  LayoutTemplate,
  X,
  FileText,
  Globe,
  CheckCircle2,
  BookOpen,
  Star,
  Building2,
  UtensilsCrossed,
  Palette,
  GraduationCap,
  Wrench,
  Heart,
  ChevronLeft,
  ChevronRight,
  Package,
  GitBranch,
  Terminal,
  Bug,
  Key,
  Plug,
  ShieldCheck,
  Smartphone,
  Presentation,
  Bot,
  Lightbulb,
  Rocket,
  Paperclip,
  Mic,
  Image as ImageIcon,
  SlidersHorizontal,
  Brain,
  Languages,
  BarChart2,
} from "lucide-react";
import { useState, useEffect } from "react";
import {
  useCreateProject,
  getListProjectsQueryKey,
  getGetProjectQueryKey,
  useListNabuflowPlans,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { TemplatePicker } from "@/components/template-picker";
import { OnboardingWizard, hasCompletedOnboarding } from "@/components/onboarding-wizard";
import { type TemplateDefinition } from "@/lib/templates";
import { INDUSTRY_PERSONAS } from "@/lib/templates";
import { cn } from "@/lib/utils";
import { DemoAnimation } from "@/components/demo-animation";
import { ThemeToggle } from "@/components/theme-toggle";
import { TechnologyEcosystemBanner } from "@/components/technology-ecosystem-banner";
import { useAuthState } from "@/lib/auth-state-context";
import { OraBubble } from "@/components/ora-bubble";
import { useOraChat } from "@/hooks/use-ora-chat";
import { OraChatMockup } from "@/components/ora-chat-mockup";

const PERSONA_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "real-estate": Building2,
  restaurant: UtensilsCrossed,
  creator: Palette,
  educator: GraduationCap,
  contractor: Wrench,
  nonprofit: Heart,
};

// Bento grid feature cards for the Ora section
const ORA_BENTO_FEATURES = [
  {
    icon: Zap,
    title: "Free, no sign-in",
    description: "Start chatting instantly. No account, no credit card, no limits.",
    accent: "teal" as const,
    wide: false,
  },
  {
    icon: Globe,
    title: "Live web search",
    description: "Up-to-date answers grounded in real sources, with citations you can follow.",
    accent: "blue" as const,
    wide: true,
    chips: ["News", "Research", "Prices"],
  },
  {
    icon: ImageIcon,
    title: "Images in & out",
    description: "Generate images from a prompt, or upload one for Ora to analyze.",
    accent: "purple" as const,
    wide: false,
  },
  {
    icon: FileText,
    title: "Document export",
    description: "Turn any answer into a ready-to-share file.",
    accent: "amber" as const,
    wide: true,
    chips: ["PDF", "DOCX", "PPTX"],
  },
  {
    icon: Mic,
    title: "Voice conversation",
    description: "Talk hands-free and hear replies spoken back in a natural voice.",
    accent: "green" as const,
    wide: false,
  },
  {
    icon: Brain,
    title: "Memory across chats",
    description: "Ora remembers what matters so every conversation builds on the last.",
    accent: "rose" as const,
    wide: false,
  },
  {
    icon: Lightbulb,
    title: "Deep thinking",
    description: "Step-by-step reasoning for complex questions that need more than a quick answer.",
    accent: "indigo" as const,
    wide: false,
  },
  {
    icon: BarChart2,
    title: "File & data analysis",
    description: "Upload spreadsheets or documents and ask Ora to crunch the numbers.",
    accent: "orange" as const,
    wide: false,
  },
  {
    icon: Languages,
    title: "Multilingual replies",
    description: "Ask in any language. Ora detects and responds in the same tongue.",
    accent: "cyan" as const,
    wide: false,
  },
] as const;

const ORA_ACCENT: Record<string, { bg: string; border: string; text: string }> = {
  teal: { bg: "bg-teal-500/10", border: "border-teal-500/20", text: "text-teal-500" },
  blue: { bg: "bg-primary/10", border: "border-primary/20", text: "text-primary" },
  purple: { bg: "bg-purple-500/10", border: "border-purple-500/20", text: "text-purple-500" },
  amber: { bg: "bg-amber-500/10", border: "border-amber-500/20", text: "text-amber-500" },
  green: { bg: "bg-green-500/10", border: "border-green-500/20", text: "text-green-500" },
  rose: { bg: "bg-rose-500/10", border: "border-rose-500/20", text: "text-rose-500" },
  indigo: { bg: "bg-indigo-500/10", border: "border-indigo-500/20", text: "text-indigo-500" },
  orange: { bg: "bg-orange-500/10", border: "border-orange-500/20", text: "text-orange-500" },
  cyan: { bg: "bg-cyan-500/10", border: "border-cyan-500/20", text: "text-cyan-500" },
};

// Capability chips — speak to ideas, not stacks. Each pre-fills the prompt input.
const CAPABILITY_CHIPS = [
  {
    name: "Brainstorm an idea",
    icon: Lightbulb,
    prompt: "I have a rough idea — help me think through what to build and how it should work",
  },
  {
    name: "Mobile app",
    icon: Smartphone,
    prompt: "A mobile app that helps me track my daily habits with reminders and streaks",
  },
  {
    name: "Web app",
    icon: Monitor,
    prompt: "A web app where small businesses can manage bookings, customers, and invoices",
  },
  {
    name: "Landing page",
    icon: Rocket,
    prompt: "A clean, modern landing page for my startup with a hero, features, and a signup form",
  },
  {
    name: "Dashboard",
    icon: LayoutDashboard,
    prompt: "A dashboard that shows my key metrics with charts, filters, and live updates",
  },
  {
    name: "AI chatbot",
    icon: Bot,
    prompt: "An AI chatbot that answers questions about my product, with chat history",
  },
  {
    name: "Slide deck",
    icon: Presentation,
    prompt: "A pitch deck for my startup with problem, solution, market, and ask slides",
  },
  {
    name: "Data automation",
    icon: Zap,
    prompt: "An automation that pulls data from a source on a schedule and emails me a summary",
  },
];

// Rotating placeholder examples — cycles through the chat input when empty
const ROTATING_PROMPTS = [
  "A mobile app for tracking my daily habits…",
  "A landing page for my new coffee shop…",
  "A dashboard that shows my sales by region…",
  "An AI chatbot that answers customer questions…",
  "A simple booking site for my photography business…",
  "A pitch deck for my startup's seed round…",
  "An automation that emails me a weekly summary…",
  "A web app for organising my recipe collection…",
];

// Developer feature cards — all features already exist in the platform
const DEV_FEATURES = [
  {
    icon: GitBranch,
    title: "GitHub push & PR",
    description:
      "Push your project to a GitHub repo and open pull requests directly from the workspace.",
    href: "/projects",
  },
  {
    icon: Terminal,
    title: "Real terminal shell",
    description:
      "Full shell access via Fly.io exec WebSocket — run commands, inspect processes, tail logs.",
    href: "/projects",
  },
  {
    icon: Bug,
    title: "Remote DAP debugging",
    description: "Attach a debugger to your running container with the Debug Adapter Protocol.",
    href: "/projects",
  },
  {
    icon: Key,
    title: "API tokens & REST access",
    description:
      "Generate personal access tokens and call the full platform via the /api/v1 REST API.",
    href: "/settings",
  },
  {
    icon: ShieldCheck,
    title: "Semgrep + CVE scanning",
    description:
      "Automated SAST and dependency CVE scans run on every build. Findings surface in the Checks tab.",
    href: "/security",
  },
  {
    icon: Plug,
    title: "40+ managed blueprints",
    description:
      "One-click provisioning for Postgres, Redis, queues, object storage, and more — no config files.",
    href: "/integrations",
  },
];

const HOW_IT_WORKS = [
  {
    step: "1",
    icon: FileText,
    title: "Describe your idea",
    description:
      "Write what you want to build in plain language. No jargon, no templates — just your idea.",
  },
  {
    step: "2",
    icon: AgentIcon,
    title: "Zero builds it for you",
    description:
      "Zero — NabuFlow's builder agent — plans, codes, and assembles your app in seconds. Preview it live as it takes shape.",
  },
  {
    step: "3",
    icon: Globe,
    title: "Publish instantly",
    description:
      "One click publishes your app to a public URL. Share it with anyone, no setup required.",
  },
];

export default function HomePage() {
  const { isSignedIn } = useAuthState();
  const { data: nabuflowPlansData } = useListNabuflowPlans();
  const nabuflowPlans = (nabuflowPlansData?.plans ?? []).filter(
    (plan): plan is typeof plan & { priceUsd: number } =>
      plan.available && typeof plan.priceUsd === "number",
  );
  const cheapestNabuflowPlan = nabuflowPlans.reduce<typeof nabuflowPlans[number] | null>(
    (cheapest, plan) => (!cheapest || plan.priceUsd < cheapest.priceUsd ? plan : cheapest),
    null,
  );
  const rolloverPlanNames = nabuflowPlans
    .filter((plan) => plan.rolloverCycles > 0)
    .map((plan) => plan.name)
    .join(" and ");
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState("");
  const [showTemplateBrowser, setShowTemplateBrowser] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [activePersona, setActivePersona] = useState(0);
  const [activeChipLabel, setActiveChipLabel] = useState<string | undefined>();
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const oraChat = useOraChat();

  // Rotate the placeholder example every 3.2s while the input is empty
  useEffect(() => {
    if (prompt.trim().length > 0) return;
    const id = setInterval(() => {
      setPlaceholderIdx((i) => (i + 1) % ROTATING_PROMPTS.length);
    }, 3200);
    return () => clearInterval(id);
  }, [prompt]);

  function handleBrainstorm() {
    // Seed the brainstorm panel with any current prompt and route to the
    // workspace where the panel can actually call the auth-protected API.
    // Signed-out visitors get sent through sign-up first.
    try {
      sessionStorage.setItem("mustaflow_brainstorm_seed", prompt.trim());
    } catch {
      /* ignore quota / privacy-mode errors */
    }
    setLocation("/projects");
  }

  const { toast } = useToast();

  // Show onboarding wizard for first-time visitors
  useEffect(() => {
    const timer = setTimeout(() => {
      if (!hasCompletedOnboarding()) {
        setShowOnboarding(true);
      }
    }, 800);
    return () => clearTimeout(timer);
  }, []);

  // Auto-rotate industry personas every 4s
  useEffect(() => {
    const interval = setInterval(() => {
      setActivePersona((prev) => (prev + 1) % INDUSTRY_PERSONAS.length);
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const handleBuild = (kind: string = "web") => {
    if (!prompt.trim()) return;
    const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
    const name = words.charAt(0).toUpperCase() + words.slice(1);
    createProject.mutate(
      {
        data: {
          name,
          description: prompt,
          kind: kind as Parameters<typeof createProject.mutate>[0]["data"]["kind"],
          initialPrompt: prompt,
          ...(activeChipLabel ? { chipLabel: activeChipLabel } : {}),
        },
      },
      {
        onSuccess: (project) => {
          queryClient.setQueryData(getGetProjectQueryKey(project.id), project);
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
        },
        onError: (err: unknown) => {
          const status = (err as { status?: number })?.status;
          if (status === 401) {
            toast({
              title: "Sign in to build",
              description: "Create a free account to start building your app.",
            });
            setLocation("/sign-in");
          } else {
            toast({
              title: "Something went wrong",
              description: "Could not create your project. Please try again.",
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  function handleTemplateSelect(template: TemplateDefinition) {
    setShowTemplateBrowser(false);
    setLocation(`/projects/new?template=${encodeURIComponent(template.id)}`);
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto pb-24">
        {/* Top navigation bar */}
        <header className="sticky top-0 z-30 backdrop-blur-xl bg-background/80 border-b border-border">
          <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
            <a
              href={import.meta.env.BASE_URL || "/"}
              className="flex items-center group"
              aria-label="MustaFlow AI home"
            >
              <span className="text-lg font-bold tracking-tight">
                MustaFlow <span className="text-primary">AI</span>
              </span>
            </a>
            <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-muted-foreground">
              <Link href="/pricing" className="hover:text-foreground transition-colors">
                Pricing
              </Link>
              <Link href="/integrations" className="hover:text-foreground transition-colors">
                Integrations
              </Link>
              <Link href="/security" className="hover:text-foreground transition-colors">
                Security
              </Link>
              <Link href="/developers" className="hover:text-foreground transition-colors">
                Developers
              </Link>
              <Link href="/help" className="hover:text-foreground transition-colors">
                Help
              </Link>
            </nav>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              {!isSignedIn && (
                <>
                  <Button variant="ghost" size="sm" className="text-sm" asChild>
                    <Link href="/sign-in">Log in</Link>
                  </Button>
                  <Button size="sm" className="rounded-full px-4 text-sm shadow-md" asChild>
                    <Link href="/sign-up">Create account</Link>
                  </Button>
                </>
              )}
              {isSignedIn && (
                <Button size="sm" className="rounded-full px-4 text-sm" asChild>
                  <Link href="/projects">
                    My projects
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
            </div>
          </div>
        </header>

        {/* Hero Section */}
        <div className="max-w-4xl mx-auto pt-10 px-6">
          {/* Big logo treatment */}
          <div className="flex justify-center mb-10">
            <div className="relative">
              <div className="absolute -inset-10 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.35)_0%,transparent_70%)] blur-3xl pointer-events-none" />
              <div className="relative rounded-[2.5rem] border-2 border-border bg-gradient-to-br from-card via-card to-primary/5 p-3 shadow-2xl ring-1 ring-primary/20">
                <img
                  src={`${import.meta.env.BASE_URL}logo.png`}
                  alt="MustaFlow AI"
                  className="h-48 w-56 sm:h-56 sm:w-64 object-contain"
                />
              </div>
            </div>
          </div>
          <div className="text-center mb-5">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-5">
              <Sparkles className="h-3 w-3" />
              Code optional
            </p>
            <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight gradient-text mb-4 leading-tight">
              Build. Debug. Deploy.
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Describe it or write it — MustaFlow plans, builds, tests, and ships your app, whether
              you code or not.
            </p>
          </div>

          {/* Capability chips — dual-audience, pre-fill prompt */}
          <div className="flex items-center justify-center gap-2 mb-4 flex-wrap">
            {CAPABILITY_CHIPS.map((chip) => {
              const Icon = chip.icon;
              return (
                <button
                  key={chip.name}
                  type="button"
                  onClick={() => {
                    setPrompt(chip.prompt);
                    setActiveChipLabel(chip.name);
                  }}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-medium transition-all",
                    prompt === chip.prompt
                      ? "border-primary bg-primary/10 text-primary shadow-sm"
                      : "border-border text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-muted/50",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {chip.name}
                </button>
              );
            })}
          </div>

          <div className="relative max-w-2xl mx-auto mb-4">
            <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.18)_0%,transparent_70%)] blur-2xl rounded-full pointer-events-none" />
            <div className="relative bg-card border border-border shadow-xl rounded-2xl input-glow overflow-hidden">
              {/* Input row */}
              <div className="flex items-center gap-2 p-2">
                <div className="pl-4 text-primary">
                  <AgentIcon size={24} />
                </div>
                <Input
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    if (e.target.value !== activeChipLabel && activeChipLabel) {
                      setActiveChipLabel(undefined);
                    }
                  }}
                  placeholder={ROTATING_PROMPTS[placeholderIdx]}
                  className="border-0 focus-visible:ring-0 focus-visible:ring-offset-0 text-lg h-14 bg-transparent shadow-none"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleBuild();
                  }}
                />
                <Button
                  size="lg"
                  className="rounded-xl px-6 h-12 shrink-0"
                  onClick={() => handleBuild()}
                  disabled={createProject.isPending || !prompt.trim()}
                >
                  {createProject.isPending ? "Starting..." : "Start Building"}
                  {!createProject.isPending && <ArrowRight className="ml-2 h-5 w-5" />}
                </Button>
              </div>
              {/* Tool row — mirrors the in-app AI Builder; signed-out so each tool routes to sign-up */}
              <div className="flex items-center gap-1 px-3 py-2 border-t border-border/60 bg-muted/30">
                {[
                  { icon: Paperclip, label: "Attach a file" },
                  { icon: ImageIcon, label: "Add an image" },
                  { icon: Mic, label: "Voice input" },
                  { icon: SlidersHorizontal, label: "Agent mode" },
                ].map(({ icon: Icon, label }) => (
                  <a
                    key={label}
                    href="/sign-up"
                    title={`${label} — sign in to use`}
                    aria-label={`${label} (sign in to use)`}
                    className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
                  >
                    <Icon className="h-4 w-4" />
                  </a>
                ))}
                <div className="ml-auto text-xs text-muted-foreground pr-2 hidden sm:block">
                  Press{" "}
                  <kbd className="px-1.5 py-0.5 rounded border border-border bg-background text-[10px] font-mono">
                    Enter
                  </kbd>{" "}
                  to build
                </div>
              </div>
            </div>
          </div>

          {/* CTA row with secondary API link */}
          <div className="flex items-center justify-center gap-4 mb-4">
            <button
              type="button"
              onClick={() => setShowTemplateBrowser((v) => !v)}
              className={cn(
                "flex items-center gap-1.5 text-sm font-medium px-4 py-1.5 rounded-full border transition-colors",
                showTemplateBrowser
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-muted/50",
              )}
            >
              {showTemplateBrowser ? (
                <>
                  <X className="h-3.5 w-3.5" />
                  Hide templates
                </>
              ) : (
                <>
                  <LayoutTemplate className="h-3.5 w-3.5" />
                  Start from a template
                </>
              )}
            </button>
            <button
              type="button"
              onClick={handleBrainstorm}
              className="flex items-center gap-1.5 text-sm font-medium px-4 py-1.5 rounded-full border border-border text-muted-foreground hover:text-foreground hover:border-border/80 hover:bg-muted/50 transition-colors"
            >
              <Lightbulb className="h-3.5 w-3.5" />
              Brainstorm first
            </button>
            <Link
              href="/developers"
              className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Explore the API
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          {/* Template browser panel */}
          {showTemplateBrowser && (
            <div className="max-w-4xl mx-auto mb-8 bg-card border border-border rounded-2xl p-5 shadow-lg">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-base font-semibold">Templates</h2>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Pick a starting point — you can customise the prompt before building
                  </p>
                </div>
              </div>
              <TemplatePicker
                onSelect={handleTemplateSelect}
                onStartFromScratch={() => setShowTemplateBrowser(false)}
              />
            </div>
          )}

          {/* Meet Ora — premium section */}
          {!isSignedIn && (
            <section className="relative mt-20 mb-2 border-t border-b border-border/40 py-20 -mx-4 px-4 sm:-mx-8 sm:px-8 lg:-mx-16 lg:px-16 overflow-hidden">
              {/* Radial glow orb */}
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0 flex items-center justify-center"
              >
                <div className="h-[600px] w-[800px] rounded-full bg-primary/5 blur-3xl dark:bg-primary/8" />
              </div>

              <div className="relative max-w-5xl mx-auto">
                {/* Section header */}
                <div className="text-center mb-12">
                  <div className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3.5 py-1.5 mb-5">
                    <Sparkles className="h-3 w-3" />
                    Meet Ora
                    <span className="flex items-center gap-1 ml-0.5 text-green-500">
                      <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                      Live
                    </span>
                  </div>
                  <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-4">
                    <span className="gradient-text">Ora</span> — your AI assistant, always on
                  </h2>
                  <p className="text-muted-foreground max-w-2xl mx-auto text-base leading-relaxed">
                    Ask anything, research the web, generate images, export documents, and talk
                    hands-free. No account. No limits.
                  </p>
                </div>

                {/* Two-column: mockup + highlights */}
                <div className="grid grid-cols-1 lg:grid-cols-[55%_45%] gap-8 mb-12 items-center">
                  {/* Chat mockup */}
                  <OraChatMockup />

                  {/* Right-column highlight rows */}
                  <div className="space-y-5">
                    {[
                      {
                        icon: Globe,
                        accent: "blue" as const,
                        title: "Live web search",
                        desc: "Real-time answers grounded in current sources, with citations you can follow.",
                      },
                      {
                        icon: Mic,
                        accent: "green" as const,
                        title: "Voice conversation",
                        desc: "Talk hands-free and hear Ora's replies spoken back in a natural voice.",
                      },
                      {
                        icon: Brain,
                        accent: "rose" as const,
                        title: "Memory across chats",
                        desc: "Ora remembers what matters so every conversation builds on the last.",
                      },
                      {
                        icon: Lightbulb,
                        accent: "indigo" as const,
                        title: "Deep thinking",
                        desc: "Step-by-step reasoning for questions that need more than a quick answer.",
                      },
                    ].map(({ icon: Icon, accent, title, desc }) => {
                      const a = ORA_ACCENT[accent];
                      return (
                        <div key={title} className="flex items-start gap-4">
                          <div
                            className={cn(
                              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border",
                              a.bg,
                              a.border,
                            )}
                          >
                            <Icon className={cn("h-5 w-5", a.text)} />
                          </div>
                          <div>
                            <p className="font-semibold text-sm text-foreground leading-snug mb-0.5">
                              {title}
                            </p>
                            <p className="text-xs text-muted-foreground leading-relaxed">{desc}</p>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Bento feature grid */}
                <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
                  {ORA_BENTO_FEATURES.map((feature) => {
                    const a = ORA_ACCENT[feature.accent];
                    const chips = "chips" in feature ? feature.chips : undefined;
                    return (
                      <div
                        key={feature.title}
                        className={cn(
                          "rounded-2xl border border-border bg-card hover:bg-muted/50 transition-colors p-5",
                          feature.wide && "col-span-2",
                        )}
                      >
                        <div
                          className={cn(
                            "flex h-9 w-9 items-center justify-center rounded-xl border mb-3",
                            a.bg,
                            a.border,
                          )}
                        >
                          <feature.icon className={cn("h-4 w-4", a.text)} />
                        </div>
                        <h3 className="font-semibold text-sm text-foreground mb-1">
                          {feature.title}
                        </h3>
                        <p className="text-xs text-muted-foreground leading-relaxed">
                          {feature.description}
                        </p>
                        {chips && (
                          <div className="flex gap-1.5 mt-3 flex-wrap">
                            {chips.map((chip) => (
                              <span
                                key={chip}
                                className={cn(
                                  "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                                  a.bg,
                                  a.border,
                                  a.text,
                                )}
                              >
                                {chip}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Capabilities pill strip */}
                <div className="flex flex-wrap justify-center gap-2 mb-10">
                  {[
                    "Web search",
                    "Image gen",
                    "Voice chat",
                    "Memory",
                    "Deep thinking",
                    "File analysis",
                    "PDF · DOCX · PPTX",
                    "Multilingual",
                    "No sign-in",
                  ].map((pill) => (
                    <span
                      key={pill}
                      className="rounded-full border border-border bg-muted/50 text-muted-foreground text-xs px-3 py-1"
                    >
                      {pill}
                    </span>
                  ))}
                </div>

                {/* CTA block */}
                <div className="flex flex-col items-center gap-3">
                  <Button
                    size="lg"
                    className="gap-2 px-7 text-base font-semibold"
                    onClick={() => window.dispatchEvent(new CustomEvent("ora:open"))}
                  >
                    Try Ora free — no account needed
                    <ArrowRight className="h-4 w-4" />
                  </Button>
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {["No credit card", "Instant access", "Free forever"].map((t, i) => (
                      <span key={t} className="flex items-center gap-1.5">
                        {i > 0 && <span className="h-1 w-1 rounded-full bg-border" />}
                        <CheckCircle2 className="h-3 w-3 text-primary/60" />
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          )}

          {/* Social proof */}
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-xs text-muted-foreground/70 mt-10 mb-20">
            {[
              "No credit card to start",
              "Publish in seconds",
              "Built for developers and makers who ship fast",
            ].map((item) => (
              <span key={item} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-primary/60" />
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* Technology ecosystem ticker */}
        <div className="border-t border-border bg-muted/10">
          <TechnologyEcosystemBanner />
        </div>

        {/* Developer features section */}
        <div className="border-t border-border bg-muted/10">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-4">
                <Terminal className="h-3 w-3" />
                For developers
              </div>
              <h2 className="text-3xl sm:text-4xl font-extrabold tracking-tight mb-3">
                Professional tools, <span className="gradient-text">built in</span>
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto">
                Not a no-code toy. MustaFlow ships with the tools developers actually use — shell
                access, debugging, CI, and a REST API to automate everything.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {DEV_FEATURES.map((feature) => (
                <Link
                  key={feature.title}
                  href={feature.href}
                  className="group text-left relative rounded-2xl border border-border bg-card p-6 hover:border-primary/40 hover:bg-muted/40 transition-all duration-200 block"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 mb-4 group-hover:bg-primary/15 transition-colors">
                    <feature.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-semibold text-sm text-foreground mb-1.5">{feature.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {feature.description}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        </div>

        {/* Meet NabuFlow */}
        <div className="border-t border-border bg-background">
          <div className="max-w-6xl mx-auto px-6 py-20">
            {/* Section header */}
            <div className="text-center mb-14">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-4">
                <Sparkles className="h-3 w-3" />
                Meet NabuFlow
              </div>
              <div className="mb-5">
                <img
                  src={`${import.meta.env.BASE_URL}logos/nabuflow.png`}
                  alt="NabuFlow logo"
                  className="inline-block h-16 w-auto"
                  loading="lazy"
                />
              </div>
              <h2 className="text-3xl sm:text-5xl font-extrabold tracking-tight mb-4">
                A prompt turns into a real, <span className="gradient-text">deployable app.</span>
              </h2>
              <p className="text-muted-foreground max-w-2xl mx-auto text-base leading-relaxed">
                NabuFlow is MustaFlow AI's fully agentic builder. Describe what you want — mobile or
                web — and Zero, the builder agent, plans, codes, tests, and ships it. No mocks. A
                real app, live on the internet.
              </p>
            </div>

            {/* How it works — 3 steps */}
            <div className="relative mb-16">
              <div
                aria-hidden
                className="hidden sm:block absolute top-8 left-[calc(33.33%_+_1rem)] right-[calc(33.33%_+_1rem)] h-px bg-border/60"
              />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                {(
                  [
                    {
                      step: "1",
                      isAgent: false,
                      Icon: FileText,
                      title: "Describe",
                      desc: "Write what you want in plain language — mobile app, web app, dashboard, or landing page. No jargon required.",
                    },
                    {
                      step: "2",
                      isAgent: true,
                      Icon: null,
                      title: "Build",
                      desc: "Zero plans the architecture, writes the code, runs tests, and reports every step honestly — no silent failures.",
                    },
                    {
                      step: "3",
                      isAgent: false,
                      Icon: Rocket,
                      title: "Publish",
                      desc: "One click deploys to a live public URL. Share it, iterate on it, or export the source — it's your app.",
                    },
                  ] as const
                ).map((item) => (
                  <div
                    key={item.step}
                    className="flex flex-col items-center text-center gap-4 relative"
                  >
                    <div className="relative z-10">
                      <div className="w-16 h-16 rounded-2xl bg-card border border-border shadow-sm flex items-center justify-center">
                        {item.isAgent ? (
                          <AgentIcon size={28} className="text-primary" />
                        ) : (
                          item.Icon && <item.Icon className="h-7 w-7 text-primary" />
                        )}
                      </div>
                      <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-primary text-primary-foreground text-xs font-bold flex items-center justify-center shadow-sm">
                        {item.step}
                      </div>
                    </div>
                    <div>
                      <h3 className="font-bold text-base mb-1">{item.title}</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Big grid: live preview hero + Zero + Verified Builds */}
            <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mb-6">
              {/* Hero card — live production preview */}
              <div className="lg:col-span-3 relative rounded-3xl border border-border bg-card overflow-hidden shadow-xl group">
                <div className="absolute inset-0 bg-gradient-to-br from-primary/15 via-transparent to-transparent pointer-events-none" />
                <div className="p-8 sm:p-10">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">
                    Live Production Preview
                  </p>
                  <h3 className="text-2xl sm:text-3xl font-bold tracking-tight mb-3">
                    What you see is what ships.
                  </h3>
                  <p className="text-sm text-muted-foreground max-w-md leading-relaxed mb-6">
                    The preview pane shows your app running on a real container — not a screenshot,
                    not a simulation. Every change Zero makes is reflected live, so you always know
                    exactly what you're publishing.
                  </p>
                  <Button size="sm" className="gap-1.5 rounded-full" asChild>
                    <Link href="/sign-up">
                      Start building free
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
                <div className="px-6 pb-6">
                  <div className="rounded-2xl overflow-hidden border border-border bg-background/60 shadow-inner">
                    <div className="flex items-center gap-1.5 px-4 py-2.5 bg-muted/40 border-b border-border">
                      <span className="h-2.5 w-2.5 rounded-full bg-red-400/70" />
                      <span className="h-2.5 w-2.5 rounded-full bg-yellow-400/70" />
                      <span className="h-2.5 w-2.5 rounded-full bg-green-400/70" />
                      <div className="ml-3 flex-1 h-5 rounded-md bg-background/60 border border-border/60 px-2 text-[10px] text-muted-foreground flex items-center">
                        mustaflow.app/preview
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-4 p-6 bg-gradient-to-br from-primary/8 via-background to-background">
                      <div className="space-y-3">
                        <div className="h-3 w-20 rounded bg-primary/40" />
                        <div className="h-6 w-32 rounded bg-foreground/80" />
                        <div className="h-3 w-40 rounded bg-muted-foreground/30" />
                        <div className="h-3 w-36 rounded bg-muted-foreground/30" />
                        <div className="h-9 w-28 rounded-lg bg-primary mt-2" />
                      </div>
                      <div className="space-y-2">
                        <div className="aspect-square rounded-xl bg-gradient-to-br from-primary/40 to-primary/10 border border-primary/20" />
                        <div className="grid grid-cols-2 gap-2">
                          <div className="aspect-square rounded-lg bg-muted/60 border border-border" />
                          <div className="aspect-square rounded-lg bg-muted/60 border border-border" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Side stack */}
              <div className="lg:col-span-2 grid grid-cols-1 gap-5">
                {/* Zero agent card */}
                <div className="relative rounded-3xl border border-border bg-gradient-to-br from-primary/15 via-primary/5 to-transparent p-7 overflow-hidden">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">
                    Meet Zero
                  </p>
                  <h3 className="text-2xl font-bold tracking-tight mb-2">Your builder agent</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Zero is the AI that does the work. It architects, codes, tests, and reports —
                    all inside one conversation. Ask it to fix a bug, redesign a page, or start from
                    scratch.
                  </p>
                  <Bot className="absolute -bottom-4 -right-4 h-32 w-32 text-primary/10" />
                </div>
                {/* Verified builds card */}
                <div className="relative rounded-3xl border border-border bg-card p-7 overflow-hidden">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary mb-2">
                    Verified Builds
                  </p>
                  <h3 className="text-2xl font-bold tracking-tight mb-2">No fake "done"</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    Every build reports honestly — pass, fail, or warning. Zero never marks a build
                    complete until it actually runs cleanly.
                  </p>
                  <CheckCircle2 className="absolute -bottom-4 -right-4 h-28 w-28 text-primary/10" />
                </div>
              </div>
            </div>

            {/* 4-feature strip */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  icon: Smartphone,
                  title: "Mobile & web",
                  desc: "Build native mobile apps (iOS + Android) or full web apps — NabuFlow handles both from a single prompt.",
                },
                {
                  icon: Globe,
                  title: "Real deployable output",
                  desc: "Every project publishes to a live URL. Share it, sell it, or iterate — it's a real app, not a prototype.",
                },
                {
                  icon: ShieldCheck,
                  title: "Security built in",
                  desc: "Semgrep SAST and CVE scans run on every build. Findings surface in the Checks tab before you ship.",
                },
                {
                  icon: Zap,
                  title: "40+ integrations",
                  desc: "Postgres, Stripe, GitHub, Slack, OpenAI and dozens more — one click to wire them into your build.",
                },
              ].map((f) => (
                <div
                  key={f.title}
                  className="rounded-2xl border border-border bg-card p-5 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10 border border-primary/20 mb-3">
                    <f.icon className="h-4 w-4 text-primary" />
                  </div>
                  <h3 className="font-semibold text-sm mb-1">{f.title}</h3>
                  <p className="text-xs text-muted-foreground leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* 4-card feature strip */}
        <div className="border-t border-border bg-muted/10">
          <div className="max-w-6xl mx-auto px-6 py-20">
            <div className="text-center mb-10">
              <h2 className="text-2xl sm:text-4xl font-bold tracking-tight mb-3">
                Everything you need, nothing you don't
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-sm">
                From the first prompt to a published, secured, scaled app — MustaFlow handles the
                whole stack.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {[
                {
                  label: "Agent Chat",
                  title: "Describe it. Publish it.",
                  desc: "Plain-language conversation with an agent that codes, plans, and ships.",
                  icon: MessageSquare,
                  tone: "from-primary/15 to-primary/0 border-primary/20",
                },
                {
                  label: "Full Stack Infrastructure",
                  title: "Build & scale easily.",
                  desc: "Auth, database, hosting, monitoring — wired up with zero setup.",
                  icon: Database,
                  tone: "from-zinc-500/10 to-transparent border-zinc-500/15",
                },
                {
                  label: "Integrations",
                  title: "Connect to AI & services.",
                  desc: "Stripe, GitHub, Slack, OpenAI and dozens more — one click each.",
                  icon: Zap,
                  tone: "from-amber-500/15 to-transparent border-amber-500/20",
                },
                {
                  label: "Enterprise Control",
                  title: "Secure as you scale.",
                  desc: "RBAC, audit logs, SSO-ready, GDPR-aware — built for teams.",
                  icon: CheckCircle2,
                  tone: "from-emerald-500/15 to-transparent border-emerald-500/20",
                },
              ].map((card) => (
                <div
                  key={card.label}
                  className={cn(
                    "group relative rounded-3xl border bg-gradient-to-br p-6 overflow-hidden hover:-translate-y-1 transition-transform duration-200",
                    card.tone,
                  )}
                >
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    {card.label}
                  </p>
                  <h3 className="text-xl font-bold tracking-tight mb-2 leading-snug">
                    {card.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">{card.desc}</p>
                  <card.icon className="absolute -bottom-3 -right-3 h-20 w-20 text-foreground/[0.04] group-hover:text-primary/20 transition-colors" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* NabuFlow pricing teaser */}
        <div className="border-t border-border bg-background">
          <div className="max-w-5xl mx-auto px-6 py-16">
            <div className="rounded-2xl border border-primary/20 bg-primary/5 p-8 sm:p-10">
              <div className="flex flex-col sm:flex-row sm:items-center gap-6">
                <div className="flex-1 min-w-0">
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-3">
                    <Zap className="h-3 w-3" />
                    NabuFlow Builder plans
                  </div>
                  <h2 className="text-xl sm:text-2xl font-extrabold tracking-tight mb-2">
                    Pick a plan and start shipping
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
                    {nabuflowPlans.length > 0 && cheapestNabuflowPlan
                      ? `${nabuflowPlans.map((plan) => plan.name).join(", ")} — credit-based builder plans from $${cheapestNabuflowPlan.priceUsd}/month.`
                      : "Credit-based builder plans with included monthly credits."}{" "}
                    {rolloverPlanNames
                      ? `Unused credits roll over on ${rolloverPlanNames}.`
                      : "Rollover is available on eligible plans."}{" "}
                    Pay-as-you-go overage only when your monthly bucket runs out. Enterprise teams get
                    Constellation with pooled credits and org-wide spend caps.
                  </p>
                  <div className="flex flex-wrap gap-3 mt-4 text-xs text-muted-foreground">
                    {nabuflowPlans.map((plan) => (
                      <span key={plan.id} className="flex items-center gap-1.5">
                        <CheckCircle2 className="h-3 w-3 text-primary/60 shrink-0" />
                        {plan.name} · ${plan.priceUsd} / {plan.includedMonthlyCredits.toLocaleString()} credits
                      </span>
                    ))}
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-start sm:items-end gap-3">
                  <Button asChild size="sm" className="gap-2 rounded-full px-5">
                    <Link href="/pricing#nabuflow-plans">
                      See builder plans
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                  <Link
                    href="/pricing"
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    Full pricing →
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Industry Starter Packs section */}
        <div className="border-t border-border bg-muted/20">
          <div className="max-w-4xl mx-auto px-6 py-16">
            <div className="text-center mb-8">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-amber-400/80 border border-amber-500/20 bg-amber-500/5 rounded-full px-3 py-1 mb-4">
                <Package className="h-3 w-3" />
                Industry Starter Packs
              </div>
              <h2 className="text-2xl font-bold tracking-tight mb-2">
                Ready-made for your industry
              </h2>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                Professionally designed multi-page templates built for real businesses. Pick your
                industry and launch in minutes.
              </p>
            </div>

            {/* Rotating persona display */}
            <div className="bg-card border border-border rounded-2xl p-6 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-amber-500/5 to-transparent pointer-events-none" />
              <div className="flex items-center justify-between mb-4">
                <div className="flex gap-1.5">
                  {INDUSTRY_PERSONAS.map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setActivePersona(i)}
                      className={cn(
                        "h-1.5 rounded-full transition-all",
                        i === activePersona
                          ? "w-6 bg-primary"
                          : "w-1.5 bg-muted-foreground/30 hover:bg-muted-foreground/60",
                      )}
                      aria-label={p.label}
                    />
                  ))}
                </div>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() =>
                      setActivePersona(
                        (p) => (p - 1 + INDUSTRY_PERSONAS.length) % INDUSTRY_PERSONAS.length,
                      )
                    }
                    className="w-7 h-7 rounded-full border border-border bg-background flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivePersona((p) => (p + 1) % INDUSTRY_PERSONAS.length)}
                    className="w-7 h-7 rounded-full border border-border bg-background flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {INDUSTRY_PERSONAS.map((persona, i) => {
                const Icon = PERSONA_ICONS[persona.id] ?? Sparkles;
                return (
                  <div
                    key={persona.id}
                    className={cn(
                      "transition-all duration-500",
                      i === activePersona ? "block animate-in fade-in duration-300" : "hidden",
                    )}
                  >
                    <div className="flex items-start gap-4">
                      <div className="w-12 h-12 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                        <Icon className="h-6 w-6 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-foreground">{persona.label}</p>
                        <p className="text-sm text-muted-foreground mt-1 mb-3">
                          "{persona.demoPrompt}"
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="gap-1.5"
                          onClick={() => {
                            setPrompt(persona.demoPrompt);
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          Build this
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-center mt-4">
              <button
                type="button"
                onClick={() => setShowTemplateBrowser(true)}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
                Browse all templates
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Animated demo */}
        <div className="border-t border-border bg-background">
          <div className="max-w-4xl mx-auto px-6 py-20">
            <div className="text-center mb-10">
              <h2 className="text-2xl font-bold tracking-tight mb-2">See it in action</h2>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                From a single sentence to a live, shareable app — watch the full journey.
              </p>
            </div>
            <DemoAnimation />
          </div>
        </div>

        {/* How it works — For makers */}
        <div className="border-t border-border bg-muted/20">
          <div className="max-w-4xl mx-auto px-6 py-20">
            <div className="text-center mb-12">
              <div className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-4">
                <Sparkles className="h-3 w-3" />
                For makers
              </div>
              <h2 className="text-2xl font-bold tracking-tight mb-2">Describe and launch</h2>
              <p className="text-muted-foreground text-sm max-w-md mx-auto">
                From idea to live app in three simple steps — no experience required.
              </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
              {HOW_IT_WORKS.map((item) => (
                <div key={item.step} className="flex flex-col items-center text-center gap-4">
                  <div className="relative">
                    <div className="w-14 h-14 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                      <item.icon className="h-6 w-6 text-primary" />
                    </div>
                    <div className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-primary text-primary-foreground text-[10px] font-bold flex items-center justify-center">
                      {item.step}
                    </div>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm mb-1">{item.title}</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      {item.description}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Knowledge Vault marketing section */}
        <div className="border-t border-border bg-muted/10">
          <div className="max-w-4xl mx-auto px-6 py-20">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-12 items-center">
              <div>
                <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold bg-primary/10 border border-primary/20 text-primary mb-4">
                  <BookOpen className="h-3.5 w-3.5" />
                  Knowledge Vault
                </div>
                <h2 className="text-2xl font-bold tracking-tight mb-3">
                  The AI that gets better with every build
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                  Every project teaches MustaFlow something new. Lessons are captured automatically
                  — what worked, what didn't, your preferences — and injected into every future
                  build so the AI always improves.
                </p>
                <ul className="space-y-2.5">
                  {[
                    "Auto-captured after every build and refinement",
                    "Style Memory learns your colour palettes and conventions",
                    "Global lessons apply across every project you own",
                    "Share lessons to the public library for the community",
                  ].map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2.5 text-sm text-muted-foreground"
                    >
                      <CheckCircle2 className="h-4 w-4 text-primary/60 shrink-0 mt-0.5" />
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div className="space-y-3">
                {[
                  {
                    icon: BookOpen,
                    title: "Project History",
                    desc: "Every build recorded, searchable, and ready to teach the AI.",
                    color: "text-primary border-primary/20 bg-primary/8",
                  },
                  {
                    icon: Star,
                    title: "Global Lessons",
                    desc: "Promote your best learnings to apply across all projects.",
                    color: "text-yellow-400 border-yellow-500/20 bg-yellow-500/8",
                  },
                  {
                    icon: Globe,
                    title: "Public Library",
                    desc: "Browse community-shared lessons and rate the most useful ones.",
                    color: "text-blue-400 border-blue-500/20 bg-blue-500/8",
                  },
                ].map((item) => (
                  <div
                    key={item.title}
                    className="flex items-start gap-3.5 p-4 rounded-xl border border-border bg-card"
                  >
                    <div
                      className={cn(
                        "w-9 h-9 rounded-lg border flex items-center justify-center shrink-0",
                        item.color,
                      )}
                    >
                      <item.icon className="h-4 w-4" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-foreground mb-0.5">{item.title}</h3>
                      <p className="text-xs text-muted-foreground leading-relaxed">{item.desc}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom CTA */}
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold mb-3">Ready to build something?</h2>
          <p className="text-muted-foreground text-sm mb-6 max-w-sm mx-auto">
            Join developers, makers, founders, and creators who ship faster with MustaFlow AI.
          </p>
          <div className="flex items-center justify-center gap-4 flex-wrap">
            <Button size="lg" className="gap-2" asChild>
              <Link href="/sign-up">
                Get started for free
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Link
              href="/developers"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              Explore the API
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </div>

      {/* Onboarding wizard — shown on first visit */}
      {showOnboarding && (
        <OnboardingWizard
          onUseTemplate={(template) => {
            setShowOnboarding(false);
            handleTemplateSelect(template);
          }}
          onSkip={() => setShowOnboarding(false)}
        />
      )}

      {/* Ora floating bubble — signed-out visitors only */}
      {!isSignedIn && <OraBubble chat={oraChat} />}
    </>
  );
}
