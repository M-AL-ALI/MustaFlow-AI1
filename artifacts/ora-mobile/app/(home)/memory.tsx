import { useAuth } from "@clerk/expo";
import { useRouter } from "expo-router";
import {
  Bookmark,
  FolderOpen,
  History,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  Shield,
  Trash2,
  User,
  X,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SignInWall } from "@/components/SignInWall";
import { Button, Card, EmptyState, Loading, Pill, TextField } from "@/components/ui";
import { useActiveProject } from "@/context/ActiveProjectContext";
import { useColors } from "@/hooks/useColors";
import {
  clearAllConversations,
  clearAllMemories,
  createMemory,
  deleteConversation,
  deleteMemory,
  getMemoryUsage,
  getProfile,
  listConversations,
  listMemories,
  listProjects,
  renameConversation,
  restoreMemory,
  updateMemory,
  updateProfile,
} from "@/lib/api";
import {
  getAskBeforeSensitive,
  getAutoSaveMemories,
  getReferenceChatHistory,
  getReferenceSavedMemories,
  loadMemorySettings,
  setAskBeforeSensitive,
  setAutoSaveMemories,
  setReferenceChatHistory,
  setReferenceSavedMemories,
} from "@/lib/memory-settings";
import type {
  MemoryUsage,
  OraConversationSummary,
  OraMemory,
  OraProfile,
  OraProjectSummary,
} from "@/lib/types";

type Tab = "profile" | "memories" | "preferences" | "history" | "data-controls" | "project";

const ORA_MEMORY_CATEGORIES: { value: string; label: string; color: string }[] = [
  { value: "preference", label: "Preference", color: "#3D83F5" },
  { value: "personal", label: "Personal", color: "#10B981" },
  { value: "project", label: "Project", color: "#F59E0B" },
  { value: "document", label: "Document", color: "#8B5CF6" },
  { value: "other", label: "Other", color: "#6B7280" },
];

function categoryMeta(value: string | null | undefined) {
  return ORA_MEMORY_CATEGORIES.find((c) => c.value === value) ?? null;
}

const PROFILE_FIELDS: { key: keyof OraProfile; label: string; multiline?: boolean }[] = [
  { key: "preferredName", label: "Preferred name" },
  { key: "occupation", label: "Occupation" },
  { key: "industry", label: "Industry" },
  { key: "goals", label: "Goals", multiline: true },
  { key: "skillLevel", label: "Skill level" },
  { key: "preferredLanguage", label: "Preferred language" },
  { key: "responseStyle", label: "Response style", multiline: true },
  { key: "avoid", label: "Things to avoid", multiline: true },
];

/* ── Main screen ─────────────────────────────────────────────────────────── */

export default function MemoryScreen() {
  const c = useColors();
  const { isSignedIn } = useAuth();
  const { activeProjectId } = useActiveProject();
  const [tab, setTab] = useState<Tab>("profile");

  if (!isSignedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScreenHeader title="Memory" subtitle="Manage what Ora knows about you and your conversation history." />
        <SignInWall
          title="Sign in for Memory"
          description="Your profile and saved memories are stored with your account."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Memory" subtitle="Manage what Ora knows about you and your conversation history." />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 12 }}>
        <Pill label="Profile" icon={User} active={tab === "profile"} onPress={() => setTab("profile")} />
        <Pill label="Saved Memories" icon={Bookmark} active={tab === "memories"} onPress={() => setTab("memories")} />
        <Pill label="Preferences" icon={Settings2} active={tab === "preferences"} onPress={() => setTab("preferences")} />
        <Pill label="History" icon={History} active={tab === "history"} onPress={() => setTab("history")} />
        <Pill label="Data Controls" icon={Shield} active={tab === "data-controls"} onPress={() => setTab("data-controls")} />
        {activeProjectId != null && (
          <Pill label="Project" icon={FolderOpen} active={tab === "project"} onPress={() => setTab("project")} />
        )}
      </View>
      {tab === "profile" ? (
        <ProfileTab />
      ) : tab === "memories" ? (
        <MemoriesTab />
      ) : tab === "preferences" ? (
        <PreferencesTab />
      ) : tab === "history" ? (
        <HistoryTab />
      ) : tab === "data-controls" ? (
        <DataControlsTab />
      ) : tab === "project" && activeProjectId != null ? (
        <ProjectMemoriesTab projectId={activeProjectId} />
      ) : null}
    </View>
  );
}

/* ── Profile tab ─────────────────────────────────────────────────────────── */

function ProfileTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [form, setForm] = useState<OraProfile>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getProfile()
      .then((p) => setForm(p ?? {}))
      .catch(() => setForm({}))
      .finally(() => setLoading(false));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      await updateProfile(form);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [form]);

  if (loading) return <Loading label="Loading profile…" />;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
          Share details so Ora can tailor every reply to you. This is private to your account.
        </Text>
        {PROFILE_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={f.label}
            value={(form[f.key] as string) ?? ""}
            onChangeText={(v) => setForm((s) => ({ ...s, [f.key]: v }))}
            multiline={f.multiline}
            style={f.multiline ? { minHeight: 80, textAlignVertical: "top" } : undefined}
          />
        ))}
        <Button label={saved ? "Saved" : "Save profile"} onPress={save} loading={saving} full />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ── Usage meter ─────────────────────────────────────────────────────────── */

function UsageMeter({ usage }: { usage: MemoryUsage | null }) {
  const c = useColors();
  if (!usage) return null;
  const pct = Math.min(100, Math.round((usage.count / usage.limit) * 100));
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Memory capacity</Text>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>{usage.count} / {usage.limit}</Text>
      </View>
      <View style={{ height: 4, borderRadius: 2, backgroundColor: c.muted, overflow: "hidden" }}>
        <View style={{ height: 4, borderRadius: 2, width: `${pct}%`, backgroundColor: pct >= 90 ? "#f87171" : c.primary }} />
      </View>
    </View>
  );
}

/* ── Category badge ──────────────────────────────────────────────────────── */

function CategoryBadge({ category }: { category: string | null | undefined }) {
  const meta = categoryMeta(category);
  if (!meta) return null;
  return (
    <View style={{ backgroundColor: `${meta.color}22`, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" }}>
      <Text style={{ color: meta.color, fontSize: 11, fontFamily: "Inter_500Medium" }}>{meta.label}</Text>
    </View>
  );
}

/* ── Category selector ───────────────────────────────────────────────────── */

function CategorySelector({ value, onSelect }: { value: string | null; onSelect: (v: string | null) => void }) {
  const c = useColors();
  return (
    <View style={{ gap: 4 }}>
      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Category</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        <Pressable
          onPress={() => onSelect(null)}
          style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: value == null ? c.primary : c.border, backgroundColor: value == null ? `${c.primary}18` : c.muted }}
        >
          <Text style={{ color: value == null ? c.primary : c.mutedForeground, fontSize: 12, fontFamily: value == null ? "Inter_600SemiBold" : "Inter_400Regular" }}>None</Text>
        </Pressable>
        {ORA_MEMORY_CATEGORIES.map((cat) => {
          const active = value === cat.value;
          return (
            <Pressable
              key={cat.value}
              onPress={() => onSelect(active ? null : cat.value)}
              style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: active ? cat.color : c.border, backgroundColor: active ? `${cat.color}22` : c.muted }}
            >
              <Text style={{ color: active ? cat.color : c.mutedForeground, fontSize: 12, fontFamily: active ? "Inter_600SemiBold" : "Inter_400Regular" }}>{cat.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/* ── Memory card ─────────────────────────────────────────────────────────── */

function MemoryCard({
  memory,
  onToggle,
  onDelete,
  onEdit,
}: {
  memory: OraMemory;
  onToggle: (m: OraMemory) => void;
  onDelete: (id: number) => void;
  onEdit?: (m: OraMemory) => void;
}) {
  const c = useColors();
  return (
    <Card style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>{memory.title}</Text>
          <CategoryBadge category={memory.category} />
        </View>
        <Switch value={memory.enabled} onValueChange={() => onToggle(memory)} trackColor={{ false: c.muted, true: c.primary }} />
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>{memory.content}</Text>
      <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
        {onEdit && (
          <Pressable onPress={() => onEdit(memory)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} hitSlop={6}>
            <Pencil size={14} color={c.mutedForeground} />
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Edit</Text>
          </Pressable>
        )}
        <Pressable onPress={() => onDelete(memory.id)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} hitSlop={6}>
          <Trash2 size={14} color="#f87171" />
          <Text style={{ color: "#f87171", fontSize: 13 }}>Delete</Text>
        </Pressable>
      </View>
    </Card>
  );
}

/* ── Superseded card ─────────────────────────────────────────────────────── */

function SupersededCard({
  memory,
  onRestore,
  onDelete,
}: {
  memory: OraMemory;
  onRestore: (m: OraMemory) => void;
  onDelete: (id: number) => void;
}) {
  const c = useColors();
  return (
    <Card style={{ gap: 8, opacity: 0.6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
        <Text style={{ color: c.mutedForeground, fontFamily: "Inter_600SemiBold", fontSize: 15, flex: 1 }}>{memory.title}</Text>
        <View style={{ borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: c.muted }}>
          <Text style={{ color: c.mutedForeground, fontSize: 11 }}>Superseded</Text>
        </View>
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>{memory.content}</Text>
      <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
        <Pressable onPress={() => onRestore(memory)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} hitSlop={6}>
          <RotateCcw size={14} color={c.primary} />
          <Text style={{ color: c.primary, fontSize: 13 }}>Restore</Text>
        </Pressable>
        <Pressable onPress={() => onDelete(memory.id)} style={{ flexDirection: "row", alignItems: "center", gap: 6 }} hitSlop={6}>
          <Trash2 size={14} color="#f87171" />
          <Text style={{ color: "#f87171", fontSize: 13 }}>Delete</Text>
        </Pressable>
      </View>
    </Card>
  );
}

/* ── Memories tab ────────────────────────────────────────────────────────── */

function MemoriesTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<OraMemory[]>([]);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newContent, setNewContent] = useState("");
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState<string | null>(null);
  const [editSaving, setEditSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [mems, usageData] = await Promise.all([listMemories(), getMemoryUsage()]);
      setMemories(mems);
      setUsage(usageData);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const add = useCallback(async () => {
    if (!newTitle.trim() || !newContent.trim()) return;
    setSaving(true);
    try {
      await createMemory(newTitle.trim(), newContent.trim(), null, newCategory);
      setNewTitle(""); setNewContent(""); setNewCategory(null); setAdding(false);
      await reload();
    } catch { /* ignore */ } finally { setSaving(false); }
  }, [newTitle, newContent, newCategory, reload]);

  const toggle = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)));
    try { await updateMemory(m.id, { enabled: !m.enabled }); }
    catch { setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: m.enabled } : x))); }
  }, []);

  const restore = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: true, supersededBy: null } : x)));
    try { await restoreMemory(m.id); } catch { await reload(); }
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    setMemories((prev) => prev.filter((x) => x.id !== id));
    try { await deleteMemory(id); } catch { /* ignore */ }
  }, []);

  const startEdit = useCallback((m: OraMemory) => {
    setEditingId(m.id);
    setEditTitle(m.title);
    setEditContent(m.content);
    setEditCategory(m.category ?? null);
  }, []);

  const saveEdit = useCallback(async () => {
    if (editingId == null || !editTitle.trim()) return;
    setEditSaving(true);
    try {
      await updateMemory(editingId, { title: editTitle.trim(), content: editContent.trim(), category: editCategory });
      setMemories((prev) => prev.map((x) => x.id === editingId ? { ...x, title: editTitle.trim(), content: editContent.trim(), category: editCategory } : x));
      setEditingId(null);
    } catch { /* ignore */ } finally { setEditSaving(false); }
  }, [editingId, editTitle, editContent, editCategory]);

  if (loading) return <Loading label="Loading memories…" />;

  const active = memories.filter((m) => m.supersededBy == null);
  const superseded = memories.filter((m) => m.supersededBy != null);
  const filtered = categoryFilter ? active.filter((m) => m.category === categoryFilter) : active;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
          Memories Ora has saved about you. Pause one to keep it without letting Ora reference it, or delete it entirely.
        </Text>

        <UsageMeter usage={usage} />

        {/* Category filter */}
        {active.length > 0 && (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            <Pressable
              onPress={() => setCategoryFilter(null)}
              style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: categoryFilter == null ? c.primary : c.border, backgroundColor: categoryFilter == null ? `${c.primary}18` : c.muted }}
            >
              <Text style={{ color: categoryFilter == null ? c.primary : c.mutedForeground, fontSize: 12, fontFamily: categoryFilter == null ? "Inter_600SemiBold" : "Inter_400Regular" }}>All</Text>
            </Pressable>
            {ORA_MEMORY_CATEGORIES.filter((cat) => active.some((m) => m.category === cat.value)).map((cat) => {
              const active2 = categoryFilter === cat.value;
              return (
                <Pressable
                  key={cat.value}
                  onPress={() => setCategoryFilter(active2 ? null : cat.value)}
                  style={{ paddingVertical: 4, paddingHorizontal: 10, borderRadius: 6, borderWidth: 1, borderColor: active2 ? cat.color : c.border, backgroundColor: active2 ? `${cat.color}22` : c.muted }}
                >
                  <Text style={{ color: active2 ? cat.color : c.mutedForeground, fontSize: 12, fontFamily: active2 ? "Inter_600SemiBold" : "Inter_400Regular" }}>{cat.label}</Text>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Add form */}
        {adding ? (
          <Card style={{ gap: 12 }}>
            <TextField label="Title" value={newTitle} onChangeText={setNewTitle} />
            <TextField label="What should Ora remember?" value={newContent} onChangeText={setNewContent} multiline style={{ minHeight: 80, textAlignVertical: "top" }} />
            <CategorySelector value={newCategory} onSelect={setNewCategory} />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label="Cancel" variant="ghost" onPress={() => { setAdding(false); setNewTitle(""); setNewContent(""); setNewCategory(null); }} style={{ flex: 1 }} />
              <Button label="Save" onPress={() => void add()} loading={saving} style={{ flex: 1 }} />
            </View>
          </Card>
        ) : (
          <Button label="Add a memory" icon={Plus} variant="secondary" onPress={() => setAdding(true)} full />
        )}

        {/* Edit form */}
        {editingId != null && (
          <Card style={{ gap: 12 }}>
            <TextField label="Title" value={editTitle} onChangeText={setEditTitle} />
            <TextField label="Content" value={editContent} onChangeText={setEditContent} multiline style={{ minHeight: 80, textAlignVertical: "top" }} />
            <CategorySelector value={editCategory} onSelect={setEditCategory} />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label="Cancel" variant="ghost" onPress={() => setEditingId(null)} style={{ flex: 1 }} />
              <Button label="Save" onPress={() => void saveEdit()} loading={editSaving} style={{ flex: 1 }} />
            </View>
          </Card>
        )}

        {active.length === 0 && superseded.length === 0 ? (
          <EmptyState icon={Bookmark} title="No saved memories" subtitle="Memories help Ora remember important facts across conversations." />
        ) : (
          <>
            {filtered.map((m) => (
              <MemoryCard key={m.id} memory={m} onToggle={toggle} onDelete={remove} onEdit={startEdit} />
            ))}
            {categoryFilter && filtered.length === 0 && (
              <Text style={{ color: c.mutedForeground, fontSize: 13, textAlign: "center" }}>No memories in this category.</Text>
            )}
            {superseded.length > 0 && (
              <>
                <Text style={{ color: c.mutedForeground, fontSize: 12, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>
                  Superseded
                </Text>
                {superseded.map((m) => (
                  <SupersededCard key={m.id} memory={m} onRestore={restore} onDelete={remove} />
                ))}
              </>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ── Project memories tab ────────────────────────────────────────────────── */

function ProjectMemoriesTab({ projectId }: { projectId: number }) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<OraMemory[]>([]);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [mems, usageData] = await Promise.all([listMemories(projectId), getMemoryUsage()]);
      setMemories(mems);
      setUsage(usageData);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { void reload(); }, [reload]);

  const add = useCallback(async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await createMemory(title.trim(), content.trim(), projectId);
      setTitle(""); setContent(""); setAdding(false);
      await reload();
    } catch { /* ignore */ } finally { setSaving(false); }
  }, [title, content, projectId, reload]);

  const toggle = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)));
    try { await updateMemory(m.id, { enabled: !m.enabled }); }
    catch { setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: m.enabled } : x))); }
  }, []);

  const restore = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: true, supersededBy: null } : x)));
    try { await restoreMemory(m.id); } catch { await reload(); }
  }, [reload]);

  const remove = useCallback(async (id: number) => {
    setMemories((prev) => prev.filter((x) => x.id !== id));
    try { await deleteMemory(id); } catch { /* ignore */ }
  }, []);

  if (loading) return <Loading label="Loading project memories…" />;

  const active = memories.filter((m) => m.supersededBy == null);
  const superseded = memories.filter((m) => m.supersededBy != null);

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
          These memories are scoped to this project and injected into every conversation within it.
        </Text>
        <UsageMeter usage={usage} />
        {adding ? (
          <Card style={{ gap: 12 }}>
            <TextField label="Title" value={title} onChangeText={setTitle} />
            <TextField label="What should Ora remember for this project?" value={content} onChangeText={setContent} multiline style={{ minHeight: 80, textAlignVertical: "top" }} />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button label="Cancel" variant="ghost" onPress={() => setAdding(false)} style={{ flex: 1 }} />
              <Button label="Save" onPress={() => void add()} loading={saving} style={{ flex: 1 }} />
            </View>
          </Card>
        ) : (
          <Button label="Add project memory" icon={Plus} variant="secondary" onPress={() => setAdding(true)} full />
        )}
        {active.length === 0 && superseded.length === 0 ? (
          <EmptyState icon={FolderOpen} title="No project memories" subtitle="Add memories that apply specifically to this project's conversations." />
        ) : (
          <>
            {active.map((m) => <MemoryCard key={m.id} memory={m} onToggle={toggle} onDelete={remove} />)}
            {superseded.length > 0 && (
              <>
                <Text style={{ color: c.mutedForeground, fontSize: 12, fontFamily: "Inter_600SemiBold", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 4 }}>Superseded</Text>
                {superseded.map((m) => <SupersededCard key={m.id} memory={m} onRestore={restore} onDelete={remove} />)}
              </>
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ── Preferences tab ─────────────────────────────────────────────────────── */

function ToggleRow({
  label,
  description,
  value,
  onValueChange,
  disabled,
}: {
  label: string;
  description?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, borderRadius: 8, borderWidth: 1, borderColor: `${c.border}99`, paddingHorizontal: 12, paddingVertical: 10 }}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: disabled ? c.mutedForeground : c.foreground, fontFamily: "Inter_500Medium", fontSize: 14 }}>{label}</Text>
        {description ? <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 17 }}>{description}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        disabled={disabled}
        trackColor={{ false: c.border, true: disabled ? c.muted : c.primary }}
        thumbColor={c.primaryForeground}
      />
    </View>
  );
}

function PreferencesTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [refSaved, setRefSavedLocal] = useState(getReferenceSavedMemories);
  const [refHistory, setRefHistoryLocal] = useState(getReferenceChatHistory);
  const [autoSave, setAutoSaveLocal] = useState(getAutoSaveMemories);
  const [askSensitive, setAskSensitiveLocal] = useState(getAskBeforeSensitive);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadMemorySettings().then(() => {
      setRefSavedLocal(getReferenceSavedMemories());
      setRefHistoryLocal(getReferenceChatHistory());
      setAutoSaveLocal(getAutoSaveMemories());
      setAskSensitiveLocal(getAskBeforeSensitive());
      setLoaded(true);
    });
  }, []);

  const handleRefSaved = (v: boolean) => {
    setRefSavedLocal(v);
    setReferenceSavedMemories(v);
    if (!v && autoSave) {
      setAutoSaveLocal(false);
      setAutoSaveMemories(false);
    }
  };
  const handleRefHistory = (v: boolean) => { setRefHistoryLocal(v); setReferenceChatHistory(v); };
  const handleAutoSave = (v: boolean) => { setAutoSaveLocal(v); setAutoSaveMemories(v); };
  const handleAskSensitive = (v: boolean) => { setAskSensitiveLocal(v); setAskBeforeSensitive(v); };

  if (!loaded) return <Loading label="Loading preferences…" />;

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }}>
      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
        Control what Ora remembers and references. These preferences are stored on this device.
      </Text>
      <ToggleRow
        label="Reference saved memories"
        description="Let Ora use your saved memories when replying."
        value={refSaved}
        onValueChange={handleRefSaved}
      />
      <ToggleRow
        label="Reference chat history"
        description="Let Ora consider earlier messages in the current conversation for more relevant replies."
        value={refHistory}
        onValueChange={handleRefHistory}
      />
      <ToggleRow
        label="Auto-save memories"
        description="Automatically save facts when you explicitly ask Ora to remember them."
        value={autoSave}
        onValueChange={handleAutoSave}
        disabled={!refSaved}
      />
      <ToggleRow
        label="Ask before saving sensitive info"
        description="Ora will ask for confirmation before saving personal or sensitive information."
        value={askSensitive}
        onValueChange={handleAskSensitive}
      />
    </ScrollView>
  );
}

/* ── History tab ─────────────────────────────────────────────────────────── */

function formatTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
  const d = Math.floor(ms / 86400000);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

function HistoryTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { setPendingConversationId } = useActiveProject();
  const [conversations, setConversations] = useState<OraConversationSummary[]>([]);
  const [projects, setProjects] = useState<OraProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameSaving, setRenameSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [convs, projs] = await Promise.all([listConversations(), listProjects()]);
      setConversations(convs);
      setProjects(projs);
    } catch {
      setConversations([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  const handleDelete = useCallback((id: number, title: string) => {
    Alert.alert(
      "Delete conversation",
      `Delete "${title}"? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            setConversations((prev) => prev.filter((c) => c.id !== id));
            try { await deleteConversation(id); } catch { await reload(); }
          },
        },
      ],
    );
  }, [reload]);

  const handleRename = useCallback(async (id: number) => {
    const trimmed = renameValue.trim();
    if (!trimmed) { setRenamingId(null); return; }
    setRenameSaving(true);
    try {
      await renameConversation(id, trimmed);
      setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
      setRenamingId(null);
    } catch { /* ignore */ } finally { setRenameSaving(false); }
  }, [renameValue]);

  if (loading) return <Loading label="Loading history…" />;

  const projectMap = new Map(projects.map((p) => [p.id, p.name]));
  const filtered = search.trim()
    ? conversations.filter((c) =>
        c.title.toLowerCase().includes(search.toLowerCase()) ||
        c.preview?.toLowerCase().includes(search.toLowerCase()),
      )
    : conversations;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
          All your Ora conversations. Open one to pick up where you left off, or rename and delete them here.
        </Text>

        {/* Search */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: c.muted, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 }}>
          <Search size={16} color={c.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Search conversations…"
            placeholderTextColor={c.mutedForeground}
            style={{ flex: 1, color: c.foreground, fontSize: 14 }}
          />
          {search.length > 0 && (
            <Pressable onPress={() => setSearch("")} hitSlop={8}>
              <X size={15} color={c.mutedForeground} />
            </Pressable>
          )}
        </View>

        {filtered.length === 0 ? (
          <EmptyState icon={History} title={search ? "No results" : "No conversations"} subtitle={search ? "Try a different search." : "Your Ora conversations will appear here."} />
        ) : (
          filtered.map((conv) => (
            <Card key={conv.id} style={{ gap: 6 }}>
              {renamingId === conv.id ? (
                <View style={{ gap: 8 }}>
                  <TextInput
                    value={renameValue}
                    onChangeText={setRenameValue}
                    autoFocus
                    style={{ color: c.foreground, fontSize: 15, fontFamily: "Inter_500Medium", borderBottomWidth: 1, borderBottomColor: c.primary, paddingVertical: 4 }}
                  />
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Button label="Cancel" variant="ghost" onPress={() => setRenamingId(null)} style={{ flex: 1 }} />
                    <Button label={renameSaving ? "Saving…" : "Save"} onPress={() => void handleRename(conv.id)} loading={renameSaving} style={{ flex: 1 }} />
                  </View>
                </View>
              ) : (
                <>
                  <Pressable
                    onPress={() => {
                      setPendingConversationId(conv.id);
                      router.push("/(home)");
                    }}
                    style={{ gap: 4 }}
                  >
                    <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
                      <Text style={{ color: c.foreground, fontFamily: "Inter_500Medium", fontSize: 15, flex: 1 }} numberOfLines={1}>
                        {conv.title}
                      </Text>
                      <Text style={{ color: c.mutedForeground, fontSize: 12, marginTop: 1 }}>
                        {formatTimeAgo(conv.lastMessageAt)}
                      </Text>
                    </View>
                    {conv.projectId != null && (
                      <View style={{ backgroundColor: `${c.primary}18`, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2, alignSelf: "flex-start" }}>
                        <Text style={{ color: c.primary, fontSize: 11 }}>
                          {projectMap.get(conv.projectId) ?? "Project"}
                        </Text>
                      </View>
                    )}
                    {conv.preview ? (
                      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }} numberOfLines={2}>
                        {conv.preview}
                      </Text>
                    ) : null}
                  </Pressable>
                  <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
                    <Pressable
                      onPress={() => { setRenamingId(conv.id); setRenameValue(conv.title); }}
                      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                      hitSlop={6}
                    >
                      <Pencil size={14} color={c.mutedForeground} />
                      <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Rename</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => handleDelete(conv.id, conv.title)}
                      style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
                      hitSlop={6}
                    >
                      <Trash2 size={14} color="#f87171" />
                      <Text style={{ color: "#f87171", fontSize: 13 }}>Delete</Text>
                    </Pressable>
                  </View>
                </>
              )}
            </Card>
          ))
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/* ── Data Controls tab ───────────────────────────────────────────────────── */

function DataControlsTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [clearingMemories, setClearingMemories] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [memoriesCleared, setMemoriesCleared] = useState(false);
  const [historyCleared, setHistoryCleared] = useState(false);

  const handleClearMemories = () => {
    Alert.alert(
      "Clear all memories",
      "This will permanently delete all your saved Ora memories. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear memories",
          style: "destructive",
          onPress: async () => {
            setClearingMemories(true);
            try {
              await clearAllMemories();
              setMemoriesCleared(true);
              setTimeout(() => setMemoriesCleared(false), 3000);
            } catch {
              Alert.alert("Error", "Could not clear memories. Please try again.");
            } finally {
              setClearingMemories(false);
            }
          },
        },
      ],
    );
  };

  const handleClearHistory = () => {
    Alert.alert(
      "Clear all conversations",
      "This will permanently delete all your Ora conversations and their messages. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear history",
          style: "destructive",
          onPress: async () => {
            setClearingHistory(true);
            try {
              await clearAllConversations();
              setHistoryCleared(true);
              setTimeout(() => setHistoryCleared(false), 3000);
            } catch {
              Alert.alert("Error", "Could not clear history. Please try again.");
            } finally {
              setClearingHistory(false);
            }
          },
        },
      ],
    );
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 24 }}>
      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
        Manage your Ora data. These actions only affect Ora — your AI Builder projects and their data are never touched.
      </Text>

      {/* Clear memories */}
      <Card style={{ gap: 10 }}>
        <View style={{ gap: 3 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Clear all memories</Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
            Permanently delete all saved Ora memories. Ora will no longer reference them in future conversations.
          </Text>
        </View>
        {memoriesCleared && (
          <Text style={{ color: "#4ade80", fontSize: 13 }}>All memories cleared.</Text>
        )}
        <Button
          label={clearingMemories ? "Clearing…" : "Clear all memories"}
          variant="destructive"
          onPress={handleClearMemories}
          loading={clearingMemories}
          full
        />
      </Card>

      {/* Clear history */}
      <Card style={{ gap: 10 }}>
        <View style={{ gap: 3 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>Clear conversation history</Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
            Permanently delete all your Ora conversations and messages. This does not affect your saved memories.
          </Text>
        </View>
        {historyCleared && (
          <Text style={{ color: "#4ade80", fontSize: 13 }}>All conversations cleared.</Text>
        )}
        <Button
          label={clearingHistory ? "Clearing…" : "Clear all conversations"}
          variant="destructive"
          onPress={handleClearHistory}
          loading={clearingHistory}
          full
        />
      </Card>
    </ScrollView>
  );
}
