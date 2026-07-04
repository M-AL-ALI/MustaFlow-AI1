import {
  AlertCircle,
  ArrowLeft,
  ArrowUp,
  Bot,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  Code2,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Lock,
  Menu,
  MessageSquare,
  Mic,
  Monitor,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Scan,
  Search,
  ShieldAlert,
  ShieldCheck,
  TerminalSquare,
  XCircle,
} from "lucide-react-native";
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder } from "expo-audio";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Button, Card, EmptyState, Loading, Pill, TextField } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import {
  addRepository,
  appendTaskMessage,
  connectRepositoryGithubToken,
  continueTask,
  createApprovedGithubPr,
  createTask,
  decideApproval,
  generateDraftPatch,
  getOraxCapabilities,
  listOraxHosts,
  listOraxProjects,
  createOraxProject,
  sendProjectThreadMessage,
  continueProjectThread,
  getProjectThreadContext,
  listRepositories,
  listRepositoryScans,
  listTaskApprovals,
  listTaskArtifacts,
  listTaskMessages,
  listTasks,
  redeemOraxPairingCode,
  createDesktopAction,
  getDesktopActions,
  requestCommandApproval,
  requestFileReadApproval,
  requestGithubPrApproval,
  requestSandboxApproval,
  scanRepository,
  transcribeAudio,
  requestDesktopCommandApproval,
  resolveDesktopCommandApproval,
} from "@/lib/api";
import type { OraxCloudProject } from "@/lib/api";
import type {
  OraxApproval,
  OraxArtifact,
  OraxCapabilities,
  OraxComposerAttachment,
  OraxComposerMetadata,
  OraxComposerPermissionMode,
  OraxComposerReasoning,
  OraxHostSummary,
  OraxRepository,
  OraxScan,
  OraxTask,
  OraxTaskActionSuggestion,
  OraxTaskKind,
  OraxTaskMessage,
  RedeemPairingPayload,
} from "@/lib/types";

type Tab = "workspace" | "repos" | "approvals" | "artifacts" | "capabilities";

type LifecycleItem =
  | {
      id: string;
      kind: "approval";
      title: string;
      label: string;
      status: string;
      createdAt: string;
      description: string;
    }
  | {
      id: string;
      kind: "artifact";
      title: string;
      label: string;
      status: string;
      createdAt: string;
      description: string;
    };

type OraxDiffLine = {
  type: "add" | "remove" | "context" | "meta";
  content: string;
};

type OraxFileDiff = {
  path: string;
  additions: number;
  deletions: number;
  lines: OraxDiffLine[];
  truncated: boolean;
};

// Phase 2K: project thread message type (desktop relay integration)
type OraxProjectThreadMessage = {
  id: string;
  role: string;
  content: string;
  eventType?: string | null;
  createdAt: string;
  payload?: {
    draftPatch?: {
      summary: string;
      changedFiles: Array<{
        relativePath: string;
        operation: "update" | "create";
        intentDescription: string;
        hunkPreview: string[];
        newContent?: string;
        unifiedDiffPreview?: string;
        reason?: string;
      }>;
      risks: string[];
      verificationPlan: string[];
      draftGeneratedAt: string;
    };
    appliedPatch?: {
      changedFiles: Array<{ relativePath: string; operation: string }>;
      checkpointPath?: string;
      durationMs?: number;
    };
    checks?: Array<{
      name: string;
      command: string;
      status: "passed" | "failed" | "skipped";
      stdout: string;
      stderr: string;
      exitCode: number | null;
      durationMs: number;
    }>;
    allPassed?: boolean;
    fileReadSummary?: Array<{ relativePath: string; truncated: boolean; reason: string }>;
    [key: string]: unknown;
  } | null;
};

type OraxRunnerActivity = {
  label: string;
  status: "running" | "completed" | "waiting" | "failed" | "blocked";
};

const TASK_KINDS: Array<{ value: OraxTaskKind; label: string }> = [
  { value: "analyze", label: "Analyze" },
  { value: "plan", label: "Plan" },
  { value: "review", label: "Review" },
  { value: "fix", label: "Fix" },
];

const ORAX_COMPOSER_MODELS = ["Orax 5.5", "Orax 5.1"] as const;
const ORAX_REASONING_OPTIONS: Array<{ value: OraxComposerReasoning; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "extra_high", label: "Extra High" },
];
const ORAX_PERMISSION_OPTIONS: Array<{ value: OraxComposerPermissionMode; label: string }> = [
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
  { value: "read_only", label: "Read" },
];
const ORAX_SLASH_COMMANDS = [
  { command: "/plan", label: "Plan mode", description: "Shape the next implementation plan." },
  { command: "/goal", label: "Set goal", description: "Define what done means for this task." },
  { command: "/review", label: "Review mode", description: "Inspect first, then report findings." },
  { command: "/status", label: "Status", description: "Summarize the current task state." },
  { command: "/scan", label: "Scan files", description: "Refresh repository context." },
  { command: "/connect", label: "Connect", description: "Update repository access." },
  { command: "/help", label: "Help", description: "Show Orax commands." },
] as const;
type OraxSlashCommandOption = (typeof ORAX_SLASH_COMMANDS)[number];
const ORAX_ATTACHMENT_TEXT_LIMIT = 120_000;
const ORAX_ATTACHMENT_DATA_URL_LIMIT = 1_500_000;
const ORAX_TEXT_ATTACHMENT_EXTENSIONS = [
  ".c",
  ".cpp",
  ".cs",
  ".css",
  ".csv",
  ".env",
  ".go",
  ".graphql",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".log",
  ".md",
  ".mdx",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
] as const;

const DEFAULT_COMMANDS = ["patch-static-checks", "json-syntax", "node-syntax"];
const ORAX_TAGLINE = "MustaFlow AI coding agent for repositories";
const COMMAND_OPTIONS = [
  { id: "patch-static-checks", label: "Static" },
  { id: "json-syntax", label: "JSON" },
  { id: "node-syntax", label: "Node" },
  { id: "pnpm-typecheck", label: "Typecheck" },
  { id: "pnpm-lint", label: "Lint" },
  { id: "pnpm-test", label: "Test" },
  { id: "pnpm-build", label: "Build" },
];

function isOraxTextAttachment(name: string, type?: string): boolean {
  const mime = (type ?? "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (
    [
      "application/json",
      "application/javascript",
      "application/typescript",
      "application/xml",
      "application/x-javascript",
      "application/x-typescript",
      "application/x-yaml",
    ].includes(mime)
  ) {
    return true;
  }
  const lowerName = name.toLowerCase();
  return ORAX_TEXT_ATTACHMENT_EXTENSIONS.some((extension) => lowerName.endsWith(extension));
}

function isOraxImageAttachment(type?: string): boolean {
  return (type ?? "").toLowerCase().startsWith("image/");
}

function buildOraxAttachmentTextPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

async function readOraxMobileAttachment(asset: {
  uri: string;
  name: string;
  mimeType?: string | null;
  size?: number | null;
}): Promise<OraxComposerAttachment> {
  const base = {
    id: `${asset.name}-${asset.size ?? 0}-${asset.uri}`,
    name: asset.name,
    type: asset.mimeType ?? "application/octet-stream",
    size: asset.size ?? undefined,
    source: "mobile" as const,
  };

  if (isOraxTextAttachment(asset.name, asset.mimeType ?? undefined)) {
    try {
      const text = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.UTF8,
      });
      const truncated = text.length > ORAX_ATTACHMENT_TEXT_LIMIT;
      const contentText = truncated ? text.slice(0, ORAX_ATTACHMENT_TEXT_LIMIT) : text;
      return {
        ...base,
        contentKind: "text",
        contentText,
        preview: buildOraxAttachmentTextPreview(contentText),
        truncated,
        ingestionStatus: "ready",
      };
    } catch {
      return {
        ...base,
        contentKind: "unsupported",
        preview: "Orax could not read this text attachment.",
        ingestionStatus: "error",
      };
    }
  }

  if (isOraxImageAttachment(asset.mimeType ?? undefined)) {
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const dataUrl = `data:${base.type};base64,${base64}`;
      const tooLarge = dataUrl.length > ORAX_ATTACHMENT_DATA_URL_LIMIT;
      return {
        ...base,
        contentKind: tooLarge ? "unsupported" : "image",
        dataUrl: tooLarge ? undefined : dataUrl,
        preview: tooLarge
          ? "Image is too large for Orax inline context."
          : "Image data attached for visual/UI context.",
        truncated: tooLarge,
        ingestionStatus: tooLarge ? "unsupported" : "ready",
      };
    } catch {
      return {
        ...base,
        contentKind: "unsupported",
        preview: "Orax could not read this image attachment.",
        ingestionStatus: "error",
      };
    }
  }

  return {
    ...base,
    contentKind: "unsupported",
    preview: "No readable text or image data was extracted.",
    ingestionStatus: "unsupported",
  };
}

type OraxActiveThreadState = {
  label: string;
  objective: string;
  nextStep?: string;
} | null;

function getOraxActiveThreadState(
  selectedTask: OraxTask | null,
  latestCheckpoint: { nextStep?: string } | null,
): OraxActiveThreadState {
  const activeGoal = selectedTask?.result?.activeGoal as
    | { objective?: string; status?: string }
    | undefined;
  const plan = selectedTask?.plan;
  const goalObjective =
    typeof activeGoal?.objective === "string" ? activeGoal.objective.trim() : "";
  const planObjective =
    typeof plan?.objective === "string" ? plan.objective.trim() : "";
  if (!goalObjective && !planObjective) return null;
  return {
    label: goalObjective ? "Goal" : "Plan mode",
    objective: goalObjective || planObjective,
    nextStep: latestCheckpoint?.nextStep,
  };
}

function mergeOraxTaskMessages(
  current: OraxTaskMessage[],
  incoming: OraxTaskMessage[],
): OraxTaskMessage[] {
  if (!incoming.length) return current;
  const byId = new Map<number, OraxTaskMessage>();
  for (const message of current) byId.set(message.id, message);
  for (const message of incoming) byId.set(message.id, message);
  return Array.from(byId.values()).sort((a, b) => {
    const left = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const right = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return left - right || a.id - b.id;
  });
}

export default function OraxScreen() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY });
  const [threadOpen, setThreadOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [homeComposeOpen, setHomeComposeOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");

  const [caps, setCaps] = useState<OraxCapabilities | null>(null);
  const [repos, setRepos] = useState<OraxRepository[]>([]);
  const [tasks, setTasks] = useState<OraxTask[]>([]);
  const [scans, setScans] = useState<OraxScan[]>([]);
  const [approvals, setApprovals] = useState<OraxApproval[]>([]);
  const [artifacts, setArtifacts] = useState<OraxArtifact[]>([]);
  const [messages, setMessages] = useState<OraxTaskMessage[]>([]);

  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const activeTaskIdRef = useRef<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [repoBranch, setRepoBranch] = useState("main");
  const [githubToken, setGithubToken] = useState("");
  const [scanBranch, setScanBranch] = useState("");

  const [taskPrompt, setTaskPrompt] = useState("");
  const [taskKind, setTaskKind] = useState<OraxTaskKind>("analyze");
  const [threadDraft, setThreadDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<OraxComposerAttachment[]>([]);
  const [composerModel, setComposerModel] =
    useState<(typeof ORAX_COMPOSER_MODELS)[number]>("Orax 5.5");
  const [composerReasoning, setComposerReasoning] = useState<OraxComposerReasoning>("extra_high");
  const [composerPermissionMode, setComposerPermissionMode] =
    useState<OraxComposerPermissionMode>("ask");
  const [composerInputMode, setComposerInputMode] = useState<"text" | "voice">("text");
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [oraxHosts, setOraxHosts] = useState<OraxHostSummary[]>([]);
  const [oraxHostsLoading, setOraxHostsLoading] = useState(true);
  const [oraxProjects, setOraxProjects] = useState<OraxCloudProject[]>([]);
  const [oraxProjectsLoading, setOraxProjectsLoading] = useState(true);
  const [activeProjectThreadId, setActiveProjectThreadId] = useState<string | null>(null);
  const [projectThreadCtx, setProjectThreadCtx] = useState<{
    canExecute: boolean;
    mode: string;
    blockReason: string | null;
    host: { deviceName: string } | null;
  } | null>(null);
  const [projectThreadMessages, setProjectThreadMessages] = useState<
    OraxProjectThreadMessage[]
  >([]);

  const reloadHosts = useCallback(async () => {
    setOraxHostsLoading(true);
    try {
      const data = await listOraxHosts();
      setOraxHosts(data.hosts ?? []);
    } catch {
      // silent — card shows empty state
    } finally {
      setOraxHostsLoading(false);
    }
  }, []);

  const reloadProjects = useCallback(async () => {
    setOraxProjectsLoading(true);
    try {
      const data = await listOraxProjects();
      setOraxProjects(data.projects ?? []);
    } catch {
      // silent — card shows empty state
    } finally {
      setOraxProjectsLoading(false);
    }
  }, []);

  const createProjectScopedThread = useCallback(
    async (projectId: string, threadId: string, userMessage: string) => {
      const ctxResult = await getProjectThreadContext(projectId, threadId);
      const ctx = ctxResult.context;
      setProjectThreadCtx({
        canExecute: ctx.canExecute,
        mode: ctx.mode,
        blockReason: ctx.blockReason ?? null,
        host: ctx.host ? { deviceName: ctx.host.deviceName ?? "Desktop" } : null,
      });
      setActiveProjectThreadId(threadId);
      if (userMessage.trim()) {
        const result = await continueProjectThread(projectId, threadId, {
          userMessage: userMessage.trim(),
        });
        if (result.context) {
          setProjectThreadCtx({
            canExecute: result.context.canExecute,
            mode: result.context.mode,
            blockReason: result.context.blockReason ?? null,
            host: result.context.host
              ? { deviceName: result.context.host.deviceName ?? "Desktop" }
              : null,
          });
        }
      }
    },
    [],
  );

  useEffect(() => {
    void reloadHosts();
    void reloadProjects();
  }, [reloadHosts, reloadProjects]);

  const desktopHostState: "online" | "offline" | "not-connected" = oraxHostsLoading
    ? "not-connected"
    : oraxHosts.length === 0
      ? "not-connected"
      : oraxHosts.some(isDesktopHostOnline)
        ? "online"
        : "offline";
  const [transcribingVoice, setTranscribingVoice] = useState(false);

  const [approvalPaths, setApprovalPaths] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [approvalBranch, setApprovalBranch] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [selectedCommands, setSelectedCommands] = useState<string[]>(DEFAULT_COMMANDS);
  const [prTitle, setPrTitle] = useState("");
  const [prConfirm, setPrConfirm] = useState("");

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === selectedRepoId) ?? repos[0] ?? null,
    [repos, selectedRepoId],
  );
  const selectedTask = useMemo(
    () => (selectedTaskId ? (tasks.find((task) => task.id === selectedTaskId) ?? null) : null),
    [tasks, selectedTaskId],
  );
  const visibleTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => {
      const repo = repos.find((item) => item.id === task.repositoryId);
      return [task.title, task.prompt, task.kind, task.status, repo?.owner, repo?.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [repos, taskSearch, tasks]);
  const menuTasks = useMemo(
    () =>
      (selectedRepo ? tasks.filter((task) => task.repositoryId === selectedRepo.id) : tasks).slice(
        0,
        5,
      ),
    [selectedRepo, tasks],
  );
  const chatPreview = useMemo(() => {
    const latestUserMessage = [...messages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    return latestUserMessage ?? selectedTask?.prompt ?? "Start a chat with Orax";
  }, [messages, selectedTask]);
  const latestScan = scans[0] ?? null;
  const latestDraftPatch = artifacts.find((artifact) => artifact.type === "draft_patch") ?? null;
  const latestSandbox = artifacts.find((artifact) => artifact.type === "sandbox_result") ?? null;
  const latestWorkspaceChangeSet =
    artifacts.find((artifact) => artifact.type === "workspace_change_set") ?? null;
  const latestCommand = artifacts.find((artifact) => artifact.type === "command_result") ?? null;
  const latestPr = artifacts.find((artifact) => artifact.type === "github_pr_result") ?? null;
  const readApproval =
    approvals.find(
      (approval) =>
        approval.action === "read_files" &&
        (approval.status === "completed" || approval.status === "approved"),
    ) ?? null;
  const latestAssistantSuggestion = useMemo(() => {
    const assistant = [...messages]
      .reverse()
      .find((message) => message.role === "assistant" && message.metadata?.actionSuggestions);
    return assistant?.metadata?.actionSuggestions?.[0] ?? null;
  }, [messages]);
  const pendingThreadApprovals = approvals.filter((approval) => approval.status === "pending");
  const latestCheckpoint = useMemo(() => {
    const checkpointMessage = [...messages]
      .reverse()
      .find((message) => message.metadata?.checkpoint);
    return (
      checkpointMessage?.metadata?.checkpoint ?? selectedTask?.result?.currentCheckpoint ?? null
    );
  }, [messages, selectedTask]);
  const lifecycleItems = useMemo(
    () =>
      buildLifecycleItems(approvals, artifacts)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 10),
    [approvals, artifacts],
  );
  const visibleMessages = useMemo(() => messages.filter(isOraxVisibleThreadMessage), [messages]);
  const visibleSlashCommands = useMemo(() => {
    const draft = threadDraft.trimStart();
    if (!draft.startsWith("/") || /\s/.test(draft)) return [];
    const query = draft.slice(1).toLowerCase();
    return ORAX_SLASH_COMMANDS.filter((command) =>
      command.command.slice(1).startsWith(query),
    ).slice(0, 7);
  }, [threadDraft]);

  const clearTaskScopedState = useCallback(() => {
    setApprovals([]);
    setArtifacts([]);
    setMessages([]);
    setThreadDraft("");
    setDraftInstructions("");
    setPrTitle("");
    setPrConfirm("");
    setComposerAttachments([]);
    setComposerInputMode("text");
  }, []);

  const loadRoot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextCaps, nextRepos, nextTasks] = await Promise.all([
        getOraxCapabilities(),
        listRepositories(),
        listTasks(),
      ]);
      setCaps(nextCaps);
      setRepos(nextRepos);
      setTasks(nextTasks);
      setSelectedRepoId((current) =>
        current && nextRepos.some((repo) => repo.id === current)
          ? current
          : (nextRepos[0]?.id ?? null),
      );
      setSelectedTaskId((current) =>
        current && nextTasks.some((task) => task.id === current)
          ? current
          : (nextTasks[0]?.id ?? null),
      );
    } catch (err) {
      setError(messageFromError(err, "Could not load Orax"));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadTaskDetails = useCallback(async (taskId: number | null) => {
    if (!taskId) {
      setApprovals([]);
      setArtifacts([]);
      setMessages([]);
      return;
    }
    setDetailsLoading(true);
    try {
      const [nextApprovals, nextArtifacts, nextMessages] = await Promise.allSettled([
        listTaskApprovals(taskId),
        listTaskArtifacts(taskId),
        listTaskMessages(taskId),
      ]);
      if (activeTaskIdRef.current !== taskId) return;
      if (nextApprovals.status === "fulfilled") {
        setApprovals(nextApprovals.value);
      }
      if (nextArtifacts.status === "fulfilled") {
        setArtifacts(nextArtifacts.value);
      }
      if (nextMessages.status === "fulfilled") {
        setMessages(nextMessages.value);
      } else {
        setError(messageFromError(nextMessages.reason, "Could not load Orax thread"));
        setMessages([]);
      }
    } catch (err) {
      if (activeTaskIdRef.current !== taskId) return;
      setError(messageFromError(err, "Could not load Orax thread"));
    } finally {
      setDetailsLoading(false);
    }
  }, []);

  const refreshTaskTimeline = useCallback(async (taskId: number) => {
    try {
      const [nextApprovals, nextArtifacts, nextMessages] = await Promise.allSettled([
        listTaskApprovals(taskId),
        listTaskArtifacts(taskId),
        listTaskMessages(taskId),
      ]);
      if (activeTaskIdRef.current !== taskId) return;
      if (nextApprovals.status === "fulfilled") {
        setApprovals(nextApprovals.value);
      }
      if (nextArtifacts.status === "fulfilled") {
        setArtifacts(nextArtifacts.value);
      }
      if (nextMessages.status === "fulfilled") {
        setMessages((prev) => mergeOraxTaskMessages(prev, nextMessages.value));
      }
    } catch {
      // Live sync is best-effort; manual refresh and action responses still load full state.
    }
  }, []);

  const loadScans = useCallback(async (repoId: number | null) => {
    if (!repoId) {
      setScans([]);
      return;
    }
    try {
      setScans(await listRepositoryScans(repoId));
    } catch {
      setScans([]);
    }
  }, []);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  useEffect(() => {
    if (!selectedTask) {
      activeTaskIdRef.current = null;
      clearTaskScopedState();
      return;
    }

    const switchedTasks = activeTaskIdRef.current !== selectedTask.id;
    activeTaskIdRef.current = selectedTask.id;
    if (switchedTasks) {
      clearTaskScopedState();
    }
    void loadTaskDetails(selectedTask.id);
  }, [clearTaskScopedState, loadTaskDetails, selectedTask]);

  useEffect(() => {
    if (!selectedTask || !threadOpen) return;
    const taskId = selectedTask.id;
    const timer = setInterval(() => {
      void refreshTaskTimeline(taskId);
    }, 4_000);
    void refreshTaskTimeline(taskId);
    return () => clearInterval(timer);
  }, [refreshTaskTimeline, selectedTask, threadOpen]);

  useEffect(() => {
    void loadScans(selectedRepo?.id ?? null);
    if (selectedRepo?.defaultBranch) {
      setApprovalBranch(selectedRepo.defaultBranch);
      setScanBranch(selectedRepo.defaultBranch);
    }
  }, [loadScans, selectedRepo?.defaultBranch, selectedRepo?.id]);

  const refreshCurrent = useCallback(async () => {
    await loadRoot();
    await loadTaskDetails(selectedTask?.id ?? null);
    await loadScans(selectedRepo?.id ?? null);
  }, [loadRoot, loadScans, loadTaskDetails, selectedRepo?.id, selectedTask?.id]);

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>) => {
      setBusyAction(key);
      setError(null);
      try {
        await action();
        await refreshCurrent();
      } catch (err) {
        setError(messageFromError(err, "Orax action failed"));
      } finally {
        setBusyAction(null);
      }
    },
    [refreshCurrent],
  );

  const submitRepository = useCallback(async () => {
    if (!repoUrl.trim()) return;
    await runAction("add-repo", async () => {
      const created = await addRepository(repoUrl.trim(), repoBranch.trim() || "main");
      let nextRepository = created.repository;
      if (githubToken.trim()) {
        const connected = await connectRepositoryGithubToken(
          created.repository.id,
          githubToken.trim(),
        );
        nextRepository = connected.repository;
        setGithubToken("");
      }
      setSelectedRepoId(nextRepository.id);
      setRepoUrl("");
      setRepoBranch("main");
      setShowDetails(false);
    });
  }, [githubToken, repoBranch, repoUrl, runAction]);

  const connectGithub = useCallback(async () => {
    if (!selectedRepo || !githubToken.trim()) return;
    await runAction("connect-github", async () => {
      await connectRepositoryGithubToken(selectedRepo.id, githubToken.trim());
      setGithubToken("");
    });
  }, [githubToken, runAction, selectedRepo]);

  const submitScan = useCallback(async () => {
    if (!selectedRepo) return;
    await runAction("scan-repo", async () => {
      await scanRepository(selectedRepo.id, scanBranch.trim() || selectedRepo.defaultBranch);
    });
  }, [runAction, scanBranch, selectedRepo]);

  const submitTask = useCallback(async () => {
    const repoId = selectedRepo?.id;
    const prompt = taskPrompt.trim();
    if (!repoId || !prompt) return;
    await runAction("create-task", async () => {
      const created = await createTask({ repositoryId: repoId, kind: taskKind, prompt });
      activeTaskIdRef.current = created.task.id;
      setTasks((prev) => [created.task, ...prev.filter((task) => task.id !== created.task.id)]);
      setSelectedTaskId(created.task.id);
      setTaskPrompt("");
      await appendTaskMessage(created.task.id, prompt);
      await loadTaskDetails(created.task.id);
      setThreadOpen(true);
      setHomeComposeOpen(false);
      setShowDetails(false);
    });
  }, [loadTaskDetails, runAction, selectedRepo?.id, taskKind, taskPrompt]);

  const selectTask = useCallback(
    (task: OraxTask) => {
      if (task.id !== activeTaskIdRef.current) {
        clearTaskScopedState();
      }
      activeTaskIdRef.current = task.id;
      setSelectedTaskId(task.id);
      setSelectedRepoId(task.repositoryId);
      setThreadOpen(true);
      setShowDetails(false);
    },
    [clearTaskScopedState],
  );

  const startNewThread = useCallback(() => {
    if (!selectedRepo) {
      clearTaskScopedState();
      activeTaskIdRef.current = null;
      setSelectedTaskId(null);
      setThreadOpen(false);
      setHomeComposeOpen(false);
      setShowDetails(false);
      setError(null);
      return;
    }
    clearTaskScopedState();
    activeTaskIdRef.current = null;
    setSelectedTaskId(null);
    setThreadDraft("");
    setTaskPrompt("");
    setThreadOpen(true);
    setHomeComposeOpen(false);
    setShowDetails(false);
  }, [clearTaskScopedState, selectedRepo]);

  const selectRepositoryFromMenu = useCallback(
    (repo: OraxRepository) => {
      const nextTask = tasks.find((task) => task.repositoryId === repo.id) ?? null;
      setSelectedRepoId(repo.id);
      setSelectedTaskId(nextTask?.id ?? null);
      setTaskSearch(repo.name);
      setThreadOpen(Boolean(nextTask));
      setWorkspaceMenuOpen(false);
    },
    [tasks],
  );

  const selectRepositoryChip = useCallback((repo: OraxRepository) => {
    setSelectedRepoId(repo.id);
    setTaskSearch(repo.name);
    setThreadOpen(false);
  }, []);

  const selectTaskFromMenu = useCallback(
    (task: OraxTask) => {
      selectTask(task);
      setWorkspaceMenuOpen(false);
    },
    [selectTask],
  );

  const buildComposerMetadata = useCallback(
    (inputMode: "text" | "voice" = composerInputMode): OraxComposerMetadata => ({
      composer: {
        model: composerModel,
        reasoning: composerReasoning,
        permissionMode: composerPermissionMode,
        inputMode,
        attachments: composerAttachments,
      },
    }),
    [
      composerAttachments,
      composerInputMode,
      composerModel,
      composerPermissionMode,
      composerReasoning,
    ],
  );

  const pickComposerAttachments = useCallback(async () => {
    const slots = Math.max(0, 6 - composerAttachments.length);
    if (slots === 0) {
      Alert.alert("Attachment limit", "Orax can attach up to 6 files to one message.");
      return;
    }
    const result = await DocumentPicker.getDocumentAsync({
      multiple: true,
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const assets = result.assets.slice(0, slots);
    const attachments = await Promise.all(assets.map((asset) => readOraxMobileAttachment(asset)));
    setComposerAttachments((prev) => [...prev, ...attachments]);
    if (result.assets.length > slots) {
      Alert.alert("Attachment limit", "Only the first 6 attachments were added.");
    }
  }, [composerAttachments.length]);

  const removeComposerAttachment = useCallback((id?: string) => {
    setComposerAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }, []);

  const cycleComposerPermissionMode = useCallback(() => {
    setComposerPermissionMode((current) => {
      const index = ORAX_PERMISSION_OPTIONS.findIndex((option) => option.value === current);
      return ORAX_PERMISSION_OPTIONS[(index + 1) % ORAX_PERMISSION_OPTIONS.length].value;
    });
  }, []);

  const toggleComposerVoiceInput = useCallback(async () => {
    if (transcribingVoice) return;
    if (recordingVoice) {
      setRecordingVoice(false);
      setTranscribingVoice(true);
      try {
        await recorder.stop();
        await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
        const uri = recorder.uri;
        if (!uri) {
          throw new Error("No audio captured");
        }
        const text = (await transcribeAudio(uri, "m4a")).trim();
        if (!text) {
          throw new Error("Empty transcript");
        }
        setThreadDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
        setComposerInputMode("voice");
      } catch {
        Alert.alert(
          "Transcription failed",
          "Orax could not transcribe that audio. Please try again.",
        );
      } finally {
        setTranscribingVoice(false);
      }
      return;
    }

    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Microphone access needed",
          "Enable microphone permission in Settings to dictate an Orax message.",
        );
        return;
      }
      await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecordingVoice(true);
    } catch {
      setRecordingVoice(false);
      Alert.alert("Recording failed", "Orax could not start recording. Please try again.");
    }
  }, [recorder, recordingVoice, transcribingVoice]);

  const sendThreadMessage = useCallback(async () => {
    const text = threadDraft.trim() || "Review the attached Orax context.";
    if (!threadDraft.trim() && composerAttachments.length === 0) return;
    const metadata = buildComposerMetadata();

    if (!selectedTask) {
      const repoId = selectedRepo?.id;
      if (!repoId) {
        setError("Connect a GitHub repository before starting an Orax chat.");
        setThreadOpen(false);
        return;
      }
      await runAction("create-task", async () => {
        const created = await createTask({ repositoryId: repoId, kind: taskKind, prompt: text });
        activeTaskIdRef.current = created.task.id;
        setTasks((prev) => [created.task, ...prev.filter((task) => task.id !== created.task.id)]);
        setSelectedTaskId(created.task.id);
        setTaskPrompt("");
        setThreadDraft("");
        setComposerAttachments([]);
        setComposerInputMode("text");
        await appendTaskMessage(created.task.id, text, metadata);
        await loadTaskDetails(created.task.id);
        setThreadOpen(true);
        setHomeComposeOpen(false);
        setShowDetails(false);
      });
      return;
    }

    await runAction("send-thread", async () => {
      await appendTaskMessage(selectedTask.id, text, metadata);
      setThreadDraft("");
      setComposerAttachments([]);
      setComposerInputMode("text");
    });
  }, [
    buildComposerMetadata,
    composerAttachments.length,
    loadTaskDetails,
    runAction,
    selectedRepo?.id,
    selectedTask,
    taskKind,
    threadDraft,
  ]);

  const continueCurrentTask = useCallback(async () => {
    if (!selectedTask) return;
    await runAction("continue-task", async () => {
      await continueTask(selectedTask.id);
    });
  }, [runAction, selectedTask]);

  const submitReadApproval = useCallback(async () => {
    if (!selectedTask) return;
    const paths = approvalPaths
      .split(/[\n,]+/)
      .map((path) => path.trim())
      .filter(Boolean);
    if (!paths.length) return;
    await runAction("request-read", async () => {
      await requestFileReadApproval({
        taskId: selectedTask.id,
        paths,
        branch: approvalBranch.trim() || selectedRepo?.defaultBranch,
        reason: approvalReason.trim() || undefined,
      });
      setApprovalPaths("");
      setApprovalReason("");
      setShowDetails(true);
    });
  }, [
    approvalBranch,
    approvalPaths,
    approvalReason,
    runAction,
    selectedRepo?.defaultBranch,
    selectedTask,
  ]);

  const applySuggestion = useCallback(
    (suggestion: OraxTaskActionSuggestion) => {
      if (!selectedTask) return;

      if (suggestion.type !== "github_pr") {
        void continueCurrentTask();
        return;
      }

      const artifactId = suggestion.artifactId ?? latestCommand?.id;
      if (!artifactId) {
        setThreadDraft("Run controlled checks before asking Orax to prepare a pull request.");
        return;
      }
      void runAction("pr-approval", async () => {
        await requestGithubPrApproval({
          taskId: selectedTask.id,
          artifactId,
          title: selectedTask.title ?? undefined,
          reason: suggestion.reason ?? suggestion.description,
        });
      });
    },
    [continueCurrentTask, latestCommand?.id, runAction, selectedTask],
  );

  const toggleCommand = useCallback((id: string) => {
    setSelectedCommands((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }, []);

  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View
        style={{
          paddingTop: insets.top + 10,
          paddingBottom: 14,
          paddingHorizontal: 24,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          backgroundColor: c.background,
        }}
        accessibilityLabel={ORAX_TAGLINE}
      >
        <Pressable
          onPress={() => {
            if (threadOpen) {
              setThreadOpen(false);
              return;
            }
            setWorkspaceMenuOpen(true);
          }}
          hitSlop={10}
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.muted,
          }}
        >
          {threadOpen ? (
            <ArrowLeft size={25} color={c.foreground} />
          ) : (
            <Menu size={25} color={c.foreground} />
          )}
        </Pressable>
        <View style={{ flex: 1, alignItems: "center", paddingHorizontal: 12 }}>
          <Text
            numberOfLines={1}
            style={{
              color: c.foreground,
              fontFamily: "Inter_700Bold",
              fontSize: 20,
            }}
          >
            {threadOpen ? (selectedTask?.title ?? "Orax") : "Orax"}
          </Text>
          {threadOpen && selectedRepo ? (
            <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
              {selectedRepo.owner}/{selectedRepo.name}
            </Text>
          ) : null}
        </View>
        <Pressable
          onPress={() => setWorkspaceMenuOpen(true)}
          hitSlop={10}
          style={{
            width: 52,
            height: 52,
            borderRadius: 26,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.muted,
          }}
        >
          <MoreHorizontal size={25} color={c.foreground} />
        </Pressable>
      </View>
      {loading ? (
        <Loading label="Loading Orax..." />
      ) : (
        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView
            contentContainerStyle={{
              padding: 14,
              gap: 12,
              paddingBottom: insets.bottom + 24,
            }}
            keyboardShouldPersistTaps="handled"
          >
            {error ? <Notice tone="error" title="Orax needs attention" body={error} /> : null}

            {!threadOpen ? (
              <>
                {desktopHostState === "offline" && (
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      paddingHorizontal: 12,
                      paddingVertical: 8,
                      borderRadius: 8,
                      backgroundColor: c.card,
                      borderWidth: 1,
                      borderColor: c.border,
                    }}
                  >
                    <Monitor size={14} color={c.mutedForeground} />
                    <Text style={{ fontSize: 13, color: c.mutedForeground, fontFamily: "Inter_500Medium" }}>
                      Desktop offline
                    </Text>
                  </View>
                )}
                <DesktopConnectionCard
                  hosts={oraxHosts}
                  hostsLoading={oraxHostsLoading}
                  onRefresh={reloadHosts}
                />

                <WorkspaceChips
                  repos={repos}
                  selectedRepo={selectedRepo}
                  taskSearch={taskSearch}
                  onShowAll={() => setTaskSearch("")}
                  onSelectRepo={selectRepositoryChip}
                  onOpenMenu={() => setWorkspaceMenuOpen(true)}
                />

                <View style={{ gap: 18, paddingTop: 22 }}>
                  <Text
                    style={{
                      color: c.foreground,
                      fontFamily: "Inter_700Bold",
                      fontSize: 24,
                    }}
                  >
                    Projects
                  </Text>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                    <Folder size={22} color={c.foreground} />
                    <View style={{ flex: 1 }}>
                      <Text
                        numberOfLines={1}
                        style={{
                          color: c.foreground,
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 18,
                        }}
                      >
                        {selectedRepo
                          ? `${selectedRepo.owner}/${selectedRepo.name}`
                          : "Connect a repository"}
                      </Text>
                    </View>
                    <Pressable
                      onPress={selectedRepo ? startNewThread : () => setThreadOpen(false)}
                      hitSlop={10}
                    >
                      {selectedRepo ? (
                        <Plus size={20} color={c.mutedForeground} />
                      ) : (
                        <GitBranch size={20} color={c.mutedForeground} />
                      )}
                    </Pressable>
                  </View>

                  <View style={{ gap: 22 }}>
                    {!selectedRepo ? (
                      <Card style={{ gap: 12, borderStyle: "dashed" }}>
                        <SectionTitle title="Connect GitHub repository" icon={GitBranch} />
                        <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
                          Orax needs a repository before it can inspect files, run checks, or
                          prepare code changes.
                        </Text>
                        <TextField
                          label="Repository URL"
                          placeholder="https://github.com/owner/repo"
                          autoCapitalize="none"
                          value={repoUrl}
                          onChangeText={setRepoUrl}
                        />
                        <TextField
                          label="Branch"
                          placeholder="main"
                          autoCapitalize="none"
                          value={repoBranch}
                          onChangeText={setRepoBranch}
                        />
                        <TextField
                          label="GitHub token"
                          placeholder="Optional for private repositories"
                          autoCapitalize="none"
                          value={githubToken}
                          onChangeText={setGithubToken}
                        />
                        <Button
                          label="Connect repository"
                          icon={GitBranch}
                          onPress={submitRepository}
                          loading={busyAction === "add-repo"}
                          disabled={!repoUrl.trim()}
                          full
                        />
                        <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18 }}>
                          Orax Desktop syncs connected repositories automatically. You can also add
                          a repository URL manually.
                        </Text>
                      </Card>
                    ) : (
                      <RepositoryWorkspaceCard
                        repo={selectedRepo}
                        latestScan={latestScan}
                        githubToken={githubToken}
                        onChangeGithubToken={setGithubToken}
                        onConnect={connectGithub}
                        onScan={submitScan}
                        onStartChat={startNewThread}
                        busyAction={busyAction}
                      />
                    )}
                    {selectedRepo ? (
                      visibleTasks.length === 0 ? (
                        <Text style={{ color: c.mutedForeground, fontSize: 16 }}>
                          No tasks yet. Tap Chat to start an Orax task.
                        </Text>
                      ) : (
                        visibleTasks.map((task) => (
                          <Pressable key={task.id} onPress={() => selectTask(task)}>
                            <Text
                              numberOfLines={1}
                              style={{ color: c.foreground, fontSize: 18, lineHeight: 26 }}
                            >
                              {task.title ?? task.prompt ?? "Orax task"}
                            </Text>
                          </Pressable>
                        ))
                      )
                    ) : null}
                  </View>

                  <View style={{ gap: 18, paddingTop: 10 }}>
                    <Text
                      style={{
                        color: c.foreground,
                        fontFamily: "Inter_700Bold",
                        fontSize: 18,
                      }}
                    >
                      Chats
                    </Text>
                    <Pressable
                      onPress={() => {
                        if (selectedTask) {
                          selectTask(selectedTask);
                        } else {
                          startNewThread();
                        }
                      }}
                    >
                      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 18 }}>
                        {selectedRepo ? chatPreview : "Connect GitHub repository"}
                      </Text>
                    </Pressable>
                  </View>
                </View>

                <View
                  style={{
                    flexDirection: "row",
                    gap: 12,
                    alignItems: "center",
                    paddingTop: 28,
                    paddingBottom: 8,
                  }}
                >
                  <View
                    style={{
                      flex: 1,
                      minHeight: 50,
                      borderRadius: 24,
                      backgroundColor: c.card,
                      borderWidth: 1,
                      borderColor: c.border,
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingHorizontal: 14,
                    }}
                  >
                    <Search size={20} color={c.mutedForeground} />
                    <TextInput
                      value={taskSearch}
                      onChangeText={setTaskSearch}
                      placeholder="Search Chats"
                      placeholderTextColor={c.mutedForeground}
                      style={{ flex: 1, color: c.foreground, fontSize: 16 }}
                    />
                  </View>
                  <Button
                    label={selectedRepo ? "Chat" : "Connect"}
                    icon={selectedRepo ? MessageSquare : GitBranch}
                    onPress={startNewThread}
                  />
                </View>
              </>
            ) : (
              <>
                <View style={{ gap: 12 }}>
                  {detailsLoading ? <Loading label="Loading thread..." /> : null}
                  {selectedTask ? (
                    <>
                      <View style={{ gap: 10 }}>
                        {visibleMessages.length === 0 ? (
                          <View style={{ minHeight: 180 }} />
                        ) : (
                          visibleMessages
                            .slice(-10)
                            .map((message) => <MessageBubble key={message.id} message={message} />)
                        )}
                      </View>
                      {latestAssistantSuggestion ? (
                        <SuggestionCard
                          suggestion={latestAssistantSuggestion}
                          onPress={() => applySuggestion(latestAssistantSuggestion)}
                        />
                      ) : null}
                      {!latestAssistantSuggestion && pendingThreadApprovals.length === 0 ? (
                        <Button
                          label="Continue"
                          icon={RefreshCw}
                          variant="secondary"
                          loading={busyAction === "continue-task"}
                          onPress={() => void continueCurrentTask()}
                        />
                      ) : null}
                      {approvals
                        .filter(
                          (approval) =>
                            approval.status === "pending" || approval.status === "approved",
                        )
                        .map((approval) => (
                          <ApprovalCard
                            key={approval.id}
                            approval={approval}
                            busyAction={busyAction}
                            onApprove={() =>
                              void runAction(`approve-${approval.id}`, async () => {
                                await decideApproval(approval.id, "approved");
                                if (approval.action === "github_pr") {
                                  await createApprovedGithubPr(approval.id);
                                } else {
                                  await continueTask(approval.taskId);
                                }
                              })
                            }
                            onDeny={() =>
                              void runAction(`deny-${approval.id}`, async () => {
                                await decideApproval(approval.id, "denied");
                              })
                            }
                            onRun={() =>
                              void runAction(`run-${approval.id}`, async () => {
                                if (approval.action === "read_files") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "sandbox_run") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "safe_check") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "github_pr") {
                                  await createApprovedGithubPr(approval.id);
                                }
                              })
                            }
                          />
                        ))}
                    </>
                  ) : null}
                  {(() => {
                    const activeThreadState = getOraxActiveThreadState(
                      selectedTask,
                      latestCheckpoint,
                    );
                    const hasVisibleInlineAction =
                      latestAssistantSuggestion !== null || pendingThreadApprovals.length > 0;
                    return activeThreadState && !hasVisibleInlineAction ? (
                      <ActiveThreadStateStrip
                        state={activeThreadState}
                        continuing={busyAction === "continue-task"}
                        onContinue={() => void continueCurrentTask()}
                      />
                    ) : null;
                  })()}
                  <OraxComposer
                    value={threadDraft}
                    onChangeText={setThreadDraft}
                    onSend={sendThreadMessage}
                    attachments={composerAttachments}
                    onAddAttachment={() => void pickComposerAttachments()}
                    onRemoveAttachment={removeComposerAttachment}
                    model={composerModel}
                    reasoning={composerReasoning}
                    permissionMode={composerPermissionMode}
                    onChangeModel={setComposerModel}
                    onChangeReasoning={setComposerReasoning}
                    onCyclePermission={cycleComposerPermissionMode}
                    onToggleVoice={() => void toggleComposerVoiceInput()}
                    voiceActive={recordingVoice}
                    voiceLoading={transcribingVoice}
                    slashCommands={visibleSlashCommands}
                    onSelectSlashCommand={(command) => setThreadDraft(`${command} `)}
                    loading={busyAction === "send-thread" || busyAction === "create-task"}
                    disabled={
                      (!threadDraft.trim() && composerAttachments.length === 0) ||
                      (!selectedTask && !selectedRepo)
                    }
                  />
                </View>

                {false ? (
                  <>
                    <TaskFocusCard
                      task={selectedTask}
                      repo={selectedRepo}
                      checkpointNextStep={latestCheckpoint?.nextStep}
                      pendingApprovals={
                        approvals.filter((approval) => approval.status === "pending").length
                      }
                      artifactCount={artifacts.length}
                      onRefresh={() => void refreshCurrent()}
                      refreshing={busyAction === "refresh"}
                    />

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Task history" icon={TerminalSquare} />
                      {repos.length === 0 ? (
                        <EmptyState
                          icon={GitBranch}
                          title="Connect a repository"
                          subtitle="Orax starts with a GitHub repository, then keeps code work isolated behind approvals."
                        />
                      ) : (
                        <>
                          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                            {TASK_KINDS.map((kind) => (
                              <Pill
                                key={kind.value}
                                label={kind.label}
                                active={taskKind === kind.value}
                                onPress={() => setTaskKind(kind.value)}
                              />
                            ))}
                          </View>
                          <TextField
                            label="Start Orax task"
                            placeholder="Ask Orax to inspect, plan, review, or fix code..."
                            value={taskPrompt}
                            onChangeText={setTaskPrompt}
                            multiline
                            style={{ minHeight: 88, textAlignVertical: "top" }}
                          />
                          <Button
                            label="Start chat"
                            icon={Play}
                            onPress={submitTask}
                            loading={busyAction === "create-task"}
                            disabled={!selectedRepo || !taskPrompt.trim()}
                            full
                          />
                          <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18 }}>
                            The first message becomes the task prompt and stays in the Orax task
                            thread, not normal Ora history or AI Builder.
                          </Text>
                          {tasks.length ? (
                            <ScrollView
                              horizontal
                              showsHorizontalScrollIndicator={false}
                              contentContainerStyle={{ gap: 8 }}
                            >
                              {tasks.map((task) => (
                                <Pressable key={task.id} onPress={() => selectTask(task)}>
                                  <View
                                    style={{
                                      width: 240,
                                      minHeight: 92,
                                      borderWidth: 1,
                                      borderColor:
                                        task.id === selectedTask?.id ? c.primary : c.border,
                                      borderRadius: 8,
                                      padding: 12,
                                      gap: 6,
                                      backgroundColor:
                                        task.id === selectedTask?.id ? c.accent : c.muted,
                                    }}
                                  >
                                    <Text
                                      numberOfLines={2}
                                      style={{
                                        color: c.foreground,
                                        fontFamily: "Inter_600SemiBold",
                                        fontSize: 14,
                                      }}
                                    >
                                      {task.title ?? task.prompt ?? "Orax task"}
                                    </Text>
                                    <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                                      #{task.id} - {task.kind} - {task.status}
                                    </Text>
                                  </View>
                                </Pressable>
                              ))}
                            </ScrollView>
                          ) : null}
                        </>
                      )}
                    </Card>

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Task shortcuts" icon={Bot} />
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        <Button
                          label="Resume task"
                          variant="secondary"
                          onPress={() =>
                            setThreadDraft(
                              "Where are we right now, and what is the next approved step?",
                            )
                          }
                        />
                        <Button
                          label="Explain approval"
                          variant="secondary"
                          onPress={() =>
                            setThreadDraft(
                              "Explain the current pending approval, its risk, and what will happen if I approve it.",
                            )
                          }
                        />
                        <Button
                          label="Summarize result"
                          variant="secondary"
                          onPress={() =>
                            setThreadDraft(
                              "Summarize result: what changed, what checks ran, and what remains?",
                            )
                          }
                        />
                      </View>
                    </Card>

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Context and actions" icon={Code2} />
                      <InfoGrid
                        items={[
                          [
                            "Repo",
                            selectedRepo ? `${selectedRepo.owner}/${selectedRepo.name}` : "none",
                          ],
                          [
                            "Pending",
                            String(
                              approvals.filter((approval) => approval.status === "pending").length,
                            ),
                          ],
                          ["Events", String(lifecycleItems.length)],
                        ]}
                      />
                      <TextField
                        label="Files to read"
                        placeholder={"src/app.tsx\npackage.json"}
                        autoCapitalize="none"
                        value={approvalPaths}
                        onChangeText={setApprovalPaths}
                        multiline
                        style={{ minHeight: 76, textAlignVertical: "top" }}
                      />
                      <TextField
                        label="Reason"
                        placeholder="Why Orax needs these files"
                        value={approvalReason}
                        onChangeText={setApprovalReason}
                      />
                      <Button
                        label="Create approval request"
                        icon={Lock}
                        variant="secondary"
                        onPress={submitReadApproval}
                        loading={busyAction === "request-read"}
                        disabled={!selectedTask || !approvalPaths.trim()}
                        full
                      />
                      <TextField
                        label="Draft patch instructions"
                        placeholder="Optional implementation notes"
                        value={draftInstructions}
                        onChangeText={setDraftInstructions}
                        multiline
                        style={{ minHeight: 66, textAlignVertical: "top" }}
                      />
                      <Button
                        label="Generate draft patch"
                        icon={Code2}
                        onPress={() =>
                          void runAction("draft-patch", async () => {
                            if (!selectedTask || !readApproval) return;
                            await generateDraftPatch({
                              taskId: selectedTask.id,
                              approvalId: readApproval.id,
                              instructions: draftInstructions.trim() || undefined,
                            });
                          })
                        }
                        loading={busyAction === "draft-patch"}
                        disabled={!selectedTask || !readApproval}
                        full
                      />
                      <Button
                        label="Request sandbox approval"
                        icon={ShieldCheck}
                        variant="secondary"
                        onPress={() =>
                          void runAction("sandbox-approval", async () => {
                            if (!selectedTask || !latestDraftPatch) return;
                            await requestSandboxApproval({
                              taskId: selectedTask.id,
                              artifactId: latestDraftPatch.id,
                            });
                          })
                        }
                        loading={busyAction === "sandbox-approval"}
                        disabled={!selectedTask || !latestDraftPatch}
                        full
                      />
                      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
                        {COMMAND_OPTIONS.map((command) => (
                          <Pill
                            key={command.id}
                            label={command.label}
                            active={selectedCommands.includes(command.id)}
                            onPress={() => toggleCommand(command.id)}
                          />
                        ))}
                      </View>
                      <Button
                        label="Request controlled checks"
                        icon={TerminalSquare}
                        variant="secondary"
                        onPress={() =>
                          void runAction("command-approval", async () => {
                            const targetArtifact = latestWorkspaceChangeSet ?? latestSandbox;
                            if (!selectedTask || !targetArtifact) return;
                            await requestCommandApproval({
                              taskId: selectedTask.id,
                              artifactId: targetArtifact.id,
                              commands: selectedCommands,
                            });
                          })
                        }
                        loading={busyAction === "command-approval"}
                        disabled={
                          !selectedTask ||
                          (!latestWorkspaceChangeSet && !latestSandbox) ||
                          selectedCommands.length === 0
                        }
                        full
                      />
                      <TextField
                        label="Type CREATE PR"
                        placeholder="CREATE PR"
                        autoCapitalize="characters"
                        value={prConfirm}
                        onChangeText={setPrConfirm}
                      />
                      <Button
                        label="Request PR approval"
                        icon={GitPullRequest}
                        variant="secondary"
                        onPress={() =>
                          void runAction("pr-approval", async () => {
                            if (!selectedTask || !latestCommand) return;
                            await requestGithubPrApproval({
                              taskId: selectedTask.id,
                              artifactId: latestCommand.id,
                              title: prTitle.trim() || undefined,
                            });
                            setPrConfirm("");
                          })
                        }
                        loading={busyAction === "pr-approval"}
                        disabled={
                          !selectedTask || !latestCommand || prConfirm.trim() !== "CREATE PR"
                        }
                        full
                      />
                    </Card>

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Approvals" icon={Lock} />
                      {approvals.length === 0 ? (
                        <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                          No approvals requested yet.
                        </Text>
                      ) : (
                        approvals.map((approval) => (
                          <ApprovalCard
                            key={approval.id}
                            approval={approval}
                            busyAction={busyAction}
                            onApprove={() =>
                              void runAction(`approve-${approval.id}`, async () => {
                                await decideApproval(approval.id, "approved");
                                if (approval.action === "github_pr") {
                                  await createApprovedGithubPr(approval.id);
                                } else {
                                  await continueTask(approval.taskId);
                                }
                              })
                            }
                            onDeny={() =>
                              void runAction(`deny-${approval.id}`, async () => {
                                await decideApproval(approval.id, "denied");
                              })
                            }
                            onRun={() =>
                              void runAction(`run-${approval.id}`, async () => {
                                if (approval.action === "read_files") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "sandbox_run") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "safe_check") {
                                  await continueTask(approval.taskId);
                                } else if (approval.action === "github_pr") {
                                  await createApprovedGithubPr(approval.id);
                                }
                              })
                            }
                          />
                        ))
                      )}
                    </Card>

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Execution lifecycle" icon={ShieldCheck} />
                      {lifecycleItems.length === 0 ? (
                        <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
                          No lifecycle activity yet.
                        </Text>
                      ) : (
                        lifecycleItems.map((item) => <LifecycleRow key={item.id} item={item} />)
                      )}
                    </Card>

                    <Card style={{ gap: 12 }}>
                      <SectionTitle title="Repository" icon={GitBranch} />
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
                        onPress={submitRepository}
                        loading={busyAction === "add-repo"}
                        disabled={!repoUrl.trim()}
                        full
                      />
                      {selectedRepo ? (
                        <>
                          <Text
                            style={{
                              color: c.foreground,
                              fontFamily: "Inter_600SemiBold",
                              fontSize: 14,
                            }}
                          >
                            {selectedRepo.owner}/{selectedRepo.name}
                          </Text>
                          <Button
                            label="Scan repository"
                            icon={RefreshCw}
                            variant="secondary"
                            onPress={submitScan}
                            loading={busyAction === "scan-repo"}
                            full
                          />
                          {latestScan ? (
                            <InfoGrid
                              items={[
                                ["Status", latestScan.status],
                                ["Files", String(latestScan.fileCount ?? 0)],
                                ["Branch", latestScan.branch],
                              ]}
                            />
                          ) : null}
                        </>
                      ) : null}
                    </Card>
                  </>
                ) : null}
              </>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      )}
      {workspaceMenuOpen ? (
        <OraxCommandCenter
          repos={repos}
          tasks={menuTasks}
          selectedRepo={selectedRepo}
          selectedTaskId={selectedTaskId}
          latestScan={latestScan}
          busyAction={busyAction}
          onClose={() => setWorkspaceMenuOpen(false)}
          onStartChat={() => {
            setWorkspaceMenuOpen(false);
            startNewThread();
          }}
          onScan={() => void submitScan()}
          onShowConnect={() => {
            setWorkspaceMenuOpen(false);
            setThreadOpen(false);
          }}
          onSelectRepo={selectRepositoryFromMenu}
          onSelectTask={selectTaskFromMenu}
        />
      ) : null}
    </View>
  );
}

function OraxCommandCenter({
  repos,
  tasks,
  selectedRepo,
  selectedTaskId,
  latestScan,
  busyAction,
  onClose,
  onStartChat,
  onScan,
  onShowConnect,
  onSelectRepo,
  onSelectTask,
}: {
  repos: OraxRepository[];
  tasks: OraxTask[];
  selectedRepo: OraxRepository | null;
  selectedTaskId: number | null;
  latestScan: OraxScan | null;
  busyAction: string | null;
  onClose: () => void;
  onStartChat: () => void;
  onScan: () => void;
  onShowConnect: () => void;
  onSelectRepo: (repo: OraxRepository) => void;
  onSelectTask: (task: OraxTask) => void;
}) {
  const c = useColors();
  const insets = useSafeAreaInsets();
  const workspaceScanned = latestScan?.status === "completed" || Boolean(selectedRepo?.lastScanAt);
  const primaryWorkspaceActionLabel = !selectedRepo
    ? "Connect GitHub"
    : !workspaceScanned
      ? "Scan files"
      : "New chat";
  const primaryWorkspaceActionIcon = !selectedRepo
    ? GitBranch
    : !workspaceScanned
      ? RefreshCw
      : MessageSquare;

  const runPrimaryWorkspaceAction = () => {
    if (!selectedRepo) {
      onShowConnect();
      return;
    }
    if (!workspaceScanned) {
      onScan();
      return;
    }
    onStartChat();
  };

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 50,
      }}
    >
      <Pressable
        onPress={onClose}
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          backgroundColor: "rgba(15, 23, 42, 0.24)",
        }}
      />
      <Card
        style={{
          position: "absolute",
          top: insets.top + 72,
          left: 14,
          right: 14,
          maxHeight: "78%",
          gap: 14,
          shadowColor: "#000",
          shadowOpacity: 0.16,
          shadowRadius: 22,
          shadowOffset: { width: 0, height: 12 },
          elevation: 8,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 17 }}>
              Workspace
            </Text>
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              Projects and recent tasks
            </Text>
          </View>
          <Pressable
            onPress={onClose}
            hitSlop={10}
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: c.muted,
            }}
          >
            <XCircle size={20} color={c.foreground} />
          </Pressable>
        </View>

        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: 14 }}>
          <View
            style={{
              gap: 10,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 18,
              backgroundColor: c.background,
              padding: 12,
            }}
          >
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
              <View style={{ flex: 1, gap: 3 }}>
                <Text
                  numberOfLines={1}
                  style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}
                >
                  {selectedRepo
                    ? `${selectedRepo.owner}/${selectedRepo.name}`
                    : "No repository connected"}
                </Text>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                  {selectedRepo
                    ? `${selectedRepo.defaultBranch || "main"} - ${
                        selectedRepo.connectionStatus === "read_only"
                          ? "GitHub connected"
                          : "metadata only"
                      }`
                    : "Connect a repository to start Orax work."}
                </Text>
              </View>
              <Pill label={latestScan ? `${latestScan.fileCount} files` : "not scanned"} />
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                label={primaryWorkspaceActionLabel}
                icon={primaryWorkspaceActionIcon}
                onPress={runPrimaryWorkspaceAction}
                loading={busyAction === "scan-repo" && Boolean(selectedRepo) && !workspaceScanned}
                style={{ flex: 1 }}
              />
            </View>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <Button
                label="Scan"
                icon={RefreshCw}
                variant="secondary"
                onPress={onScan}
                loading={busyAction === "scan-repo"}
                disabled={!selectedRepo}
                style={{ flex: 1 }}
              />
              <Button
                label="Connect"
                icon={GitBranch}
                variant="secondary"
                onPress={onShowConnect}
                style={{ flex: 1 }}
              />
            </View>
          </View>

          <View style={{ gap: 8 }}>
            <Text
              style={{
                color: c.mutedForeground,
                fontFamily: "Inter_700Bold",
                fontSize: 11,
                letterSpacing: 0,
                textTransform: "uppercase",
              }}
            >
              Switch workspace
            </Text>
            {repos.length ? (
              repos.slice(0, 6).map((repo) => {
                const active = repo.id === selectedRepo?.id;
                return (
                  <Pressable key={repo.id} onPress={() => onSelectRepo(repo)}>
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: active ? c.foreground : c.border,
                        backgroundColor: active ? c.muted : c.card,
                        borderRadius: 18,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text
                          numberOfLines={1}
                          style={{
                            color: c.foreground,
                            fontFamily: "Inter_600SemiBold",
                            fontSize: 14,
                          }}
                        >
                          {repo.owner}/{repo.name}
                        </Text>
                        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                          {repo.connectionStatus === "read_only" ? "GitHub connected" : "metadata"}
                        </Text>
                      </View>
                      {active ? <CheckCircle2 size={18} color={c.foreground} /> : null}
                    </View>
                  </Pressable>
                );
              })
            ) : (
              <View
                style={{
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: c.border,
                  borderRadius: 18,
                  padding: 16,
                }}
              >
                <Text style={{ color: c.mutedForeground, fontSize: 14 }}>No repositories yet.</Text>
              </View>
            )}
          </View>

          <View style={{ gap: 8 }}>
            <Text
              style={{
                color: c.mutedForeground,
                fontFamily: "Inter_700Bold",
                fontSize: 11,
                letterSpacing: 0,
                textTransform: "uppercase",
              }}
            >
              Recent tasks
            </Text>
            {tasks.length ? (
              tasks.map((task) => {
                const active = task.id === selectedTaskId;
                return (
                  <Pressable key={task.id} onPress={() => onSelectTask(task)}>
                    <View
                      style={{
                        borderWidth: 1,
                        borderColor: active ? c.foreground : c.border,
                        backgroundColor: active ? c.muted : c.card,
                        borderRadius: 18,
                        paddingHorizontal: 12,
                        paddingVertical: 10,
                        flexDirection: "row",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <Text
                        numberOfLines={1}
                        style={{
                          flex: 1,
                          color: c.foreground,
                          fontFamily: "Inter_600SemiBold",
                          fontSize: 14,
                        }}
                      >
                        {task.title ?? task.prompt ?? "Orax task"}
                      </Text>
                      <Pill label={task.status} active={active} />
                    </View>
                  </Pressable>
                );
              })
            ) : (
              <View
                style={{
                  borderWidth: 1,
                  borderStyle: "dashed",
                  borderColor: c.border,
                  borderRadius: 18,
                  padding: 16,
                }}
              >
                <Text style={{ color: c.mutedForeground, fontSize: 14 }}>
                  No Orax tasks in this workspace yet.
                </Text>
              </View>
            )}
          </View>
        </ScrollView>
      </Card>
    </View>
  );
}

function isDesktopHostOnline(host: OraxHostSummary): boolean {
  if (host.status === "online") return true;
  if (!host.lastSeenAt) return false;
  return Date.now() - new Date(host.lastSeenAt).getTime() < 90_000;
}

const DIAG_COMMANDS = [
  "node --version",
  "npm --version",
  "pnpm --version",
  "git --version",
  "pwd",
];

type DiagApprovalState =
  | "idle"
  | "requesting"
  | "pending"
  | "approved"
  | "denied"
  | "executing"
  | "done"
  | "error";

interface DiagCmdResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

function DiagnosticsSection({
  host,
  colors: c,
}: {
  host: OraxHostSummary;
  colors: ReturnType<typeof useColors>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [selectedCmd, setSelectedCmd] = useState(DIAG_COMMANDS[0]!);
  const [state, setState] = useState<DiagApprovalState>("idle");
  const [approval, setApproval] = useState<{ id: string; command: string } | null>(null);
  const [result, setResult] = useState<DiagCmdResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  function reset() {
    setState("idle");
    setApproval(null);
    setResult(null);
    setErrorMsg(null);
  }

  async function handleRequest() {
    setState("requesting");
    setApproval(null);
    setResult(null);
    setErrorMsg(null);
    try {
      const { approval: a } = await requestDesktopCommandApproval(host.id, {
        command: selectedCmd,
        reason: "Diagnostic check from Orax mobile",
      });
      setApproval(a);
      setState("pending");
    } catch {
      setErrorMsg("Could not create approval request");
      setState("error");
    }
  }

  async function handleDecide(decision: "approved" | "denied") {
    if (!approval) return;
    try {
      const data = await resolveDesktopCommandApproval(approval.id, decision);
      if (decision === "denied") {
        setState("denied");
        return;
      }
      const aid = data.action?.id ?? null;
      if (!aid) {
        setErrorMsg("No action was queued");
        setState("error");
        return;
      }
      setState("executing");
      for (let i = 0; i < 15; i++) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        const { actions } = await getDesktopActions(host.id);
        const found = actions.find((a) => a.id === aid);
        if (!found) break;
        if (found.status === "completed") {
          setResult(found.result as DiagCmdResult);
          setState("done");
          return;
        }
        if (found.status === "failed") {
          setErrorMsg("Desktop reported an error");
          setState("error");
          return;
        }
      }
      setErrorMsg("Timed out — is Orax Desktop running?");
      setState("error");
    } catch {
      setErrorMsg("Network error");
      setState("error");
    }
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          paddingHorizontal: 12,
          paddingVertical: 10,
          backgroundColor: pressed ? c.muted : "transparent",
        })}
      >
        <Text style={{ color: c.foreground, fontSize: 13, fontFamily: "Inter_600SemiBold" }}>
          Diagnostics
        </Text>
        <ChevronDown
          size={14}
          color={c.mutedForeground}
          style={expanded ? { transform: [{ rotate: "180deg" }] } : undefined}
        />
      </Pressable>

      {expanded && (
        <View
          style={{
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: c.border,
            gap: 10,
          }}
        >
          {state === "idle" && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Safe command</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: "row", gap: 6 }}>
                  {DIAG_COMMANDS.map((cmd) => (
                    <Pressable
                      key={cmd}
                      onPress={() => setSelectedCmd(cmd)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 10,
                        paddingVertical: 6,
                        borderRadius: 6,
                        borderWidth: 1,
                        borderColor: selectedCmd === cmd ? c.foreground : c.border,
                        backgroundColor: pressed
                          ? c.muted
                          : selectedCmd === cmd
                          ? c.foreground + "15"
                          : "transparent",
                      })}
                    >
                      <Text
                        style={{
                          color: selectedCmd === cmd ? c.foreground : c.mutedForeground,
                          fontSize: 12,
                          fontFamily: "Inter_600SemiBold",
                        }}
                      >
                        {cmd}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </ScrollView>
              <Pressable
                onPress={() => void handleRequest()}
                style={({ pressed }) => ({
                  alignSelf: "flex-start",
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor: c.border,
                  backgroundColor: pressed ? c.muted : "transparent",
                })}
              >
                <Text style={{ color: c.foreground, fontSize: 13 }}>Request approval</Text>
              </Pressable>
            </View>
          )}

          {state === "requesting" && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={c.mutedForeground} />
              <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Creating request…</Text>
            </View>
          )}

          {state === "pending" && approval && (
            <View style={{ gap: 8 }}>
              <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                Run on your desktop:{" "}
                <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>
                  {approval.command}
                </Text>
              </Text>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <Pressable
                  onPress={() => void handleDecide("approved")}
                  style={({ pressed }) => ({
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 8,
                    backgroundColor: pressed ? "#059669" : "#10b981",
                  })}
                >
                  <Text style={{ color: "#fff", fontSize: 13, fontFamily: "Inter_600SemiBold" }}>
                    Approve
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => void handleDecide("denied")}
                  style={({ pressed }) => ({
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: c.border,
                    backgroundColor: pressed ? c.muted : "transparent",
                  })}
                >
                  <Text style={{ color: c.destructive, fontSize: 13 }}>Deny</Text>
                </Pressable>
              </View>
            </View>
          )}

          {state === "executing" && (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ActivityIndicator size="small" color={c.mutedForeground} />
              <Text style={{ color: c.mutedForeground, fontSize: 13 }}>Running on desktop…</Text>
            </View>
          )}

          {state === "done" && result && (
            <View style={{ gap: 6 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                  Exit code:{" "}
                  <Text
                    style={{
                      color: result.exitCode === 0 ? "#10b981" : c.destructive,
                      fontFamily: "Inter_600SemiBold",
                    }}
                  >
                    {result.exitCode ?? "null"}
                  </Text>
                  {result.durationMs ? `  ·  ${result.durationMs}ms` : ""}
                </Text>
                <Pressable onPress={reset}>
                  <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Reset</Text>
                </Pressable>
              </View>
              {!!result.stdout && (
                <ScrollView
                  style={{
                    maxHeight: 100,
                    backgroundColor: c.muted,
                    borderRadius: 6,
                    padding: 8,
                  }}
                >
                  <Text style={{ color: c.foreground, fontFamily: "Inter_400Regular", fontSize: 12 }}>
                    {result.stdout}
                  </Text>
                </ScrollView>
              )}
              {!!result.stderr && (
                <ScrollView
                  style={{
                    maxHeight: 80,
                    backgroundColor: c.destructive + "18",
                    borderRadius: 6,
                    padding: 8,
                  }}
                >
                  <Text style={{ color: c.destructive, fontFamily: "Inter_400Regular", fontSize: 12 }}>
                    {result.stderr}
                  </Text>
                </ScrollView>
              )}
            </View>
          )}

          {state === "denied" && (
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ color: c.destructive, fontSize: 13 }}>Command denied.</Text>
              <Pressable onPress={reset}>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Try again</Text>
              </Pressable>
            </View>
          )}

          {state === "error" && (
            <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
              <Text style={{ color: c.destructive, fontSize: 13, flex: 1 }}>
                {errorMsg ?? "An error occurred"}
              </Text>
              <Pressable onPress={reset}>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Reset</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function DesktopConnectionCard({
  hosts,
  hostsLoading,
  onRefresh,
}: {
  hosts: OraxHostSummary[];
  hostsLoading: boolean;
  onRefresh: () => void;
}) {
  const c = useColors();
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [testState, setTestState] = useState<"idle" | "pending" | "completed" | "failed">("idle");
  const [testResult, setTestResult] = useState<string | null>(null);

  const activeHosts = hosts.filter((h) => h.status !== "revoked");
  const onlineHost = activeHosts.find(isDesktopHostOnline) ?? null;
  const primaryHost = onlineHost ?? activeHosts[0] ?? null;
  const isOnline = !!onlineHost;

  async function handleRedeem() {
    const code = pairingCodeInput.trim().toUpperCase();
    if (code.length < 6) return;
    setRedeeming(true);
    try {
      const payload: RedeemPairingPayload = {
        code,
        mobileDeviceId: `${Platform.OS}-mobile`,
        displayName: `${Platform.OS.charAt(0).toUpperCase() + Platform.OS.slice(1)} Device`,
        platform: Platform.OS,
      };
      await redeemOraxPairingCode(payload);
      setPairingCodeInput("");
      onRefresh();
    } catch {
      Alert.alert("Pairing failed", "Could not pair with this code. Check the code and try again.");
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 18,
        backgroundColor: c.card,
        padding: 16,
        gap: 12,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Monitor size={20} color={c.foreground} />
        <Text
          style={{
            color: c.foreground,
            fontFamily: "Inter_600SemiBold",
            fontSize: 15,
            flex: 1,
          }}
        >
          {primaryHost ? primaryHost.deviceName : "Orax Desktop"}
        </Text>
        {hostsLoading ? (
          <ActivityIndicator size="small" color={c.mutedForeground} />
        ) : (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: isOnline ? "#10b981" : "#94a3b8",
              }}
            />
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              {activeHosts.length === 0 ? "Not connected" : isOnline ? "Online" : "Offline"}
            </Text>
          </View>
        )}
      </View>

      {!hostsLoading && activeHosts.length === 0 && (
        <View style={{ gap: 6 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
            Connect Orax Desktop
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
            Install Orax Desktop on your computer. Once running, pair this device to control Orax
            remotely and see your projects here.
          </Text>
        </View>
      )}

      {!hostsLoading && activeHosts.length > 0 && !isOnline && (
        <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
          This computer is not currently online. Open Orax Desktop on your computer to reconnect.
        </Text>
      )}

      {!hostsLoading && isOnline && (
        <View style={{ gap: 10 }}>
          <Text style={{ color: c.mutedForeground, fontSize: 14, lineHeight: 20 }}>
            Your desktop is connected and ready.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <Pressable
              onPress={() => {
                if (testState === "pending" || !onlineHost) return;
                setTestState("pending");
                setTestResult(null);
                void (async () => {
                  try {
                    const { action } = await createDesktopAction(onlineHost.id, "ping_desktop");
                    const actionId = action.id;
                    for (let i = 0; i < 7; i++) {
                      await new Promise<void>((r) => setTimeout(r, 2000));
                      const { actions } = await getDesktopActions(onlineHost.id);
                      const found = actions.find((a) => a.id === actionId);
                      if (!found) break;
                      if (found.status === "completed") {
                        setTestState("completed");
                        setTestResult("Desktop responded");
                        return;
                      }
                      if (found.status === "failed") {
                        setTestState("failed");
                        setTestResult("Desktop reported an error");
                        return;
                      }
                    }
                    setTestState("failed");
                    setTestResult("No response — is Orax Desktop running?");
                  } catch {
                    setTestState("failed");
                    setTestResult("Could not send test ping");
                  }
                })();
              }}
              style={({ pressed }) => ({
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: c.border,
                backgroundColor: pressed ? c.muted : "transparent",
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                opacity: testState === "pending" ? 0.7 : 1,
              })}
            >
              {testState === "pending" ? (
                <RefreshCw
                  size={14}
                  color={c.mutedForeground}
                  style={{ transform: [{ rotate: "45deg" }] }}
                />
              ) : null}
              <Text style={{ color: c.foreground, fontSize: 14 }}>Test connection</Text>
            </Pressable>
            {testState !== "idle" && testState !== "pending" && testResult ? (
              <Text
                style={{
                  fontSize: 13,
                  color: testState === "completed" ? "#10b981" : c.destructive,
                }}
              >
                {testResult}
              </Text>
            ) : null}
          </View>

          <DiagnosticsSection host={onlineHost} colors={c} />
        </View>
      )}

      <Button
        label="Scan QR Code"
        icon={Scan}
        onPress={() => {}}
        disabled
        full
      />

      <View
        style={{
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 12,
          paddingHorizontal: 14,
          paddingVertical: 10,
          backgroundColor: c.background,
          gap: 8,
        }}
      >
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>Manual pairing code</Text>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <TextInput
            style={{
              flex: 1,
              color: c.foreground,
              fontSize: 18,
              fontFamily: "Inter_600SemiBold",
              letterSpacing: 4,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 8,
              paddingHorizontal: 12,
              paddingVertical: 8,
              backgroundColor: c.card,
            }}
            value={pairingCodeInput}
            onChangeText={(t) => setPairingCodeInput(t.toUpperCase().slice(0, 6))}
            placeholder="ABC123"
            placeholderTextColor={c.mutedForeground}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={6}
            keyboardType="default"
          />
          <Pressable
            onPress={() => void handleRedeem()}
            disabled={pairingCodeInput.trim().length < 6 || redeeming}
            style={({ pressed }) => ({
              backgroundColor:
                pairingCodeInput.trim().length >= 6 && !redeeming
                  ? "#10b981"
                  : c.muted,
              borderRadius: 8,
              paddingHorizontal: 14,
              paddingVertical: 10,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            {redeeming ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <Text
                style={{
                  color:
                    pairingCodeInput.trim().length >= 6 ? "#fff" : c.mutedForeground,
                  fontFamily: "Inter_600SemiBold",
                  fontSize: 14,
                }}
              >
                Pair
              </Text>
            )}
          </Pressable>
        </View>
      </View>

      <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18 }}>
        Keep Orax Desktop open and on the same network as your phone to stay connected.
      </Text>
    </View>
  );
}

function WorkspaceChips({
  repos,
  selectedRepo,
  taskSearch,
  onShowAll,
  onSelectRepo,
  onOpenMenu,
}: {
  repos: OraxRepository[];
  selectedRepo: OraxRepository | null;
  taskSearch: string;
  onShowAll: () => void;
  onSelectRepo: (repo: OraxRepository) => void;
  onOpenMenu: () => void;
}) {
  const c = useColors();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingRight: 4 }}
    >
      <Pill label="All" active={!taskSearch.trim()} onPress={onShowAll} />
      {repos.slice(0, 6).map((repo) => {
        const active = repo.id === selectedRepo?.id;
        return (
          <Pressable key={repo.id} onPress={() => onSelectRepo(repo)}>
            <View
              style={{
                minHeight: 38,
                maxWidth: 240,
                borderRadius: 19,
                paddingHorizontal: 14,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                backgroundColor: active ? c.muted : c.background,
                borderWidth: active ? 0 : 1,
                borderColor: c.border,
              }}
            >
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 4,
                  backgroundColor: repo.connectionStatus === "read_only" ? "#10b981" : "#f59e0b",
                }}
              />
              <Code2 size={16} color={c.foreground} />
              <Text
                numberOfLines={1}
                style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}
              >
                {repo.name}
              </Text>
            </View>
          </Pressable>
        );
      })}
      <Pressable onPress={onOpenMenu}>
        <View
          style={{
            width: 38,
            height: 38,
            borderRadius: 19,
            borderWidth: 1,
            borderColor: c.border,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.background,
          }}
        >
          <MoreHorizontal size={18} color={c.mutedForeground} />
        </View>
      </Pressable>
    </ScrollView>
  );
}

function ActiveThreadStateStrip({
  state,
  continuing,
  onContinue,
}: {
  state: NonNullable<OraxActiveThreadState>;
  continuing: boolean;
  onContinue: () => void;
}) {
  const c = useColors();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: c.card,
        paddingHorizontal: 12,
        paddingVertical: 8,
      }}
    >
      <View
        style={{
          backgroundColor: c.muted,
          borderRadius: 99,
          paddingHorizontal: 8,
          paddingVertical: 2,
        }}
      >
        <Text
          style={{
            color: c.mutedForeground,
            fontSize: 10,
            fontFamily: "Inter_600SemiBold",
            textTransform: "uppercase",
            letterSpacing: 0.8,
          }}
        >
          {state.label}
        </Text>
      </View>
      <Text
        style={{ color: c.foreground, fontSize: 13, flex: 1 }}
        numberOfLines={1}
      >
        {state.objective}
      </Text>
      <Pressable
        onPress={onContinue}
        disabled={continuing}
        style={{
          backgroundColor: c.muted,
          borderRadius: 6,
          paddingHorizontal: 10,
          paddingVertical: 4,
          opacity: continuing ? 0.5 : 1,
        }}
      >
        <Text
          style={{
            color: c.foreground,
            fontSize: 12,
            fontFamily: "Inter_500Medium",
          }}
        >
          {continuing ? "Working…" : "Continue"}
        </Text>
      </Pressable>
    </View>
  );
}

function OraxComposer({
  value,
  onChangeText,
  onSend,
  attachments,
  onAddAttachment,
  onRemoveAttachment,
  model,
  reasoning,
  permissionMode,
  onChangeModel,
  onChangeReasoning,
  onCyclePermission,
  onToggleVoice,
  voiceActive,
  voiceLoading,
  slashCommands,
  onSelectSlashCommand,
  disabled,
  loading,
}: {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  attachments: OraxComposerAttachment[];
  onAddAttachment: () => void;
  onRemoveAttachment: (id?: string) => void;
  model: (typeof ORAX_COMPOSER_MODELS)[number];
  reasoning: OraxComposerReasoning;
  permissionMode: OraxComposerPermissionMode;
  onChangeModel: (value: (typeof ORAX_COMPOSER_MODELS)[number]) => void;
  onChangeReasoning: (value: OraxComposerReasoning) => void;
  onCyclePermission: () => void;
  onToggleVoice: () => void;
  voiceActive: boolean;
  voiceLoading: boolean;
  slashCommands: OraxSlashCommandOption[];
  onSelectSlashCommand: (command: string) => void;
  disabled: boolean;
  loading: boolean;
}) {
  const c = useColors();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const canSend = !disabled && !loading;
  const reasoningLabel =
    ORAX_REASONING_OPTIONS.find((option) => option.value === reasoning)?.label ?? "Extra High";

  return (
    <View
      style={{
        backgroundColor: c.card,
        borderColor: c.border,
        borderRadius: 30,
        borderWidth: 1,
        gap: 12,
        padding: 12,
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.12,
        shadowRadius: 22,
        elevation: 5,
      }}
    >
      {attachments.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {attachments.map((attachment) => (
            <View
              key={attachment.id ?? attachment.name}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                maxWidth: "100%",
                borderRadius: 12,
                backgroundColor: c.muted,
                paddingHorizontal: 10,
                paddingVertical: 7,
              }}
            >
              <FileText size={16} color={c.mutedForeground} />
              <Text numberOfLines={1} style={{ color: c.foreground, flexShrink: 1, fontSize: 13 }}>
                {attachment.name}
              </Text>
              <Text style={{ color: c.mutedForeground, fontSize: 11 }}>
                {attachment.ingestionStatus === "ready" ? "read" : "not read"}
              </Text>
              <Pressable
                accessibilityLabel={`Remove ${attachment.name}`}
                accessibilityRole="button"
                onPress={() => onRemoveAttachment(attachment.id)}
              >
                <XCircle size={16} color={c.mutedForeground} />
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      {slashCommands.length ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 18,
            backgroundColor: c.background,
            padding: 6,
            gap: 2,
          }}
        >
          {slashCommands.map((command) => (
            <Pressable
              key={command.command}
              onPress={() => onSelectSlashCommand(command.command)}
              style={{
                borderRadius: 14,
                paddingHorizontal: 10,
                paddingVertical: 8,
                flexDirection: "row",
                gap: 10,
              }}
            >
              <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", minWidth: 68 }}>
                {command.command}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold" }}>
                  {command.label}
                </Text>
                <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
                  {command.description}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder="Ask Orax"
        placeholderTextColor={c.mutedForeground}
        multiline
        style={{
          color: c.foreground,
          fontFamily: "Inter_400Regular",
          fontSize: 20,
          lineHeight: 27,
          minHeight: 78,
          paddingHorizontal: 8,
          paddingTop: 8,
          textAlignVertical: "top",
        }}
      />
      {settingsOpen ? (
        <View
          style={{
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 18,
            padding: 10,
            gap: 10,
            backgroundColor: c.background,
          }}
        >
          <Text style={{ color: c.mutedForeground, fontSize: 11, textTransform: "uppercase" }}>
            Model
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {ORAX_COMPOSER_MODELS.map((option) => (
              <Pressable
                key={option}
                onPress={() => onChangeModel(option)}
                style={{
                  borderWidth: 1,
                  borderColor: model === option ? c.foreground : c.border,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  backgroundColor: model === option ? c.foreground : c.card,
                }}
              >
                <Text style={{ color: model === option ? c.background : c.foreground }}>
                  {option}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={{ color: c.mutedForeground, fontSize: 11, textTransform: "uppercase" }}>
            Reasoning
          </Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {ORAX_REASONING_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                onPress={() => onChangeReasoning(option.value)}
                style={{
                  borderWidth: 1,
                  borderColor: reasoning === option.value ? c.foreground : c.border,
                  borderRadius: 999,
                  paddingHorizontal: 12,
                  paddingVertical: 7,
                  backgroundColor: reasoning === option.value ? c.foreground : c.card,
                }}
              >
                <Text style={{ color: reasoning === option.value ? c.background : c.foreground }}>
                  {option.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable
          accessibilityLabel="Attach files to Orax message"
          accessibilityRole="button"
          onPress={onAddAttachment}
          style={{
            height: 40,
            width: 40,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Plus size={30} color={c.foreground} />
        </Pressable>
        <Pressable
          accessibilityLabel={`Orax permission mode: ${permissionMode}`}
          accessibilityRole="button"
          onPress={onCyclePermission}
          style={{
            height: 40,
            width: 40,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <ShieldAlert size={28} color="#c2410c" />
        </Pressable>
        <View style={{ flex: 1, alignItems: "center", minWidth: 0 }}>
          <Pressable
            accessibilityLabel="Choose Orax model and reasoning"
            accessibilityRole="button"
            onPress={() => setSettingsOpen((value) => !value)}
          >
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.82}
              style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 18 }}
            >
              {model.replace("Orax ", "")}{" "}
              <Text style={{ color: c.mutedForeground }}>{reasoningLabel}</Text>
            </Text>
          </Pressable>
        </View>
        <Pressable
          accessibilityLabel={voiceActive ? "Stop Orax voice input" : "Start Orax voice input"}
          accessibilityRole="button"
          onPress={onToggleVoice}
          style={{
            height: 40,
            width: 40,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 20,
            backgroundColor: voiceActive ? c.muted : "transparent",
            opacity: voiceLoading ? 0.5 : 1,
          }}
        >
          {voiceLoading ? (
            <ActivityIndicator color={c.foreground} />
          ) : (
            <Mic size={30} color={voiceActive ? c.primary : c.foreground} />
          )}
        </Pressable>
        <Pressable
          accessibilityLabel="Send Orax message"
          accessibilityRole="button"
          disabled={!canSend}
          onPress={onSend}
          style={{
            height: 50,
            width: 50,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 25,
            backgroundColor: c.foreground,
            opacity: canSend ? 1 : 0.45,
          }}
        >
          {loading ? (
            <ActivityIndicator color={c.background} />
          ) : (
            <ArrowUp size={30} color={c.background} strokeWidth={3} />
          )}
        </Pressable>
      </View>
    </View>
  );
}

function SectionTitle({
  title,
  icon: Icon,
}: {
  title: string;
  icon: React.ComponentType<{ size?: number; color?: string }>;
}) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon size={18} color={c.accentForeground} />
      <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 16 }}>
        {title}
      </Text>
    </View>
  );
}

function TaskFocusCard({
  task,
  repo,
  checkpointNextStep,
  pendingApprovals,
  artifactCount,
  onRefresh,
  refreshing,
}: {
  task: OraxTask | null;
  repo: OraxRepository | null;
  checkpointNextStep?: string;
  pendingApprovals: number;
  artifactCount: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const c = useColors();
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ color: c.mutedForeground, fontSize: 12, textTransform: "uppercase" }}>
            Active Orax workspace
          </Text>
          <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 18 }}>
            {task?.title ?? "No task selected"}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
            {repo ? `${repo.owner}/${repo.name}` : "Connect a repository to begin"}
          </Text>
        </View>
        <Pressable
          onPress={onRefresh}
          style={{
            width: 40,
            height: 40,
            borderRadius: 12,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: c.secondary,
          }}
        >
          <RefreshCw size={18} color={refreshing ? c.primary : c.foreground} />
        </Pressable>
      </View>
      <InfoGrid
        items={[
          ["Status", task?.status ?? "idle"],
          ["Approvals", String(pendingApprovals)],
          ["Artifacts", String(artifactCount)],
        ]}
      />
      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
        {checkpointNextStep ??
          "Orax is isolated from Ora. It works through repository-scoped tasks, approvals, artifacts, and pull requests."}
      </Text>
    </Card>
  );
}

function TaskHistoryRow({
  task,
  repo,
  active,
  onPress,
}: {
  task: OraxTask;
  repo: OraxRepository | null;
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress}>
      <View
        style={{
          borderWidth: 1,
          borderColor: active ? c.primary : c.border,
          borderRadius: c.radius,
          padding: 12,
          gap: 8,
          backgroundColor: active ? c.accent : c.muted,
        }}
      >
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
              {task.title ?? task.prompt ?? "Orax task"}
            </Text>
            <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
              {task.kind} - {task.status}
              {repo ? ` - ${repo.owner}/${repo.name}` : ""}
            </Text>
          </View>
          {active ? <CheckCircle2 size={18} color={c.accentForeground} /> : null}
        </View>
        {task.result?.message ? (
          <Text numberOfLines={2} style={{ color: c.mutedForeground, fontSize: 12 }}>
            {task.result.message}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function RepositoryCard({
  repo,
  active,
  onPress,
}: {
  repo: OraxRepository;
  active: boolean;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable onPress={onPress}>
      <Card style={{ gap: 8, borderColor: active ? c.primary : c.cardBorder }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
              {repo.owner}/{repo.name}
            </Text>
            <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
              {repo.connectionStatus.replace(/_/g, " ")}
            </Text>
          </View>
          {active ? <CheckCircle2 size={18} color={c.accentForeground} /> : null}
        </View>
        <InfoGrid
          items={[
            ["Provider", repo.provider ?? "github"],
            ["Branch", repo.defaultBranch ?? "main"],
            ["Scan", repo.scanStatus ?? "idle"],
          ]}
        />
      </Card>
    </Pressable>
  );
}

function RepositoryWorkspaceCard({
  repo,
  latestScan,
  githubToken,
  onChangeGithubToken,
  onConnect,
  onScan,
  onStartChat,
  busyAction,
}: {
  repo: OraxRepository;
  latestScan: OraxScan | null;
  githubToken: string;
  onChangeGithubToken: (value: string) => void;
  onConnect: () => void;
  onScan: () => void;
  onStartChat: () => void;
  busyAction: string | null;
}) {
  const c = useColors();
  const connected = repo.connectionStatus === "read_only";
  const scanned = latestScan?.status === "completed" || Boolean(repo.lastScanAt);
  const nextAction = !connected
    ? "Connect token or scan public repo"
    : !scanned
      ? "Scan repository"
      : "Start chat";

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_700Bold", fontSize: 16 }}>
            Workspace ready
          </Text>
          <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 15 }}>
            {repo.owner}/{repo.name}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 17 }}>
            {connected
              ? repo.githubAccountName
                ? `Connected as ${repo.githubAccountName}`
                : "GitHub access connected"
              : "Public scan available; add a token for private repository access."}
          </Text>
        </View>
        <Pill label={connected ? "Connected" : "Metadata"} active={connected} />
      </View>
      <InfoGrid
        items={[
          ["Branch", repo.defaultBranch ?? "main"],
          ["Scan", latestScan?.status ?? repo.scanStatus ?? "idle"],
          ["Files", latestScan?.fileCount ? String(latestScan.fileCount) : "not scanned"],
          ["Next", nextAction],
        ]}
      />
      {!connected ? (
        <>
          <TextField
            label="GitHub token"
            placeholder="Optional GitHub token for private repos"
            autoCapitalize="none"
            value={githubToken}
            onChangeText={onChangeGithubToken}
          />
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Button
              label="Connect"
              icon={ShieldCheck}
              onPress={onConnect}
              loading={busyAction === "connect-github"}
              disabled={!githubToken.trim()}
              style={{ flex: 1 }}
            />
            <Button
              label="Scan"
              icon={RefreshCw}
              variant="secondary"
              onPress={onScan}
              loading={busyAction === "scan-repo"}
              style={{ flex: 1 }}
            />
          </View>
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            label="Scan"
            icon={RefreshCw}
            variant="secondary"
            onPress={onScan}
            loading={busyAction === "scan-repo"}
            style={{ flex: 1 }}
          />
          <Button
            label="Start chat"
            icon={MessageSquare}
            onPress={onStartChat}
            style={{ flex: 1 }}
          />
        </View>
      )}
    </Card>
  );
}

function LifecycleRow({ item }: { item: LifecycleItem }) {
  const c = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: c.radius,
        padding: 12,
        gap: 6,
        backgroundColor: c.muted,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.mutedForeground, fontSize: 11, textTransform: "uppercase" }}>
            {item.label}
          </Text>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
            {item.title}
          </Text>
        </View>
        <StatusIcon status={item.status} />
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>
        {item.description}
      </Text>
    </View>
  );
}

function SuggestionCard({
  suggestion,
  onPress,
}: {
  suggestion: OraxTaskActionSuggestion;
  onPress: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={{
        alignSelf: "flex-start",
        minHeight: 38,
        borderRadius: 19,
        paddingHorizontal: 16,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: c.foreground,
      }}
    >
      <Text style={{ color: c.background, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
        {suggestion.buttonLabel ?? suggestion.title}
      </Text>
    </Pressable>
  );
}

function getMessageComposerAttachments(message: OraxTaskMessage): OraxComposerAttachment[] {
  const composer = message.metadata?.composer as
    | { attachments?: OraxComposerAttachment[] }
    | undefined;
  return Array.isArray(composer?.attachments) ? composer.attachments : [];
}

// Phase 2K: compact card for project_patch_drafted thread messages
function ProjectPatchDraftedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const draft = msg.payload?.draftPatch;
  if (!draft) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{msg.content}</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 12,
        padding: 12,
        gap: 8,
        backgroundColor: c.card,
      }}
    >
      <Text
        style={{
          color: c.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontFamily: "Inter_500Medium",
        }}
      >
        {draft.summary}
      </Text>
      {/* Changed file chips */}
      {draft.changedFiles.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {draft.changedFiles.map((f) => (
            <View
              key={f.relativePath}
              style={{
                flexDirection: "row",
                alignItems: "center",
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 6,
                paddingHorizontal: 6,
                paddingVertical: 2,
                gap: 4,
                backgroundColor: c.muted,
              }}
            >
              <Text
                style={{ color: c.mutedForeground, fontSize: 10, fontFamily: "SpaceMono_400Regular" }}
                numberOfLines={1}
              >
                {f.relativePath}
              </Text>
              <Text
                style={{
                  fontSize: 9,
                  fontFamily: "Inter_600SemiBold",
                  color: f.operation === "create" ? "#22c55e" : "#3b82f6",
                  textTransform: "uppercase",
                }}
              >
                {f.operation}
              </Text>
            </View>
          ))}
        </View>
      )}
      {/* Diff preview for first file */}
      {(draft.changedFiles[0]?.hunkPreview ?? []).length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 6,
            backgroundColor: c.muted,
            maxHeight: 100,
          }}
        >
          <Text
            style={{
              color: c.mutedForeground,
              fontSize: 10,
              fontFamily: "SpaceMono_400Regular",
              padding: 8,
              lineHeight: 16,
            }}
          >
            {draft.changedFiles[0]!.hunkPreview.join("\n")}
          </Text>
        </ScrollView>
      )}
      {/* Risks */}
      {draft.risks.length > 0 &&
        draft.risks.slice(0, 2).map((r, i) => (
          <Text
            key={i}
            style={{ color: "#f59e0b", fontSize: 11, lineHeight: 16 }}
          >
            {"\u26A0\uFE0F"} {r}
          </Text>
        ))}
      {/* Verification plan */}
      {draft.verificationPlan.length > 0 &&
        draft.verificationPlan.slice(0, 2).map((v, i) => (
          <Text
            key={i}
            style={{ color: c.mutedForeground, fontSize: 11, lineHeight: 16 }}
          >
            {"\u2714\uFE0F"} {v}
          </Text>
        ))}
      <Text style={{ color: c.mutedForeground, fontSize: 10 }}>
        Review and approve via Orax Desktop
      </Text>
    </View>
  );
}

// Phase 2L: compact card for project_patch_applied thread messages
function ProjectPatchAppliedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const ap = msg.payload?.appliedPatch;
  const changed = ap?.changedFiles ?? [];
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#22c55e55",
        borderRadius: 12,
        padding: 12,
        gap: 6,
        backgroundColor: "#22c55e08",
      }}
    >
      <Text style={{ color: "#22c55e", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Patch applied — {changed.length} file{changed.length === 1 ? "" : "s"} written
      </Text>
      {changed.slice(0, 5).map((f) => (
        <Text
          key={f.relativePath}
          style={{ color: c.mutedForeground, fontSize: 11, fontFamily: "SpaceMono_400Regular" }}
          numberOfLines={1}
        >
          {f.operation === "create" ? "+" : "~"} {f.relativePath}
        </Text>
      ))}
      {ap?.checkpointPath && (
        <Text style={{ color: c.mutedForeground, fontSize: 10 }}>
          Originals backed up in .orax/checkpoints
        </Text>
      )}
    </View>
  );
}

// Phase 2L: compact card for project_patch_failed thread messages
function ProjectPatchFailedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#ef444455",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#ef444408",
      }}
    >
      <Text style={{ color: "#ef4444", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Patch failed
      </Text>
      <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 4 }}>
        {msg.content}
      </Text>
    </View>
  );
}

// Phase 2M: compact card for project_patch_verified thread messages
function ProjectPatchVerifiedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const checks = msg.payload?.checks ?? [];
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#22c55e55",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#22c55e08",
      }}
    >
      <Text style={{ color: "#22c55e", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Verification passed
      </Text>
      {checks.length > 0 ? (
        <View style={{ marginTop: 8, gap: 4 }}>
          {checks.map((c2) => (
            <Text
              key={c2.name}
              style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18 }}
            >
              {`\u2713 ${c2.name} (${c2.durationMs}ms)`}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 4 }}>
          {msg.content}
        </Text>
      )}
    </View>
  );
}

// Phase 2M: compact card for project_patch_verification_failed thread messages
function ProjectPatchVerificationFailedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const checks = msg.payload?.checks ?? [];
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#f59e0b55",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#f59e0b08",
      }}
    >
      <Text style={{ color: "#f59e0b", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Verification failed
      </Text>
      {checks.length > 0 ? (
        <View style={{ marginTop: 8, gap: 4 }}>
          {checks.map((c2) => (
            <Text
              key={c2.name}
              style={{
                color: c2.status === "failed" ? "#ef4444" : c.mutedForeground,
                fontSize: 12,
                lineHeight: 18,
              }}
            >
              {`${c2.status === "passed" ? "\u2713" : c2.status === "skipped" ? "\u2013" : "\u2717"} ${c2.name} (${c2.durationMs}ms)`}
            </Text>
          ))}
        </View>
      ) : (
        <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 4 }}>
          {msg.content}
        </Text>
      )}
    </View>
  );
}

// Phase 2N: compact card for project_fix_drafted thread messages
function ProjectFixDraftedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const draft = msg.payload?.draftPatch;
  if (!draft) {
    return (
      <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
        <Text style={{ color: c.foreground, fontSize: 13 }}>{msg.content}</Text>
      </View>
    );
  }
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#3b82f655",
        borderRadius: 12,
        padding: 12,
        gap: 8,
        backgroundColor: "#3b82f608",
      }}
    >
      <Text
        style={{
          color: "#3b82f6",
          fontSize: 13,
          lineHeight: 18,
          fontFamily: "Inter_500Medium",
        }}
      >
        Auto-fix proposal
      </Text>
      <Text
        style={{
          color: c.foreground,
          fontSize: 13,
          lineHeight: 18,
          fontFamily: "Inter_500Medium",
        }}
      >
        {draft.summary}
      </Text>
      {/* Changed file chips */}
      {draft.changedFiles.length > 0 && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {draft.changedFiles.map((f) => (
            <View
              key={f.relativePath}
              style={{
                flexDirection: "row",
                alignItems: "center",
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 6,
                paddingHorizontal: 6,
                paddingVertical: 2,
                gap: 4,
                backgroundColor: c.muted,
              }}
            >
              <Text
                style={{ color: c.mutedForeground, fontSize: 10, fontFamily: "SpaceMono_400Regular" }}
                numberOfLines={1}
              >
                {f.relativePath}
              </Text>
              <Text
                style={{
                  fontSize: 9,
                  fontFamily: "Inter_600SemiBold",
                  color: "#3b82f6",
                  textTransform: "uppercase",
                }}
              >
                {f.operation}
              </Text>
            </View>
          ))}
        </View>
      )}
      {/* Risks */}
      {draft.risks.length > 0 &&
        draft.risks.slice(0, 2).map((r, i) => (
          <Text
            key={i}
            style={{ color: "#f59e0b", fontSize: 11, lineHeight: 16 }}
          >
            {"\u26A0\uFE0F"} {r}
          </Text>
        ))}
      <Text style={{ color: c.mutedForeground, fontSize: 10 }}>
        Review and approve via Orax Desktop
      </Text>
    </View>
  );
}

// Phase 3B: compact card for project_pr_ready thread messages
function ProjectPrReadyCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  const branchName = msg.payload?.branchName as string | undefined;
  const commitSha = msg.payload?.commitSha as string | undefined;
  const prUrl = msg.payload?.prUrl as string | null | undefined;
  const warnings = msg.payload?.warnings as string[] | undefined;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#22c55e55",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#22c55e08",
      }}
    >
      <Text style={{ color: "#22c55e", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Pull request ready
      </Text>
      {branchName ? (
        <Text
          style={{
            color: c.mutedForeground,
            fontSize: 11,
            fontFamily: "SpaceMono_400Regular",
            marginTop: 4,
          }}
          numberOfLines={1}
        >
          {branchName}
        </Text>
      ) : null}
      {commitSha ? (
        <Text style={{ color: c.mutedForeground, fontSize: 11, marginTop: 2 }}>
          {`Commit: ${commitSha.slice(0, 8)}`}
        </Text>
      ) : null}
      {prUrl ? (
        <Text style={{ color: "#3b82f6", fontSize: 12, marginTop: 6 }} numberOfLines={2}>
          {prUrl}
        </Text>
      ) : (
        <Text style={{ color: c.mutedForeground, fontSize: 11, marginTop: 4 }}>
          Branch committed locally — push to remote to open a PR.
        </Text>
      )}
      {warnings && warnings.length > 0
        ? warnings.slice(0, 2).map((w, i) => (
            <Text key={i} style={{ color: "#f59e0b", fontSize: 11, marginTop: 2 }}>
              {w}
            </Text>
          ))
        : null}
    </View>
  );
}

// Phase 3B: compact card for project_pr_failed thread messages
function ProjectPrFailedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#ef444455",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#ef444408",
      }}
    >
      <Text style={{ color: "#ef4444", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        Pull request failed
      </Text>
      <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 4 }}>
        {msg.content}
      </Text>
    </View>
  );
}

// Phase 3C: compact card for project_pr_blocked thread messages
function ProjectPrBlockedCard({ msg }: { msg: OraxProjectThreadMessage }) {
  const c = useColors();
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: "#f59e0b55",
        borderRadius: 12,
        padding: 12,
        backgroundColor: "#f59e0b08",
      }}
    >
      <Text style={{ color: "#f59e0b", fontSize: 13, fontFamily: "Inter_500Medium" }}>
        GitHub connection required
      </Text>
      <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 18, marginTop: 4 }}>
        {msg.content}
      </Text>
      <Text style={{ color: c.mutedForeground, fontSize: 11, marginTop: 6 }}>
        Open device settings in the Orax app to connect GitHub.
      </Text>
    </View>
  );
}

function isOraxVisibleThreadMessage(message: OraxTaskMessage): boolean {
  if (message.role === "user" || message.role === "assistant") return true;
  const event = typeof message.metadata?.event === "string" ? message.metadata.event : "";
  if (
    [
      "checkpoint_updated",
      "execution_session_started",
      "execution_step",
      "approval_requested",
      "approval_decided",
    ].includes(event)
  ) {
    return false;
  }
  return message.role === "tool";
}

function formatOraxVisibleThreadContent(message: OraxTaskMessage): string {
  const event = typeof message.metadata?.event === "string" ? message.metadata.event : "";
  if (event === "runner_continue") {
    return message.content
      .replace(/^Approved file read completed:/i, "Inspected")
      .replace(/^Draft patch generated:/i, "Prepared changes")
      .replace(/^Sandbox validation passed/i, "Checked changes")
      .replace(/^Sandbox validation failed/i, "Change check failed")
      .replace(/^Controlled checks passed:/i, "Checks passed:")
      .replace(/^Controlled checks failed:/i, "Checks failed:");
  }
  return message.content;
}

function getOraxRunnerActivity(message: OraxTaskMessage): OraxRunnerActivity | null {
  const event = typeof message.metadata?.event === "string" ? message.metadata.event : "";
  if (event !== "runner_continue") return null;
  const action =
    typeof message.metadata?.runnerAction === "string" ? message.metadata.runnerAction : "";
  const executionStep = message.metadata?.executionStep;
  const rawStatus =
    typeof executionStep?.status === "string"
      ? executionStep.status
      : typeof message.metadata?.runnerStatus === "string"
        ? message.metadata.runnerStatus
        : "";
  const content = message.content.toLowerCase();
  const status: OraxRunnerActivity["status"] =
    /failed|error/.test(content) || rawStatus === "failed"
      ? "failed"
      : rawStatus === "blocked"
        ? "blocked"
        : rawStatus === "waiting"
          ? "waiting"
          : rawStatus === "running"
            ? "running"
            : "completed";
  return {
    label: formatOraxRunnerActivityLabel(action, content, status),
    status,
  };
}

function formatOraxRunnerActivityLabel(
  action: string,
  content: string,
  status: OraxRunnerActivity["status"],
): string {
  if (status === "failed" && content.includes("sandbox")) return "Change check failed";
  if (status === "failed" && content.includes("check")) return "Checks failed";
  if (status === "blocked") return "Needs attention";
  switch (action) {
    case "run_approved_read":
    case "request_read_approval":
      return "Inspected files";
    case "draft_patch":
    case "create_workspace_change_set":
      return "Prepared changes";
    case "run_approved_sandbox":
    case "request_sandbox_approval":
      return "Checked changes";
    case "run_approved_checks":
    case "request_command_approval":
      return "Ran checks";
    case "retry_failed_patch":
      return "Prepared a fix";
    case "run_approved_pr":
    case "request_pr_approval":
      return "Prepared pull request";
    default:
      return status === "running" ? "Working" : "Updated task";
  }
}

function MessageBubble({ message }: { message: OraxTaskMessage }) {
  const c = useColors();
  const isUser = message.role === "user";
  const activity = getOraxRunnerActivity(message);
  const attachments = getMessageComposerAttachments(message);
  if (activity) return <RunnerActivityRow activity={activity} />;
  return (
    <View
      style={{
        alignSelf: isUser ? "flex-end" : "stretch",
        maxWidth: isUser ? "88%" : "100%",
        borderWidth: isUser ? 1 : 0,
        borderColor: isUser ? c.border : "transparent",
        borderRadius: isUser ? 24 : 0,
        padding: 12,
        backgroundColor: isUser ? c.muted : "transparent",
        gap: 6,
      }}
    >
      <Text
        style={{
          color: c.foreground,
          fontSize: 14,
          lineHeight: 20,
        }}
      >
        {formatOraxVisibleThreadContent(message)}
      </Text>
      {attachments.length ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {attachments.map((attachment) => (
            <View
              key={attachment.id ?? attachment.name}
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                borderWidth: 1,
                borderColor: c.border,
                borderRadius: 999,
                paddingHorizontal: 10,
                paddingVertical: 6,
              }}
            >
              <FileText size={14} color={c.mutedForeground} />
              <Text numberOfLines={1} style={{ color: c.mutedForeground, fontSize: 12 }}>
                {attachment.name}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function RunnerActivityRow({ activity }: { activity: OraxRunnerActivity }) {
  const c = useColors();
  const isRunning = activity.status === "running" || activity.status === "waiting";
  const isProblem = activity.status === "failed" || activity.status === "blocked";
  return (
    <View
      style={{
        alignSelf: "flex-start",
        maxWidth: "92%",
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderWidth: 1,
        borderColor: isProblem ? c.destructive : c.border,
        borderRadius: 999,
        backgroundColor: isProblem ? c.card : c.muted,
        paddingHorizontal: 12,
        paddingVertical: 7,
      }}
    >
      {isRunning ? (
        <ActivityIndicator size="small" color={c.mutedForeground} />
      ) : isProblem ? (
        <AlertCircle size={16} color={c.destructive} />
      ) : (
        <CheckCircle2 size={16} color={c.mutedForeground} />
      )}
      <Text
        numberOfLines={1}
        style={{
          color: isProblem ? c.destructive : c.foreground,
          fontFamily: "Inter_600SemiBold",
          fontSize: 13,
        }}
      >
        {activity.label}
      </Text>
    </View>
  );
}

function ApprovalCard({
  approval,
  busyAction,
  onApprove,
  onDeny,
  onRun,
}: {
  approval: OraxApproval;
  busyAction: string | null;
  onApprove: () => void;
  onDeny: () => void;
  onRun: () => void;
}) {
  const c = useColors();
  const canDecide = approval.status === "pending";
  const canRun = approval.status === "approved";
  return (
    <View
      style={{
        gap: 10,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 24,
        backgroundColor: c.card,
        padding: 14,
      }}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
            {formatApprovalAction(approval.action)}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
            {approval.status === "pending" ? "Waiting for your approval" : "Ready to continue"}
          </Text>
        </View>
        <StatusIcon status={approval.status} />
      </View>
      {approval.riskSummary ? (
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
          {approval.riskSummary}
        </Text>
      ) : null}
      {approval.request.paths?.length ? (
        <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
          Will inspect {approval.request.paths.length} file
          {approval.request.paths.length === 1 ? "" : "s"}.
        </Text>
      ) : null}
      {approval.request.commands?.length ? (
        <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
          Will run {approval.request.commands.length} check
          {approval.request.commands.length === 1 ? "" : "s"}.
        </Text>
      ) : null}
      {canDecide ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          <Button
            label="Approve"
            icon={CheckCircle2}
            onPress={onApprove}
            loading={busyAction === `approve-${approval.id}`}
            style={{ flex: 1 }}
          />
          <Button
            label="Deny"
            icon={XCircle}
            variant="destructive"
            onPress={onDeny}
            loading={busyAction === `deny-${approval.id}`}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
      {canRun ? (
        <Button
          label="Continue"
          icon={RefreshCw}
          variant="secondary"
          onPress={onRun}
          loading={busyAction === `run-${approval.id}`}
          full
        />
      ) : null}
      {approval.result?.pullRequestUrl ? (
        <Text style={{ color: c.accentForeground, fontSize: 13 }}>
          PR: {approval.result.pullRequestUrl}
        </Text>
      ) : null}
    </View>
  );
}

function ArtifactCard({
  artifact,
  latestPr,
}: {
  artifact: OraxArtifact;
  latestPr: OraxArtifact | null;
}) {
  const c = useColors();
  const commands = artifact.payload.commands ?? [];
  const changedFiles = artifact.payload.changedFiles ?? [];
  const patchedFiles = artifact.payload.patchedFiles ?? [];
  const rollbackFiles = artifact.payload.rollback?.sourceFiles ?? [];
  const fileDiffs = parseOraxUnifiedDiffFiles(artifact.payload.unifiedDiff);
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 15 }}>
            {artifact.title}
          </Text>
          <Text style={{ color: c.mutedForeground, fontSize: 13 }}>
            {artifact.type.replace(/_/g, " ")} - {artifact.status}
          </Text>
        </View>
        <StatusIcon status={artifact.status} />
      </View>
      {artifact.summary ? (
        <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 19 }}>
          {artifact.summary}
        </Text>
      ) : null}
      {artifact.payload.explanation ? (
        <Text style={{ color: c.foreground, fontSize: 13, lineHeight: 19 }}>
          {artifact.payload.explanation}
        </Text>
      ) : null}
      {artifact.type === "workspace_change_set" ? (
        <WorkspaceChangeSetDiffReview changedFiles={changedFiles} fileDiffs={fileDiffs} />
      ) : changedFiles.length ? (
        <Text style={{ color: c.foreground, fontSize: 13 }}>
          Changed: {changedFiles.map((file) => file.path).join(", ")}
        </Text>
      ) : null}
      {artifact.type === "workspace_change_set" && (patchedFiles.length || rollbackFiles.length) ? (
        <Text style={{ color: c.mutedForeground, fontSize: 12, lineHeight: 17 }}>
          Snapshots: {patchedFiles.length}. Rollback sources: {rollbackFiles.length}.
        </Text>
      ) : null}
      {commands.length ? (
        <View style={{ gap: 6 }}>
          {commands.map((command) => (
            <Text key={command.id} style={{ color: c.mutedForeground, fontSize: 12 }}>
              {command.label ?? command.id}: {command.status}
              {command.message ? ` - ${command.message}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
      {(artifact.payload.pullRequestUrl ?? latestPr?.payload.pullRequestUrl) ? (
        <Text style={{ color: c.accentForeground, fontSize: 13 }}>
          PR: {artifact.payload.pullRequestUrl ?? latestPr?.payload.pullRequestUrl}
        </Text>
      ) : null}
      {artifact.payload.error?.message ? (
        <Notice tone="error" title="Artifact error" body={artifact.payload.error.message} />
      ) : null}
    </Card>
  );
}

function WorkspaceChangeSetDiffReview({
  changedFiles,
  fileDiffs,
}: {
  changedFiles: NonNullable<OraxArtifact["payload"]["changedFiles"]>;
  fileDiffs: OraxFileDiff[];
}) {
  const c = useColors();
  if (!changedFiles.length && !fileDiffs.length) return null;

  const diffByPath = new Map(fileDiffs.map((file) => [file.path, file]));
  const ordered = changedFiles.length
    ? changedFiles.map((file) => ({
        path: file.path,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        diff: diffByPath.get(file.path),
      }))
    : fileDiffs.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        diff: file,
      }));

  return (
    <View style={{ gap: 8 }}>
      <Text style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 13 }}>
        Changed files
      </Text>
      {ordered.map((file) => (
        <WorkspaceDiffFileRow
          key={file.path}
          path={file.path}
          additions={file.additions}
          deletions={file.deletions}
          diff={file.diff}
        />
      ))}
    </View>
  );
}

function WorkspaceDiffFileRow({
  path,
  additions,
  deletions,
  diff,
}: {
  path: string;
  additions: number;
  deletions: number;
  diff?: OraxFileDiff;
}) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const Icon = open ? ChevronDown : ChevronRight;

  return (
    <View
      style={{
        borderColor: c.border,
        borderRadius: 8,
        borderWidth: 1,
        overflow: "hidden",
      }}
    >
      <Pressable
        onPress={() => setOpen((value) => !value)}
        style={{
          alignItems: "center",
          backgroundColor: c.muted,
          flexDirection: "row",
          gap: 8,
          justifyContent: "space-between",
          paddingHorizontal: 10,
          paddingVertical: 9,
        }}
      >
        <View style={{ alignItems: "center", flex: 1, flexDirection: "row", gap: 8 }}>
          <Icon size={14} color={c.mutedForeground} />
          <Text
            numberOfLines={1}
            style={{ color: c.foreground, flex: 1, fontFamily: "Inter_600SemiBold", fontSize: 12 }}
          >
            {path}
          </Text>
        </View>
        <Text style={{ color: c.mutedForeground, fontSize: 12 }}>
          +{additions} / -{deletions}
        </Text>
      </Pressable>
      {open ? (
        diff?.lines.length ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={{ minWidth: "100%", paddingVertical: 6 }}>
              {diff.lines.map((line, index) => (
                <Text
                  key={`${path}-${index}`}
                  style={{
                    backgroundColor: backgroundForDiffLine(line.type),
                    color: colorForDiffLine(line.type, c),
                    fontFamily: Platform.select({
                      ios: "Menlo",
                      android: "monospace",
                      default: "monospace",
                    }),
                    fontSize: 11,
                    lineHeight: 17,
                    paddingHorizontal: 10,
                  }}
                >
                  {line.content || " "}
                </Text>
              ))}
              {diff.truncated ? (
                <Text style={{ color: c.mutedForeground, fontSize: 11, padding: 10 }}>
                  Diff preview truncated.
                </Text>
              ) : null}
            </View>
          </ScrollView>
        ) : (
          <Text style={{ color: c.mutedForeground, fontSize: 12, padding: 10 }}>
            Diff preview unavailable for this file.
          </Text>
        )
      ) : null}
    </View>
  );
}

function backgroundForDiffLine(type: OraxDiffLine["type"]): string {
  if (type === "add") return "rgba(16, 185, 129, 0.12)";
  if (type === "remove") return "rgba(239, 68, 68, 0.12)";
  if (type === "meta") return "rgba(148, 163, 184, 0.12)";
  return "transparent";
}

function colorForDiffLine(type: OraxDiffLine["type"], c: ReturnType<typeof useColors>): string {
  if (type === "add") return "#047857";
  if (type === "remove") return "#b91c1c";
  if (type === "meta") return c.mutedForeground;
  return c.foreground;
}

function CapabilityRow({ text, available }: { text: string; available?: boolean }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {available ? (
        <CheckCircle2 size={16} color={c.accentForeground} />
      ) : (
        <Lock size={16} color={c.mutedForeground} />
      )}
      <Text style={{ color: available ? c.foreground : c.mutedForeground, fontSize: 14, flex: 1 }}>
        {text}
      </Text>
    </View>
  );
}

function Notice({ tone, title, body }: { tone: "error" | "info"; title: string; body: string }) {
  const c = useColors();
  const color = tone === "error" ? c.destructive : c.accentForeground;
  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: color,
        borderRadius: c.radius,
        padding: 12,
        gap: 6,
        backgroundColor: c.card,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <AlertCircle size={16} color={color} />
        <Text style={{ color, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>{title}</Text>
      </View>
      <Text style={{ color: c.mutedForeground, fontSize: 13, lineHeight: 18 }}>{body}</Text>
    </View>
  );
}

function InfoGrid({ items }: { items: Array<[string, string]> }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      {items.map(([label, value]) => (
        <View
          key={label}
          style={{
            flex: 1,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 10,
            padding: 10,
            backgroundColor: c.muted,
          }}
        >
          <Text style={{ color: c.mutedForeground, fontSize: 10, textTransform: "uppercase" }}>
            {label}
          </Text>
          <Text
            numberOfLines={1}
            style={{ color: c.foreground, fontFamily: "Inter_600SemiBold", fontSize: 13 }}
          >
            {value || "none"}
          </Text>
        </View>
      ))}
    </View>
  );
}

function StatusIcon({ status }: { status: string }) {
  const c = useColors();
  if (status === "completed" || status === "approved") {
    return <CheckCircle2 size={18} color={c.accentForeground} />;
  }
  if (status === "failed" || status === "denied") {
    return <XCircle size={18} color={c.destructive} />;
  }
  return <Lock size={18} color={c.mutedForeground} />;
}

function formatApprovalAction(action: string): string {
  if (action === "read_files") return "Inspect files";
  if (action === "sandbox_run") return "Check changes";
  if (action === "safe_check") return "Run checks";
  if (action === "github_pr") return "Prepare pull request";
  return action.replace(/_/g, " ");
}

function buildLifecycleItems(
  approvals: OraxApproval[],
  artifacts: OraxArtifact[],
): LifecycleItem[] {
  const approvalItems: LifecycleItem[] = approvals.map((approval) => ({
    id: `approval-${approval.id}`,
    kind: "approval",
    label: approval.status === "pending" ? "Approval requested" : "Approval decision",
    title: formatApprovalAction(approval.action),
    status: approval.status,
    createdAt: approval.decidedAt ?? approval.completedAt ?? approval.createdAt ?? "",
    description: describeApproval(approval),
  }));
  const artifactItems: LifecycleItem[] = artifacts.map((artifact) => ({
    id: `artifact-${artifact.id}`,
    kind: "artifact",
    label: formatArtifactLabel(artifact.type),
    title: artifact.title,
    status: artifact.status,
    createdAt: artifact.updatedAt ?? artifact.createdAt ?? "",
    description: describeArtifact(artifact),
  }));
  return [...approvalItems, ...artifactItems];
}

function describeApproval(approval: OraxApproval): string {
  if (approval.action === "read_files") {
    const files = approval.request.paths?.join(", ") || "selected files";
    if (approval.status === "completed") {
      const count = approval.result?.files?.length ?? 0;
      return `Inspected ${count} file${count === 1 ? "" : "s"}.`;
    }
    return `Review ${files}.`;
  }
  if (approval.action === "sandbox_run") {
    return "Check the prepared change before moving on.";
  }
  if (approval.action === "safe_check") {
    return approval.request.commands?.length
      ? `Checks: ${approval.request.commands.join(", ")}.`
      : "Run the selected checks.";
  }
  if (approval.action === "github_pr") {
    return approval.result?.pullRequestUrl
      ? `Pull request created: ${approval.result.pullRequestUrl}`
      : "Prepare the pull request after checks pass.";
  }
  return approval.riskSummary ?? "Confirm the next step.";
}

function parseOraxUnifiedDiffFiles(diff?: string): OraxFileDiff[] {
  if (!diff?.trim()) return [];
  const files: OraxFileDiff[] = [];
  let current: OraxFileDiff | null = null;

  for (const rawLine of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (rawLine.startsWith("diff --git ")) {
      if (current) files.push(current);
      const match = rawLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const path = match?.[2] ?? match?.[1] ?? "unknown file";
      current = { path, additions: 0, deletions: 0, lines: [], truncated: false };
      continue;
    }

    if (!current && rawLine.startsWith("+++ b/")) {
      current = {
        path: rawLine.replace("+++ b/", "").trim(),
        additions: 0,
        deletions: 0,
        lines: [],
        truncated: false,
      };
    }
    if (!current) continue;

    if (rawLine.startsWith("+++ b/")) {
      current.path = rawLine.replace("+++ b/", "").trim() || current.path;
      continue;
    }
    if (rawLine.startsWith("--- ")) continue;

    const type: OraxDiffLine["type"] = rawLine.startsWith("@@")
      ? "meta"
      : rawLine.startsWith("+")
        ? "add"
        : rawLine.startsWith("-")
          ? "remove"
          : "context";
    if (type === "add") current.additions += 1;
    if (type === "remove") current.deletions += 1;
    if (current.lines.length < 180) {
      current.lines.push({ type, content: rawLine });
    } else {
      current.truncated = true;
    }
  }

  if (current) files.push(current);
  return files.filter((file) => file.path && file.path !== "/dev/null").slice(0, 12);
}

function formatArtifactLabel(type: string): string {
  if (type === "execution_session") return "Execution session";
  if (type === "draft_patch") return "Draft patch generated";
  if (type === "sandbox_result") return "Sandbox result";
  if (type === "workspace_change_set") return "Workspace change set";
  if (type === "command_result") return "Controlled checks result";
  if (type === "github_pr_result") return "Pull request result";
  return "Workflow result";
}

function describeArtifact(artifact: OraxArtifact): string {
  if (artifact.type === "execution_session") {
    const steps = artifact.payload.steps?.length ?? 0;
    return `Execution session ${artifact.status}; ${steps} step${steps === 1 ? "" : "s"} recorded.`;
  }
  if (artifact.type === "draft_patch") {
    const files = artifact.payload.filesRead?.length ?? 0;
    if (artifact.payload.retryOfArtifactId) {
      return (
        artifact.summary ??
        `Retry patch attempt ${artifact.payload.retryAttempt ?? 1} for failed artifact #${artifact.payload.retryOfArtifactId}.`
      );
    }
    return (
      artifact.summary ?? `Review-only patch preview generated from ${files} approved file(s).`
    );
  }
  if (artifact.type === "sandbox_result") {
    const changedFiles = artifact.payload.changedFiles?.length ?? 0;
    return artifact.payload.applied
      ? `Sandbox applied the patch preview to ${changedFiles} file(s).`
      : "Sandbox could not apply the patch preview.";
  }
  if (artifact.type === "workspace_change_set") {
    const changedFiles = artifact.payload.changedFiles?.length ?? 0;
    const diff = artifact.payload.diffSummary;
    const diffText =
      diff && (diff.additions || diff.deletions)
        ? ` (+${diff.additions ?? 0} / -${diff.deletions ?? 0})`
        : "";
    return `Workspace change set ready for ${changedFiles} file${changedFiles === 1 ? "" : "s"}${diffText}.`;
  }
  if (artifact.type === "command_result") {
    const passed =
      artifact.payload.commands?.filter((command) => command.status === "passed").length ?? 0;
    const failed =
      artifact.payload.commands?.filter((command) => command.status === "failed").length ?? 0;
    return `Controlled checks completed: ${passed} passed, ${failed} failed.`;
  }
  if (artifact.type === "github_pr_result") {
    return artifact.payload.pullRequestUrl
      ? `Pull request created on ${artifact.payload.branchName ?? "the ORAX branch"}.`
      : (artifact.payload.error?.message ?? "GitHub PR result recorded.");
  }
  return artifact.summary ?? "ORAX workflow artifact recorded.";
}

function messageFromError(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) {
    if (/invalid orax task/i.test(err.message)) {
      return "Start a new Orax chat, then send the message again.";
    }
    return err.message;
  }
  return fallback;
}
