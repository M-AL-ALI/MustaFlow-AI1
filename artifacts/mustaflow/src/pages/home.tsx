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
} from "lucide-react";
import { useState } from "react";
import { useCreateProject, useListProjects, getListProjectsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { TemplatePicker } from "@/components/template-picker";
import { CreateProjectModal } from "@/components/create-project-modal";
import { type TemplateDefinition } from "@/lib/templates";
import { cn } from "@/lib/utils";

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
    createProject.mutate({
      data: {
        name,
        description: prompt,
        kind: kind as Parameters<typeof createProject.mutate>[0]["data"]["kind"],
        initialPrompt: prompt
      }
    }, {
      onSuccess: (project) => {
        void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
        setLocation(`/projects/${project.id}`);
      }
    });
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
        <div className="max-w-4xl mx-auto pt-24 px-6">
          <h1 className="text-5xl font-extrabold text-center mb-4 tracking-tight gradient-text">
            What do you want to build?
          </h1>
          <p className="text-muted-foreground text-center mb-12 text-lg">
            Describe your idea in natural language. MustaFlow AI will plan, build, and deploy it.
          </p>

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
                className="rounded-xl px-6 h-12"
                onClick={() => handleBuild()}
                disabled={createProject.isPending || !prompt.trim()}
              >
                {createProject.isPending ? "Starting..." : "Start Building"}
                {!createProject.isPending && <ArrowRight className="ml-2 h-5 w-5" />}
              </Button>
            </div>
          </div>

          {/* Template browser toggle */}
          <div className="flex justify-center mb-8">
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

          <div className="flex flex-wrap justify-center gap-2 max-w-3xl mx-auto">
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
