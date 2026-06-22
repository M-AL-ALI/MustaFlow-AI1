import { useAuth } from "@clerk/expo";
import { Bookmark, Plus, Trash2, User } from "lucide-react-native";
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
import { useColors } from "@/hooks/useColors";
import {
  createMemory,
  deleteMemory,
  getProfile,
  listMemories,
  updateMemory,
  updateProfile,
} from "@/lib/api";
import type { OraMemory, OraProfile } from "@/lib/types";

type Tab = "profile" | "memories";

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
      </View>
      {tab === "profile" ? <ProfileTab /> : <MemoriesTab />}
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

function MemoriesTab() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [memories, setMemories] = useState<OraMemory[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    try {
      setMemories(await listMemories());
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

  const remove = useCallback(async (id: number) => {
    setMemories((prev) => prev.filter((x) => x.id !== id));
    try {
      await deleteMemory(id);
    } catch {
      /* ignore */
    }
  }, []);

  if (loading) return <Loading label="Loading memories…" />;

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

        {memories.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title="No saved memories"
            subtitle="Memories help Ora remember important facts across conversations."
          />
        ) : (
          memories.map((m) => (
            <Card key={m.id} style={{ gap: 8 }}>
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
                  {m.title}
                </Text>
                <Switch
                  value={m.enabled}
                  onValueChange={() => toggle(m)}
                  trackColor={{ false: c.muted, true: c.primary }}
                />
              </View>
              <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
                {m.content}
              </Text>
              <Pressable
                onPress={() => remove(m.id)}
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
          ))
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
