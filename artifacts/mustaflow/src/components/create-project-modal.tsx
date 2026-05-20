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
import { useCreateProject, getListProjectsQueryKey } from "@workspace/api-client-react";
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
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TemplatePicker } from "@/components/template-picker";
import { type TemplateDefinition } from "@/lib/templates";

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
  const [name, setName] = useState("");
  const [nameDirty, setNameDirty] = useState(false);
  const [kind, setKind] = useState<ProjectKind>("web");
  const [prompt, setPrompt] = useState(initialPrompt);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateDefinition | undefined>(
    initialTemplate,
  );

  useEffect(() => {
    if (!open) return;
    setView("form");
    setNameDirty(false);
    if (initialTemplate) {
      setSelectedTemplate(initialTemplate);
      setName(initialTemplate.title);
      setPrompt(initialTemplate.seedPrompt);
      const templateKind = initialTemplate.projectKind as ProjectKind;
      setKind(templateKind);
      setPlatformTab(isMobileKind(templateKind) ? "mobile" : "web");
    } else {
      setSelectedTemplate(undefined);
      setName("");
      setPrompt(initialPrompt);
      setKind("web");
      setPlatformTab("web");
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
                  <span className="text-[10px] font-normal px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400 leading-none">
                    React + Vite
                  </span>
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
                          : "My towing company site"
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
