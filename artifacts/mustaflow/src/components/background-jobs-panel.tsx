import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Activity, Loader2, X } from "lucide-react";
import {
  useListBackgroundJobs,
  getListBackgroundJobsQueryKey,
  useCancelTask,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useClerkUser } from "@/lib/clerk-safe";
import { cn } from "@/lib/utils";

const ACTIVE = new Set(["queued", "planning", "building", "needs_review"]);

function statusLabel(status: string): string {
  switch (status) {
    case "planning":
      return "Planning";
    case "building":
      return "Building";
    case "queued":
      return "Queued";
    case "needs_review":
      return "Needs review";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "discarded":
      return "Discarded";
    default:
      return status;
  }
}

function statusClass(status: string): string {
  if (ACTIVE.has(status)) return "text-primary";
  if (status === "completed") return "text-green-500";
  if (status === "failed") return "text-red-500";
  return "text-muted-foreground";
}

function elapsedLabel(startedAt: string | null, createdAt: string): string {
  const start = startedAt ? new Date(startedAt) : new Date(createdAt);
  const elapsed = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
  if (elapsed < 60) return `${elapsed}s`;
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function BackgroundJobsPanel() {
  const { isSignedIn } = useClerkUser();
  const [open, setOpen] = useState(false);
  const [tick, setTick] = useState(0);
  const queryClient = useQueryClient();
  const cancelTask = useCancelTask();

  const { data } = useListBackgroundJobs(
    { status: "active", limit: 30 },
    {
      query: {
        queryKey: getListBackgroundJobsQueryKey({ status: "active", limit: 30 }),
        enabled: !!isSignedIn,
        refetchInterval: 8000,
      },
    },
  );

  // Re-render once per second while open so the elapsed time counter ticks.
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [open]);
  void tick;

  if (!isSignedIn) return null;

  const jobs = data?.jobs ?? [];
  const activeCount = jobs.filter((j) => ACTIVE.has(j.status)).length;

  async function handleCancel(taskId: number, projectId: number) {
    try {
      await cancelTask.mutateAsync({ id: projectId, taskId });
      await queryClient.invalidateQueries({
        queryKey: getListBackgroundJobsQueryKey({ status: "active", limit: 30 }),
      });
    } catch {
      /* surfaced by the underlying mutation */
    }
  }

  return (
    <div className="relative px-3 py-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-150 ease-out cursor-pointer border-l-2",
          open
            ? "border-primary bg-primary/5 text-primary pl-[10px]"
            : "border-transparent text-muted-foreground hover:bg-muted hover:text-foreground pl-[10px]",
        )}
      >
        <Activity className="h-4 w-4 shrink-0" />
        <span className="flex-1 text-left">Background</span>
        {activeCount > 0 && (
          <span className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/30 leading-none flex items-center gap-1">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1 mx-1 bg-card border border-border rounded-lg shadow-lg overflow-hidden max-h-96 overflow-y-auto">
          {jobs.length === 0 ? (
            <div className="px-3 py-4 text-xs text-muted-foreground text-center">
              No background jobs running.
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {jobs.map((j) => {
                const isActive = ACTIVE.has(j.status);
                return (
                  <li key={j.id} className="group">
                    <div className="px-3 py-2.5 hover:bg-muted/60 transition-colors flex items-start gap-2">
                      <Link href={`/projects/${j.projectId}`} className="flex-1 min-w-0">
                        <div className="cursor-pointer" onClick={() => setOpen(false)}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-semibold text-foreground truncate">
                              {j.projectName}
                            </span>
                            <span
                              className={cn(
                                "text-[10px] font-semibold uppercase tracking-wide shrink-0",
                                statusClass(j.status),
                              )}
                            >
                              {statusLabel(j.status)}
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                            {j.title || `Task #${j.id}`}
                          </div>
                          {isActive && (
                            <div className="text-[10px] text-muted-foreground/70 mt-1 flex items-center gap-1">
                              <Loader2 className="h-2.5 w-2.5 animate-spin" />
                              <span>{elapsedLabel(j.startedAt ?? null, j.createdAt)} elapsed</span>
                            </div>
                          )}
                        </div>
                      </Link>
                      {isActive && j.status !== "needs_review" && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            void handleCancel(j.id, j.projectId);
                          }}
                          disabled={cancelTask.isPending}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          title="Cancel job"
                          aria-label="Cancel job"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
