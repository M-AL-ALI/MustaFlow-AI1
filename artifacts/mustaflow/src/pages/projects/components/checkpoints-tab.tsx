import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCheckpoints,
  useRestoreCheckpoint,
  getListCheckpointsQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import type { Checkpoint } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Clock3, Database, FileText, History, Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import {
  formatCheckpointClockTime,
  restoreConfirmationMessage,
  versionHistoryDescription,
} from "./version-history-model";

function formatCalendarDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Saved version";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(date);
}

interface CheckpointsTabProps {
  projectId: number;
  focusCheckpointId?: number | null;
  onRestored?: () => void;
}

export function CheckpointsTab({ projectId, focusCheckpointId, onRestored }: CheckpointsTabProps) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListCheckpoints(projectId);
  const [restoreTarget, setRestoreTarget] = useState<Checkpoint | null>(null);
  const historySurfaceRef = useRef<HTMLDivElement>(null);

  const restore = useRestoreCheckpoint({
    mutation: {
      onSuccess: (response) => {
        toast.success(
          `Restored "${response.label || "saved version"}". Your previous version is still saved.`,
        );
        void queryClient.invalidateQueries({
          queryKey: getListCheckpointsQueryKey(projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListMessagesQueryKey(projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListProjectFilesQueryKey(projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: getListVersionsQueryKey(projectId),
        });
        void queryClient.invalidateQueries({
          queryKey: getGetProjectQueryKey(projectId),
        });
        setRestoreTarget(null);
        onRestored?.();
      },
      onError: (error: unknown) => {
        const message =
          error instanceof Error ? error.message : "That version could not be restored.";
        toast.error(message);
      },
    },
  });

  const checkpoints = data ?? [];

  useEffect(() => {
    if (!focusCheckpointId || isLoading) return;
    const target = historySurfaceRef.current?.querySelector<HTMLElement>(
      `[data-checkpoint-id="${focusCheckpointId}"]`,
    );
    if (!target) return;

    const frame = requestAnimationFrame(() => {
      target.scrollIntoView({
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
          ? "auto"
          : "smooth",
        block: "center",
      });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [data, focusCheckpointId, isLoading]);

  return (
    <div ref={historySurfaceRef} className="h-full overflow-y-auto bg-background">
      <div className="mx-auto max-w-3xl px-5 py-7 sm:px-8">
        <div className="mb-6">
          <div className="flex items-center gap-2 text-primary">
            <History className="h-4 w-4" />
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em]">
              Version history
            </span>
          </div>
          <h2 className="mt-2 text-xl font-semibold text-foreground">
            Go back without losing work
          </h2>
          <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Every restore saves your current app first, so you can always move forward again.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 rounded-2xl border border-border bg-card/30 px-5 py-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            Loading saved versions...
          </div>
        ) : checkpoints.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-card/30 px-6 py-12 text-center">
            <Clock3 className="mx-auto h-7 w-7 text-primary/70" />
            <h3 className="mt-4 text-sm font-semibold text-foreground">
              Your saved versions will appear here
            </h3>
            <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted-foreground">
              Build your app or make a change. NabuFlow saves a version automatically.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {checkpoints.map((checkpoint, index) => (
              <article
                key={checkpoint.id}
                tabIndex={-1}
                data-checkpoint-id={checkpoint.id}
                data-focused={checkpoint.id === focusCheckpointId ? "true" : undefined}
                aria-current={checkpoint.id === focusCheckpointId ? "true" : undefined}
                className="group rounded-2xl border border-border bg-card/50 p-4 outline-none transition-colors hover:border-primary/25 hover:bg-card data-[focused=true]:border-primary/50 data-[focused=true]:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <div className="flex items-start gap-4">
                  <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                    <Clock3 className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-foreground">
                        {checkpoint.label || "Saved version"}
                      </h3>
                      {index === 0 && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          Latest
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-1 text-xs leading-relaxed text-muted-foreground">
                      {versionHistoryDescription(checkpoint)}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                      <span>
                        {formatCalendarDate(checkpoint.createdAt)} at{" "}
                        {formatCheckpointClockTime(checkpoint.createdAt)}
                      </span>
                      <span className="flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        {checkpoint.filesCount} file{checkpoint.filesCount === 1 ? "" : "s"}
                      </span>
                      {checkpoint.hasDbSnapshot && (
                        <span className="flex items-center gap-1">
                          <Database className="h-3 w-3" />
                          Database saved
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 rounded-lg"
                    disabled={restore.isPending}
                    onClick={() => setRestoreTarget(checkpoint)}
                  >
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                    Restore
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>

      <AlertDialog
        open={restoreTarget !== null}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setRestoreTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              {restoreTarget
                ? restoreConfirmationMessage(restoreTarget.createdAt)
                : "Your current version stays saved."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending || !restoreTarget}
              onClick={(event) => {
                event.preventDefault();
                if (!restoreTarget) return;
                restore.mutate({ id: projectId, checkpointId: restoreTarget.id });
              }}
            >
              {restore.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Restoring...
                </>
              ) : (
                "Restore"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
