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
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import logoUrl from "/logo.png";

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
}

function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
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

  const items = [
    {
      icon: Keyboard,
      label: "Keyboard shortcuts",
      description: "View all shortcuts",
      action: () => onClose(),
    },
    {
      icon: Moon,
      label: "Appearance",
      description: "Dark mode (default)",
      action: () => onClose(),
    },
    {
      icon: Info,
      label: "About MustaFlow",
      description: "Version & documentation",
      action: () => onClose(),
    },
  ];

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 pointer-events-none" />
      )}
      <div
        ref={drawerRef}
        className={cn(
          "fixed left-0 top-11 bottom-0 z-50 w-64 bg-zinc-950 border-r border-border flex flex-col shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
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
          <div className="px-3 pb-2">
            <p className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
              Developer Mode
            </p>
            <Link href="/dev">
              <button
                onClick={onClose}
                className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <span>Back to projects</span>
                <ChevronRight className="h-3 w-3 opacity-40" />
              </button>
            </Link>
          </div>

          <div className="px-3 pt-1">
            <p className="text-[9px] font-semibold text-muted-foreground/50 uppercase tracking-wider px-1 mb-1">
              Workspace
            </p>
            {items.map(({ icon: Icon, label, description, action }) => (
              <button
                key={label}
                onClick={action}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted/60 transition-colors group"
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
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />

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
          <TooltipContent>Settings & navigation</TooltipContent>
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
              <Link href={`/projects/${projectId}`}>
                <Button size="sm" variant="outline" className="h-7 px-3 gap-1.5 text-xs">
                  <Rocket className="h-3.5 w-3.5" />
                  Deploy
                </Button>
              </Link>
            )}
          </TooltipTrigger>
          <TooltipContent>Open deployment panel</TooltipContent>
        </Tooltip>

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
          <TooltipContent>Settings</TooltipContent>
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
