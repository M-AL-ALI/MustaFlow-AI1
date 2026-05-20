import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Monitor,
  LayoutDashboard,
  Paintbrush,
  BarChart,
  Table,
  Zap,
  Database,
  MessageSquare,
  Store,
  Sparkles,
  ArrowRight,
  LayoutTemplate,
  X,
  FileText,
  Globe,
  CheckCircle2,
} from "lucide-react";
import { useState } from "react";
import { useCreateProject, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { TemplatePicker } from "@/components/template-picker";
import { CreateProjectModal } from "@/components/create-project-modal";
import { type TemplateDefinition } from "@/lib/templates";
import { cn } from "@/lib/utils";
import { DemoAnimation } from "@/components/demo-animation";

// Mobile generation is intentionally excluded — the builder produces static
// HTML/CSS/JS. Expo/React Native output is a future milestone.
const CHIPS = [
  { name: "Website", icon: Monitor, kind: "web" },
  { name: "Dashboard", icon: LayoutDashboard, kind: "dashboard" },
  { name: "Design", icon: Paintbrush, kind: "design" },
  { name: "Data Viz", icon: BarChart, kind: "dashboard" },
  { name: "Spreadsheet", icon: Table, kind: "spreadsheet" },
  { name: "Automation", icon: Zap, kind: "automation" },
  { name: "API/Backend", icon: Database, kind: "api" },
  { name: "AI Chatbot", icon: MessageSquare, kind: "chatbot" },
  { name: "Marketplace", icon: Store, kind: "marketplace" },
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
    icon: Sparkles,
    title: "AI builds it for you",
    description:
      "MustaFlow AI plans, codes, and assembles your app in seconds. Preview it live as it takes shape.",
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
  const [, setLocation] = useLocation();
  const [prompt, setPrompt] = useState("");
  const [showTemplateBrowser, setShowTemplateBrowser] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | undefined>();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();

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
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
        },
      },
    );
  };

  function handleTemplateSelect(template: TemplateDefinition) {
    setSelectedTemplate(template);
    setShowTemplateBrowser(false);
    setModalOpen(true);
  }

  function handleModalClose(open: boolean) {
    setModalOpen(open);
    if (!open) {
      setSelectedTemplate(undefined);
    }
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto pb-24">
        {/* Hero Section */}
        <div className="max-w-4xl mx-auto pt-20 px-6">
          <div className="text-center mb-6">
            <p className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-primary/80 border border-primary/20 bg-primary/5 rounded-full px-3 py-1 mb-6">
              <Sparkles className="h-3 w-3" />
              No code required
            </p>
            <h1 className="text-5xl sm:text-6xl font-extrabold tracking-tight gradient-text mb-5 leading-tight">
              Describe it.
              <br className="hidden sm:block" /> Watch it build.
            </h1>
            <p className="text-muted-foreground text-lg max-w-xl mx-auto">
              Type your idea in plain language. MustaFlow AI plans, builds, and publishes your app —
              no coding, no setup.
            </p>
          </div>

          <div className="relative max-w-2xl mx-auto mb-4">
            <div className="absolute -inset-6 bg-[radial-gradient(ellipse_at_center,hsl(var(--primary)/0.18)_0%,transparent_70%)] blur-2xl rounded-full pointer-events-none" />
            <div className="relative bg-card border border-border shadow-xl rounded-2xl p-2 flex items-center gap-2 input-glow">
              <div className="pl-4 text-primary">
                <Sparkles className="h-6 w-6" />
              </div>
              <Input
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="e.g. A marketplace app for local artists to sell prints..."
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
          </div>

          {/* Template browser toggle */}
          <div className="flex justify-center mb-6">
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

          <div className="flex flex-wrap justify-center gap-2 max-w-3xl mx-auto mb-6">
            {CHIPS.map((chip) => (
              <button
                key={chip.name}
                aria-label={`Build a ${chip.name}`}
                onClick={() => {
                  const template = `Build me a ${chip.name.toLowerCase()}`;
                  if (!prompt.trim()) {
                    setPrompt(template);
                  } else {
                    handleBuild(chip.kind);
                  }
                }}
                className="group flex items-center gap-2 px-4 py-2 rounded-full border border-border bg-card hover:bg-muted chip-hover text-sm font-medium text-foreground"
              >
                <chip.icon className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors duration-150" />
                {chip.name}
              </button>
            ))}
          </div>

          {/* Social proof */}
          <div className="flex flex-wrap items-center justify-center gap-4 sm:gap-6 text-xs text-muted-foreground/70 mb-20">
            {[
              "No credit card to start",
              "Publish in seconds",
              "Built for makers, not engineers",
            ].map((item) => (
              <span key={item} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-primary/60" />
                {item}
              </span>
            ))}
          </div>
        </div>

        {/* Animated demo */}
        <div className="border-t border-border bg-muted/20">
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

        {/* How it works */}
        <div className="border-t border-border bg-background">
          <div className="max-w-4xl mx-auto px-6 py-20">
            <div className="text-center mb-12">
              <h2 className="text-2xl font-bold tracking-tight mb-2">How it works</h2>
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

        {/* Bottom CTA */}
        <div className="max-w-4xl mx-auto px-6 py-16 text-center">
          <h2 className="text-2xl font-bold mb-3">Ready to build something?</h2>
          <p className="text-muted-foreground text-sm mb-6 max-w-sm mx-auto">
            Join makers, founders, and creators who build faster with MustaFlow AI.
          </p>
          <Button size="lg" onClick={() => setLocation("/sign-up")} className="gap-2">
            Get started for free
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Create project modal — opened with a pre-applied template */}
      <CreateProjectModal
        open={modalOpen}
        onOpenChange={handleModalClose}
        initialTemplate={selectedTemplate}
      />
    </>
  );
}
