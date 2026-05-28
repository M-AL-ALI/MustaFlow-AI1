import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { useUser } from "@clerk/react";
import { cn } from "@/lib/utils";
import {
  Play,
  Square,
  Loader2,
  ExternalLink,
  Rocket,
  PanelLeft,
  PanelRight,
  Maximize2,
  SplitSquareHorizontal,
  Settings,
  X,
  Moon,
  Keyboard,
  Info,
  ChevronRight,
  FolderOpen,
  Search,
  Layers,
  Wrench,
  Lock,
  Package,
  GitBranch,
  Database,
  Boxes,
  Gauge,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { DynamicAtom } from "@/components/icons/dynamic-atom";
import logoUrl from "/logo.png";
import type { PanelId } from "./icon-rail";

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

export type PaneLayout = "default" | "editor-max" | "preview-max" | "editor-split";

interface TopBarProps {
  projectId: number;
  projectName: string;
  containerStatus: ContainerStatus;
  isStarting: boolean;
  onStartContainer: () => void;
  onStopContainer: () => void;
  onNameChange: (name: string) => void;
  onOpenNewTab: () => void;
  paneLayout: PaneLayout;
  onPaneLayout: (layout: PaneLayout) => void;
  onDeploy?: () => void;
  onPanelOpen?: (panel: PanelId) => void;
}

// All panels available in the icon rail
const PANEL_NAV: Array<{
  id: PanelId;
  label: string;
  description: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "files", label: "Files", description: "Browse and open project files", icon: FolderOpen },
  { id: "search", label: "Search", description: "Full-text search across files", icon: Search },
  {
    id: "zero-agent",
    label: "Zero Agent",
    description: "AI assistant chat panel",
    icon: DynamicAtom,
  },
  { id: "canvas", label: "Canvas", description: "Visual design canvas", icon: Layers },
  { id: "tools", label: "Tools", description: "All workspace tools", icon: Wrench },
  { id: "secrets", label: "Secrets", description: "Environment variables & secrets", icon: Lock },
  { id: "packages", label: "Packages", description: "Manage dependencies", icon: Package },
  { id: "git", label: "Version Control", description: "Git history & branches", icon: GitBranch },
  {
    id: "database",
    label: "Database",
    description: "Query and manage the database",
    icon: Database,
  },
  {
    id: "storage",
    label: "Object Storage",
    description: "Files and assets in the cloud",
    icon: Boxes,
  },
  {
    id: "resources",
    label: "Resources",
    description: "CPU, memory, container status",
    icon: Gauge,
  },
];

function SettingsDrawer({
  open,
  onClose,
  onPanelOpen,
}: {
  open: boolean;
  onClose: () => void;
  onPanelOpen?: (panel: PanelId) => void;
}) {
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open, onClose]);

  const settingsItems = [
    {
      icon: Keyboard,
      label: "Keyboard shortcuts",
      description: "View all shortcuts",
    },
    {
      icon: Moon,
      label: "Appearance",
      description: "Dark mode (default)",
    },
    {
      icon: Info,
      label: "About MustaFlow",
      description: "Version & documentation",
    },
  ];

  return (
    <>
      {open && <div className="fixed inset-0 z-40 pointer-events-none" />}
      <div
        ref={drawerRef}
        className={cn(
          "fixed left-0 top-11 bottom-0 z-50 w-64 bg-zinc-950 border-r border-border flex flex-col shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <img src={logoUrl} alt="MustaFlow AI" className="h-6 w-auto object-contain" />
            <span className="text-xs font-semibold text-foreground">Settings</span>
          </div>
          <button
            onClick={onClose}
            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto py-2">
          {/* Back to projects */}
          <div className="px-3 pb-1">
            <p className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
              Developer Mode
            </p>
            <Link
              href="/dev"
              onClick={onClose}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors no-underline"
            >
              <span>Back to projects</span>
              <ChevronRight className="h-3 w-3 opacity-40" />
            </Link>
          </div>

          {/* Panels — all icon-rail items */}
          <div className="px-3 pt-2">
            <p className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
              Panels
            </p>
            {PANEL_NAV.map(({ id, label, description, icon: Icon }) => (
              <button
                key={id}
                onClick={() => {
                  onPanelOpen?.(id);
                  onClose();
                }}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/60 transition-colors group"
              >
                <div className="h-7 w-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <div className="text-left min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{label}</p>
                  <p className="text-[10px] text-muted-foreground/60 truncate">{description}</p>
                </div>
              </button>
            ))}
          </div>

          {/* Workspace settings */}
          <div className="px-3 pt-3">
            <p className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
              Workspace
            </p>
            {settingsItems.map(({ icon: Icon, label, description }) => (
              <button
                key={label}
                onClick={onClose}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/60 transition-colors group"
              >
                <div className="h-7 w-7 rounded-md bg-muted border border-border flex items-center justify-center shrink-0 group-hover:border-primary/30 transition-colors">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground group-hover:text-foreground" />
                </div>
                <div className="text-left min-w-0">
                  <p className="text-xs font-medium text-foreground truncate">{label}</p>
                  <p className="text-[10px] text-muted-foreground/60 truncate">{description}</p>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-border shrink-0">
          <p className="text-[9px] text-muted-foreground/40 text-center">
            MustaFlow AI · Developer Mode
          </p>
        </div>
      </div>
    </>
  );
}

export function TopBar({
  projectId,
  projectName,
  containerStatus,
  isStarting,
  onStartContainer,
  onStopContainer,
  onNameChange,
  onOpenNewTab,
  paneLayout,
  onPaneLayout,
  onDeploy,
  onPanelOpen,
}: TopBarProps) {
  const { user } = useUser();
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(projectName);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setNameValue(projectName);
  }, [projectName]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const commitName = () => {
    setEditingName(false);
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== projectName) {
      onNameChange(trimmed);
    } else {
      setNameValue(projectName);
    }
  };

  const isRunning = containerStatus === "running";
  const isLoading = containerStatus === "starting" || isStarting;

  const paneControls: Array<{
    id: PaneLayout;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
  }> = [
    { id: "default", label: "Default layout", icon: SplitSquareHorizontal },
    { id: "editor-max", label: "Maximise editor", icon: Maximize2 },
    { id: "preview-max", label: "Maximise preview", icon: PanelRight },
    { id: "editor-split", label: "Toggle left panel", icon: PanelLeft },
  ];

  return (
    <>
      <SettingsDrawer
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onPanelOpen={onPanelOpen}
      />

      <header className="flex items-center h-11 px-3 gap-2 bg-zinc-950 border-b border-border shrink-0 z-20">
        {/* MustaFlow logo — click to open settings drawer */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              className={cn(
                "flex items-center justify-center h-8 px-1.5 rounded-lg border transition-colors cursor-pointer shrink-0",
                settingsOpen
                  ? "bg-primary/15 border-primary/30"
                  : "bg-primary/10 border-primary/20 hover:bg-primary/20",
              )}
              aria-label="Open settings"
            >
              <img src={logoUrl} alt="MustaFlow AI" className="h-5 w-auto object-contain" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Settings & panels</TooltipContent>
        </Tooltip>

        <div className="w-px h-5 bg-border mx-1 shrink-0" />

        {/* Editable project name */}
        {editingName ? (
          <input
            ref={nameInputRef}
            value={nameValue}
            onChange={(e) => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setEditingName(false);
                setNameValue(projectName);
              }
            }}
            className="text-sm font-medium bg-muted border border-primary/40 rounded px-2 py-0.5 text-foreground outline-none focus:ring-1 focus:ring-primary min-w-0 max-w-[200px]"
            spellCheck={false}
          />
        ) : (
          <button
            onClick={() => setEditingName(true)}
            className="text-sm font-medium text-foreground hover:text-primary transition-colors truncate max-w-[200px] text-left"
            title="Click to rename"
          >
            {projectName}
          </button>
        )}

        <div className="flex-1" />

        {/* Pane layout controls */}
        <div className="flex items-center gap-0.5 border border-border rounded-md p-0.5">
          {paneControls.map(({ id, label, icon: Icon }) => (
            <Tooltip key={id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onPaneLayout(id === paneLayout ? "default" : id)}
                  className={cn(
                    "flex items-center justify-center h-6 w-6 rounded transition-colors",
                    paneLayout === id
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>
          ))}
        </div>

        <div className="w-px h-5 bg-border mx-1 shrink-0" />

        {/* Run / Stop */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="sm"
              onClick={isRunning ? onStopContainer : onStartContainer}
              disabled={isLoading}
              className={cn(
                "h-7 px-3 gap-1.5 text-xs font-semibold",
                isRunning
                  ? "bg-red-600 hover:bg-red-700 text-white border-0"
                  : "bg-green-600 hover:bg-green-700 text-white border-0",
              )}
            >
              {isLoading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : isRunning ? (
                <Square className="h-3.5 w-3.5 fill-current" />
              ) : (
                <Play className="h-3.5 w-3.5 fill-current" />
              )}
              {isLoading ? "Starting…" : isRunning ? "Stop" : "Run"}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {isRunning ? "Stop the running container" : "Start the project container"}
          </TooltipContent>
        </Tooltip>

        {/* Deploy */}
        <Tooltip>
          <TooltipTrigger asChild>
            {onDeploy ? (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 gap-1.5 text-xs"
                onClick={onDeploy}
              >
                <Rocket className="h-3.5 w-3.5" />
                Deploy
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline" className="h-7 px-3 gap-1.5 text-xs">
                <Link href={`/projects/${projectId}`}>
                  <Rocket className="h-3.5 w-3.5" />
                  Deploy
                </Link>
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent>Open deployment panel</TooltipContent>
        </Tooltip>

        {/* How it works */}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                  <Info className="h-4 w-4" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>How Developer Mode works</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-80 p-0 bg-zinc-900 border-border text-sm">
            <div className="px-4 py-3 border-b border-border">
              <p className="font-semibold text-foreground">How Developer Mode works</p>
              <p className="text-xs text-muted-foreground mt-0.5">From prompt to live preview</p>
            </div>
            <ol className="px-4 py-3 space-y-3">
              {[
                {
                  label: "Context assembly",
                  detail:
                    "Your text, the full file tree, conversation history, tool definitions, and the system prompt are bundled into one payload.",
                },
                {
                  label: "Chain-of-thought reasoning",
                  detail:
                    "The LLM writes out reasoning steps before deciding on an action. The thinking text you see is real — it improves decision quality.",
                },
                {
                  label: "Tool call output",
                  detail:
                    'The model outputs structured JSON — { tool: "write_file", arguments: { path, content } }. It decides; the backend executes.',
                },
                {
                  label: "Real execution",
                  detail:
                    "The backend intercepts the tool call, runs it against the real container, and returns the result. Nothing is simulated.",
                },
                {
                  label: "Loop until done",
                  detail:
                    "The result is appended to context and sent back to the LLM. It reasons again, calls another tool, and repeats — 10 to 50 times for complex tasks.",
                },
                {
                  label: "HMR auto-refresh",
                  detail:
                    "Every file write triggers the filesystem watcher → HMR signal → preview refresh. The agent never restarts the server.",
                },
              ].map((step, i) => (
                <li key={i} className="flex gap-3">
                  <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-bold mt-0.5">
                    {i + 1}
                  </span>
                  <div>
                    <p className="font-medium text-foreground leading-snug">{step.label}</p>
                    <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">
                      {step.detail}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="px-4 py-2.5 border-t border-border">
              <a
                href="/docs/developer-mode"
                target="_blank"
                rel="noreferrer"
                className="text-xs text-primary hover:underline flex items-center gap-1"
              >
                Full documentation
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </PopoverContent>
        </Popover>

        {/* Open in new tab */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenNewTab}
              className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Open in new tab</TooltipContent>
        </Tooltip>

        {/* Settings button */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={() => setSettingsOpen((v) => !v)}
              className={cn(
                "flex items-center justify-center h-7 w-7 rounded transition-colors",
                settingsOpen
                  ? "text-foreground bg-muted"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted",
              )}
            >
              <Settings className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Settings & panels</TooltipContent>
        </Tooltip>

        {/* User avatar */}
        {user && (
          <img
            src={user.imageUrl}
            alt={user.fullName ?? "User"}
            className="h-7 w-7 rounded-full border border-border object-cover shrink-0"
            title={user.fullName ?? user.primaryEmailAddress?.emailAddress}
          />
        )}
      </header>
    </>
  );
}
