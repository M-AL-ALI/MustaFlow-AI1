import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Blocks,
  BookOpen,
  BrainCircuit,
  CheckCircle2,
  Code2,
  Cpu,
  Database,
  Github,
  Globe,
  HeartPulse,
  Image,
  KeyRound,
  ListChecks,
  Map,
  MessageSquare,
  Monitor,
  Paintbrush,
  Plug,
  Puzzle,
  Rocket,
  RotateCcw,
  Settings,
  ShieldCheck,
  TerminalSquare,
  Workflow,
  Wrench,
} from "lucide-react";
import {
  WORKSPACE_TOOL_CATEGORIES,
  WORKSPACE_TOOLS,
  type WorkspaceToolId,
  type WorkspaceToolOpen,
} from "@workspace/nabuflow-workspace-tools";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { DialogDescription, DialogTitle } from "@/components/ui/dialog";

type CommandCenterProps = {
  open: boolean;
  onClose: () => void;
  onNavigate: (target: WorkspaceToolOpen) => void;
  isPublished: boolean;
};

const TOOL_ICONS = {
  preview: Monitor,
  "page-map": Globe,
  plan: ListChecks,
  images: Image,
  code: Code2,
  recipes: Puzzle,
  workflows: Workflow,
  publishing: Rocket,
  terminal: TerminalSquare,
  logs: Wrench,
  canvas: Paintbrush,
  "activity-log": Activity,
  integrations: Plug,
  git: Github,
  database: Database,
  comments: MessageSquare,
  manage: Settings,
  secrets: KeyRound,
  "tools-files": Blocks,
  knowledge: BrainCircuit,
  runtime: Cpu,
  resources: BookOpen,
  checkpoints: RotateCcw,
  checks: CheckCircle2,
  security: ShieldCheck,
  health: HeartPulse,
  analytics: Map,
} satisfies Record<WorkspaceToolId, typeof Monitor>;

export function CommandPalette({ open, onClose, onNavigate, isPublished }: CommandCenterProps) {
  const [query, setQuery] = useState("");
  const visibleTools = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return WORKSPACE_TOOLS.filter((tool) => {
      const isAvailable =
        tool.availability === "always" || (tool.availability === "published" && isPublished);
      if (!isAvailable) return false;
      if (!normalizedQuery) return true;
      return `${tool.name} ${tool.description} ${tool.category}`
        .toLocaleLowerCase()
        .includes(normalizedQuery);
    });
  }, [isPublished, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  return (
    <CommandDialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <div className="border-b border-border px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <DialogTitle className="text-sm font-semibold text-foreground">
              Command Center
            </DialogTitle>
            <DialogDescription className="mt-0.5 text-xs text-muted-foreground">
              Find everything you can use in this project.
            </DialogDescription>
          </div>
          <kbd className="rounded border border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground">
            Ctrl K
          </kbd>
        </div>
      </div>
      <CommandInput
        aria-label="Search project tools"
        placeholder="Search tools..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(65vh,520px)] p-2">
        <CommandEmpty>No matching tool found.</CommandEmpty>
        {WORKSPACE_TOOL_CATEGORIES.map((category) => {
          const categoryTools = visibleTools.filter((tool) => tool.category === category);
          if (categoryTools.length === 0) return null;
          return (
            <CommandGroup key={category} heading={category}>
              {categoryTools.map((tool) => {
                const Icon = TOOL_ICONS[tool.id];
                return (
                  <CommandItem
                    key={tool.id}
                    value={`${tool.name} ${tool.description} ${tool.category}`}
                    onSelect={() => {
                      onNavigate(tool.open);
                      onClose();
                    }}
                    className="items-start gap-3 px-3 py-2.5"
                  >
                    <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40 text-muted-foreground">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-medium text-foreground">{tool.name}</span>
                      <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
                        {tool.description}
                      </span>
                    </span>
                    {tool.placement === "primary" && (
                      <CommandShortcut className="normal-case tracking-normal">
                        Always visible
                      </CommandShortcut>
                    )}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
