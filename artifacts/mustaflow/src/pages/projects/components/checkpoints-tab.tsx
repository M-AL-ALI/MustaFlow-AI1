/**
 * Unified Checkpoints timeline (Task #538)
 *
 * Replaces the old Versions tab. Lists every checkpoint with the file count,
 * whether a database snapshot is attached, and a Rewind button that restores
 * code + DB + chat history together (with a 2-step confirm).
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListCheckpoints,
  useRestoreCheckpoint,
  getListCheckpointsQueryKey,
  getListMessagesQueryKey,
  getListVersionsQueryKey,
  getGetProjectQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Clock, Database, FileText, RotateCcw, ShieldCheck } from "lucide-react";
import { toast } from "sonner";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function CheckpointsTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const { data, isLoading } = useListCheckpoints(projectId);
  const [confirmId, setConfirmId] = useState<number | null>(null);

  const restore = useRestoreCheckpoint({
    mutation: {
      onSuccess: (resp) => {
        toast.success(
          `Rewound to "${resp.label ?? "checkpoint"}" — ${resp.restoredFiles ?? 0} files restored${
            resp.dbSnapshotRestored ? ", database restored" : ""
          }${
            (resp.truncatedMessages ?? 0) > 0
              ? `, ${resp.truncatedMessages} later messages removed`
              : ""
          }.`,
        );
        queryClient.invalidateQueries({ queryKey: getListCheckpointsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
        queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        setConfirmId(null);
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Restore failed";
        toast.error(msg);
        setConfirmId(null);
      },
    },
  });

  if (isLoading) {
    return <div className="p-4 text-xs text-muted-foreground">Loading checkpoints…</div>;
  }

  const checkpoints = data ?? [];
  if (checkpoints.length === 0) {
    return (
      <div className="p-6 text-sm text-muted-foreground text-center">
        <Clock className="h-6 w-6 mx-auto mb-2 opacity-50" />
        No checkpoints yet. Every build, refine, rollback, or publish creates one automatically.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="text-[11px] text-muted-foreground px-1 pb-1">
        Restoring a checkpoint rewinds your code, database, and chat history together. A safety
        checkpoint is created first so you can undo.
      </div>
      {checkpoints.map((cp) => {
        const isConfirming = confirmId === cp.id;
        const isPending = restore.isPending && restore.variables?.id === cp.id;
        return (
          <div
            key={cp.id}
            className="border border-border rounded-lg p-3 bg-card hover:bg-muted/30 transition-colors"
          >
            <div className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
                <ShieldCheck className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <div className="font-medium text-sm truncate">{cp.label}</div>
                  <div className="text-[11px] text-muted-foreground shrink-0">
                    {formatTime(cp.createdAt)}
                  </div>
                </div>
                <div className="mt-1 flex items-center gap-3 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    {cp.filesCount} files
                  </span>
                  {cp.hasDbSnapshot && (
                    <span className="flex items-center gap-1 text-emerald-500">
                      <Database className="h-3 w-3" />
                      Database{cp.dbProvider ? ` (${cp.dbProvider})` : ""}
                      {cp.dbSnapshotSizeBytes ? ` · ${formatBytes(cp.dbSnapshotSizeBytes)}` : ""}
                    </span>
                  )}
                </div>
                {cp.triggerMessagePreview && (
                  <div className="mt-2 text-[11px] text-muted-foreground italic line-clamp-2 border-l-2 border-border/60 pl-2">
                    “{cp.triggerMessagePreview}”
                  </div>
                )}
              </div>
              <div className="shrink-0">
                {isConfirming ? (
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={isPending}
                      onClick={() => restore.mutate({ id: projectId, checkpointId: cp.id })}
                    >
                      {isPending ? "Restoring…" : "Confirm rewind"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isPending}
                      onClick={() => setConfirmId(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setConfirmId(cp.id)}>
                    <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Rewind
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
