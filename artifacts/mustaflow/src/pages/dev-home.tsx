import { useState, useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import {
  useListProjects,
  useCreateProject,
  getListProjectsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { SlideOutNav } from "@/components/layout/slide-out-nav";
import {
  SendHorizonal,
  Clock,
  Plus,
  Code2,
  Globe2,
  Server,
  Layers,
  Terminal,
  Smartphone,
  FileCode2,
  Zap,
  RefreshCw,
} from "lucide-react";

const EXAMPLE_PROMPTS = [
  "A REST API for a task manager with user auth and JWT",
  "A real-time chat server with WebSocket rooms and presence",
  "A React dashboard for monitoring server metrics",
  "A Python web scraper with async job queue and SQLite storage",
  "A Go microservice with gRPC and PostgreSQL",
  "A Next.js blog with MDX, search, and RSS feed",
];

const TEMPLATE_CHIPS: Array<{
  label: string;
  stack: string;
  kind: string;
  icon: React.ComponentType<{ className?: string }>;
  description: string;
}> = [
  { label: "React", stack: "react-vite", kind: "web", icon: Layers, description: "React + Vite" },
  {
    label: "Node.js",
    stack: "node-api",
    kind: "web",
    icon: Server,
    description: "Express + TypeScript",
  },
  {
    label: "Python",
    stack: "python-flask",
    kind: "web",
    icon: FileCode2,
    description: "Flask REST API",
  },
  { label: "Next.js", stack: "nextjs", kind: "web", icon: Globe2, description: "Full-stack React" },
  { label: "Go", stack: "go-gin", kind: "web", icon: Terminal, description: "Gin REST API" },
  {
    label: "Mobile",
    stack: "react-vite",
    kind: "mobile-cross",
    icon: Smartphone,
    description: "Expo / React Native",
  },
  {
    label: "FastAPI",
    stack: "python-fastapi",
    kind: "web",
    icon: Zap,
    description: "Async Python API",
  },
  { label: "Blank", stack: "react-vite", kind: "web", icon: Code2, description: "Empty project" },
];

const STACKS = [
  { value: "react-vite", label: "React + Vite", description: "Static web app", icon: Layers },
  { value: "nextjs", label: "Next.js 14", description: "App Router + SSR", icon: Globe2 },
  { value: "node-api", label: "Node.js API", description: "Express + TypeScript", icon: Server },
  { value: "python-flask", label: "Python Flask", description: "REST API / web", icon: FileCode2 },
  { value: "python-fastapi", label: "FastAPI", description: "Async Python API", icon: Zap },
  { value: "go-gin", label: "Go + Gin", description: "Go REST API", icon: Terminal },
];

function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface DevCreateModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt?: string;
  initialStack?: string;
  initialKind?: string;
}

function DevCreateModal({
  open,
  onOpenChange,
  initialPrompt = "",
  initialStack = "react-vite",
  initialKind = "web",
}: DevCreateModalProps) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [stack, setStack] = useState(initialStack);
  const [kind, setKind] = useState(initialKind);

  useEffect(() => {
    if (open) {
      setName("");
      setPrompt(initialPrompt);
      setStack(initialStack);
      setKind(initialKind);
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const resolvedName = name.trim() || (prompt.trim() ? nameFromPrompt(prompt) : "New Project");

    createProject.mutate(
      {
        data: {
          name: resolvedName,
          description: prompt.trim() || undefined,
          kind: kind as Parameters<typeof createProject.mutate>[0]["data"]["kind"],
          stack:
            kind === "mobile-cross"
              ? undefined
              : (stack as Parameters<typeof createProject.mutate>[0]["data"]["stack"]),
          initialPrompt: prompt.trim() || undefined,
          mode: "developer",
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          onOpenChange(false);
          setLocation(`/dev/workspace/${project.id}`);
        },
        onError: (err: unknown) => {
          const message =
            err instanceof Error ? err.message : "Could not create your project. Please try again.";
          toast({ title: "Couldn't create project", description: message, variant: "destructive" });
        },
      },
    );
  }

  const isMobile = kind === "mobile-cross";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create new project</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-5 pt-1">
          <div className="flex flex-col gap-5 max-h-[60vh] overflow-y-auto pr-1">
            {/* Stack selector */}
            {!isMobile && (
              <div className="space-y-1.5">
                <Label>Stack</Label>
                <div className="grid grid-cols-3 gap-2">
                  {STACKS.map((opt) => {
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          setStack(opt.value);
                          setKind("web");
                        }}
                        className={cn(
                          "flex flex-col items-center gap-1 rounded-xl border px-2 py-3 text-[11px] font-medium transition-colors text-center",
                          stack === opt.value
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        <span className="leading-tight">{opt.label}</span>
                        <span
                          className={cn(
                            "text-[9px] font-normal leading-tight",
                            stack === opt.value ? "text-primary/70" : "text-muted-foreground/60",
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

            {isMobile && (
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs text-blue-400">
                <Smartphone className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                <div>
                  <span className="font-medium">Expo / React Native</span>
                  {" — "}
                  Generates iOS + Android source code. Scan the QR code with Expo Go to run on
                  device.
                </div>
              </div>
            )}

            {/* Project name */}
            <div className="space-y-1.5">
              <Label htmlFor="dev-cp-name">Project name</Label>
              <Input
                id="dev-cp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={prompt.trim() ? nameFromPrompt(prompt) : "My project"}
                autoFocus
              />
            </div>

            {/* Prompt */}
            <div className="space-y-1.5">
              <Label htmlFor="dev-cp-prompt">Description (optional)</Label>
              <textarea
                id="dev-cp-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Briefly describe what this project does..."
                rows={3}
                className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-none"
              />
            </div>
          </div>

          <DialogFooter>
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
      </DialogContent>
    </Dialog>
  );
}

function CreationZone({
  onSubmit,
  onChipClick,
}: {
  onSubmit: (prompt: string) => void;
  onChipClick: (chip: (typeof TEMPLATE_CHIPS)[number]) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [exampleIndex, setExampleIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleSubmit() {
    if (!prompt.trim()) return;
    onSubmit(prompt.trim());
  }

  function rotateExample() {
    setExampleIndex((i) => (i + 1) % EXAMPLE_PROMPTS.length);
  }

  function applyExample() {
    setPrompt(EXAMPLE_PROMPTS[exampleIndex] ?? "");
    inputRef.current?.focus();
  }

  return (
    <div className="flex flex-col items-center gap-6 w-full max-w-2xl mx-auto">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight mb-1">What do you want to build?</h1>
        <p className="text-sm text-muted-foreground">Describe your project or pick a stack below</p>
      </div>

      {/* Prompt input */}
      <div className="flex items-center gap-2 w-full">
        <div className="flex-1 relative">
          <Input
            ref={inputRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmit();
            }}
            placeholder="A REST API for a task manager with user auth..."
            className="h-12 text-base pr-4"
          />
        </div>
        <Button
          onClick={handleSubmit}
          disabled={!prompt.trim()}
          size="lg"
          className="h-12 px-5 shrink-0"
        >
          <SendHorizonal className="h-4 w-4" />
        </Button>
      </div>

      {/* Example prompt */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Try:</span>
        <button
          type="button"
          onClick={applyExample}
          className="text-primary hover:underline text-left"
        >
          "{EXAMPLE_PROMPTS[exampleIndex]}"
        </button>
        <button
          type="button"
          onClick={rotateExample}
          className="text-muted-foreground hover:text-foreground transition-colors"
          aria-label="Next example"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      {/* Template chips */}
      <div className="flex items-center gap-2 flex-wrap justify-center">
        {TEMPLATE_CHIPS.map((chip) => {
          const Icon = chip.icon;
          return (
            <button
              key={chip.label}
              type="button"
              onClick={() => onChipClick(chip)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-border bg-card text-sm text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-muted transition-colors font-medium"
            >
              <Icon className="h-3.5 w-3.5" />
              {chip.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ProjectCard({
  project,
}: {
  project: {
    id: number;
    name: string;
    stack?: string | null;
    status: string;
    updatedAt: string;
    kind: string;
  };
}) {
  const StackIcon =
    TEMPLATE_CHIPS.find(
      (c) =>
        c.stack === project.stack || (project.kind === "mobile-cross" && c.kind === "mobile-cross"),
    )?.icon ?? Code2;

  return (
    <Link href={`/dev/workspace/${project.id}`}>
      <div className="group flex flex-col gap-2 rounded-xl border border-border bg-card p-4 hover:border-primary/40 hover:bg-muted/30 transition-all cursor-pointer h-full">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center justify-center h-9 w-9 rounded-lg border border-border bg-muted shrink-0 text-muted-foreground group-hover:text-foreground transition-colors">
            <StackIcon className="h-4.5 w-4.5 h-[18px] w-[18px]" />
          </div>
          <span
            className={cn(
              "text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0",
              project.status === "published"
                ? "text-green-400 bg-green-500/10 border-green-500/20"
                : project.status === "building"
                  ? "text-yellow-400 bg-yellow-500/10 border-yellow-500/20"
                  : "text-muted-foreground bg-muted border-border",
            )}
          >
            {project.status}
          </span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold truncate text-foreground">{project.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
            <Clock className="h-3 w-3 shrink-0" />
            {new Date(project.updatedAt).toLocaleDateString()}
          </p>
        </div>
      </div>
    </Link>
  );
}

export default function DevHomePage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { toast } = useToast();

  const { data: projects, isLoading } = useListProjects({ mode: "developer" });

  const [modalOpen, setModalOpen] = useState(false);
  const [modalPrompt, setModalPrompt] = useState("");
  const [modalStack, setModalStack] = useState("react-vite");
  const [modalKind, setModalKind] = useState("web");

  function _openModalWithPrompt(prompt: string) {
    setModalPrompt(prompt);
    setModalStack("react-vite");
    setModalKind("web");
    setModalOpen(true);
  }

  function openModalWithChip(chip: (typeof TEMPLATE_CHIPS)[number]) {
    setModalPrompt("");
    setModalStack(chip.stack);
    setModalKind(chip.kind);
    setModalOpen(true);
  }

  function handleQuickCreate(prompt: string) {
    const resolvedName = nameFromPrompt(prompt);
    createProject.mutate(
      {
        data: {
          name: resolvedName,
          description: prompt,
          kind: "web",
          stack: "react-vite",
          initialPrompt: prompt,
          mode: "developer",
        },
      },
      {
        onSuccess: (project) => {
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          setLocation(`/dev/workspace/${project.id}`);
        },
        onError: (err: unknown) => {
          const message = err instanceof Error ? err.message : "Could not create project.";
          toast({ title: "Couldn't create project", description: message, variant: "destructive" });
        },
      },
    );
  }

  return (
    <div className="h-screen bg-background text-foreground w-full overflow-hidden">
      <SlideOutNav />

      <main className="h-full w-full overflow-y-auto pl-14 pt-3">
        <div className="min-h-full flex flex-col">
          {/* Creation zone — centered in the top portion */}
          <div className="flex items-center justify-center px-6 pt-16 pb-12">
            <CreationZone onSubmit={handleQuickCreate} onChipClick={openModalWithChip} />
          </div>

          {/* Project grid */}
          <div className="flex-1 px-6 pb-12 max-w-6xl mx-auto w-full">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-base font-semibold text-foreground">
                {projects && projects.length > 0 ? "Your projects" : "No projects yet"}
              </h2>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openModalWithChip(TEMPLATE_CHIPS[0]!)}
                className="gap-1.5 text-xs h-8"
              >
                <Plus className="h-3.5 w-3.5" />
                Create project
              </Button>
            </div>

            {isLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-28 rounded-xl border border-border bg-muted/20 animate-pulse"
                  />
                ))}
              </div>
            ) : projects && projects.length > 0 ? (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                {/* Create card */}
                <button
                  type="button"
                  onClick={() => openModalWithChip(TEMPLATE_CHIPS[0]!)}
                  className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/40 p-4 text-muted-foreground hover:border-primary/40 hover:text-foreground hover:bg-muted/30 transition-all h-full min-h-[7rem]"
                >
                  <Plus className="h-6 w-6" />
                  <span className="text-xs font-medium">New project</span>
                </button>

                {projects.map((project) => (
                  <ProjectCard key={project.id} project={project} />
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-border bg-card/30 px-8 py-14 text-center max-w-md mx-auto">
                <Code2 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
                <h3 className="text-sm font-semibold text-foreground mb-1">No projects yet</h3>
                <p className="text-xs text-muted-foreground mb-5">
                  Describe what you want to build above, or pick a stack to get started.
                </p>
                <Button
                  size="sm"
                  onClick={() => openModalWithChip(TEMPLATE_CHIPS[0]!)}
                  className="gap-2"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Create your first project
                </Button>
              </div>
            )}
          </div>
        </div>
      </main>

      <DevCreateModal
        open={modalOpen}
        onOpenChange={setModalOpen}
        initialPrompt={modalPrompt}
        initialStack={modalStack}
        initialKind={modalKind}
      />
    </div>
  );
}
