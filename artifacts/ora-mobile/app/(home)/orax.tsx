import {
  CheckCircle2,
  GitBranch,
  Lock,
  Plus,
  Sparkles,
  TerminalSquare,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import {
  Button,
  Card,
  EmptyState,
  Loading,
  Pill,
  TextField,
} from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  addRepository,
  createTask,
  getOraxCapabilities,
  listRepositories,
  listTasks,
} from "@/lib/api";
import type {
  OraxCapabilities,
  OraxRepository,
  OraxTask,
} from "@/lib/types";

type Tab = "repos" | "tasks" | "capabilities";

export default function OraxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>("repos");

  const [caps, setCaps] = useState<OraxCapabilities | null>(null);
  const [repos, setRepos] = useState<OraxRepository[]>([]);
  const [tasks, setTasks] = useState<OraxTask[]>([]);
  const [loading, setLoading] = useState(true);

  const [repoUrl, setRepoUrl] = useState("");
  const [addingRepo, setAddingRepo] = useState(false);

  const [taskRepoId, setTaskRepoId] = useState<number | null>(null);
  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskKind, setTaskKind] = useState<"analyze" | "coding">("analyze");
  const [creatingTask, setCreatingTask] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    const [capRes, repoRes, taskRes] = await Promise.allSettled([
      getOraxCapabilities(),
      listRepositories(),
      listTasks(),
    ]);
    if (capRes.status === "fulfilled") setCaps(capRes.value);
    if (repoRes.status === "fulfilled") setRepos(repoRes.value);
    if (taskRes.status === "fulfilled") setTasks(taskRes.value);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submitRepo = useCallback(async () => {
    if (!repoUrl.trim()) return;
    setAddingRepo(true);
    try {
      await addRepository(repoUrl.trim());
      setRepoUrl("");
      setRepos(await listRepositories());
    } catch {
      /* ignore */
    } finally {
      setAddingRepo(false);
    }
  }, [repoUrl]);

  const submitTask = useCallback(async () => {
    if (!taskRepoId || !taskPrompt.trim()) return;
    setCreatingTask(true);
    try {
      await createTask({
        repositoryId: taskRepoId,
        kind: taskKind,
        prompt: taskPrompt.trim(),
      });
      setTaskPrompt("");
      setTasks(await listTasks());
      setTab("tasks");
    } catch {
      /* ignore */
    } finally {
      setCreatingTask(false);
    }
  }, [taskRepoId, taskPrompt, taskKind]);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader
        title="Orax"
        subtitle="Connect repositories & run agentic tasks"
      />
      <View
        style={{
          flexDirection: "row",
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 12,
        }}
      >
        <Pill
          label="Repositories"
          icon={GitBranch}
          active={tab === "repos"}
          onPress={() => setTab("repos")}
        />
        <Pill
          label="Tasks"
          icon={TerminalSquare}
          active={tab === "tasks"}
          onPress={() => setTab("tasks")}
        />
        <Pill
          label="Capabilities"
          icon={Sparkles}
          active={tab === "capabilities"}
          onPress={() => setTab("capabilities")}
        />
      </View>

      {loading ? (
        <Loading label="Loading Orax…" />
      ) : (
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
            {tab === "repos" && (
              <>
                <Card style={{ gap: 12 }}>
                  <TextField
                    label="Repository URL"
                    placeholder="https://github.com/owner/repo"
                    autoCapitalize="none"
                    value={repoUrl}
                    onChangeText={setRepoUrl}
                  />
                  <Button
                    label="Connect repository"
                    icon={Plus}
                    onPress={submitRepo}
                    loading={addingRepo}
                    full
                  />
                </Card>
                {repos.length === 0 ? (
                  <EmptyState
                    icon={GitBranch}
                    title="No repositories yet"
                    subtitle="Connect a GitHub repository so Orax can analyze and work on it."
                  />
                ) : (
                  repos.map((r) => (
                    <Card key={r.id} style={{ gap: 4 }}>
                      <Text
                        style={{
                          color: c.foreground,
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 15,
                        }}
                      >
                        {r.owner}/{r.name}
                      </Text>
                      <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                        {r.connectionStatus.replace(/_/g, " ")}
                      </Text>
                      <Button
                        label="New task on this repo"
                        variant="ghost"
                        onPress={() => {
                          setTaskRepoId(r.id);
                          setTab("tasks");
                        }}
                        style={{ marginTop: 6 }}
                      />
                    </Card>
                  ))
                )}
              </>
            )}

            {tab === "tasks" && (
              <>
                <Card style={{ gap: 12 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 15,
                    }}
                  >
                    New task
                  </Text>
                  <View style={{ flexDirection: "row", gap: 8 }}>
                    <Pill
                      label="Analyze"
                      active={taskKind === "analyze"}
                      onPress={() => setTaskKind("analyze")}
                    />
                    <Pill
                      label="Coding"
                      active={taskKind === "coding"}
                      onPress={() => setTaskKind("coding")}
                    />
                  </View>
                  {repos.length > 0 && (
                    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                      {repos.map((r) => (
                        <Pill
                          key={r.id}
                          label={`${r.owner}/${r.name}`}
                          active={taskRepoId === r.id}
                          onPress={() => setTaskRepoId(r.id)}
                        />
                      ))}
                    </View>
                  )}
                  <TextField
                    label="Prompt"
                    placeholder="Describe what Orax should do…"
                    value={taskPrompt}
                    onChangeText={setTaskPrompt}
                    multiline
                    style={{ minHeight: 80, textAlignVertical: "top" }}
                  />
                  <Button
                    label="Run task"
                    onPress={submitTask}
                    loading={creatingTask}
                    disabled={!taskRepoId || !taskPrompt.trim()}
                    full
                  />
                </Card>
                {tasks.length === 0 ? (
                  <EmptyState
                    icon={TerminalSquare}
                    title="No tasks yet"
                    subtitle="Run an analyze or coding task against a connected repository."
                  />
                ) : (
                  tasks.map((t) => (
                    <Card key={t.id} style={{ gap: 6 }}>
                      <View
                        style={{
                          flexDirection: "row",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <Text
                          style={{
                            color: c.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 15,
                          }}
                        >
                          {t.title || t.kind || "Task"}
                        </Text>
                        <View
                          style={{
                            backgroundColor: c.muted,
                            borderRadius: 999,
                            paddingHorizontal: 10,
                            paddingVertical: 3,
                          }}
                        >
                          <Text
                            style={{
                              color: c.accentForeground,
                              fontSize: 12,
                            }}
                          >
                            {t.status}
                          </Text>
                        </View>
                      </View>
                      {t.prompt ? (
                        <Text
                          numberOfLines={3}
                          style={{ color: c.mutedForeground, fontSize: 13 }}
                        >
                          {t.prompt}
                        </Text>
                      ) : null}
                    </Card>
                  ))
                )}
              </>
            )}

            {tab === "capabilities" && (
              <>
                <Card style={{ gap: 10 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_600SemiBold",
                      fontSize: 15,
                    }}
                  >
                    Available now
                  </Text>
                  {(caps?.available ?? []).length === 0 ? (
                    <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                      No capabilities reported.
                    </Text>
                  ) : (
                    caps?.available.map((cap) => (
                      <View
                        key={cap}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <CheckCircle2 size={16} color={c.accentForeground} />
                        <Text style={{ color: c.foreground, fontSize: 14 }}>
                          {cap.replace(/_/g, " ")}
                        </Text>
                      </View>
                    ))
                  )}
                </Card>
                {(caps?.lockedUntilApprovalLayer ?? []).length > 0 && (
                  <Card style={{ gap: 10 }}>
                    <Text
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_600SemiBold",
                        fontSize: 15,
                      }}
                    >
                      Requires approval
                    </Text>
                    {caps?.lockedUntilApprovalLayer.map((cap) => (
                      <View
                        key={cap}
                        style={{
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 8,
                        }}
                      >
                        <Lock size={16} color={c.mutedForeground} />
                        <Text style={{ color: c.mutedForeground, fontSize: 14 }}>
                          {cap.replace(/_/g, " ")}
                        </Text>
                      </View>
                    ))}
                  </Card>
                )}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
    </View>
  );
}
