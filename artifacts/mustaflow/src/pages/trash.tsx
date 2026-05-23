import { useQueryClient } from "@tanstack/react-query";
import { Trash2, RotateCcw, AlertCircle } from "lucide-react";
import {
  useListTrashedProjects,
  useRestoreProject,
  getListTrashedProjectsQueryKey,
  getListProjectsQueryKey,
  getGetProjectsSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Project } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";

const RECOVERY_DAYS = 30;

function daysRemaining(deletedAt: string | Date): number {
  const deleted = new Date(deletedAt).getTime();
  const expiresAt = deleted + RECOVERY_DAYS * 24 * 60 * 60 * 1000;
  const ms = expiresAt - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function TrashPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listQuery = useListTrashedProjects();
  const restoreMutation = useRestoreProject();

  const projects = listQuery.data ?? [];

  function handleRestore(p: Project) {
    restoreMutation.mutate(
      { id: p.id },
      {
        onSuccess: () => {
          toast({ title: "Project restored", description: `"${p.name}" is back in your projects.` });
          void queryClient.invalidateQueries({ queryKey: getListTrashedProjectsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetProjectsSummaryQueryKey() });
        },
        onError: (err: unknown) => {
          const msg =
            err && typeof err === "object" && "message" in err
              ? String((err as { message: unknown }).message)
              : "Could not restore project";
          toast({ title: "Restore failed", description: msg, variant: "destructive" });
        },
      },
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <header className="flex items-center gap-3">
        <Trash2 className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
        <div>
          <h1 className="text-2xl font-semibold">Trash</h1>
          <p className="text-sm text-muted-foreground">
            Deleted projects are kept for {RECOVERY_DAYS} days. After that they disappear from this list.
          </p>
        </div>
      </header>

      {listQuery.isPending && (
        <div className="flex items-center justify-center py-16">
          <div className="h-5 w-5 rounded-full border-2 border-border border-t-primary animate-spin" />
        </div>
      )}

      {listQuery.isError && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1">
            <p className="text-sm font-medium text-destructive">Could not load trash</p>
            <button
              onClick={() => void listQuery.refetch()}
              className="text-xs text-destructive underline mt-1"
            >
              Try again
            </button>
          </div>
        </div>
      )}

      {!listQuery.isPending && !listQuery.isError && projects.length === 0 && (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Trash2 className="h-8 w-8 text-muted-foreground/40 mx-auto mb-3" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">Trash is empty.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            When you delete a project it will appear here for {RECOVERY_DAYS} days.
          </p>
        </div>
      )}

      {projects.length > 0 && (
        <ul className="space-y-2">
          {projects.map((p) => {
            const days = p.deletedAt ? daysRemaining(p.deletedAt) : 0;
            const isRestoring = restoreMutation.isPending && restoreMutation.variables?.id === p.id;
            return (
              <li
                key={p.id}
                className="flex items-center gap-4 rounded-lg border border-border bg-card p-4"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-muted-foreground truncate">{p.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {days > 0
                      ? `Permanently removed in ${days} day${days === 1 ? "" : "s"}`
                      : "Recovery window expired"}
                  </p>
                </div>
                <button
                  onClick={() => handleRestore(p)}
                  disabled={isRestoring || days === 0}
                  className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                  aria-label={`Restore project "${p.name}"`}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {isRestoring ? "Restoring…" : "Restore"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
