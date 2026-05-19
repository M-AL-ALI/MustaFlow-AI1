import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListKnowledge,
  useCreateKnowledge,
  useUpdateKnowledge,
  useDeleteKnowledge,
  getListKnowledgeQueryKey,
} from "@workspace/api-client-react";
import type { KnowledgeEntry, KnowledgeInput, KnowledgeUpdate } from "@workspace/api-client-react";
import {
  Plus,
  Pencil,
  Trash2,
  BookOpen,
  X,
  AlertTriangle,
} from "lucide-react";

const CATEGORIES = ["lesson", "pattern", "fix", "diagnostic", "note"] as const;
const SEVERITIES = ["info", "warning", "error"] as const;
const TYPES = [
  "note",
  "test_report",
  "secret_warning",
  "integration_needed",
  "build",
  "refine",
  "rollback",
  "publish",
  "publish_failed",
  "duplicate",
] as const;

type Category = (typeof CATEGORIES)[number];
type Severity = (typeof SEVERITIES)[number];
type KnowledgeType = (typeof TYPES)[number];

interface EntryFormValues {
  title: string;
  content: string;
  category: Category;
  type: KnowledgeType;
  severity: Severity;
}

const emptyForm = (): EntryFormValues => ({
  title: "",
  content: "",
  category: "note",
  type: "note",
  severity: "info",
});

export default function KnowledgePage() {
  const queryClient = useQueryClient();
  const { data: knowledge, isLoading } = useListKnowledge();
  const createMutation = useCreateKnowledge();
  const updateMutation = useUpdateKnowledge();
  const deleteMutation = useDeleteKnowledge();

  const [showModal, setShowModal] = useState(false);
  const [editEntry, setEditEntry] = useState<KnowledgeEntry | null>(null);
  const [deleteEntry, setDeleteEntry] = useState<KnowledgeEntry | null>(null);
  const [form, setForm] = useState<EntryFormValues>(emptyForm());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openCreate = () => {
    setEditEntry(null);
    setForm(emptyForm());
    setSaveError(null);
    setShowModal(true);
  };

  const openEdit = (entry: KnowledgeEntry) => {
    setEditEntry(entry);
    setForm({
      title: entry.title,
      content: entry.content,
      category: (entry.category as Category) ?? "note",
      type: (entry.type as KnowledgeType) ?? "note",
      severity: (entry.severity as Severity) ?? "info",
    });
    setSaveError(null);
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditEntry(null);
    setSaveError(null);
  };

  const handleSave = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      setSaveError("Title and content are required.");
      return;
    }
    setSaveError(null);
    try {
      if (editEntry) {
        await updateMutation.mutateAsync({
          id: editEntry.id,
          data: { title: form.title, content: form.content, category: form.category, type: form.type, severity: form.severity } as KnowledgeUpdate,
        });
      } else {
        await createMutation.mutateAsync({
          data: { title: form.title, content: form.content, category: form.category, type: form.type, severity: form.severity } as KnowledgeInput,
        });
      }
      await queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
      closeModal();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : "Failed to save entry");
    }
  };

  const handleDelete = async () => {
    if (!deleteEntry) return;
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync({ id: deleteEntry.id });
      await queryClient.invalidateQueries({ queryKey: getListKnowledgeQueryKey() });
      setDeleteEntry(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Failed to delete entry");
    }
  };

  const saving = createMutation.isPending || updateMutation.isPending;
  const deleting = deleteMutation.isPending;

  const categoryBadgeColor = (c?: string) => {
    if (c === "fix") return "bg-green-500/10 text-green-600";
    if (c === "lesson") return "bg-blue-500/10 text-blue-500";
    if (c === "pattern") return "bg-purple-500/10 text-purple-500";
    if (c === "diagnostic") return "bg-yellow-500/10 text-yellow-600";
    return "bg-muted text-muted-foreground";
  };

  const severityColor = (s?: string) => {
    if (s === "error") return "text-destructive";
    if (s === "warning") return "text-yellow-500";
    return "";
  };

  const formatType = (t?: string) =>
    t ? t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "";

  return (
    <div className="p-8 max-w-7xl mx-auto w-full">
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <BookOpen className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Knowledge Vault</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Shared learnings and patterns across your builds.
            </p>
          </div>
        </div>
        <button
          onClick={openCreate}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Entry
        </button>
      </div>

      {isLoading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="border border-border rounded-lg p-4 bg-card animate-pulse h-20" />
          ))}
        </div>
      )}

      {!isLoading && knowledge && knowledge.length === 0 && (
        <div className="border border-dashed border-border rounded-lg p-12 text-center text-muted-foreground">
          <BookOpen className="h-8 w-8 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No knowledge entries yet</p>
          <p className="text-sm mt-1">
            Entries are created automatically after builds and refines, or you can add them manually.
          </p>
        </div>
      )}

      {!isLoading && knowledge && knowledge.length > 0 && (
        <div className="grid gap-3">
          {knowledge.map((entry) => (
            <div
              key={entry.id}
              className="border border-border rounded-lg p-4 bg-card flex items-start justify-between gap-4 group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className="font-medium truncate">{entry.title}</span>
                  <span
                    className={`text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${categoryBadgeColor(entry.category)}`}
                  >
                    {entry.category}
                  </span>
                  {entry.type && entry.type !== "note" && (
                    <span className="text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded bg-muted/60 text-muted-foreground">
                      {formatType(entry.type)}
                    </span>
                  )}
                  {entry.severity && entry.severity !== "info" && (
                    <span className={`text-[10px] font-semibold uppercase ${severityColor(entry.severity)}`}>
                      {entry.severity}
                    </span>
                  )}
                </div>
                <p className="text-sm text-muted-foreground line-clamp-2">{entry.content}</p>
                <p className="text-xs text-muted-foreground/60 mt-1">
                  {new Date(entry.createdAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
              <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <button
                  onClick={() => openEdit(entry)}
                  title="Edit"
                  className="p-1.5 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  onClick={() => { setDeleteError(null); setDeleteEntry(entry); }}
                  title="Delete"
                  className="p-1.5 rounded hover:bg-destructive/10 transition-colors text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg">
            <div className="flex items-center justify-between px-6 py-4 border-b border-border">
              <h2 className="text-lg font-semibold">
                {editEntry ? "Edit Entry" : "New Knowledge Entry"}
              </h2>
              <button
                onClick={closeModal}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="Brief descriptive title"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="text-sm font-medium">Type</label>
                  <select
                    value={form.type}
                    onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as KnowledgeType }))}
                    className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {TYPES.map((t) => (
                      <option key={t} value={t}>
                        {formatType(t)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Category</label>
                  <select
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as Category }))}
                    className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c.charAt(0).toUpperCase() + c.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-sm font-medium">Severity</label>
                  <select
                    value={form.severity}
                    onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value as Severity }))}
                    className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {SEVERITIES.map((s) => (
                      <option key={s} value={s}>
                        {s.charAt(0).toUpperCase() + s.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Content</label>
                <textarea
                  value={form.content}
                  onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
                  rows={4}
                  className="w-full px-3 py-2 rounded-md border border-border bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                  placeholder="Describe the lesson, pattern, or fix in detail…"
                />
              </div>
              {saveError && (
                <p className="text-sm text-destructive">{saveError}</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
              <button
                onClick={closeModal}
                disabled={saving}
                className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleSave()}
                disabled={saving}
                className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving…" : editEntry ? "Save Changes" : "Create Entry"}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteEntry && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-sm">
            <div className="px-6 py-5 space-y-3">
              <div className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <h2 className="text-lg font-semibold">Delete entry?</h2>
              </div>
              <p className="text-sm text-muted-foreground">
                This will permanently delete{" "}
                <span className="font-medium text-foreground">"{deleteEntry.title}"</span>. This
                cannot be undone.
              </p>
              {deleteError && (
                <p className="text-sm text-destructive">{deleteError}</p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 px-6 py-4 border-t border-border">
              <button
                onClick={() => setDeleteEntry(null)}
                disabled={deleting}
                className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDelete()}
                disabled={deleting}
                className="px-4 py-2 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {deleting ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
