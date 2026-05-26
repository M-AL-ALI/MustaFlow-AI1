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
  Code2,
  PanelLeft,
  PanelRight,
  Maximize2,
  SplitSquareHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

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
    <header className="flex items-center h-11 px-3 gap-2 bg-zinc-950 border-b border-border shrink-0 z-20">
      {/* Logo */}
      <Link href="/dev">
        <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 hover:bg-primary/20 transition-colors cursor-pointer shrink-0">
          <Code2 className="h-4 w-4 text-primary" />
        </div>
      </Link>

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
  );
}
