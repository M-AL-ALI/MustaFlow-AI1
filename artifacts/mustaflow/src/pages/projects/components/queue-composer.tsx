import { useState, useRef, useEffect, useCallback } from "react";
import {
  Send,
  Plus,
  X,
  GripVertical,
  Trash2,
  Sparkles,
  Paperclip,
  Mic,
  Paintbrush2,
  CheckSquare,
  ServerCog,
} from "lucide-react";
import { cn } from "@/lib/utils";

type AgentMode = "lite" | "eco" | "power" | "pro";

interface QueueRow {
  id: string;
  text: string;
}

interface QueueComposerProps {
  projectId: number;
  agentMode: AgentMode;
  onAgentModeChange: (mode: AgentMode) => void;
  planMode: boolean;
  onPlanModeChange: (v: boolean) => void;
  runInBackground: boolean;
  onRunInBackgroundChange: (v: boolean) => void;
  disabled: boolean;
  onSingleSend: (content: string) => void;
  onBatchStarted: (batchId: string, totalCount: number) => void;
  promptValue?: string;
  onPromptValueChange?: (v: string) => void;
}

export function QueueComposer({
  projectId,
  agentMode,
  onAgentModeChange,
  planMode,
  onPlanModeChange,
  runInBackground,
  onRunInBackgroundChange,
  disabled,
  onSingleSend,
  onBatchStarted,
  promptValue,
  onPromptValueChange,
}: QueueComposerProps) {
  const [rows, setRows] = useState<QueueRow[]>([{ id: crypto.randomUUID(), text: "" }]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const dragItemId = useRef<string | null>(null);
  const textareaRefs = useRef<Map<string, HTMLTextAreaElement>>(new Map());

  const isMultiRow = rows.length > 1;

  useEffect(() => {
    if (promptValue !== undefined) {
      setRows((prev) => {
        if (prev.length !== 1) return prev;
        return [{ id: prev[0]!.id, text: promptValue }];
      });
    }
  }, [promptValue]);

  const updateRow = useCallback(
    (id: string, text: string) => {
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, text } : r)));
      if (rows.length === 1 && onPromptValueChange) {
        onPromptValueChange(text);
      }
    },
    [rows.length, onPromptValueChange],
  );

  const addRow = useCallback(() => {
    const newId = crypto.randomUUID();
    setRows((prev) => [...prev, { id: newId, text: "" }]);
    setTimeout(() => textareaRefs.current.get(newId)?.focus(), 50);
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((r) => r.id !== id);
    });
  }, []);

  const clearQueue = useCallback(() => {
    const newId = crypto.randomUUID();
    setRows([{ id: newId, text: "" }]);
    if (onPromptValueChange) onPromptValueChange("");
  }, [onPromptValueChange]);

  const handleSend = useCallback(async () => {
    const messages = rows.map((r) => r.text.trim()).filter(Boolean);
    if (messages.length === 0) return;

    if (messages.length === 1) {
      const text = messages[0]!;
      setRows([{ id: crypto.randomUUID(), text: "" }]);
      if (onPromptValueChange) onPromptValueChange("");
      onSingleSend(text);
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/queue`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, agentMode, planMode }),
        credentials: "include",
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        throw new Error(err.error ?? "Queue submission failed");
      }
      const data = (await res.json()) as { batchId: string; totalTasks: number };
      setRows([{ id: crypto.randomUUID(), text: "" }]);
      if (onPromptValueChange) onPromptValueChange("");
      onBatchStarted(data.batchId, data.totalTasks);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Queue submission failed:", err);
    } finally {
      setIsSubmitting(false);
    }
  }, [rows, agentMode, planMode, projectId, onSingleSend, onBatchStarted, onPromptValueChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>, _rowId: string) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void handleSend();
        return;
      }
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        addRow();
        return;
      }
    },
    [addRow, handleSend],
  );

  const handleDragStart = useCallback((id: string) => {
    dragItemId.current = id;
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    const fromId = dragItemId.current;
    if (!fromId || fromId === targetId) {
      setDragOverId(null);
      return;
    }
    setRows((prev) => {
      const fromIdx = prev.findIndex((r) => r.id === fromId);
      const toIdx = prev.findIndex((r) => r.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const next = [...prev];
      const [item] = next.splice(fromIdx, 1);
      if (item) next.splice(toIdx, 0, item);
      return next;
    });
    dragItemId.current = null;
    setDragOverId(null);
  }, []);

  const isBusy = disabled || isSubmitting;
  const canSend = rows.some((r) => r.text.trim().length > 0) && !isBusy;

  return (
    <div className="shrink-0 px-3 py-2.5 border-t border-border">
      {isMultiRow && (
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
            Queue — {rows.length} tasks
          </span>
          <button
            onClick={clearQueue}
            className="ml-auto flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium text-muted-foreground border border-border hover:text-foreground hover:border-destructive/50 hover:text-destructive transition-colors"
          >
            <Trash2 className="h-2.5 w-2.5" />
            Clear queue
          </button>
        </div>
      )}

      <div className="flex items-start gap-2">
        <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shrink-0 shadow-md shadow-primary/20 mt-0.5">
          <Sparkles style={{ width: 12, height: 12 }} className="text-white" />
        </div>

        <div className="flex-1 bg-muted border border-border rounded-2xl rounded-tl-sm overflow-hidden">
          {rows.map((row, idx) => (
            <div
              key={row.id}
              draggable={isMultiRow}
              onDragStart={() => handleDragStart(row.id)}
              onDragOver={(e) => handleDragOver(e, row.id)}
              onDrop={(e) => handleDrop(e, row.id)}
              onDragEnd={() => setDragOverId(null)}
              className={cn(
                "flex items-start gap-1.5 transition-colors",
                idx > 0 && "border-t border-border/40",
                dragOverId === row.id && "bg-primary/5",
              )}
            >
              {isMultiRow && (
                <div className="flex items-center gap-1 pt-2.5 pl-2 shrink-0">
                  <span className="text-[9px] font-bold text-muted-foreground/50 w-4 text-right">
                    {idx + 1}
                  </span>
                  <GripVertical className="h-3 w-3 text-muted-foreground/30 cursor-grab" />
                </div>
              )}
              <textarea
                ref={(el) => {
                  if (el) textareaRefs.current.set(row.id, el);
                  else textareaRefs.current.delete(row.id);
                }}
                value={row.text}
                onChange={(e) => updateRow(row.id, e.target.value)}
                placeholder={
                  idx === 0
                    ? planMode
                      ? "Describe your app — I'll create a plan first…"
                      : isMultiRow
                        ? "Task 1…"
                        : "Describe what to build or change…"
                    : `Task ${idx + 1}…`
                }
                rows={isMultiRow ? 1 : 2}
                className="flex-1 bg-transparent px-4 pt-2.5 pb-1.5 text-sm resize-none focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                onKeyDown={(e) => handleKeyDown(e, row.id)}
                title={
                  isMultiRow
                    ? "Shift+Enter to add task · ⌘↩ to send all"
                    : "⌘↩ or Enter to send · Shift+Enter to add task to queue"
                }
              />
              {isMultiRow && (
                <button
                  onClick={() => removeRow(row.id)}
                  className="mt-2 mr-2 w-4 h-4 shrink-0 flex items-center justify-center rounded text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors"
                  title="Remove task"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}

          {isMultiRow && (
            <button
              onClick={addRow}
              className="w-full flex items-center gap-2 px-4 py-1.5 text-[11px] text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/50 transition-colors border-t border-border/30"
            >
              <Plus className="h-3 w-3" />
              Add task to queue
            </button>
          )}

          <div className="h-px bg-border/40 mx-4" />
          <div className="flex items-center gap-2 px-3 py-1.5">
            {!isMultiRow && (
              <>
                <button
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Attach file"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                </button>
                <button
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Attach design"
                >
                  <Paintbrush2 className="h-3.5 w-3.5" />
                </button>
                <button
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Voice"
                >
                  <Mic className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={addRow}
                  className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors"
                  title="Add task to queue (Shift+Enter)"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex bg-background/60 border border-border rounded-lg p-0.5">
                {(["lite", "eco", "power", "pro"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => onAgentModeChange(mode)}
                    className={cn(
                      "px-2 py-0.5 text-[9px] uppercase font-bold rounded-md transition-colors",
                      agentMode === mode
                        ? "bg-primary text-primary-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
              <button
                onClick={() => void handleSend()}
                disabled={!canSend}
                title={isMultiRow ? `Send all ${rows.length} tasks (⌘↩)` : "Send (⌘↩)"}
                className="h-8 px-3 bg-primary rounded-xl flex items-center gap-1.5 shadow-md shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-primary-foreground"
              >
                <Send style={{ width: 14, height: 14 }} />
                {isMultiRow && <span className="text-[10px] font-bold">{rows.length}</span>}
              </button>
            </div>
          </div>
        </div>
      </div>

      {!isBusy && (
        <div className="mt-1.5 px-9 flex items-center gap-2">
          <button
            onClick={() => onPlanModeChange(!planMode)}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors border",
              planMode
                ? "bg-secondary/15 text-secondary border-secondary/30"
                : "text-muted-foreground border-border hover:text-foreground",
            )}
          >
            <CheckSquare className="h-3 w-3" /> Plan
          </button>
          <button
            onClick={() => onRunInBackgroundChange(!runInBackground)}
            className={cn(
              "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors border",
              runInBackground
                ? "bg-primary/10 text-primary border-primary/30"
                : "text-muted-foreground border-border hover:text-foreground",
            )}
          >
            <ServerCog className="h-3 w-3" /> Background
          </button>
          {!isMultiRow && (
            <span className="ml-auto text-[9px] text-muted-foreground/40">
              ⌘↩ send · Shift+↩ add task
            </span>
          )}
        </div>
      )}
    </div>
  );
}
