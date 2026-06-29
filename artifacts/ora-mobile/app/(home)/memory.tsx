import { useAuth } from "@clerk/expo";
import { Bookmark, FolderOpen, Plus, RotateCcw, Trash2, User } from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SignInWall } from "@/components/SignInWall";
import { Button, Card, EmptyState, Loading, Pill, TextField } from "@/components/ui";
import { useActiveProject } from "@/context/ActiveProjectContext";
import { useColors } from "@/hooks/useColors";
import {
  clearAllMemories,
  createMemory,
  deleteMemory,
  getMemoryUsage,
  getProfile,
  listMemories,
  restoreMemory,
  updateMemory,
  updateProfile,
} from "@/lib/api";
import type { MemoryUsage, OraMemory, OraProfile } from "@/lib/types";

type Tab = "profile" | "memories" | "project";

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

export default function MemoryScreen() {
  const c = useColors();
  const { isSignedIn } = useAuth();
  const { activeProjectId } = useActiveProject();
  const [tab, setTab] = useState<Tab>("profile");

  if (!isSignedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScreenHeader title="Memory" subtitle="What Ora knows about you" />
        <SignInWall
          title="Sign in for Memory"
          description="Your profile and saved memories are stored with your account."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Memory" subtitle="What Ora knows about you" />
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <Pill
          label="Profile"
          icon={User}
          active={tab === "profile"}
          onPress={() => setTab("profile")}
        />
        <Pill
          label="Saved Memories"
          icon={Bookmark}
          active={tab === "memories"}
          onPress={() => setTab("memories")}
        />
        {activeProjectId != null && (
          <Pill
            label="Project"
            icon={FolderOpen}
            active={tab === "project"}
            onPress={() => setTab("project")}
          />
        )}
      </View>
      {tab === "profile" ? (
        <ProfileTab />
      ) : tab === "project" && activeProjectId != null ? (
        <ProjectMemoriesTab projectId={activeProjectId} />
      ) : (
        <MemoriesTab />
      )}
    </View>
  );
}

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
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 14,
          paddingBottom: insets.bottom + 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
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

function UsageMeter({ usage }: { usage: MemoryUsage | null }) {
  const c = useColors();
  if (!usage) return null;
  const pct = Math.min(100, Math.round((usage.count / usage.limit) * 100));
  return (
    <View style={{ gap: 6 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Memory capacity</Text>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
          {usage.count} / {usage.limit}
        </Text>
      </View>
      <View
        style={{
          height: 4,
          borderRadius: 2,
          backgroundColor: c.muted,
          overflow: "hidden",
        }}
      >
        <View
          style={{
            height: 4,
            borderRadius: 2,
            width: `${pct}%`,
            backgroundColor: pct >= 90 ? c.destructive : c.primary,
          }}
        />
      </View>
    </View>
  );
}

function MemoriesTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<OraMemory[]>([]);
  const [usage, setUsage] = useState<MemoryUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

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

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await createMemory(title.trim(), content.trim());
      setTitle("");
      setContent("");
      setAdding(false);
      await reload();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [title, content, reload]);

  const toggle = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await updateMemory(m.id, { enabled: !m.enabled });
    } catch {
      setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: m.enabled } : x)));
    }
  }, []);

  const restore = useCallback(
    async (m: OraMemory) => {
      setMemories((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, enabled: true, supersededBy: null } : x)),
      );
      try {
        await restoreMemory(m.id);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const remove = useCallback(async (id: number) => {
    setMemories((prev) => prev.filter((x) => x.id !== id));
    try {
      await deleteMemory(id);
    } catch {
      /* ignore */
    }
  }, []);

  const clearAll = useCallback(async () => {
    setClearing(true);
    try {
      await clearAllMemories();
      await reload();
    } catch {
      /* ignore */
    } finally {
      setClearing(false);
    }
  }, [reload]);

  if (loading) return <Loading label="Loading memories…" />;

  const active = memories.filter((m) => m.supersededBy == null);
  const superseded = memories.filter((m) => m.supersededBy != null);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 12,
          paddingBottom: insets.bottom + 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <UsageMeter usage={usage} />

        {adding ? (
          <Card style={{ gap: 12 }}>
            <TextField label="Title" value={title} onChangeText={setTitle} />
            <TextField
              label="What should Ora remember?"
              value={content}
              onChangeText={setContent}
              multiline
              style={{ minHeight: 80, textAlignVertical: "top" }}
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setAdding(false)}
                style={{ flex: 1 }}
              />
              <Button label="Save" onPress={add} loading={saving} style={{ flex: 1 }} />
            </View>
          </Card>
        ) : (
          <Button
            label="Add a memory"
            icon={Plus}
            variant="secondary"
            onPress={() => setAdding(true)}
            full
          />
        )}

        {active.length === 0 && superseded.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="No saved memories"
            subtitle="Memories help Ora remember important facts across conversations."
          />
        ) : (
          <>
            {active.map((m) => (
              <MemoryCard key={m.id} memory={m} onToggle={toggle} onDelete={remove} />
            ))}

            {superseded.length > 0 && (
              <>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_600SemiBold",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 4,
                  }}
                >
                  Superseded
                </Text>
                {superseded.map((m) => (
                  <SupersededCard key={m.id} memory={m} onRestore={restore} onDelete={remove} />
                ))}
              </>
            )}

            {memories.length > 0 && (
              <Button
                label={clearing ? "Clearing…" : "Clear all memories"}
                variant="ghost"
                onPress={clearAll}
                loading={clearing}
                full
                style={{ marginTop: 8 }}
              />
            )}
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

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

  useEffect(() => {
    void reload();
  }, [reload]);

  const add = useCallback(async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await createMemory(title.trim(), content.trim(), projectId);
      setTitle("");
      setContent("");
      setAdding(false);
      await reload();
    } catch {
      /* ignore */
    } finally {
      setSaving(false);
    }
  }, [title, content, projectId, reload]);

  const toggle = useCallback(async (m: OraMemory) => {
    setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: !x.enabled } : x)));
    try {
      await updateMemory(m.id, { enabled: !m.enabled });
    } catch {
      setMemories((prev) => prev.map((x) => (x.id === m.id ? { ...x, enabled: m.enabled } : x)));
    }
  }, []);

  const restore = useCallback(
    async (m: OraMemory) => {
      setMemories((prev) =>
        prev.map((x) => (x.id === m.id ? { ...x, enabled: true, supersededBy: null } : x)),
      );
      try {
        await restoreMemory(m.id);
      } catch {
        await reload();
      }
    },
    [reload],
  );

  const remove = useCallback(async (id: number) => {
    setMemories((prev) => prev.filter((x) => x.id !== id));
    try {
      await deleteMemory(id);
    } catch {
      /* ignore */
    }
  }, []);

  if (loading) return <Loading label="Loading project memories…" />;

  const active = memories.filter((m) => m.supersededBy == null);
  const superseded = memories.filter((m) => m.supersededBy != null);

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={{
          padding: 16,
          gap: 12,
          paddingBottom: insets.bottom + 24,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
          These memories are scoped to this project and injected into every conversation within it.
        </Text>

        <UsageMeter usage={usage} />

        {adding ? (
          <Card style={{ gap: 12 }}>
            <TextField label="Title" value={title} onChangeText={setTitle} />
            <TextField
              label="What should Ora remember for this project?"
              value={content}
              onChangeText={setContent}
              multiline
              style={{ minHeight: 80, textAlignVertical: "top" }}
            />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Button
                label="Cancel"
                variant="ghost"
                onPress={() => setAdding(false)}
                style={{ flex: 1 }}
              />
              <Button label="Save" onPress={add} loading={saving} style={{ flex: 1 }} />
            </View>
          </Card>
        ) : (
          <Button
            label="Add project memory"
            icon={Plus}
            variant="secondary"
            onPress={() => setAdding(true)}
            full
          />
        )}

        {active.length === 0 && superseded.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title="No project memories"
            subtitle="Add memories that apply specifically to this project's conversations."
          />
        ) : (
          <>
            {active.map((m) => (
              <MemoryCard key={m.id} memory={m} onToggle={toggle} onDelete={remove} />
            ))}

            {superseded.length > 0 && (
              <>
                <Text
                  style={{
                    color: c.mutedForeground,
                    fontSize: 12,
                    fontFamily: "Inter_600SemiBold",
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginTop: 4,
                  }}
                >
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

function MemoryCard({
  memory,
  onToggle,
  onDelete,
}: {
  memory: OraMemory;
  onToggle: (m: OraMemory) => void;
  onDelete: (id: number) => void;
}) {
  const c = useColors();
  return (
    <Card style={{ gap: 8 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          style={{
            color: c.foreground,
            fontFamily: "Inter_600SemiBold",
            fontSize: 15,
            flex: 1,
          }}
        >
          {memory.title}
        </Text>
        <Switch
          value={memory.enabled}
          onValueChange={() => onToggle(memory)}
          trackColor={{ false: c.muted, true: c.primary }}
        />
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
        {memory.content}
      </Text>
      <Pressable
        onPress={() => onDelete(memory.id)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          alignSelf: "flex-start",
          marginTop: 2,
        }}
        hitSlop={6}
      >
        <Trash2 size={14} color={c.destructive} />
        <Text style={{ color: c.destructive, fontSize: 13 }}>Delete</Text>
      </Pressable>
    </Card>
  );
}

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
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
        }}
      >
        <Text
          style={{
            color: c.mutedForeground,
            fontFamily: "Inter_600SemiBold",
            fontSize: 15,
            flex: 1,
          }}
        >
          {memory.title}
        </Text>
        <View
          style={{
            borderRadius: 4,
            paddingHorizontal: 6,
            paddingVertical: 2,
            backgroundColor: c.muted,
          }}
        >
          <Text style={{ color: c.mutedForeground, fontSize: 11 }}>Superseded</Text>
        </View>
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
        {memory.content}
      </Text>
      <View style={{ flexDirection: "row", gap: 16, marginTop: 2 }}>
        <Pressable
          onPress={() => onRestore(memory)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          hitSlop={6}
        >
          <RotateCcw size={14} color={c.primary} />
          <Text style={{ color: c.primary, fontSize: 13 }}>Restore</Text>
        </Pressable>
        <Pressable
          onPress={() => onDelete(memory.id)}
          style={{ flexDirection: "row", alignItems: "center", gap: 6 }}
          hitSlop={6}
        >
          <Trash2 size={14} color={c.destructive} />
          <Text style={{ color: c.destructive, fontSize: 13 }}>Delete</Text>
        </Pressable>
      </View>
    </Card>
  );
}
