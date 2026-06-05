import { useState } from "react";
import { Brain, Check, Loader2, Pencil, Trash2, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledge,
  getListKnowledgeQueryKey,
  type KnowledgeEntry,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { authFetch } from "@/lib/api-fetch";
import { useToast } from "@/hooks/use-toast";
import {
  getReferenceSavedMemories,
  setReferenceSavedMemories,
  getAutoSaveMemories,
  setAutoSaveMemories,
} from "@/lib/ora-memory-settings";

/**
 * In-chat memory manager. Lets the user review and delete their saved Ora
 * memories without leaving the chat, and exposes the two preferences that
 * govern memory behaviour: whether Ora references saved memories when replying,
 * and whether high-confidence candidates are auto-saved.
 */
export function OraMemoryManager({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");

  // Mirror the persisted toggles in local state so the switches react instantly.
  const [referenceSaved, setReferenceSavedState] = useState(getReferenceSavedMemories);
  const [autoSave, setAutoSaveState] = useState(getAutoSaveMemories);

  const params = { scope: "user" as const, archived: false, limit: 100 };
  const {
    data: entries = [],
    isLoading,
    refetch,
  } = useListKnowledge(params, {
    query: { queryKey: getListKnowledgeQueryKey(params), enabled: open },
  });

  const memories = entries.filter((e: KnowledgeEntry) => e.type === "note");

  const handleForget = async (id: number) => {
    setBusyId(id);
    try {
      const res = await authFetch(`/api/knowledge/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed with status ${res.status}`);
      void refetch();
      void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey(params) });
      toast({ title: "Memory forgotten" });
    } catch {
      toast({ title: "Failed to forget memory", variant: "destructive" });
    } finally {
      setBusyId(null);
    }
  };

  const handleEditStart = (m: KnowledgeEntry) => {
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
      const res = await authFetch(`/api/knowledge/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title || content, content }),
      });
      if (!res.ok) throw new Error(`Update failed with status ${res.status}`);
      void refetch();
      void queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey(params) });
      toast({ title: "Memory updated" });
      handleEditCancel();
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
              <p className="text-sm font-medium text-foreground">Auto-save clear memories</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Automatically save facts when you explicitly ask Ora to remember them.
              </p>
            </div>
            <Switch
              checked={autoSave}
              disabled={!referenceSaved}
              onCheckedChange={handleAutoSaveToggle}
            />
          </div>
        </div>

        <div className="mt-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            Saved memories
          </p>
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading…
            </div>
          ) : memories.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No saved memories yet. When Ora detects a durable fact, save it from the chat.
            </p>
          ) : (
            <ul className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {memories.map((m: KnowledgeEntry) =>
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
                      <p className="text-sm font-medium text-foreground truncate">{m.title}</p>
                      <p className="text-xs text-muted-foreground break-words mt-0.5">
                        {m.content}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
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
                ),
              )}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
