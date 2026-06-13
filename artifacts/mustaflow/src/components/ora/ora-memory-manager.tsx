import { useCallback, useEffect, useState } from "react";
import { Brain, Check, FileText, Loader2, Pencil, Trash2, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  fetchOraMemories,
  fetchOraMemoryUsage,
  updateOraMemory,
  deleteOraMemory,
  type OraMemory,
  type OraMemoryUsage,
} from "@/lib/ora-memories";
import {
  getReferenceSavedMemories,
  setReferenceSavedMemories,
  getAutoSaveMemories,
  setAutoSaveMemories,
} from "@/lib/ora-memory-settings";
import { ORA_MEMORY_CATEGORY_LABELS, normalizeOraMemoryCategory } from "@/lib/ora-memories";
import { cn } from "@/lib/utils";

/**
 * In-chat memory manager. Lets the user review and delete their saved Ora
 * memories without leaving the chat, and exposes the two preferences that
 * govern memory behaviour: whether Ora references saved memories when replying,
 * and whether high-confidence candidates are auto-saved.
 *
 * Reads/writes go through the Ora memory endpoints (`/api/ora/memories`), which
 * are isolated from the Builder Knowledge Vault (origin="ora"). When an
 * `oraProjectId` is supplied, this also surfaces that project's persistent
 * memories in a dedicated section alongside the user-level ones.
 */
/**
 * Capacity meter for saved memories. Turns amber when nearing the cap (>=80%)
 * and red when full, so the user understands why new saves may be blocked.
 */
function MemoryUsageMeter({ count, limit }: { count: number; limit: number }) {
  const pct = Math.min(100, Math.round((count / limit) * 100));
  const full = count >= limit;
  const near = !full && pct >= 80;
  const barColor = full ? "bg-destructive" : near ? "bg-amber-500" : "bg-[hsl(265_85%_65%)]";
  return (
    <div className="rounded-lg border border-border/60 px-3 py-2.5">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-foreground">Memory capacity</p>
        <p className="text-xs font-medium text-muted-foreground tabular-nums">
          {count} / {limit}
        </p>
      </div>
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", barColor)}
          style={{ width: `${pct}%` }}
        />
      </div>
      {full ? (
        <p className="mt-1.5 text-xs text-destructive">
          You've reached your memory limit. Forget a memory to save new ones.
        </p>
      ) : near ? (
        <p className="mt-1.5 text-xs text-amber-500">
          You're nearing your memory limit. Consider forgetting old memories.
        </p>
      ) : null}
    </div>
  );
}

export function OraMemoryManager({
  open,
  onOpenChange,
  oraProjectId = null,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** When set, also show/manage this Ora project's persistent memories. */
  oraProjectId?: number | null;
}) {
  const { toast } = useToast();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  const [userMemories, setUserMemories] = useState<OraMemory[]>([]);
  const [projectMemories, setProjectMemories] = useState<OraMemory[]>([]);
  const [usage, setUsage] = useState<OraMemoryUsage | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Mirror the persisted toggles in local state so the switches react instantly.
  const [referenceSaved, setReferenceSavedState] = useState(getReferenceSavedMemories);
  const [autoSave, setAutoSaveState] = useState(getAutoSaveMemories);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const [u, p, usageRes] = await Promise.all([
        fetchOraMemories(),
        typeof oraProjectId === "number"
          ? fetchOraMemories(oraProjectId)
          : Promise.resolve([] as OraMemory[]),
        fetchOraMemoryUsage().catch(() => null),
      ]);
      setUserMemories(u);
      setProjectMemories(p);
      setUsage(usageRes);
    } catch {
      toast({ title: "Failed to load memories", variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }, [oraProjectId, toast]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleForget = async (id: number) => {
    setBusyId(id);
    try {
      await deleteOraMemory(id);
      await load();
      toast({ title: "Memory forgotten" });
    } catch {
      toast({ title: "Failed to forget memory", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleEditStart = (m: OraMemory) => {
    setEditingId(m.id);
    setEditTitle(m.title);
    setEditContent(m.content);
  };

  const handleEditCancel = () => {
    setEditingId(null);
    setEditTitle("");
    setEditContent("");
  };

  const handleEditSave = async (id: number) => {
    const title = editTitle.trim();
    const content = editContent.trim();
    if (!content) {
      toast({ title: "Memory can't be empty", variant: "destructive" });
      return;
    }
    setBusyId(id);
    try {
      await updateOraMemory(id, { title: title || content, content });
      await load();
      toast({ title: "Memory updated" });
      handleEditCancel();
    } catch {
      toast({ title: "Failed to update memory", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleEnabledToggle = async (m: OraMemory, enabled: boolean) => {
    setBusyId(m.id);
    try {
      await updateOraMemory(m.id, { enabled });
      await load();
      toast({ title: enabled ? "Memory enabled" : "Memory disabled" });
    } catch {
      toast({ title: "Failed to update memory", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleReferenceToggle = (v: boolean) => {
    setReferenceSavedState(v);
    setReferenceSavedMemories(v);
    // Auto-save is meaningless when Ora never reads memories back, so turn it off.
    if (!v && autoSave) {
      setAutoSaveState(false);
      setAutoSaveMemories(false);
    }
  };

  const handleAutoSaveToggle = (v: boolean) => {
    setAutoSaveState(v);
    setAutoSaveMemories(v);
  };

  const renderMemory = (m: OraMemory) =>
    editingId === m.id ? (
      <li key={m.id} className="rounded-lg border border-border/60 px-3 py-2 space-y-2">
        <textarea
          aria-label="Edit memory"
          value={editContent}
          onChange={(e) => {
            setEditContent(e.target.value);
            setEditTitle(e.target.value);
          }}
          rows={3}
          className="w-full resize-none rounded-md border border-border/60 bg-background px-2.5 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-[hsl(265_85%_65%)]"
        />
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            aria-label="Cancel edit"
            onClick={handleEditCancel}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/60 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
            Cancel
          </button>
          <button
            type="button"
            aria-label="Save memory edit"
            disabled={busyId === m.id}
            onClick={() => void handleEditSave(m.id)}
            className="inline-flex items-center gap-1 rounded-md bg-[hsl(265_85%_65%/0.15)] px-2 py-1 text-[11px] font-medium text-[hsl(265_85%_65%)] hover:bg-[hsl(265_85%_65%/0.25)] transition-colors disabled:opacity-50"
          >
            {busyId === m.id ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            Save
          </button>
        </div>
      </li>
    ) : (
      <li
        key={m.id}
        className="flex items-start justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
      >
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium text-foreground truncate flex items-center gap-1.5">
              {m.category === "document" && (
                <FileText className="h-3.5 w-3.5 shrink-0 text-[hsl(265_85%_65%)]" />
              )}
              <span className="truncate">{m.title}</span>
            </p>
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {ORA_MEMORY_CATEGORY_LABELS[normalizeOraMemoryCategory(m.category)]}
            </span>
          </div>
          {m.category === "document" && (
            <span className="mt-0.5 inline-block rounded bg-[hsl(265_85%_65%/0.12)] px-1.5 py-0.5 text-[10px] font-medium text-[hsl(265_85%_65%)]">
              From document
            </span>
          )}
          <p
            className={cn(
              "text-xs text-muted-foreground break-words mt-0.5",
              !m.enabled && "line-through opacity-70",
            )}
          >
            {m.content}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <div className="mr-1 flex items-center gap-1.5 rounded-md px-1.5 py-1">
            <span className="sr-only" id={`ora-memory-enabled-${m.id}`}>
              Reference memory
            </span>
            <Switch
              aria-labelledby={`ora-memory-enabled-${m.id}`}
              checked={m.enabled}
              disabled={busyId === m.id}
              onCheckedChange={(checked) => void handleEnabledToggle(m, checked)}
            />
          </div>
          <button
            type="button"
            aria-label="Edit memory"
            disabled={busyId === m.id}
            onClick={() => handleEditStart(m)}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-50"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Forget memory"
            disabled={busyId === m.id}
            onClick={() => void handleForget(m.id)}
            className="rounded-md p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
          >
            {busyId === m.id ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Trash2 className="h-4 w-4" />
            )}
          </button>
        </div>
      </li>
    );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-[hsl(265_85%_65%)]" />
            Ora memory
          </DialogTitle>
          <DialogDescription>
            Review what Ora remembers about you, and control how memories are used.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Reference saved memories</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Let Ora use your saved memories when replying.
              </p>
            </div>
            <Switch checked={referenceSaved} onCheckedChange={handleReferenceToggle} />
          </div>

          <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">Auto-save memories</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Automatically save durable facts Ora detects. Sensitive details still ask first.
              </p>
            </div>
            <Switch
              checked={autoSave}
              disabled={!referenceSaved}
              onCheckedChange={handleAutoSaveToggle}
            />
          </div>

          {usage && usage.limit > 0 && <MemoryUsageMeter count={usage.count} limit={usage.limit} />}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <div className="mt-1 space-y-4 max-h-72 overflow-y-auto pr-1">
            {typeof oraProjectId === "number" && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                  This project
                </p>
                {projectMemories.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No project memories yet. Memories you save while in this project stay with it.
                  </p>
                ) : (
                  <ul className="space-y-2">{projectMemories.map(renderMemory)}</ul>
                )}
              </div>
            )}

            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                {typeof oraProjectId === "number" ? "About you" : "Saved memories"}
              </p>
              {userMemories.length === 0 ? (
                <p className="py-4 text-center text-sm text-muted-foreground">
                  No saved memories yet. When Ora detects a durable fact, save it from the chat.
                </p>
              ) : (
                <ul className="space-y-2">{userMemories.map(renderMemory)}</ul>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
