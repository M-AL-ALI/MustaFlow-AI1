import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  useCreateProject,
  getListProjectsQueryKey,
  getGetProjectQueryKey,
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
  ChevronDown,
  Smartphone,
  ShoppingCart,
  MessageSquare,
  CreditCard,
  Layers,
  Server,
  Code2,
  CheckCircle2,
  Clock,
  Rocket,
  KeyRound,
  Cpu,
  ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TemplatePicker } from "@/components/template-picker";
import { type TemplateDefinition } from "@/lib/templates";
import { useToast } from "@/hooks/use-toast";

type Stack = "react-vite" | "nextjs" | "node-api" | "python-flask" | "python-fastapi" | "go-gin";

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
  {
    value: "go-gin",
    label: "Go + Gin",
    description: "Go REST API",
    icon: Server,
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

const FULLSTACK_CHECKLIST = [
  {
    icon: Server,
    label: "Private server",
    detail: "Your own isolated runtime — no shared hosting",
  },
  {
    icon: Database,
    label: "Postgres database",
    detail: "A dedicated Neon Postgres project, auto-provisioned",
  },
  {
    icon: KeyRound,
    label: "Secret management",
    detail: "DATABASE_URL and custom secrets, encrypted at rest",
  },
  {
    icon: Rocket,
    label: "Production pipeline",
    detail: "Staging review + one-click promote to production",
  },
];

type PlatformTab = "web" | "mobile";
type AppMode = "simple" | "fullstack";

type WebProjectKind = (typeof WEB_PROJECT_TYPES)[number]["kind"];
type MobileProjectKind = "mobile-cross";
type ProjectKind = WebProjectKind | MobileProjectKind;

type View = "form" | "templates";

function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isMobileKind(k: string): boolean {
  return k === "mobile-cross" || k === "mobile-ios" || k === "mobile-android";
}

export default function NewProjectPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { currentWorkspace } = useWorkspace();
  const { toast } = useToast();

  // Read pre-fill hints from the URL (?prompt=…&platform=web|mobile) so the
  // dashboard hero and other entry points can hand off a typed idea.
  const initialParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const initialPrompt = initialParams.get("prompt") ?? "";
  const initialPlatform: PlatformTab =
    initialParams.get("platform") === "mobile" ? "mobile" : "web";

  const [view, setView] = useState<View>("form");
  const [platformTab, setPlatformTab] = useState<PlatformTab>(initialPlatform);
  const [stack, setStack] = useState<Stack>("react-vite");
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [kind, setKind] = useState<ProjectKind>(
    initialPlatform === "mobile" ? "mobile-cross" : "web",
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [appMode, setAppMode] = useState<AppMode>("simple");
  const [checklistOpen, setChecklistOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | undefined>(
    undefined,
  );

  // Strip the query params from the URL once consumed so a refresh starts clean.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.search) {
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

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
    setStack("react-vite");
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
    const builderMode = appMode === "fullstack" ? "agentic" : "static-legacy";

    createProject.mutate(
      {
        data: {
          name: resolvedName,
          description: prompt.trim() || undefined,
          workspaceId: currentWorkspace?.id,
          kind: kind as Parameters<typeof createProject.mutate>[0]["data"]["kind"],
          stack: platformTab === "web" ? (stack as ProjectInputStack) : undefined,
          initialPrompt: prompt.trim() || undefined,
          builderMode,
        },
      },
      {
        onSuccess: (project) => {
          queryClient.setQueryData(getGetProjectQueryKey(project.id), project);
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/projects/${project.id}`);
        },
        onError: (err: unknown) => {
          const message =
            err instanceof Error && err.message
              ? err.message
              : "Could not create your project. Please try again.";
          toast({
            title: "Couldn't create project",
            description: message,
            variant: "destructive",
          });
        },
      },
    );
  }

  const templateCount = platformTab === "mobile" ? "6 mobile templates" : "16 templates";

  if (view === "templates") {
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <button
          type="button"
          onClick={() => setView("form")}
          className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
          Back to project details
        </button>
        <h1 className="mb-1 text-2xl font-bold tracking-tight">Choose a template</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          Pick a recommended starting point, or start from scratch.
        </p>
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
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-8">
      {/* Page header */}
      <button
        type="button"
        onClick={() => setLocation("/projects")}
        className="mb-6 inline-flex items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to projects
      </button>

      <div className="mb-7">
        <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Create a new project</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Give your project a name and choose what you&apos;re building. You can refine everything
          later in the workspace.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="flex flex-col gap-6">
        {/* Project name — the primary field, up top */}
        <div className="space-y-1.5">
          <Label htmlFor="np-name">Project name</Label>
          <Input
            id="np-name"
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
                    : stack === "python-flask" || stack === "python-fastapi"
                      ? "My Python API"
                      : stack === "node-api"
                        ? "My Node.js API"
                        : stack === "go-gin"
                          ? "My Go API"
                          : "My web app"
            }
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            Leave blank to auto-generate from your prompt.
          </p>
        </div>

        {/* ── App mode selector — web only ── */}
        {platformTab === "web" && (
          <div className="space-y-2">
            <Label>What do you want to build?</Label>
            <div className="grid grid-cols-2 gap-3">
              {/* Simple app */}
              <button
                type="button"
                onClick={() => setAppMode("simple")}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-3.5 text-left transition-all",
                  appMode === "simple"
                    ? "border-primary bg-primary/8 ring-1 ring-primary/20"
                    : "border-border bg-card hover:bg-muted hover:border-border/80",
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                      appMode === "simple" ? "bg-primary/15" : "bg-muted",
                    )}
                  >
                    <Zap
                      className={cn(
                        "h-4 w-4",
                        appMode === "simple" ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold",
                      appMode === "simple" ? "text-primary" : "text-foreground",
                    )}
                  >
                    Simple app
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Static site or client-only app. Ready instantly — no server setup.
                </p>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <Clock className="h-3 w-3 shrink-0" />
                  Builds in seconds
                </div>
              </button>

              {/* Full-stack app */}
              <button
                type="button"
                onClick={() => setAppMode("fullstack")}
                className={cn(
                  "flex flex-col gap-2 rounded-xl border p-3.5 text-left transition-all",
                  appMode === "fullstack"
                    ? "border-primary bg-primary/8 ring-1 ring-primary/20"
                    : "border-border bg-card hover:bg-muted hover:border-border/80",
                )}
              >
                <div className="flex items-center gap-2">
                  <div
                    className={cn(
                      "flex h-8 w-8 items-center justify-center rounded-lg shrink-0",
                      appMode === "fullstack" ? "bg-primary/15" : "bg-muted",
                    )}
                  >
                    <Cpu
                      className={cn(
                        "h-4 w-4",
                        appMode === "fullstack" ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                  </div>
                  <span
                    className={cn(
                      "text-sm font-semibold",
                      appMode === "fullstack" ? "text-primary" : "text-foreground",
                    )}
                  >
                    Full-stack app
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Real server + Postgres database. Ideal for APIs, auth, and data-driven apps.
                </p>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <Clock className="h-3 w-3 shrink-0" />
                  ~1 min setup
                </div>
              </button>
            </div>

            {/* Full-stack checklist */}
            {appMode === "fullstack" && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setChecklistOpen((v) => !v)}
                  className="w-full flex items-center justify-between gap-2 px-3.5 py-2.5 text-sm font-medium text-primary hover:bg-primary/8 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                    What gets set up automatically
                  </div>
                  <ChevronDown
                    className={cn(
                      "h-4 w-4 shrink-0 transition-transform duration-200",
                      checklistOpen && "rotate-180",
                    )}
                  />
                </button>
                {checklistOpen && (
                  <div className="px-3.5 pb-3.5 pt-1 space-y-2.5 border-t border-primary/10">
                    {FULLSTACK_CHECKLIST.map(({ icon: Icon, label, detail }) => (
                      <div key={label} className="flex items-start gap-2.5">
                        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-primary/10 shrink-0 mt-0.5">
                          <Icon className="h-3.5 w-3.5 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-[12px] font-semibold text-foreground">{label}</div>
                          <div className="text-[11px] text-muted-foreground leading-snug">
                            {detail}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
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
              Generates iOS + Android source code with a web preview. Scan the QR code with Expo Go
              to run on your device.
            </div>
          </div>
        )}

        {/* Recommended choices — template selector strip */}
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

        {/* Project type — web only; mobile is always mobile-cross */}
        {platformTab === "web" && (
          <div className="space-y-1.5">
            <Label>Project type</Label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
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
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {MOBILE_PROJECT_TYPES.map(({ label, icon: Icon }, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => setKind("mobile-cross")}
                  className={cn(
                    "flex flex-col items-center gap-1.5 rounded-xl border px-2 py-3 text-[11px] font-medium transition-colors",
                    kind === "mobile-cross" && i === 0
                      ? "border-primary bg-primary/10 text-primary"
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
          <Label htmlFor="np-prompt">
            {selectedTemplate ? "Prompt (from template — edit freely)" : "First prompt (optional)"}
          </Label>
          <Textarea
            id="np-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              platformTab === "mobile"
                ? "Describe your mobile app — e.g. A fitness tracker with workout logging, progress charts, and a home screen dashboard."
                : appMode === "fullstack"
                  ? "Describe your full-stack app — e.g. A task manager with user accounts, a REST API, and a Postgres database for storing tasks."
                  : stack === "python-flask" || stack === "python-fastapi"
                    ? "Describe your Python API — e.g. A REST API for a task management system with user authentication and CRUD endpoints."
                    : stack === "node-api"
                      ? "Describe your Node.js API — e.g. An Express REST API for a recipe book with search, categories, and user bookmarks."
                      : stack === "go-gin"
                        ? "Describe your Go API — e.g. A REST API for a URL shortener with Gin, in-memory store, and JSON responses."
                        : "Describe what you want to build — e.g. A landing page for a local towing company with a hero section, services, and contact form."
            }
            rows={selectedTemplate ? 5 : 4}
            className="resize-none"
          />
          <p className="text-xs text-muted-foreground">
            {selectedTemplate
              ? "This seed prompt is pre-filled from the template. You can refine it before building."
              : appMode === "fullstack"
                ? "The AI will plan, build, and test your app. A server and database are provisioned automatically."
                : "If provided, the AI builder will start building immediately after you create the project."}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 border-t border-border pt-5">
          <Button
            type="button"
            variant="outline"
            onClick={() => setLocation("/projects")}
            disabled={createProject.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={createProject.isPending} className="gap-2">
            <Rocket className="h-4 w-4" />
            {createProject.isPending
              ? "Starting…"
              : appMode === "fullstack"
                ? "Start full-stack project"
                : "Start project"}
          </Button>
        </div>
      </form>
    </div>
  );
}
