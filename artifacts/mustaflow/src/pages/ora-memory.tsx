import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Brain,
  User,
  Bookmark,
  SlidersHorizontal,
  History,
  ShieldAlert,
  Save,
  Loader2,
  Search,
  Pencil,
  Trash2,
  Check,
  Plus,
  X,
  MessageSquare,
  AlertTriangle,
} from "lucide-react";
import { OraSidebar } from "@/components/layout/ora-sidebar";
import { OraConversationsProvider } from "@/hooks/use-ora-conversations";
import { useOraConversations } from "@/hooks/ora-conversations-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { fetchOraProfile, saveOraProfile, type OraProfileInput } from "@/lib/ora-profile";
import {
  fetchOraMemories,
  createOraMemory,
  updateOraMemory,
  deleteOraMemory,
  clearOraMemories,
  clearOraConversations,
  type OraMemory,
} from "@/lib/ora-memories";
import {
  getReferenceSavedMemories,
  setReferenceSavedMemories,
  getReferenceChatHistory,
  setReferenceChatHistory,
  getAutoSaveMemories,
  setAutoSaveMemories,
  getAskBeforeSensitive,
  setAskBeforeSensitive,
} from "@/lib/ora-memory-settings";

type TabId = "profile" | "memories" | "preferences" | "history" | "data";

const TABS: { id: TabId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "profile", label: "Profile", icon: User },
  { id: "memories", label: "Saved Memories", icon: Bookmark },
  { id: "preferences", label: "Preferences", icon: SlidersHorizontal },
  { id: "history", label: "History", icon: History },
  { id: "data", label: "Data Controls", icon: ShieldAlert },
];

/* ─── Profile tab ──────────────────────────────────────────────────────────── */

const EMPTY_PROFILE: OraProfileInput = {
  preferredName: "",
  occupation: "",
  industry: "",
  goals: "",
  skillLevel: "",
  preferredLanguage: "",
  responseStyle: "",
  avoid: "",
};

function Field({
  label,
  hint,
  value,
  onChange,
  textarea,
  placeholder,
  maxLength,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
  placeholder?: string;
  maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {textarea ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      ) : (
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      )}
    </div>
  );
}

function ProfileTab() {
  const { toast } = useToast();
  const [form, setForm] = useState<OraProfileInput>(EMPTY_PROFILE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const profile = await fetchOraProfile();
        if (!cancelled && profile) {
          setForm({
            preferredName: profile.preferredName ?? "",
            occupation: profile.occupation ?? "",
            industry: profile.industry ?? "",
            goals: profile.goals ?? "",
            skillLevel: profile.skillLevel ?? "",
            preferredLanguage: profile.preferredLanguage ?? "",
            responseStyle: profile.responseStyle ?? "",
            avoid: profile.avoid ?? "",
          });
        }
      } catch {
        if (!cancelled) toast({ title: "Could not load your profile", variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const set = (key: keyof OraProfileInput) => (v: string) => setForm((f) => ({ ...f, [key]: v }));

  async function handleSave() {
    setSaving(true);
    try {
      await saveOraProfile(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch {
      toast({ title: "Could not save your profile", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading your profile
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Tell Ora about yourself. These details are applied to every Ora conversation to make replies
        more relevant — they are never shared with the AI Builder.
      </p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Preferred name"
          value={form.preferredName ?? ""}
          onChange={set("preferredName")}
          placeholder="What should Ora call you?"
          maxLength={200}
        />
        <Field
          label="Preferred language"
          value={form.preferredLanguage ?? ""}
          onChange={set("preferredLanguage")}
          placeholder="e.g. English, Spanish"
          maxLength={200}
        />
        <Field
          label="Occupation"
          value={form.occupation ?? ""}
          onChange={set("occupation")}
          placeholder="e.g. Product designer"
          maxLength={200}
        />
        <Field
          label="Industry"
          value={form.industry ?? ""}
          onChange={set("industry")}
          placeholder="e.g. Healthcare"
          maxLength={200}
        />
        <Field
          label="Skill level"
          value={form.skillLevel ?? ""}
          onChange={set("skillLevel")}
          placeholder="e.g. Beginner, Expert"
          maxLength={200}
        />
      </div>
      <Field
        label="Goals"
        hint="What are you trying to accomplish with Ora?"
        value={form.goals ?? ""}
        onChange={set("goals")}
        textarea
        maxLength={2000}
      />
      <Field
        label="Preferred response style"
        hint="How should Ora respond? e.g. concise, detailed, formal, casual."
        value={form.responseStyle ?? ""}
        onChange={set("responseStyle")}
        textarea
        maxLength={2000}
      />
      <Field
        label="Things to avoid"
        hint="Anything Ora should steer clear of in its responses."
        value={form.avoid ?? ""}
        onChange={set("avoid")}
        textarea
        maxLength={2000}
      />
      <div className="flex items-center gap-3">
        <button
          onClick={() => void handleSave()}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Save className="h-3.5 w-3.5" />
          )}
          {saving ? "Saving…" : "Save profile"}
        </button>
        {saved && <span className="text-sm text-green-500">Saved</span>}
      </div>
    </div>
  );
}

/* ─── Saved Memories tab ───────────────────────────────────────────────────── */

function MemoryRow({
  memory,
  onToggle,
  onSave,
  onDelete,
}: {
  memory: OraMemory;
  onToggle: (enabled: boolean) => void;
  onSave: (patch: { title: string; content: string }) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(memory.title);
  const [content, setContent] = useState(memory.content);

  const commit = () => {
    if (title.trim()) onSave({ title: title.trim(), content: content.trim() });
    setEditing(false);
  };

  return (
    <div
      className={cn(
        "rounded-lg border px-4 py-3 transition-colors",
        memory.enabled ? "border-border bg-card" : "border-border/50 bg-muted/30 opacity-70",
      )}
    >
      {editing ? (
        <div className="space-y-2">
          <input
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={commit}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
            >
              <Check className="h-3 w-3" />
              Save
            </button>
            <button
              onClick={() => {
                setTitle(memory.title);
                setContent(memory.content);
                setEditing(false);
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">{memory.title}</p>
            {memory.content && (
              <p className="mt-0.5 text-sm text-muted-foreground whitespace-pre-wrap break-words">
                {memory.content}
              </p>
            )}
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {new Date(memory.createdAt).toLocaleDateString()}
              {!memory.enabled && " · Paused"}
            </p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <Switch
              checked={memory.enabled}
              onCheckedChange={onToggle}
              aria-label="Let Ora use this memory"
            />
            <button
              onClick={() => setEditing(true)}
              aria-label="Edit memory"
              className="p-1.5 text-muted-foreground hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onDelete}
              aria-label="Delete memory"
              className="p-1.5 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoriesTab() {
  const { toast } = useToast();
  const [memories, setMemories] = useState<OraMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await fetchOraMemories();
        if (!cancelled) setMemories(rows);
      } catch {
        if (!cancelled) toast({ title: "Could not load memories", variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [toast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return memories;
    return memories.filter(
      (m) => m.title.toLowerCase().includes(q) || (m.content ?? "").toLowerCase().includes(q),
    );
  }, [memories, query]);

  async function handleToggle(m: OraMemory, enabled: boolean) {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled } : x)));
    try {
      await updateOraMemory(m.id, { enabled });
    } catch {
      setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !enabled } : x)));
      toast({ title: "Could not update memory", variant: "destructive" });
    }
  }

  async function handleSave(m: OraMemory, patch: { title: string; content: string }) {
    const prev = memories;
    setMemories((cur) => cur.map((x) => (x.id === m.id ? { ...x, ...patch } : x)));
    try {
      await updateOraMemory(m.id, patch);
    } catch {
      setMemories(prev);
      toast({ title: "Could not save memory", variant: "destructive" });
    }
  }

  async function handleDelete(m: OraMemory) {
    if (!window.confirm("Delete this memory? Ora will forget it.")) return;
    const prev = memories;
    setMemories((cur) => cur.filter((x) => x.id !== m.id));
    try {
      await deleteOraMemory(m.id);
    } catch {
      setMemories(prev);
      toast({ title: "Could not delete memory", variant: "destructive" });
    }
  }

  function resetAddForm() {
    setAdding(false);
    setNewTitle("");
    setNewContent("");
  }

  async function handleCreate() {
    const title = newTitle.trim();
    if (!title || saving) return;
    setSaving(true);
    try {
      const created = await createOraMemory({ title, content: newContent.trim() });
      setMemories((prev) => [created, ...prev]);
      resetAddForm();
    } catch {
      toast({ title: "Could not save memory", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading memories
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Memories Ora has saved about you. Pause one to keep it without letting Ora reference it,
          or delete it entirely.
        </p>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-3.5 w-3.5" />
            Add memory
          </button>
        )}
      </div>
      {adding && (
        <div className="space-y-2 rounded-lg border border-border bg-card px-4 py-3">
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="What should Ora remember?"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            rows={2}
            placeholder="Add detail (optional)"
            className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={() => void handleCreate()}
              disabled={!newTitle.trim() || saving}
              className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Check className="h-3 w-3" />
              )}
              Save
            </button>
            <button
              onClick={resetAddForm}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}
      {memories.length > 0 && (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search memories"
            className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
      )}
      {memories.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <Bookmark className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">No saved memories yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Ask Ora to remember something in chat, or add a memory here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No memories match your search.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((m) => (
            <MemoryRow
              key={m.id}
              memory={m}
              onToggle={(enabled) => void handleToggle(m, enabled)}
              onSave={(patch) => void handleSave(m, patch)}
              onDelete={() => void handleDelete(m)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Preferences tab ──────────────────────────────────────────────────────── */

function PreferenceToggle({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-border/60 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}

function PreferencesTab() {
  const [referenceSaved, setReferenceSavedState] = useState(getReferenceSavedMemories);
  const [referenceHistory, setReferenceHistoryState] = useState(getReferenceChatHistory);
  const [autoSave, setAutoSaveState] = useState(getAutoSaveMemories);
  const [askSensitive, setAskSensitiveState] = useState(getAskBeforeSensitive);

  const handleReference = (v: boolean) => {
    setReferenceSavedState(v);
    setReferenceSavedMemories(v);
    if (!v && autoSave) {
      setAutoSaveState(false);
      setAutoSaveMemories(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Control what Ora remembers and references. These preferences are stored on this device.
      </p>
      <div className="space-y-3">
        <PreferenceToggle
          title="Reference saved memories"
          description="Let Ora use your saved memories when replying."
          checked={referenceSaved}
          onChange={handleReference}
        />
        <PreferenceToggle
          title="Reference chat history"
          description="Let Ora consider earlier messages in the current conversation for more relevant replies."
          checked={referenceHistory}
          onChange={(v) => {
            setReferenceHistoryState(v);
            setReferenceChatHistory(v);
          }}
        />
        <PreferenceToggle
          title="Auto-save memories"
          description="Automatically save facts when you explicitly ask Ora to remember them."
          checked={autoSave}
          disabled={!referenceSaved}
          onChange={(v) => {
            setAutoSaveState(v);
            setAutoSaveMemories(v);
          }}
        />
        <PreferenceToggle
          title="Ask before saving sensitive info"
          description="Always confirm before Ora saves anything that looks sensitive, like passwords or financial details."
          checked={askSensitive}
          onChange={(v) => {
            setAskSensitiveState(v);
            setAskBeforeSensitive(v);
          }}
        />
      </div>
    </div>
  );
}

/* ─── History tab ──────────────────────────────────────────────────────────── */

function HistoryTab() {
  const {
    conversations,
    projects,
    currentConversationId,
    selectConversation,
    renameConversation,
    deleteConversation,
  } = useOraConversations();
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  const projectName = useMemo(() => {
    const map = new Map<number, string>();
    for (const p of projects) map.set(p.id, p.name);
    return map;
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = [...conversations].sort(
      (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime(),
    );
    if (!q) return sorted;
    return sorted.filter(
      (c) =>
        (c.title ?? "").toLowerCase().includes(q) || (c.preview ?? "").toLowerCase().includes(q),
    );
  }, [conversations, query]);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        All your Ora conversations. Open one to pick up where you left off, or rename and delete
        them here.
      </p>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search conversations"
          className="w-full rounded-md border border-border bg-background py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>
      {conversations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <MessageSquare className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">No conversations yet</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Start chatting with Ora and your history will appear here.
          </p>
        </div>
      ) : filtered.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No conversations match your search.
        </p>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => {
            const isEditing = editingId === c.id;
            const label = c.title?.trim() || "New chat";
            return (
              <div
                key={c.id}
                className={cn(
                  "group rounded-lg border px-4 py-3 transition-colors",
                  c.id === currentConversationId
                    ? "border-primary/40 bg-primary/5"
                    : "border-border bg-card hover:bg-muted/50",
                )}
              >
                {isEditing ? (
                  <div className="flex items-center gap-2">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const t = draft.trim();
                          if (t && t !== c.title) void renameConversation(c.id, t);
                          setEditingId(null);
                        }
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={() => {
                        const t = draft.trim();
                        if (t && t !== c.title) void renameConversation(c.id, t);
                        setEditingId(null);
                      }}
                      aria-label="Save name"
                      className="p-1.5 text-muted-foreground hover:text-foreground"
                    >
                      <Check className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                      className="p-1.5 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <button
                      onClick={() => {
                        selectConversation(c.id);
                        navigate("/ora");
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">
                          {label}
                        </span>
                        {c.projectId != null && projectName.has(c.projectId) && (
                          <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                            {projectName.get(c.projectId)}
                          </span>
                        )}
                      </div>
                      {c.preview && (
                        <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.preview}</p>
                      )}
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {new Date(c.lastMessageAt).toLocaleString()}
                      </p>
                    </button>
                    <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        onClick={() => {
                          setDraft(c.title ?? "");
                          setEditingId(c.id);
                        }}
                        aria-label="Rename conversation"
                        className="p-1.5 text-muted-foreground hover:text-foreground"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => {
                          if (window.confirm("Delete this conversation?"))
                            void deleteConversation(c.id);
                        }}
                        aria-label="Delete conversation"
                        className="p-1.5 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ─── Data Controls tab ────────────────────────────────────────────────────── */

function DangerCard({
  title,
  description,
  buttonLabel,
  busy,
  onConfirm,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <button
          onClick={onConfirm}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          {buttonLabel}
        </button>
      </div>
    </div>
  );
}

function DataControlsTab() {
  const { toast } = useToast();
  const { refresh } = useOraConversations();
  const [clearingMemories, setClearingMemories] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  async function handleClearMemories() {
    if (
      !window.confirm("Delete ALL saved memories? Ora will forget everything it knows about you.")
    )
      return;
    setClearingMemories(true);
    try {
      await clearOraMemories();
      toast({ title: "All memories cleared" });
    } catch {
      toast({ title: "Could not clear memories", variant: "destructive" });
    } finally {
      setClearingMemories(false);
    }
  }

  async function handleClearHistory() {
    if (!window.confirm("Delete ALL conversation history? This cannot be undone.")) return;
    setClearingHistory(true);
    try {
      await clearOraConversations();
      await refresh();
      toast({ title: "All conversation history cleared" });
    } catch {
      toast({ title: "Could not clear history", variant: "destructive" });
    } finally {
      setClearingHistory(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Manage your Ora data. These actions only affect Ora — your AI Builder projects and their
        data are never touched.
      </p>
      <DangerCard
        title="Clear all saved memories"
        description="Permanently removes every memory Ora has saved about you."
        buttonLabel="Clear memories"
        busy={clearingMemories}
        onConfirm={() => void handleClearMemories()}
      />
      <DangerCard
        title="Clear all conversation history"
        description="Permanently removes all of your Ora conversations."
        buttonLabel="Clear history"
        busy={clearingHistory}
        onConfirm={() => void handleClearHistory()}
      />
    </div>
  );
}

/* ─── Page shell ───────────────────────────────────────────────────────────── */

function OraMemoryInner() {
  const { newConversation } = useOraConversations();
  const [, navigate] = useLocation();
  const [tab, setTab] = useState<TabId>("profile");
  const mainRef = useRef<HTMLDivElement>(null);

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <OraSidebar
        onNewConversation={() => {
          newConversation();
          navigate("/ora");
        }}
      />

      <div className="fixed top-3 right-3 z-50">
        <ThemeToggle />
      </div>

      <main className="flex-1 px-4 py-12 sm:py-16" ref={mainRef}>
        <div className="mx-auto w-full max-w-2xl space-y-8">
          <div className="space-y-2">
            <Link
              href="/ora"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to chat
            </Link>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10">
                <Brain className="h-5 w-5 text-primary" />
              </span>
              <div>
                <h1 className="text-2xl font-extrabold tracking-tight">Memory</h1>
                <p className="text-sm text-muted-foreground">
                  Manage what Ora knows about you and your conversation history.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-border">
            {TABS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={cn(
                  "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition-colors -mb-px",
                  tab === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          <div>
            {tab === "profile" && <ProfileTab />}
            {tab === "memories" && <MemoriesTab />}
            {tab === "preferences" && <PreferencesTab />}
            {tab === "history" && <HistoryTab />}
            {tab === "data" && <DataControlsTab />}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function OraMemoryPage() {
  return (
    <OraConversationsProvider>
      <OraMemoryInner />
    </OraConversationsProvider>
  );
}
