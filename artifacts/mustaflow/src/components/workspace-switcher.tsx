import { useState } from "react";
import { useLocation } from "wouter";
import { useWorkspace } from "@/contexts/workspace-context";
import { CreateWorkspaceModal } from "@/components/create-workspace-modal";
import { Briefcase, ChevronDown, Plus, RotateCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function WorkspaceSwitcher({ onNavigate }: { onNavigate?: () => void } = {}) {
  const [, setLocation] = useLocation();
  const {
    workspaces,
    currentWorkspace,
    setCurrentWorkspaceId,
    isLoading,
    isError,
    retryWorkspaces,
  } = useWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const label =
    currentWorkspace?.name ??
    (isLoading ? "Loading workspaces" : isError ? "Workspaces unavailable" : "Choose workspace");

  return (
    <>
      <CreateWorkspaceModal
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setLocation("/projects");
          onNavigate?.();
        }}
      />
      <div className="px-3 pb-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Switch workspace, ${label}`}
              className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Briefcase className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                {label}
              </span>
              <ChevronDown
                className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={6}
            className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 max-w-[calc(100vw-2rem)] rounded-xl p-1.5"
          >
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
              Your workspaces
            </DropdownMenuLabel>
            {isLoading && (
              <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
                Loading workspaces...
              </p>
            )}
            {isError && (
              <>
                <p role="status" className="px-2 py-2 text-xs text-muted-foreground">
                  Couldn't refresh your workspaces. Any names shown are last known.
                </p>
                <DropdownMenuItem onSelect={retryWorkspaces}>
                  <RotateCw aria-hidden="true" />
                  Retry workspace loading
                </DropdownMenuItem>
              </>
            )}
            {!isLoading && !isError && workspaces.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Create a workspace to organize your projects.
              </p>
            )}
            <DropdownMenuRadioGroup
              value={currentWorkspace ? String(currentWorkspace.id) : ""}
              onValueChange={(value) => {
                const id = Number(value);
                if (isLoading || isError || !workspaces.some((workspace) => workspace.id === id))
                  return;
                setCurrentWorkspaceId(id);
                setLocation("/projects");
                onNavigate?.();
              }}
            >
              {!isLoading &&
                !isError &&
                workspaces.map((workspace) => (
                  <DropdownMenuRadioItem
                    key={workspace.id}
                    value={String(workspace.id)}
                    className="rounded-md py-2.5"
                  >
                    <span className="truncate">{workspace.name}</span>
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setCreateOpen(true)} className="rounded-md py-2.5">
              <Plus aria-hidden="true" />
              Create workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}
