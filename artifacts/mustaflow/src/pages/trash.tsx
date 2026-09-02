import { useCallback, useEffect, useRef, useState } from "react";
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
import {
  describePurgeDueAt,
  describePurgeState,
  isPurgeInProgress,
  ProjectPermanentDeletionControl,
  type PurgeableTrashedProject,
} from "./trash-permanent-deletion";

const RECOVERY_DAYS = 30;

type TrashedProject = Project & PurgeableTrashedProject;

function readMonotonicNow(): number {
  return typeof performance === "undefined" ? 0 : performance.now();
}

function parseServerNow(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export default function TrashPage() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const listQuery = useListTrashedProjects();
  const restoreMutation = useRestoreProject();
  const [locallyPurgingProjectIds, setLocallyPurgingProjectIds] = useState<ReadonlySet<number>>(
    new Set(),
  );
  const [monotonicNowMs, setMonotonicNowMs] = useState(readMonotonicNow);

  const projects = (listQuery.data ?? []) as TrashedProject[];
  const serverNowSource = projects.find((project) => project.serverNow)?.serverNow ?? null;
  const serverClockAnchor = useRef<{
    source: string | null;
    serverNowMs: number | null;
    monotonicMs: number;
  }>({ source: null, serverNowMs: null, monotonicMs: monotonicNowMs });
  if (serverClockAnchor.current.source !== serverNowSource) {
    serverClockAnchor.current = {
      source: serverNowSource,
      serverNowMs: parseServerNow(serverNowSource),
      monotonicMs: monotonicNowMs,
    };
  }
  const estimatedServerNowMs =
    serverClockAnchor.current.serverNowMs === null
      ? Number.NaN
      : serverClockAnchor.current.serverNowMs +
        Math.max(0, monotonicNowMs - serverClockAnchor.current.monotonicMs);

  useEffect(() => {
    const timer = window.setInterval(() => setMonotonicNowMs(readMonotonicNow()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshProjectLists = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: getListTrashedProjectsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getListProjectsQueryKey() }),
      queryClient.invalidateQueries({ queryKey: getGetProjectsSummaryQueryKey() }),
    ]);
  }, [queryClient]);

  function handleRestore(p: Project) {
    restoreMutation.mutate(
      { id: p.id },
      {
        onSuccess: () => {
          toast({
            title: "Project restored",
            description: `"${p.name}" is back in your projects.`,
          });
          void refreshProjectLists();
        },
        onError: () => {
          toast({
            title: "Restore failed",
            description: "This project could not be restored. Try again shortly.",
            variant: "destructive",
          });
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
            Projects remain recoverable for up to {RECOVERY_DAYS} days, then are permanently deleted
            automatically. You can also permanently delete your own project sooner.
          </p>
        </div>
      </header>

      {listQuery.isPending && (
        <div
          className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
          role="status"
          aria-live="polite"
          aria-busy="true"
        >
          <div
            className="h-5 w-5 rounded-full border-2 border-border border-t-primary animate-spin"
            aria-hidden="true"
          />
          Loading Trash…
        </div>
      )}

      {listQuery.isError && (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 flex items-start gap-3"
          role="alert"
        >
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
            const isRestoring = restoreMutation.isPending && restoreMutation.variables?.id === p.id;
            const purgeInProgress =
              locallyPurgingProjectIds.has(p.id) || isPurgeInProgress(p.purgeState);
            const restoreAllowed = p.restoreAllowed === true && !purgeInProgress;
            const purgeStatus = describePurgeState(p);
            return (
              <li
                key={p.id}
                className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium [overflow-wrap:anywhere]">{p.name}</p>
                  {p.description && (
                    <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {p.description}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground/70 mt-1">
                    {describePurgeDueAt(p.purgeDueAt, estimatedServerNowMs)}
                  </p>
                  {purgeStatus && (
                    <p
                      className={`mt-1 text-xs ${
                        purgeStatus.tone === "danger"
                          ? "text-destructive"
                          : purgeStatus.tone === "warning"
                            ? "text-amber-700 dark:text-amber-400"
                            : "text-muted-foreground"
                      }`}
                      role="status"
                    >
                      {purgeStatus.message}
                    </p>
                  )}
                  {!p.restoreAllowed && !purgeInProgress && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Restoration is unavailable for this project.
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-stretch gap-2 sm:items-end">
                  <button
                    onClick={() => handleRestore(p)}
                    disabled={isRestoring || !restoreAllowed}
                    className="inline-flex items-center justify-center gap-2 rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label={`Restore project "${p.name}"`}
                  >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {isRestoring ? "Restoring…" : "Restore"}
                  </button>
                  <ProjectPermanentDeletionControl
                    project={p}
                    onPurgeActivityChange={(projectId, active) => {
                      setLocallyPurgingProjectIds((current) => {
                        const next = new Set(current);
                        if (active) next.add(projectId);
                        else next.delete(projectId);
                        return next;
                      });
                    }}
                    onStateRefresh={refreshProjectLists}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
