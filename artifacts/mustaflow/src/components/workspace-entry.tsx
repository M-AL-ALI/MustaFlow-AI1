import { ArrowUpRight, Briefcase, Plus, RotateCw } from "lucide-react";
import type { WorkspaceItem } from "@/contexts/workspace-context";

export type WorkspaceEntryItem = Pick<WorkspaceItem, "id" | "name" | "description" | "type">;

export interface WorkspaceEntryProps {
  workspaces: readonly WorkspaceEntryItem[];
  state: "loading" | "error" | "ready";
  currentWorkspaceId?: number | null;
  retrying?: boolean;
  onChooseWorkspace: (workspaceId: number) => void;
  onCreateWorkspace: () => void;
  onRetry: () => void;
}

function categoryLabel(type: string): string {
  switch (type) {
    case "personal":
      return "Personal";
    case "business":
      return "Business";
    case "client":
      return "Client work";
    case "team":
      return "Team";
    default:
      return "Workspace";
  }
}

/**
 * An explicit NabuFlow entry choice, including accounts with one workspace.
 * The caller supplies account-owned rows and owns selection, modal and routing.
 * Rendering or choosing a workspace never starts a project or a build here.
 */
export function WorkspaceEntry({
  workspaces,
  state,
  currentWorkspaceId,
  retrying = false,
  onChooseWorkspace,
  onCreateWorkspace,
  onRetry,
}: WorkspaceEntryProps) {
  const ready = state === "ready";

  return (
    <section
      className="nf-dashboard"
      aria-label="Choose a workspace"
      aria-busy={state === "loading" || retrying}
    >
      <div className="mx-auto max-w-4xl py-6 sm:py-12">
        <header className="mb-8 max-w-2xl">
          <p className="nf-eyebrow">NabuFlow</p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            Choose a workspace
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-muted-foreground sm:text-base">
            Open a workspace to see its projects and start your next idea.
          </p>
        </header>

        {state === "loading" ? (
          <div
            role="status"
            className="rounded-xl border border-border bg-muted/20 p-6 text-sm text-muted-foreground"
          >
            Loading your workspaces...
          </div>
        ) : state === "error" ? (
          <div role="alert" className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-base font-semibold text-foreground">Workspaces are unavailable</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              We could not refresh your workspace list. Try again before choosing a workspace.
            </p>
            <button
              type="button"
              onClick={retrying ? undefined : onRetry}
              disabled={retrying}
              className="nf-secondary-button mt-5"
            >
              <RotateCw
                size={15}
                className={retrying ? "animate-spin" : undefined}
                aria-hidden="true"
              />
              {retrying ? "Retrying workspaces..." : "Retry workspaces"}
            </button>
          </div>
        ) : workspaces.length === 0 ? (
          <div className="rounded-xl border border-border bg-gradient-to-br from-card to-muted/20 p-6 sm:p-8">
            <Briefcase size={25} className="text-muted-foreground" aria-hidden="true" />
            <h2 className="mt-4 text-lg font-semibold text-foreground">
              Create your first workspace
            </h2>
            <p className="mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
              Give your work a home. You can add projects after your workspace is ready.
            </p>
          </div>
        ) : (
          <ul aria-label="Your workspaces" className="grid gap-4 sm:grid-cols-2">
            {workspaces.map((workspace) => {
              const name = workspace.name.trim() || "Untitled workspace";
              const current = workspace.id === currentWorkspaceId;
              return (
                <li key={workspace.id} className="min-w-0">
                  <button
                    type="button"
                    aria-label={"Open workspace " + name}
                    onClick={() => onChooseWorkspace(workspace.id)}
                    className={
                      "group flex h-full w-full flex-col rounded-xl border bg-gradient-to-br from-card to-muted/20 p-5 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-6 " +
                      (current ? "border-primary/50" : "border-border")
                    }
                  >
                    <span className="mb-5 flex w-full items-center justify-between gap-3">
                      <Briefcase size={22} className="text-muted-foreground" aria-hidden="true" />
                      {current && (
                        <span className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground">
                          Selected
                        </span>
                      )}
                    </span>
                    <span className="w-full break-words text-lg font-semibold text-foreground">
                      {name}
                    </span>
                    <span className="mt-1 text-xs text-muted-foreground">
                      {categoryLabel(workspace.type)}
                    </span>
                    {workspace.description?.trim() && (
                      <span className="mt-3 break-words text-sm leading-relaxed text-muted-foreground">
                        {workspace.description}
                      </span>
                    )}
                    <span className="mt-auto flex w-full items-center justify-between gap-3 pt-6 text-sm font-medium text-foreground">
                      Open workspace
                      <ArrowUpRight size={17} aria-hidden="true" />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-8 flex flex-col items-start gap-3 border-t border-border pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm leading-relaxed text-muted-foreground">
            Keep unrelated work in a separate workspace.
          </p>
          <button
            type="button"
            onClick={ready ? onCreateWorkspace : undefined}
            disabled={!ready}
            className="nf-secondary-button shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus size={15} aria-hidden="true" />
            Create workspace
          </button>
        </div>
      </div>
    </section>
  );
}
