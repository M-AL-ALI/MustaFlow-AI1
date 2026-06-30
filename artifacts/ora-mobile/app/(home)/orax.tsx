import { useAuth } from "@clerk/expo";
import {
  Check,
  CheckCircle2,
  FileText,
  GitBranch,
  GitPullRequest,
  Key,
  Lock,
  MessageCircle,
  Play,
  Plus,
  Sparkles,
  TerminalSquare,
  X,
} from "lucide-react-native";
import React, { useCallback, useEffect, useRef, useState } from "react";
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
  connectGithubToken,
  createGithubPR,
  createTask,
  generateDraftPatch,
  getOraxCapabilities,
  listTaskApprovals,
  listTaskArtifacts,
  listTaskMessages,
  listRepositories,
  listTasks,
  patchApproval,
  readApprovedFiles,
  requestCommandApproval,
  requestGithubPrApproval,
  requestSandboxApproval,
  runCommands,
  runSandbox,
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

const DEFAULT_ORAX_COMMAND_IDS = ["patch-static-checks", "json-syntax", "node-syntax"];

function artifactPayload(artifact: OraxTaskArtifact): Record<string, unknown> {
  return artifact.payload && typeof artifact.payload === "object" ? artifact.payload : {};
}

function artifactFlag(artifact: OraxTaskArtifact, key: string): boolean {
  return artifactPayload(artifact)[key] === true;
}

function artifactText(artifact: OraxTaskArtifact, key: string): string | null {
  const value = artifactPayload(artifact)[key];
  return typeof value === "string" && value.trim() ? value : null;
}

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

  const [githubTokenByRepo, setGithubTokenByRepo] = useState<Record<number, string>>({});
  const [connectingGithubRepoId, setConnectingGithubRepoId] = useState<number | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  // Task-switch guard — cleared state that is scoped to a single ORAX task so
  // stale async callbacks from a previous task never overwrite the active task's data.
  const activeTaskIdRef = useRef<number | null>(null);
  const [taskMessageDraft, setTaskMessageDraft] = useState("");
  // "Start ORAX chat" — first-message thread creation mode
  const [startingThread, setStartingThread] = useState(false);
  const [threadFirstMessage, setThreadFirstMessage] = useState("");

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
    const taskId = task.id;
    // Guard: prevent a message that was staged for task A from sending if the
    // user has already switched to task B. Not Ora — task threads are ORAX-only.
    if (activeTaskIdRef.current !== taskId) return;
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

  // Clear task-scoped state immediately when the user switches to a different task.
  // Thread messages, approvals, and artifacts are stored separately from Ora chat and
  // AI Builder history — this is not Ora history and not AI Builder state.
  useEffect(() => {
    if (!selectedTask) return;
    const switchedTasks = activeTaskIdRef.current !== selectedTask.id;
    activeTaskIdRef.current = selectedTask.id;
    if (switchedTasks) {
      setTaskMessages([]);
      setTaskApprovals([]);
      setTaskArtifacts([]);
      setTaskMessageDraft("");
    }
    // Only re-run when task id changes — ref mutation is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id]);

  // When a task is created but the first-message send failed, pre-fill the chat input
  // so the user can retry without re-typing.
  useEffect(() => {
    if (taskMessageDraft) {
      setTaskChatInput(taskMessageDraft);
      setTaskMessageDraft("");
    }
  }, [taskMessageDraft]);

  // Create a task and immediately open its thread ("Start ORAX chat").
  // The first message becomes the task prompt and also seeds the thread.
  const createTaskWithThread = useCallback(async () => {
    const firstMessage = threadFirstMessage.trim();
    if (!taskRepoId || !firstMessage) return;
    setCreatingTask(true);
    let createdTask: (typeof tasks)[number] | null = null;
    try {
      const body = await createTask({
        repositoryId: taskRepoId,
        kind: taskKind,
        prompt: firstMessage,
        startThread: true,
      });
      createdTask = body.task;
      activeTaskIdRef.current = body.task.id;
      const refreshed = await listTasks();
      setTasks(refreshed);
      setStartingThread(false);
      setThreadFirstMessage("");
      setTab("tasks");
      void loadTaskDetail(body.task);
    } catch (err) {
      if (createdTask) {
        // Task created, but first message failed to save — pre-fill the draft.
        setTaskMessageDraft(firstMessage);
        void loadTaskDetail(createdTask);
      } else {
        Alert.alert("Could not create task", err instanceof Error ? err.message : "Try again.");
      }
    } finally {
      setCreatingTask(false);
    }
  }, [taskRepoId, taskKind, threadFirstMessage, loadTaskDetail]);

  const handleConnectGithub = useCallback(
    async (repoId: number) => {
      const token = (githubTokenByRepo[repoId] ?? "").trim();
      if (!token) return;
      setConnectingGithubRepoId(repoId);
      try {
        const res = await connectGithubToken(repoId, token);
        Alert.alert(
          "GitHub connected",
          `Connected to ${res.repository.owner}/${res.repository.name}.`,
        );
        setGithubTokenByRepo((prev) => ({ ...prev, [repoId]: "" }));
        setRepos(await listRepositories());
      } catch (err) {
        Alert.alert("Connect failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setConnectingGithubRepoId(null);
      }
    },
    [githubTokenByRepo],
  );

  const handleApprovalDecision = useCallback(
    async (approvalId: number, decision: "approved" | "denied") => {
      setActionBusy(`decision-${approvalId}`);
      try {
        await patchApproval(approvalId, decision);
        if (selectedTask) setTaskApprovals(await listTaskApprovals(selectedTask.id));
      } catch (err) {
        Alert.alert("Action failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask],
  );

  const handleReadFiles = useCallback(
    async (approvalId: number) => {
      setActionBusy(`read-${approvalId}`);
      try {
        const res = await readApprovedFiles(approvalId);
        const summary =
          res.files.length > 0
            ? `${res.files.length} file(s) on branch "${res.branch}"${
                res.skipped.length
                  ? `\nSkipped: ${res.skipped.map((item) => `${item.path}: ${item.reason}`).join(", ")}`
                  : ""
              }`
            : "No files could be read.";
        Alert.alert("Files read", summary);
        if (selectedTask) {
          const [appr, arts] = await Promise.allSettled([
            listTaskApprovals(selectedTask.id),
            listTaskArtifacts(selectedTask.id),
          ]);
          if (appr.status === "fulfilled") setTaskApprovals(appr.value);
          if (arts.status === "fulfilled") setTaskArtifacts(arts.value);
        }
      } catch (err) {
        Alert.alert("Read failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask],
  );

  const handleDraftPatch = useCallback(
    async (taskId: number, approvalId: number) => {
      const readApproval = taskApprovals.find((a) => a.id === approvalId);
      if (
        !readApproval ||
        readApproval.action !== "read_files" ||
        !["approved", "completed"].includes(readApproval.status)
      ) {
        Alert.alert(
          "No approved file read",
          "An approved file-read request is required before generating a draft patch.",
        );
        return;
      }
      setActionBusy(`patch-${approvalId}`);
      try {
        const res = await generateDraftPatch(taskId, approvalId);
        Alert.alert("Draft patch ready", res.artifact.summary ?? "Artifact created.");
        if (selectedTask) {
          const [appr, arts] = await Promise.allSettled([
            listTaskApprovals(selectedTask.id),
            listTaskArtifacts(selectedTask.id),
          ]);
          if (appr.status === "fulfilled") setTaskApprovals(appr.value);
          if (arts.status === "fulfilled") setTaskArtifacts(arts.value);
        }
      } catch (err) {
        Alert.alert("Patch failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask, taskApprovals],
  );

  const handleRequestApproval = useCallback(
    async (kind: "sandbox" | "commands" | "pr", task: OraxTask, artifact: OraxTaskArtifact) => {
      if (kind === "sandbox") {
        if (artifact.type !== "draft_patch" || !artifactText(artifact, "unifiedDiff")) {
          Alert.alert(
            "No draft patch",
            "Generate a draft patch before requesting sandbox validation.",
          );
          return;
        }
      } else if (kind === "commands") {
        if (artifact.type !== "sandbox_result" || !artifactFlag(artifact, "applied")) {
          Alert.alert("No sandbox result", "A passed sandbox validation is required first.");
          return;
        }
      } else {
        if (artifact.type !== "command_result" || !artifactFlag(artifact, "passed")) {
          Alert.alert("No command result", "Passed controlled checks are required first.");
          return;
        }
        const confirmed = await new Promise<boolean>((resolve) => {
          Alert.alert(
            "Create GitHub PR",
            "ORAX will create a branch and open a pull request. No direct push or deploy will occur.",
            [
              { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
              { text: "Request PR approval", onPress: () => resolve(true) },
            ],
          );
        });
        if (!confirmed) return;
      }
      setActionBusy(`req-${kind}-${artifact.id}`);
      try {
        if (kind === "sandbox") {
          await requestSandboxApproval(
            task.id,
            artifact.id,
            "Validate the draft patch in an isolated sandbox before any GitHub action.",
          );
        } else if (kind === "commands") {
          await requestCommandApproval(
            task.id,
            artifact.id,
            DEFAULT_ORAX_COMMAND_IDS,
            "Run approval-gated ORAX checks before any GitHub pull request approval.",
          );
        } else {
          await requestGithubPrApproval(task.id, artifact.id, {
            title: `ORAX: ${task.title || "Mobile task"}`,
            reason: "Create a GitHub branch and pull request from the sandbox-passed patch.",
          });
        }
        setTaskApprovals(await listTaskApprovals(task.id));
        Alert.alert("Approval requested", "The approval request has been queued.");
      } catch (err) {
        Alert.alert("Request failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [],
  );

  const handleRunSandbox = useCallback(
    async (approvalId: number) => {
      setActionBusy(`sandbox-${approvalId}`);
      try {
        const res = await runSandbox(approvalId);
        const applied = artifactFlag(res.artifact, "applied");
        Alert.alert(
          applied ? "Sandbox passed" : "Sandbox result recorded",
          res.artifact.summary ?? "Sandbox artifact created.",
        );
        if (selectedTask) {
          const [appr, arts] = await Promise.allSettled([
            listTaskApprovals(selectedTask.id),
            listTaskArtifacts(selectedTask.id),
          ]);
          if (appr.status === "fulfilled") setTaskApprovals(appr.value);
          if (arts.status === "fulfilled") setTaskArtifacts(arts.value);
        }
      } catch (err) {
        Alert.alert("Sandbox failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask],
  );

  const handleRunCommands = useCallback(
    async (approvalId: number) => {
      setActionBusy(`commands-${approvalId}`);
      try {
        const res = await runCommands(approvalId);
        const passed = artifactFlag(res.artifact, "passed");
        Alert.alert(
          passed ? "Checks passed" : "Check result recorded",
          res.artifact.summary ?? "Controlled-check artifact created.",
        );
        if (selectedTask) {
          const [appr, arts] = await Promise.allSettled([
            listTaskApprovals(selectedTask.id),
            listTaskArtifacts(selectedTask.id),
          ]);
          if (appr.status === "fulfilled") setTaskApprovals(appr.value);
          if (arts.status === "fulfilled") setTaskArtifacts(arts.value);
        }
      } catch (err) {
        Alert.alert("Checks failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask],
  );

  const handleCreatePR = useCallback(
    async (approvalId: number) => {
      setActionBusy(`pr-${approvalId}`);
      try {
        const res = await createGithubPR(approvalId);
        const url = artifactText(res.artifact, "pullRequestUrl");
        const number = artifactPayload(res.artifact).pullRequestNumber;
        Alert.alert(
          res.reused ? "PR reused" : "PR created",
          url
            ? `Pull request ${typeof number === "number" ? `#${number}` : ""}\n${url}`
            : (res.artifact.summary ?? "GitHub PR artifact recorded."),
        );
        if (selectedTask) {
          const [appr, arts] = await Promise.allSettled([
            listTaskApprovals(selectedTask.id),
            listTaskArtifacts(selectedTask.id),
          ]);
          if (appr.status === "fulfilled") setTaskApprovals(appr.value);
          if (arts.status === "fulfilled") setTaskArtifacts(arts.value);
        }
      } catch (err) {
        Alert.alert("PR creation failed", err instanceof Error ? err.message : "Please try again.");
      } finally {
        setActionBusy(null);
      }
    },
    [selectedTask],
  );

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
                      <View
                        style={{
                          borderTopWidth: 1,
                          borderTopColor: c.border,
                          marginTop: 8,
                          paddingTop: 10,
                          gap: 8,
                        }}
                      >
                        <Text
                          style={{
                            color: c.mutedForeground,
                            fontSize: 12,
                            fontFamily: "Inter_600SemiBold",
                          }}
                        >
                          GitHub token (private repos)
                        </Text>
                        <TextField
                          label=""
                          placeholder="github_pat_..."
                          autoCapitalize="none"
                          secureTextEntry
                          value={githubTokenByRepo[r.id] ?? ""}
                          onChangeText={(v) =>
                            setGithubTokenByRepo((prev) => ({ ...prev, [r.id]: v }))
                          }
                        />
                        <Button
                          label="Connect GitHub token"
                          icon={Key}
                          variant="secondary"
                          disabled={!(githubTokenByRepo[r.id] ?? "").trim()}
                          loading={connectingGithubRepoId === r.id}
                          onPress={() => void handleConnectGithub(r.id)}
                        />
                      </View>
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
                  <Button
                    label="Start ORAX chat"
                    icon={MessageCircle}
                    variant="secondary"
                    onPress={() => setStartingThread((v) => !v)}
                    disabled={!taskRepoId}
                    full
                  />
                  {startingThread && (
                    <View style={{ gap: 8 }}>
                      <TextField
                        label="First message"
                        placeholder="What should Orax do first?"
                        value={threadFirstMessage}
                        onChangeText={setThreadFirstMessage}
                        multiline
                        style={{ minHeight: 60, textAlignVertical: "top" }}
                      />
                      <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                        The first message becomes the task prompt and opens a live ORAX thread.
                      </Text>
                      <Button
                        label="Create task + open thread"
                        onPress={createTaskWithThread}
                        loading={creatingTask}
                        disabled={!taskRepoId || !threadFirstMessage.trim()}
                        full
                      />
                    </View>
                  )}
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
                        Thread messages, approvals, and artifacts are stored separately from Ora chat and
                        project knowledge — not Ora history, not AI Builder data.
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
                          Execution lifecycle
                        </Text>
                        {taskArtifacts.length === 0 ? (
                          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                            No execution events yet.
                          </Text>
                        ) : (
                          taskArtifacts
                            .filter((a) =>
                              ["draft_patch", "sandbox_result", "command_result", "github_pr_result"].includes(
                                a.type,
                              ),
                            )
                            .map((a) => {
                              const LIFECYCLE_LABELS: Record<string, string> = {
                                draft_patch: "Draft patch generated",
                                sandbox_result: "Sandbox result",
                                command_result: "Controlled checks result",
                                github_pr_result: "Pull request result",
                              };
                              return (
                                <Text
                                  key={a.id}
                                  style={{ color: c.mutedForeground, fontSize: 13 }}
                                >
                                  • {LIFECYCLE_LABELS[a.type] ?? a.type}
                                </Text>
                              );
                            })
                        )}

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
                                backgroundColor: c.muted,
                                borderRadius: 10,
                                padding: 10,
                                gap: 8,
                              }}
                            >
                              <View
                                style={{
                                  flexDirection: "row",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  gap: 8,
                                }}
                              >
                                <Text style={{ color: c.foreground, flex: 1, fontSize: 13 }}>
                                  {a.action.replace(/_/g, " ")}
                                </Text>
                                <Text style={{ color: c.accentForeground, fontSize: 12 }}>
                                  {a.status}
                                </Text>
                              </View>
                              {a.status === "pending" && (
                                <View style={{ flexDirection: "row", gap: 8 }}>
                                  <Button
                                    label="Approve"
                                    icon={Check}
                                    variant="secondary"
                                    loading={actionBusy === `decision-${a.id}`}
                                    onPress={() => void handleApprovalDecision(a.id, "approved")}
                                    style={{ flex: 1 }}
                                  />
                                  <Button
                                    label="Deny"
                                    icon={X}
                                    variant="ghost"
                                    loading={actionBusy === `decision-${a.id}`}
                                    onPress={() => void handleApprovalDecision(a.id, "denied")}
                                    style={{ flex: 1 }}
                                  />
                                </View>
                              )}
                              {a.status === "approved" && /read.?file/i.test(a.action) && (
                                <Button
                                  label="Read files"
                                  icon={FileText}
                                  variant="secondary"
                                  loading={actionBusy === `read-${a.id}`}
                                  onPress={() => void handleReadFiles(a.id)}
                                />
                              )}
                              {["approved", "completed"].includes(a.status) &&
                                /read.?file/i.test(a.action) && (
                                  <Button
                                    label="Generate draft patch"
                                    icon={FileText}
                                    variant="secondary"
                                    loading={actionBusy === `patch-${a.id}`}
                                    onPress={() => void handleDraftPatch(selectedTask.id, a.id)}
                                  />
                                )}
                              {a.status === "approved" && /sandbox/i.test(a.action) && (
                                <Button
                                  label="Run sandbox"
                                  icon={Play}
                                  variant="secondary"
                                  loading={actionBusy === `sandbox-${a.id}`}
                                  onPress={() => void handleRunSandbox(a.id)}
                                />
                              )}
                              {a.status === "approved" && /command/i.test(a.action) && (
                                <Button
                                  label="Run commands"
                                  icon={Play}
                                  variant="secondary"
                                  loading={actionBusy === `commands-${a.id}`}
                                  onPress={() => void handleRunCommands(a.id)}
                                />
                              )}
                              {a.status === "approved" &&
                                /github.?pr|pull.?request/i.test(a.action) && (
                                  <Button
                                    label="Create GitHub PR"
                                    icon={GitPullRequest}
                                    variant="secondary"
                                    loading={actionBusy === `pr-${a.id}`}
                                    onPress={() => void handleCreatePR(a.id)}
                                  />
                                )}
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
                              {a.type === "draft_patch" && !!artifactText(a, "unifiedDiff") && (
                                <Button
                                  label="Request sandbox approval"
                                  icon={Play}
                                  variant="secondary"
                                  loading={actionBusy === `req-sandbox-${a.id}`}
                                  onPress={() =>
                                    void handleRequestApproval("sandbox", selectedTask, a)
                                  }
                                />
                              )}
                              {a.type === "sandbox_result" && artifactFlag(a, "applied") && (
                                <Button
                                  label="Request controlled checks"
                                  icon={TerminalSquare}
                                  variant="secondary"
                                  loading={actionBusy === `req-commands-${a.id}`}
                                  onPress={() =>
                                    void handleRequestApproval("commands", selectedTask, a)
                                  }
                                />
                              )}
                              {a.type === "command_result" && artifactFlag(a, "passed") && (
                                <Button
                                  label="Request GitHub PR approval"
                                  icon={GitPullRequest}
                                  variant="secondary"
                                  loading={actionBusy === `req-pr-${a.id}`}
                                  onPress={() => void handleRequestApproval("pr", selectedTask, a)}
                                />
                              )}
                              {a.type === "github_pr_result" &&
                                artifactText(a, "pullRequestUrl") && (
                                  <Text style={{ color: c.accentForeground, fontSize: 12 }}>
                                    {artifactText(a, "pullRequestUrl")}
                                  </Text>
                                )}
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
