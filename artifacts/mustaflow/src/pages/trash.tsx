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
import { authFetch } from "@/lib/api-fetch";
import {
  describePurgeDueAt,
  describePurgeState,
  isPurgeInProgress,
  ProjectPermanentDeletionControl,
  type PurgeableTrashedProject,
} from "./trash-permanent-deletion";

const RECOVERY_DAYS = 30;

type TrashedProject = Project &
  PurgeableTrashedProject & {
    restoreBlockedCode?: string | null;
    retirementOperationId?: string | null;
    reconciliationEligible?: boolean;
    reconciliationBlockedCode?: string | null;
  };

type RetirementRecoveryStatus = {
  operationId: string;
  state: string;
  completedAt: string | null;
  reconciliationEligible: boolean;
  reconciliationBlockedCode: string | null;
  completionEvidenceCurrent: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function cleanupRecoveryMessage(code: unknown): string {
  switch (code) {
    case "project_retirement_reconciliation_limit_reached":
      return "Cleanup has reached its retry limit. Contact support with the cleanup reference below.";
    case "project_retirement_provider_configuration_unavailable":
      return "Cleanup is waiting for platform configuration. Contact support, then check status.";
    case "project_retirement_worker_unavailable":
      return "Cleanup verification is temporarily unavailable. Check status and try again shortly.";
    case "project_retirement_retry_not_allowed":
    case "project_retirement_not_found":
      return "Cleanup needs support review before restoration. Contact support with this project and its cleanup reference.";
    case "project_purge_in_progress":
      return "Permanent deletion has started. This project can no longer be restored.";
    default:
      return "This project's earlier cleanup needs verification before it can be restored.";
  }
}

function ProjectRestoreRecoveryControl({
  project,
  onStateRefresh,
  onVerified,
}: {
  project: TrashedProject;
  onStateRefresh: () => Promise<void>;
  onVerified: () => void;
}) {
  const [status, setStatus] = useState<RetirementRecoveryStatus | null>(null);
  const [blockedCode, setBlockedCode] = useState(project.reconciliationBlockedCode ?? null);
  const [message, setMessage] = useState(() => cleanupRecoveryMessage(blockedCode));
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);
  const polls = useRef(0);
  const eligible =
    !blockedCode && (status?.reconciliationEligible ?? project.reconciliationEligible) === true;
  const operationId = status?.operationId ?? project.retirementOperationId;
  const isPending =
    status &&
    (status.state === "accepted" ||
      status.state === "running" ||
      (status.state === "failed" && status.completedAt === null));

  const readStatus = useCallback(async () => {
    const response = await authFetch(`/api/projects/${project.id}/retirement`);
    const body = record(await response.json());
    if (
      !response.ok ||
      body.projectId !== project.id ||
      typeof body.operationId !== "string" ||
      body.operationId.length > 200 ||
      !["accepted", "running", "failed", "completed", "canceled"].includes(String(body.state)) ||
      typeof body.reconciliationEligible !== "boolean"
    ) {
      throw new Error("cleanup_status_unavailable");
    }
    const next: RetirementRecoveryStatus = {
      operationId: body.operationId,
      state: String(body.state),
      completedAt: typeof body.completedAt === "string" ? body.completedAt : null,
      reconciliationEligible: body.reconciliationEligible,
      reconciliationBlockedCode:
        typeof body.reconciliationBlockedCode === "string" ? body.reconciliationBlockedCode : null,
      completionEvidenceCurrent: body.completionEvidenceCurrent === true,
    };
    setStatus(next);
    setBlockedCode(next.reconciliationBlockedCode);
    if (next.state === "completed" && next.completionEvidenceCurrent) {
      setMessage("Cleanup is verified. Refreshing Trash...");
      onVerified();
      await onStateRefresh();
    } else if (
      next.state === "accepted" ||
      next.state === "running" ||
      (next.state === "failed" && next.completedAt === null)
    ) {
      setMessage(
        "Cleanup verification is in progress. Restore will be available after verification finishes.",
      );
    } else {
      setMessage(cleanupRecoveryMessage(next.reconciliationBlockedCode));
    }
  }, [project.id, onStateRefresh, onVerified]);

  useEffect(() => {
    if (!isPending || busy) return;
    if (polls.current >= 30) {
      setMessage(
        "Cleanup is still pending. Automatic status checks paused; use Check status to continue.",
      );
      return;
    }
    const timer = window.setTimeout(() => {
      polls.current += 1;
      void readStatus().catch(() =>
        setMessage("Could not check cleanup. Use Check status to try again."),
      );
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [isPending, status, busy, readStatus]);

  async function runAction(retry: boolean) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    polls.current = 0;
    try {
      if (retry) {
        const response = await authFetch(`/api/projects/${project.id}/retirement/retry`, {
          method: "POST",
        });
        const body = record(await response.json());
        const recorded =
          body.projectId === project.id &&
          body.state === "accepted" &&
          typeof body.operationId === "string" &&
          body.operationId.length <= 200 &&
          ((response.status === 202 &&
            body.code === "project_retirement_reconciliation_accepted") ||
            (response.status === 503 && body.code === "project_retirement_cleanup_pending"));
        if (!recorded) {
          setBlockedCode(typeof body.code === "string" ? body.code : "unavailable");
          setMessage(cleanupRecoveryMessage(body.code));
          if (body.code === "project_retirement_not_terminal") await readStatus();
          return;
        }
        setStatus({
          operationId: body.operationId as string,
          state: "accepted",
          completedAt: null,
          reconciliationEligible: false,
          reconciliationBlockedCode: null,
          completionEvidenceCurrent: false,
        });
        setBlockedCode(null);
        setMessage("Cleanup verification was recorded. Checking its progress...");
        await onStateRefresh();
      }
      await readStatus();
    } catch {
      setMessage("Could not check cleanup. Use Check status to try again.");
    } finally {
      actionInFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div
      className="mt-2 space-y-2 text-xs"
      aria-label={`Cleanup recovery for project "${project.name}"`}
    >
      <p role="status">{message}</p>
      {operationId && (
        <p className="text-muted-foreground [overflow-wrap:anywhere]">
          Cleanup reference: {operationId}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {eligible && !isPending && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void runAction(true)}
            className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
          >
            {busy ? "Verifying cleanup..." : "Verify cleanup"}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void runAction(false)}
          className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
        >
          Check status
        </button>
      </div>
    </div>
  );
}

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
  const [restoreDeniedIds, setRestoreDeniedIds] = useState<ReadonlySet<number>>(new Set());
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
        onError: (error) => {
          const code = record(record(error).data).code;
          if (code === "project_retirement_cleanup_unverified") {
            setRestoreDeniedIds((current) => new Set([...current, p.id]));
          }
          toast({
            title: "Restore failed",
            description:
              code === "project_retirement_cleanup_unverified"
                ? "Earlier cleanup needs verification. Use cleanup recovery on this project before restoring."
                : code === "project_purge_in_progress"
                  ? "Permanent deletion has started. This project can no longer be restored."
                  : "This project could not be restored. Check its cleanup status and try again.",
            variant: "destructive",
          });
          void refreshProjectLists();
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
            const restoreAllowed =
              p.restoreAllowed === true && !purgeInProgress && !restoreDeniedIds.has(p.id);
            const showCleanupRecovery =
              !restoreAllowed &&
              !purgeInProgress &&
              (!p.purgeState || p.purgeState === "scheduled");
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
                  {showCleanupRecovery && (
                    <ProjectRestoreRecoveryControl
                      project={p}
                      onStateRefresh={refreshProjectLists}
                      onVerified={() =>
                        setRestoreDeniedIds((current) => {
                          if (!current.has(p.id)) return current;
                          const next = new Set(current);
                          next.delete(p.id);
                          return next;
                        })
                      }
                    />
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
