import { useRef } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import type { ImageStudioCollectionContext } from "./image-studio-collections";

export function AssetReuseDialog({
  assetLabel,
  projects,
  projectsLoading,
  projectsError,
  retryProjects,
  projectId,
  busy,
  error,
  onProjectChange,
  onCancel,
  onConfirm,
}: ImageStudioCollectionContext & {
  assetLabel: string;
  projectId: number | null;
  busy: boolean;
  error: string | null;
  onProjectChange: (projectId: number | null) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const opener = useRef(typeof document === "undefined" ? null : document.activeElement);
  const destination = projects.find((project) => project.id === projectId);
  const unavailable = projectsLoading || !!projectsError || projects.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        className={`max-h-[85vh] w-[calc(100%-2rem)] max-w-md overflow-y-auto rounded-xl ${busy ? "[&>button]:hidden" : ""}`}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (opener.current instanceof HTMLElement && opener.current.isConnected)
            opener.current.focus();
        }}
      >
        <div className="space-y-2 pr-5">
          <DialogTitle>Use in a project</DialogTitle>
          <DialogDescription>
            Review the asset and choose its destination. This adds a project file and records its
            use; it does not move the source asset.
          </DialogDescription>
        </div>
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Selected asset
          </p>
          <p className="mt-1 break-words text-sm font-medium">{assetLabel}</p>
        </div>
        {projectsLoading ? (
          <p role="status" className="text-sm text-muted-foreground">
            Loading destination projects...
          </p>
        ) : projectsError ? (
          <div role="alert" className="space-y-2 text-sm text-destructive">
            <p>Destination projects could not be loaded. Choose a project after retrying.</p>
            <button type="button" onClick={retryProjects} className="underline">
              Retry destinations
            </button>
          </div>
        ) : projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No destination projects are available. Create a project before adding this asset.
          </p>
        ) : null}
        <div>
          <label htmlFor="image-studio-reuse-project" className="mb-1.5 block text-xs font-medium">
            Destination project
          </label>
          <select
            id="image-studio-reuse-project"
            aria-label="Project for asset"
            value={destination?.id ?? ""}
            disabled={busy || unavailable}
            onChange={(event) => {
              const value = event.target.value;
              onProjectChange(
                value !== "" && projects.some((project) => project.id === Number(value))
                  ? Number(value)
                  : null,
              );
            }}
            className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <option value="">Choose a destination project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name} (#{project.id})
              </option>
            ))}
          </select>
        </div>
        {destination && !unavailable && (
          <p className="text-sm leading-relaxed">
            Add <strong>{assetLabel}</strong> to{" "}
            <strong>
              {destination.name} (#{destination.id})
            </strong>{" "}
            only.
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {busy && (
          <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            Waiting for the selected project to confirm the addition...
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!busy && !unavailable && destination) onConfirm();
            }}
            disabled={busy || unavailable || !destination}
            className="rounded-lg bg-foreground px-4 py-2 text-sm font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Adding..." : "Add to project"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
