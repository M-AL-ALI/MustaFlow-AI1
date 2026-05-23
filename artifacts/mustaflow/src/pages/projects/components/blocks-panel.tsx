import { useMemo, useState, useCallback } from "react";
import {
  useGetFileBlocks,
  useReorderFileBlocks,
  useMoveBlockBetweenFiles,
  useListProjectFiles,
  getGetFileBlocksQueryKey,
  getListProjectFilesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { GripVertical, ArrowRightLeft, Sparkles, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  projectId: number;
  filePath: string;
  /** Called with a prefilled chat prompt after a successful cross-file move. */
  onAskAiToAdapt?: (prompt: string) => void;
};

const HTML_RX = /\.html?$/i;

/**
 * Drag-to-reorder + cross-file move panel for the top-level HTML blocks
 * (header / nav / main / section / article / aside / footer / form, plus any
 * element with data-block) of a single page. No external dnd dependency —
 * uses native HTML5 drag events so we don't add weight for a feature that
 * only ever needs vertical reordering of ~5–10 items.
 */
export function BlocksPanel({ projectId, filePath, onAskAiToAdapt }: Props) {
  const queryClient = useQueryClient();
  const filesQuery = useListProjectFiles(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListProjectFilesQueryKey(projectId),
    },
  });
  const allFiles = useMemo(() => filesQuery.data ?? [], [filesQuery.data]);

  const currentFile = useMemo(
    () => allFiles.find((f) => f.path === filePath),
    [allFiles, filePath],
  );
  const otherHtmlFiles = useMemo(
    () => allFiles.filter((f) => HTML_RX.test(f.path) && f.id !== currentFile?.id),
    [allFiles, currentFile?.id],
  );

  const fileId = currentFile?.id ?? 0;
  const isHtml = !!currentFile && HTML_RX.test(currentFile.path);

  const blocksQuery = useGetFileBlocks(projectId, fileId, {
    query: {
      enabled: !!projectId && !!fileId && isHtml,
      queryKey: getGetFileBlocksQueryKey(projectId, fileId),
    },
  });

  const reorderMut = useReorderFileBlocks();
  const moveMut = useMoveBlockBetweenFiles();

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [movedBanner, setMovedBanner] = useState<{
    label: string;
    sourcePath: string;
    targetPath: string;
    snippet: string;
  } | null>(null);

  const blocks = useMemo(() => blocksQuery.data?.blocks ?? [], [blocksQuery.data]);
  const parseOk = blocksQuery.data?.parseOk ?? true;

  const invalidateBlocks = useCallback(() => {
    void queryClient.invalidateQueries({
      queryKey: getGetFileBlocksQueryKey(projectId, fileId),
    });
  }, [queryClient, projectId, fileId]);

  // Serialize edits: a single user-driven reorder/move is in flight at a time.
  // Without this, rapid drags issue concurrent UPDATEs on the same file from
  // stale read snapshots and the last server response wins (not the last user
  // action), which can scramble order or — for cross-file moves — duplicate a
  // block across files. The pending flag also disables the drag handle / select.
  const isMutating = reorderMut.isPending || moveMut.isPending;

  const handleDrop = useCallback(
    (targetIdx: number) => {
      if (dragIndex == null || dragIndex === targetIdx || isMutating) {
        setDragIndex(null);
        setOverIndex(null);
        return;
      }
      const next = blocks.slice();
      const [moved] = next.splice(dragIndex, 1);
      next.splice(targetIdx, 0, moved);
      const order = next.map((b) => b.id);
      reorderMut.mutate(
        { id: projectId, fileId, data: { order } },
        { onSettled: invalidateBlocks },
      );
      setDragIndex(null);
      setOverIndex(null);
    },
    [dragIndex, blocks, reorderMut, projectId, fileId, invalidateBlocks, isMutating],
  );

  const handleMove = useCallback(
    (block: { id: string; label: string; tag: string }, targetFileId: number) => {
      if (isMutating) return;
      const targetFile = allFiles.find((f) => f.id === targetFileId);
      if (!targetFile) return;
      // Capture sourcePath at request time so the banner's "Ask AI to adapt"
      // prompt references the file the user actually moved *from*, even if
      // they switch the selected page before clicking the button.
      const sourcePathAtRequest = filePath;
      moveMut.mutate(
        {
          id: projectId,
          data: {
            sourceFileId: fileId,
            blockId: block.id,
            targetFileId,
          },
        },
        {
          onSuccess: (result) => {
            setMovedBanner({
              label: block.label,
              sourcePath: sourcePathAtRequest,
              targetPath: result.targetPath,
              snippet: result.movedSnippet,
            });
            invalidateBlocks();
            void queryClient.invalidateQueries({
              queryKey: getGetFileBlocksQueryKey(projectId, targetFileId),
            });
          },
        },
      );
    },
    [allFiles, moveMut, projectId, fileId, filePath, invalidateBlocks, queryClient, isMutating],
  );

  if (!isHtml || !currentFile) return null;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
          Blocks
        </label>
        <span className="text-[10px] text-muted-foreground tabular-nums">{blocks.length}</span>
      </div>

      {!parseOk && (
        <div className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
          <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0 mt-0.5" />
          <span className="text-[11px] text-muted-foreground leading-snug">
            This file couldn't be parsed for blocks. Reordering is disabled.
          </span>
        </div>
      )}

      {parseOk && blocks.length === 0 && (
        <div className="text-[11px] text-muted-foreground italic px-1">
          No structural blocks found. Add <code>&lt;header&gt;</code>, <code>&lt;section&gt;</code>,
          etc. (or <code>data-block=&quot;…&quot;</code>) to make this page reorderable.
        </div>
      )}

      {parseOk && blocks.length > 0 && (
        <ul className="space-y-1">
          {blocks.map((block, idx) => {
            const isDragging = dragIndex === idx;
            const isOver = overIndex === idx && dragIndex !== idx;
            return (
              <li
                key={block.id}
                draggable={!isMutating}
                onDragStart={(e) => {
                  if (isMutating) {
                    e.preventDefault();
                    return;
                  }
                  setDragIndex(idx);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (overIndex !== idx) setOverIndex(idx);
                }}
                onDragLeave={() => {
                  if (overIndex === idx) setOverIndex(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  handleDrop(idx);
                }}
                onDragEnd={() => {
                  setDragIndex(null);
                  setOverIndex(null);
                }}
                className={cn(
                  "group flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1.5 transition-all",
                  isDragging && "opacity-40",
                  isOver ? "border-primary bg-primary/10" : "border-border hover:border-primary/30",
                )}
              >
                <GripVertical className="h-3 w-3 text-muted-foreground shrink-0 cursor-grab active:cursor-grabbing" />
                <span className="text-[10px] font-mono uppercase text-muted-foreground shrink-0">
                  {block.tag}
                </span>
                <span className="flex-1 text-[11px] text-foreground truncate" title={block.label}>
                  {block.label}
                </span>
                {otherHtmlFiles.length > 0 && (
                  <div
                    className={cn(
                      "relative shrink-0 rounded-sm focus-within:ring-2 focus-within:ring-primary/60",
                      isMutating && "opacity-50",
                    )}
                  >
                    <select
                      value=""
                      disabled={isMutating}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v > 0) handleMove(block, v);
                        e.currentTarget.value = "";
                      }}
                      aria-label={`Move "${block.label}" to another file`}
                      title="Move to another file"
                      className="appearance-none w-5 h-5 opacity-0 absolute inset-0 cursor-pointer disabled:cursor-not-allowed"
                    >
                      <option value="">Move to…</option>
                      {otherHtmlFiles.map((f) => (
                        <option key={f.id} value={f.id}>
                          {f.path}
                        </option>
                      ))}
                    </select>
                    <ArrowRightLeft
                      aria-hidden="true"
                      className="h-3 w-3 text-muted-foreground opacity-40 group-hover:opacity-80 group-focus-within:opacity-80 transition-opacity pointer-events-none"
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {(reorderMut.isPending || moveMut.isPending) && (
        <div className="text-[10px] text-muted-foreground italic px-1">Saving…</div>
      )}
      {reorderMut.isError && (
        <div className="text-[10px] text-red-400 px-1">Reorder failed. Try again.</div>
      )}
      {moveMut.isError && (
        <div className="text-[10px] text-red-400 px-1">
          Move failed. The target file may have no anchorable blocks.
        </div>
      )}

      {movedBanner && (
        <div className="rounded-md border border-primary/30 bg-primary/5 px-2 py-2 space-y-1.5">
          <div className="text-[11px] text-foreground leading-snug">
            Moved <span className="font-semibold">{movedBanner.label}</span> to{" "}
            <code className="text-[10px]">{movedBanner.targetPath}</code>.
          </div>
          {onAskAiToAdapt && (
            <div className="flex gap-1.5">
              <button
                onClick={() => {
                  onAskAiToAdapt(
                    [
                      `I just moved a block ("${movedBanner.label}") from "${movedBanner.sourcePath}" to "${movedBanner.targetPath}".`,
                      `The moved HTML snippet is:`,
                      "```html",
                      movedBanner.snippet,
                      "```",
                      `Please adapt the destination page so this block fits properly:`,
                      `- Move any inline <style> rules or scoped IDs/classes the block depends on into the destination's <head> or stylesheet (or remove them from the source).`,
                      `- Update any JavaScript event handlers, anchors, or imports the block relies on so they work in the new file.`,
                      `- Keep the visual appearance of the block intact in its new home.`,
                      `Do not move it back. Do not re-order the surrounding blocks.`,
                    ].join("\n"),
                  );
                  setMovedBanner(null);
                }}
                className="flex-1 flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-2 py-1.5 text-[11px] font-medium hover:bg-primary/90 transition-colors"
              >
                <Sparkles className="h-3 w-3" />
                Ask AI to adapt
              </button>
              <button
                onClick={() => setMovedBanner(null)}
                className="text-[11px] text-muted-foreground hover:text-foreground px-2"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
