import { useState } from "react";
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
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspace } from "@/contexts/workspace-context";
import {
  Monitor,
  LayoutDashboard,
  Zap,
  Database,
  Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";

const PROJECT_TYPES = [
  { label: "Website", kind: "web", icon: Monitor },
  { label: "Web App", kind: "fullstack", icon: Globe },
  { label: "Dashboard", kind: "dashboard", icon: LayoutDashboard },
  { label: "Automation", kind: "automation", icon: Zap },
  { label: "API", kind: "api", icon: Database },
] as const;

type ProjectKind = (typeof PROJECT_TYPES)[number]["kind"];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-fill the first-prompt field (e.g. when triggered from home page). */
  initialPrompt?: string;
}

/** Derive a short project name from a prompt string (first 5 significant words). */
function nameFromPrompt(prompt: string): string {
  const words = prompt.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function CreateProjectModal({ open, onOpenChange, initialPrompt = "" }: Props) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const createProject = useCreateProject();
  const { currentWorkspace } = useWorkspace();

  const [name, setName] = useState("");
  const [kind, setKind] = useState<ProjectKind>("web");
  const [prompt, setPrompt] = useState(initialPrompt);

  // Reset form when modal opens
  function handleOpenChange(val: boolean) {
    if (val) {
      setName("");
      setKind("web");
      setPrompt(initialPrompt);
    }
    onOpenChange(val);
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

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create new project</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-5 pt-1">
          {/* Project name */}
          <div className="space-y-1.5">
            <Label htmlFor="cp-name">Project name</Label>
            <Input
              id="cp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={prompt.trim() ? nameFromPrompt(prompt) : "My towing company site"}
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to auto-generate from your prompt.
            </p>
          </div>

          {/* Project type */}
          <div className="space-y-1.5">
            <Label>Project type</Label>
            <div className="grid grid-cols-5 gap-2">
              {PROJECT_TYPES.map(({ label, kind: k, icon: Icon }) => (
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

          {/* First prompt */}
          <div className="space-y-1.5">
            <Label htmlFor="cp-prompt">First prompt (optional)</Label>
            <Textarea
              id="cp-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe what you want to build — e.g. A landing page for a local towing company with a hero section, services, and contact form."
              rows={3}
              className="resize-none"
            />
            <p className="text-xs text-muted-foreground">
              If provided, the AI builder will start building immediately after you create the project.
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
      </DialogContent>
    </Dialog>
  );
}
