import { useAuth } from "@clerk/expo";
import {
  CheckCircle2,
  FileText,
  GitBranch,
  Lock,
  MessageCircle,
  Plus,
  Sparkles,
  TerminalSquare,
} from "lucide-react-native";
import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/ScreenHeader";
import { SignInWall } from "@/components/SignInWall";
import { Button, Card, EmptyState, Loading, Pill, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  addRepository,
  createTask,
  getOraxCapabilities,
  listTaskApprovals,
  listTaskArtifacts,
  listTaskMessages,
  listRepositories,
  listTasks,
  scanRepository,
  sendTaskMessage,
} from "@/lib/api";
import type {
  OraxCapabilities,
  OraxRepository,
  OraxTask,
  OraxTaskApproval,
  OraxTaskArtifact,
  OraxTaskMessage,
} from "@/lib/types";

type Tab = "repos" | "tasks" | "capabilities";

export default function OraxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const { isSignedIn } = useAuth();
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
  const [scanningRepoId, setScanningRepoId] = useState<number | null>(null);
  const [selectedTask, setSelectedTask] = useState<OraxTask | null>(null);
  const [taskMessages, setTaskMessages] = useState<OraxTaskMessage[]>([]);
  const [taskApprovals, setTaskApprovals] = useState<OraxTaskApproval[]>([]);
  const [taskArtifacts, setTaskArtifacts] = useState<OraxTaskArtifact[]>([]);
  const [taskChatInput, setTaskChatInput] = useState("");
  const [taskDetailLoading, setTaskDetailLoading] = useState(false);
  const [sendingTaskMessage, setSendingTaskMessage] = useState(false);

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
    if (!isSignedIn) return;
    void reload();
  }, [reload, isSignedIn]);

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

  const runScan = useCallback(async (repository: OraxRepository) => {
    setScanningRepoId(repository.id);
    try {
      await scanRepository(repository.id);
      setRepos(await listRepositories());
    } catch (err) {
      Alert.alert("Scan failed", err instanceof Error ? err.message : "Please try again.");
    } finally {
      setScanningRepoId(null);
    }
  }, []);

  const loadTaskDetail = useCallback(async (task: OraxTask) => {
    setSelectedTask(task);
    setTaskDetailLoading(true);
    try {
      const [messagesRes, approvalsRes, artifactsRes] = await Promise.allSettled([
        listTaskMessages(task.id),
        listTaskApprovals(task.id),
        listTaskArtifacts(task.id),
      ]);
      setTaskMessages(messagesRes.status === "fulfilled" ? messagesRes.value : []);
      setTaskApprovals(approvalsRes.status === "fulfilled" ? approvalsRes.value : []);
      setTaskArtifacts(artifactsRes.status === "fulfilled" ? artifactsRes.value : []);
    } catch {
      /* individual promises are handled above */
    } finally {
      setTaskDetailLoading(false);
    }
  }, []);

  const submitTaskMessage = useCallback(async () => {
    const task = selectedTask;
    const text = taskChatInput.trim();
    if (!task || !text || sendingTaskMessage) return;
    setTaskChatInput("");
    setSendingTaskMessage(true);
    try {
      const newMessages = await sendTaskMessage(task.id, text);
      setTaskMessages((prev) => [...prev, ...newMessages]);
      const [approvals, artifacts] = await Promise.allSettled([
        listTaskApprovals(task.id),
        listTaskArtifacts(task.id),
      ]);
      if (approvals.status === "fulfilled") setTaskApprovals(approvals.value);
      if (artifacts.status === "fulfilled") setTaskArtifacts(artifacts.value);
    } catch (err) {
      Alert.alert("Could not send ORAX message", err instanceof Error ? err.message : "Try again.");
    } finally {
      setSendingTaskMessage(false);
    }
  }, [selectedTask, sendingTaskMessage, taskChatInput]);

  if (!isSignedIn) {
    return (
      <View style={{ flex: 1, backgroundColor: c.background }}>
        <ScreenHeader title="Orax" subtitle="Connect repositories & run agentic tasks" />
        <SignInWall
          title="Sign in for Orax"
          description="Orax connects to your repositories and runs agentic coding tasks with your account."
        />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <ScreenHeader title="Orax" subtitle="Connect repositories & run agentic tasks" />
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
                        {r.scanStatus ? ` · scan ${r.scanStatus}` : ""}
                      </Text>
                      <Button
                        label="Scan repository"
                        variant="secondary"
                        icon={GitBranch}
                        onPress={() => void runScan(r)}
                        loading={scanningRepoId === r.id}
                        style={{ marginTop: 6 }}
                      />
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
                        <Text numberOfLines={3} style={{ color: c.mutedForeground, fontSize: 13 }}>
                          {t.prompt}
                        </Text>
                      ) : null}
                      <Button
                        label="Open ORAX thread"
                        icon={MessageCircle}
                        variant="ghost"
                        onPress={() => void loadTaskDetail(t)}
                      />
                    </Card>
                  ))
                )}
                {selectedTask && (
                  <Card style={{ gap: 12 }}>
                    <View style={{ gap: 4 }}>
                      <Text
                        style={{
                          color: c.foreground,
                          fontFamily: "Inter_700Bold",
                          fontSize: 16,
                        }}
                      >
                        {selectedTask.title || "ORAX task"}
                      </Text>
                      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                        Thread, approvals, and artifacts are ORAX-only and never appear in normal
                        Ora chat.
                      </Text>
                    </View>

                    {taskDetailLoading ? (
                      <Loading label="Loading task detail..." />
                    ) : (
                      <>
                        <Text
                          style={{
                            color: c.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                        >
                          Task thread
                        </Text>
                        {taskMessages.length === 0 ? (
                          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                            No ORAX messages yet.
                          </Text>
                        ) : (
                          taskMessages.map((m) => (
                            <View
                              key={m.id}
                              style={{
                                backgroundColor: c.muted,
                                borderRadius: 12,
                                paddingHorizontal: 12,
                                paddingVertical: 9,
                                gap: 3,
                              }}
                            >
                              <Text
                                style={{
                                  color: c.accentForeground,
                                  fontFamily: "Inter_600SemiBold",
                                  fontSize: 12,
                                  textTransform: "uppercase",
                                }}
                              >
                                {m.role}
                                {m.event ? ` · ${m.event}` : ""}
                              </Text>
                              <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>
                                {m.content}
                              </Text>
                            </View>
                          ))
                        )}

                        <TextField
                          label="Message ORAX"
                          placeholder="Ask about the task, approvals, files, or next step..."
                          value={taskChatInput}
                          onChangeText={setTaskChatInput}
                          multiline
                          style={{ minHeight: 70, textAlignVertical: "top" }}
                        />
                        <Button
                          label="Send to ORAX"
                          icon={MessageCircle}
                          onPress={submitTaskMessage}
                          loading={sendingTaskMessage}
                          disabled={!taskChatInput.trim()}
                          full
                        />

                        <Text
                          style={{
                            color: c.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                        >
                          Approvals
                        </Text>
                        {taskApprovals.length === 0 ? (
                          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                            No approvals requested yet.
                          </Text>
                        ) : (
                          taskApprovals.map((a) => (
                            <View
                              key={a.id}
                              style={{
                                flexDirection: "row",
                                alignItems: "center",
                                justifyContent: "space-between",
                                gap: 8,
                                backgroundColor: c.muted,
                                borderRadius: 10,
                                padding: 10,
                              }}
                            >
                              <Text style={{ color: c.foreground, flex: 1 }}>{a.action}</Text>
                              <Text style={{ color: c.accentForeground }}>{a.status}</Text>
                            </View>
                          ))
                        )}

                        <Text
                          style={{
                            color: c.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                        >
                          Artifacts
                        </Text>
                        {taskArtifacts.length === 0 ? (
                          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                            No artifacts generated yet.
                          </Text>
                        ) : (
                          taskArtifacts.map((a) => (
                            <View
                              key={a.id}
                              style={{
                                backgroundColor: c.muted,
                                borderRadius: 10,
                                padding: 10,
                                gap: 4,
                              }}
                            >
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                                <FileText size={16} color={c.accentForeground} />
                                <Text
                                  style={{
                                    color: c.foreground,
                                    fontFamily: "Inter_600SemiBold",
                                    flex: 1,
                                  }}
                                >
                                  {a.title ?? a.type}
                                </Text>
                                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                                  {a.status}
                                </Text>
                              </View>
                              {a.summary ? (
                                <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                                  {a.summary}
                                </Text>
                              ) : null}
                            </View>
                          ))
                        )}
                      </>
                    )}
                  </Card>
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
