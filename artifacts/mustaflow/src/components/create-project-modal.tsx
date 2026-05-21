import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateProject,
  getListProjectsQueryKey,
  ProjectInputStack,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/contexts/workspace-context";
import {
  Monitor,
  LayoutDashboard,
  Zap,
  Database,
  Globe,
  LayoutTemplate,
  PencilLine,
  ChevronLeft,
  Smartphone,
  ShoppingCart,
  MessageSquare,
  CreditCard,
  Layers,
  Server,
  Code2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TemplatePicker } from "@/components/template-picker";
import { type TemplateDefinition } from "@/lib/templates";

type Stack = "react-vite" | "nextjs" | "node-api" | "python-flask" | "python-fastapi";

const STACK_OPTIONS: Array<{
  value: Stack;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}> = [
  {
    value: "react-vite",
    label: "React + Vite",
    description: "Static web app",
    icon: Layers,
    badge: "default",
  },
  {
    value: "nextjs",
    label: "Next.js 14",
    description: "App Router",
    icon: Globe,
  },
  {
    value: "node-api",
    label: "Node.js API",
    description: "Express + TypeScript",
    icon: Server,
  },
  {
    value: "python-flask",
    label: "Python Flask",
    description: "REST API / web",
    icon: Code2,
  },
  {
    value: "python-fastapi",
    label: "FastAPI",
    description: "Async Python API",
    icon: Zap,
  },
];

const WEB_PROJECT_TYPES = [
  { label: "Website", kind: "web", icon: Monitor },
  { label: "Web App", kind: "fullstack", icon: Globe },
  { label: "Dashboard", kind: "dashboard", icon: LayoutDashboard },
  { label: "Automation", kind: "automation", icon: Zap },
  { label: "API", kind: "api", icon: Database },
  { label: "Mobile", kind: "mobile", icon: Smartphone },
] as const;

const MOBILE_PROJECT_TYPES = [
  { label: "Cross-platform", kind: "mobile-cross", icon: Smartphone },
  { label: "Store", kind: "mobile-cross", icon: ShoppingCart, preset: "mobile-ecommerce" },
  { label: "Chat", kind: "mobile-cross", icon: MessageSquare, preset: "mobile-chat" },
  { label: "SaaS", kind: "mobile-cross", icon: CreditCard, preset: "mobile-subscription-saas" },
] as const;

type RuntimeOption = "react-vite" | "node20" | "node22" | "python312";

const WEB_RUNTIMES: Array<{
  value: RuntimeOption;
  label: string;
  badge: string;
  description: string;
  icon: typeof Monitor;
}> = [
  {
    value: "react-vite",
    label: "React + Vite",
    badge: "Default",
    description: "Modern React SPA with Tailwind CSS and Vite build tool",
    icon: Monitor,
  },
  {
    value: "node20",
    label: "Node.js 20",
    badge: "LTS",
    description: "Express API server with Node.js 20 LTS runtime",
    icon: Server,
  },
  {
    value: "node22",
    label: "Node.js 22",
    badge: "Latest",
    description: "Express API server with Node.js 22 latest runtime",
    icon: Server,
  },
  {
    value: "python312",
    label: "Python 3.12",
    badge: "Flask",
    description: "Flask/FastAPI web server with Python 3.12",
    icon: Code2,
  },
];

type PlatformTab = "web" | "mobile";

type WebProjectKind = (typeof WEB_PROJECT_TYPES)[number]["kind"];
type MobileProjectKind = "mobile-cross";
type ProjectKind = WebProjectKind | MobileProjectKind;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt?: string;
  initialTemplate?: TemplateDefinition;
}

function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

type View = "form" | "templates";

export function CreateProjectModal({
  open,
  onOpenChange,
  initialPrompt = "",
  initialTemplate,
}: Props) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { currentWorkspace } = useWorkspace();

  const [view, setView] = useState<View>("form");
  const [platformTab, setPlatformTab] = useState<PlatformTab>("web");
  const [stack, setStack] = useState<Stack>("react-vite");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [kind, setKind] = useState<ProjectKind>("web");
  const [runtime, setRuntime] = useState<RuntimeOption>("react-vite");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | undefined>(
    initialTemplate,
  );

  useEffect(() => {
    if (!open) return;
    setView("form");
    setNameDirty(false);
    setStack("react-vite");
    if (initialTemplate) {
      setSelectedTemplate(initialTemplate);
      setName(initialTemplate.title);
      setPrompt(initialTemplate.seedPrompt);
      const templateKind = initialTemplate.projectKind as ProjectKind;
      setKind(templateKind);
      setPlatformTab(isMobileKind(templateKind) ? "mobile" : "web");
      setRuntime("react-vite");
    } else {
      setSelectedTemplate(undefined);
      setName("");
      setPrompt(initialPrompt);
      setKind("web");
      setPlatformTab("web");
      setRuntime("react-vite");
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function isMobileKind(k: string): boolean {
    return k === "mobile-cross" || k === "mobile-ios" || k === "mobile-android";
  }

  function handleOpenChange(val: boolean) {
    onOpenChange(val);
  }

  function applyTemplate(template: TemplateDefinition) {
    setSelectedTemplate(template);
    setPrompt(template.seedPrompt);
    if (!nameDirty || !name.trim()) {
      setName(template.title);
      setNameDirty(false);
    }
    const templateKind = template.projectKind as ProjectKind;
    setKind(templateKind);
    setPlatformTab(isMobileKind(templateKind) ? "mobile" : "web");
    setRuntime("react-vite");
    setView("form");
  }

  function clearTemplate() {
    setSelectedTemplate(undefined);
    setPrompt("");
    if (platformTab === "mobile") {
      setKind("mobile-cross");
    } else {
      setKind("web");
    }
  }

  function handlePlatformTabChange(tab: PlatformTab) {
    setPlatformTab(tab);
    setSelectedTemplate(undefined);
    setRuntime("react-vite");
    if (tab === "mobile") {
      setKind("mobile-cross");
    } else {
      setKind("web");
      setStack("react-vite");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const resolvedName = name.trim() || (prompt.trim() ? nameFromPrompt(prompt) : "New Project");

    createProject.mutate(
      {
        data: {
          name: resolvedName,
          description: prompt.trim() || undefined,
          workspaceId: currentWorkspace?.id,
          kind: kind as Parameters<typeof createProject.mutate>[0]["data"]["kind"],
          stack: platformTab === "web" ? (stack as ProjectInputStack) : undefined,
          initialPrompt: prompt.trim() || undefined,
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          onOpenChange(false);
          setLocation(`/projects/${project.id}`);
        },
      },
    );
  }

  const templateCount = platformTab === "mobile" ? "6 mobile templates" : "16 templates";

  // For non-react-vite runtimes, show a note about container-based execution
  const isServerRuntime = runtime !== "react-vite" && platformTab === "web";
  const selectedRuntimeDef = WEB_RUNTIMES.find((r) => r.value === runtime);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={cn(
          "transition-all duration-200",
          view === "templates" ? "sm:max-w-3xl" : "sm:max-w-lg",
        )}
      >
        {view === "templates" ? (
          <>
            <DialogHeader className="flex-row items-center gap-3 space-y-0">
              <button
                type="button"
                onClick={() => setView("form")}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Back to form"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <DialogTitle>Choose a template</DialogTitle>
            </DialogHeader>

            <div className="max-h-[70vh] overflow-y-auto pr-1">
              <TemplatePicker
                selectedId={selectedTemplate?.id}
                onSelect={applyTemplate}
                onStartFromScratch={() => {
                  clearTemplate();
                  setView("form");
                }}
                filterPlatform={platformTab}
              />
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create new project</DialogTitle>
            </DialogHeader>

            <form onSubmit={handleSubmit} className="space-y-5 pt-1">
              {/* Platform tab selector */}
              <div className="flex items-center bg-muted border border-border rounded-lg p-1 gap-1">
                <button
                  type="button"
                  onClick={() => handlePlatformTabChange("web")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    platformTab === "web"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Monitor className="h-4 w-4" />
                  Web
                </button>
                <button
                  type="button"
                  onClick={() => handlePlatformTabChange("mobile")}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors",
                    platformTab === "mobile"
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Smartphone className="h-4 w-4" />
                  Mobile
                </button>
              </div>

              {/* Stack selector — web only */}
              {platformTab === "web" && (
                <div className="space-y-1.5">
                  <Label>Stack</Label>
                  <div className="grid grid-cols-5 gap-2">
                    {STACK_OPTIONS.map((opt) => {
                      const Icon = opt.icon;
                      const isSelected = stack === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => setStack(opt.value)}
                          className={cn(
                            "flex flex-col items-center gap-1 rounded-xl border px-1.5 py-2.5 text-[10px] font-medium transition-colors text-center",
                            isSelected
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="leading-tight">{opt.label}</span>
                          <span
                            className={cn(
                              "text-[9px] font-normal leading-tight",
                              isSelected ? "text-primary/70" : "text-muted-foreground/60",
                            )}
                          >
                            {opt.description}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Mobile info banner */}
              {platformTab === "mobile" && (
                <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-green-500/10 border border-green-500/20 text-xs text-green-400">
                  <Smartphone className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium">Expo / React Native</span>
                    {" — "}
                    Generates iOS + Android source code with a web preview. Scan the QR code with
                    Expo Go to run on your device.
                  </div>
                </div>
              )}

              {/* Template selector strip */}
              <div
                className={cn(
                  "rounded-xl border p-3 transition-colors",
                  selectedTemplate ? "border-primary/50 bg-primary/5" : "border-border bg-muted/40",
                )}
              >
                {selectedTemplate ? (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <LayoutTemplate className="h-4 w-4 text-primary shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium text-primary truncate">
                          {selectedTemplate.title}
                        </p>
                        <p className="text-xs text-muted-foreground truncate">
                          Template applied — you can edit the prompt below
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs gap-1"
                        onClick={() => setView("templates")}
                      >
                        <LayoutTemplate className="h-3 w-3" />
                        Change
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-muted-foreground hover:text-foreground gap-1"
                        onClick={clearTemplate}
                      >
                        <PencilLine className="h-3 w-3" />
                        Clear
                      </Button>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full text-sm text-muted-foreground hover:text-foreground transition-colors group"
                    onClick={() => setView("templates")}
                  >
                    <LayoutTemplate className="h-4 w-4 group-hover:text-primary transition-colors" />
                    <span>Start from a template</span>
                    <span className="ml-auto text-xs text-muted-foreground/60 group-hover:text-muted-foreground">
                      {templateCount} available
                    </span>
                  </button>
                )}
              </div>

              {/* Project name */}
              <div className="space-y-1.5">
                <Label htmlFor="cp-name">Project name</Label>
                <Input
                  id="cp-name"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setNameDirty(true);
                  }}
                  placeholder={
                    selectedTemplate
                      ? selectedTemplate.title
                      : prompt.trim()
                        ? nameFromPrompt(prompt)
                        : platformTab === "mobile"
                          ? "My mobile app"
                          : runtime === "python312"
                            ? "My Python API"
                            : runtime === "node20" || runtime === "node22"
                              ? "My Node.js API"
                              : "My web app"
                  }
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank to auto-generate from your prompt.
                </p>
              </div>

              {/* Project type — web only; mobile is always mobile-cross */}
              {platformTab === "web" && (
                <div className="space-y-1.5">
                  <Label>Project type</Label>
                  <div className="grid grid-cols-5 gap-2">
                    {WEB_PROJECT_TYPES.map(({ label, kind: k, icon: Icon }) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKind(k)}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] font-medium transition-colors",
                          kind === k
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Mobile type picker */}
              {platformTab === "mobile" && (
                <div className="space-y-1.5">
                  <Label>App type</Label>
                  <div className="grid grid-cols-4 gap-2">
                    {MOBILE_PROJECT_TYPES.map(({ label, icon: Icon }, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => setKind("mobile-cross")}
                        className={cn(
                          "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] font-medium transition-colors",
                          kind === "mobile-cross" && i === 0
                            ? "border-primary bg-primary/10 text-primary"
                            : kind === "mobile-cross" && i > 0
                              ? "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                              : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    All mobile projects target iOS and Android via Expo.
                  </p>
                </div>
              )}

              {/* First prompt */}
              <div className="space-y-1.5">
                <Label htmlFor="cp-prompt">
                  {selectedTemplate
                    ? "Prompt (from template — edit freely)"
                    : "First prompt (optional)"}
                </Label>
                <Textarea
                  id="cp-prompt"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    platformTab === "mobile"
                      ? "Describe your mobile app — e.g. A fitness tracker with workout logging, progress charts, and a home screen dashboard."
                      : runtime === "python312"
                        ? "Describe your Python API — e.g. A REST API for a task management system with user authentication and CRUD endpoints."
                        : runtime === "node20" || runtime === "node22"
                          ? "Describe your Node.js API — e.g. An Express REST API for a recipe book with search, categories, and user bookmarks."
                          : "Describe what you want to build — e.g. A landing page for a local towing company with a hero section, services, and contact form."
                  }
                  rows={selectedTemplate ? 4 : 3}
                  className="resize-none"
                />
                <p className="text-xs text-muted-foreground">
                  {selectedTemplate
                    ? "This seed prompt is pre-filled from the template. You can refine it before building."
                    : "If provided, the AI builder will start building immediately after you create the project."}
                </p>
              </div>

              <DialogFooter className="pt-1">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                  disabled={createProject.isPending}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={createProject.isPending}>
                  {createProject.isPending ? "Creating…" : "Create project"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
