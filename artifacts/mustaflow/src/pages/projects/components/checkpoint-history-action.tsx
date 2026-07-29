import { useCallback, useRef } from "react";
import { GitCommit } from "lucide-react";
import { cn } from "@/lib/utils";

export const CHECKPOINT_HISTORY_ACTION_LABEL = "Checkpoint saved — restore any time";

export type OpenCheckpointHistory = (checkpointId: number) => void;

export function CheckpointHistoryAction({
  checkpointId,
  onOpenCheckpoint,
  className,
}: {
  checkpointId: number;
  onOpenCheckpoint: OpenCheckpointHistory;
  className?: string;
}) {
  const openedFromPointer = useRef(false);
  const openCheckpoint = useCallback(
    () => onOpenCheckpoint(checkpointId),
    [checkpointId, onOpenCheckpoint],
  );

  return (
    <button
      type="button"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        openedFromPointer.current = true;
        openCheckpoint();
      }}
      onPointerCancel={() => {
        openedFromPointer.current = false;
      }}
      onClick={() => {
        // Pointer activation opens on pointer-down so a live→persisted refetch
        // cannot replace the report node between down and click. Keyboard
        // activation has no pointer-down and continues through this path.
        if (openedFromPointer.current) {
          openedFromPointer.current = false;
          return;
        }
        openCheckpoint();
      }}
      className={cn(
        "flex w-full items-center gap-2 border-t border-border/40 py-2 text-left text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        className,
      )}
      data-testid="inline-build-checkpoint"
      aria-label={`${CHECKPOINT_HISTORY_ACTION_LABEL} #${checkpointId}`}
    >
      <GitCommit className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{CHECKPOINT_HISTORY_ACTION_LABEL}</span>
      <span className="ml-auto font-mono text-[9px]">#{checkpointId}</span>
    </button>
  );
}
