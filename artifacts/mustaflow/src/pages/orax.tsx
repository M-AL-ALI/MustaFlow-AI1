import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Code2,
  FileSearch,
  FileText,
  GitBranch,
  GitPullRequest,
  KeyRound,
  Loader2,
  LockKeyhole,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { authFetch } from "@/lib/api-fetch";
import { cn } from "@/lib/utils";

type OraxRepository = {
  id: number;
  provider: string;
  owner: string;
  name: string;
  repositoryUrl: string;
  defaultBranch: string;
  connectionStatus: string;
  githubAccountName?: string | null;
  tokenScopes?: string | null;
  connectedAt?: string | null;
  lastScanAt?: string | null;
  scanStatus?: string;
  updatedAt: string;
};

type OraxScanSummary = {
  repo?: {
    fullName?: string;
    htmlUrl?: string;
    defaultBranch?: string;
    private?: boolean;
    language?: string | null;
  };
  branch?: string;
  commitSha?: string;
  fileCount?: number;
  directoryCount?: number;
  totalBytes?: number;
  languages?: Record<string, number>;
  topLevelEntries?: Array<{ path: string; type: string }>;
  sampleFiles?: string[];
  truncated?: boolean;
};

type OraxScan = {
  id: number;
  repositoryId: number;
  status: string;
  branch: string;
  commitSha?: string | null;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  summary: OraxScanSummary;
  error?: string | null;
  createdAt: string;
  completedAt?: string | null;
};

type OraxCheckpointSummary = {
  goal: string;
  status: string;
  filesReviewed: string[];
  approvals: {
    pending: number;
    completed: number;
    failed: number;
    denied: number;
    total: number;
  };
  artifacts: {
    draftPatches: number;
    sandboxResults: number;
    commandResults: number;
    githubPrResults: number;
    total: number;
  };
  latestBlocker: string | null;
  nextStep: string;
  updatedAt: string;
};

type OraxTask = {
  id: number;
  repositoryId: number;
  kind: string;
  status: string;
  title: string;
  prompt: string;
  plan: {
    mode?: string;
    objective?: string;
    steps?: string[];
    guardrails?: string[];
    unavailableUntilApproved?: string[];
  };
  result?: { message?: string; currentCheckpoint?: OraxCheckpointSummary };
  createdAt: string;
};

type OraxTaskMessage = {
  id: number;
  repositoryId: number;
  taskId: number;
  role: string;
  content: string;
  metadata?: {
    actionSuggestions?: OraxTaskActionSuggestion[];
    checkpoint?: OraxCheckpointSummary;
    event?: string;
    source?: string;
    [key: string]: unknown;
  };
  artifactId?: number | null;
  approvalId?: number | null;
  createdAt: string;
  updatedAt: string;
};

type OraxTaskActionSuggestion = {
  type:
    | "read_files"
    | "draft_patch"
    | "sandbox_run"
    | "controlled_checks"
    | "github_pr"
    | "review_pending_approval";
  title: string;
  description: string;
  buttonLabel?: string;
  paths?: string[];
  reason?: string;
  instructions?: string;
  artifactId?: number;
  approvalId?: number;
  commands?: string[];
  requiresManualConfirmation?: boolean;
};

type OraxApproval = {
  id: number;
  repositoryId: number;
  taskId: number;
  action: string;
  status: string;
  request: {
    paths?: string[];
    branch?: string;
    reason?: string | null;
    artifactId?: number;
    scope?: string;
  };
  result?: {
    artifactId?: number;
    branch?: string;
    totalBytes?: number;
    files?: Array<{ path: string; sha: string; size: number; truncated: boolean }>;
    skipped?: Array<{ path: string; reason: string }>;
    branchName?: string;
    pullRequestUrl?: string;
    error?: OraxFailureInfo;
  };
  riskSummary?: string | null;
  createdAt: string;
  decidedAt?: string | null;
  completedAt?: string | null;
};

type OraxReadResult = {
  branch: string;
  files: Array<{
    path: string;
    sha: string;
    size: number;
    content: string;
    truncated: boolean;
  }>;
  skipped: Array<{ path: string; reason: string }>;
};

type OraxArtifact = {
  id: number;
  repositoryId: number;
  taskId: number;
  approvalId?: number | null;
  type: string;
  status: string;
  title: string;
  summary?: string | null;
  payload: {
    branch?: string;
    unifiedDiff?: string;
    explanation?: string;
    risks?: string[];
    tests?: string[];
    filesRead?: Array<{ path: string; sha: string; size: number }>;
    skipped?: Array<{ path: string; reason: string }>;
    model?: string;
    generatedAt?: string;
    sourceArtifactId?: number;
    sourceApprovalId?: number;
    validatedAt?: string;
    applied?: boolean;
    changedFiles?: Array<{
      path: string;
      beforeBytes: number;
      afterBytes: number;
      additions: number;
      deletions: number;
    }>;
    checks?: Array<{ name: string; status: string; message: string }>;
    errors?: string[];
    testPreview?: Array<{ name: string; status: string; message: string }>;
    passed?: boolean;
    commands?: Array<{
      id: string;
      label: string;
      status: string;
      exitCode?: number | null;
      durationMs?: number;
      stdout?: string;
      stderr?: string;
      message: string;
    }>;
    executedAt?: string;
    draftArtifactId?: number;
    commandArtifactId?: number;
    branchName?: string;
    baseBranch?: string;
    commitSha?: string;
    pullRequestNumber?: number;
    pullRequestUrl?: string;
    pullRequestState?: string;
    filesChanged?: string[];
    auditTrail?: Array<{ label: string; id: number; kind: string }>;
    error?: OraxFailureInfo;
    failedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
};

type OraxFailureInfo = {
  code?: string;
  message?: string;
  hint?: string;
  rawMessage?: string;
};

type OraxThreadLifecycleItem =
  | {
      id: string;
      source: "approval";
      label: string;
      title: string;
      status: string;
      description: string;
      createdAt: string;
      approval: OraxApproval;
    }
  | {
      id: string;
      source: "artifact";
      label: string;
      title: string;
      status: string;
      description: string;
      createdAt: string;
      artifact: OraxArtifact;
    };

type OraxCapabilities = {
  available: string[];
  lockedUntilApprovalLayer: string[];
};

const TASK_KINDS = [
  { value: "analyze", label: "Analyze" },
  { value: "plan", label: "Plan" },
  { value: "review", label: "Review" },
  { value: "fix", label: "Fix" },
] as const;

const ORAX_COMMAND_OPTIONS = [
  {
    id: "patch-static-checks",
    label: "Static patch checks",
    description: "Validate patch scope and changed-file metadata.",
  },
  {
    id: "json-syntax",
    label: "JSON syntax",
    description: "Parse patched JSON files.",
  },
  {
    id: "node-syntax",
    label: "Node syntax",
    description: "Run node --check on patched JavaScript files.",
  },
  {
    id: "pnpm-typecheck",
    label: "pnpm run typecheck",
    description: "Run the repository typecheck script in a temporary workspace.",
  },
  {
    id: "pnpm-lint",
    label: "pnpm run lint",
    description: "Run the repository lint script in a temporary workspace.",
  },
  {
    id: "pnpm-test",
    label: "pnpm test",
    description: "Run the repository test script in a temporary workspace.",
  },
  {
    id: "pnpm-build",
    label: "pnpm run build",
    description: "Run the repository build script in a temporary workspace.",
  },
] as const;

const DEFAULT_ORAX_COMMAND_IDS = ["patch-static-checks", "json-syntax", "node-syntax"];

export default function OraxPage() {
  const [repositories, setRepositories] = useState<OraxRepository[]>([]);
  const [tasks, setTasks] = useState<OraxTask[]>([]);
  const [approvals, setApprovals] = useState<OraxApproval[]>([]);
  const [artifacts, setArtifacts] = useState<OraxArtifact[]>([]);
  const [taskMessages, setTaskMessages] = useState<OraxTaskMessage[]>([]);
  const [capabilities, setCapabilities] = useState<OraxCapabilities | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const activeTaskIdRef = useRef<number | null>(null);
  const [githubToken, setGithubToken] = useState("");
  const [scans, setScans] = useState<OraxScan[]>([]);
  const [taskKind, setTaskKind] = useState<(typeof TASK_KINDS)[number]["value"]>("analyze");
  const [prompt, setPrompt] = useState("");
  const [approvalPaths, setApprovalPaths] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [taskMessageDraft, setTaskMessageDraft] = useState("");
  const [pendingSuggestionConfirmation, setPendingSuggestionConfirmation] =
    useState<OraxTaskActionSuggestion | null>(null);
  const [suggestionPrConfirmationText, setSuggestionPrConfirmationText] = useState("");
  const [selectedCommandIds, setSelectedCommandIds] = useState<string[]>(DEFAULT_ORAX_COMMAND_IDS);
  const [prConfirmationText, setPrConfirmationText] = useState("");
  const [readResult, setReadResult] = useState<OraxReadResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [scanningRepository, setScanningRepository] = useState(false);
  const [loadingScans, setLoadingScans] = useState(false);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [loadingArtifacts, setLoadingArtifacts] = useState(false);
  const [loadingTaskMessages, setLoadingTaskMessages] = useState(false);
  const [submittingTask, setSubmittingTask] = useState(false);
  const [sendingTaskMessage, setSendingTaskMessage] = useState(false);
  const [requestingApproval, setRequestingApproval] = useState(false);
  const [requestingSandboxApprovalArtifactId, setRequestingSandboxApprovalArtifactId] = useState<
    number | null
  >(null);
  const [requestingCommandApprovalArtifactId, setRequestingCommandApprovalArtifactId] = useState<
    number | null
  >(null);
  const [requestingPrApprovalArtifactId, setRequestingPrApprovalArtifactId] = useState<
    number | null
  >(null);
  const [decidingApprovalId, setDecidingApprovalId] = useState<number | null>(null);
  const [readingApprovalId, setReadingApprovalId] = useState<number | null>(null);
  const [runningSandboxApprovalId, setRunningSandboxApprovalId] = useState<number | null>(null);
  const [runningCommandApprovalId, setRunningCommandApprovalId] = useState<number | null>(null);
  const [creatingPrApprovalId, setCreatingPrApprovalId] = useState<number | null>(null);
  const [generatingArtifactApprovalId, setGeneratingArtifactApprovalId] = useState<number | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === selectedRepoId) ?? repositories[0] ?? null,
    [repositories, selectedRepoId],
  );
  const latestScan = scans[0] ?? null;
  const latestScanLanguages = Object.entries(latestScan?.summary?.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null,
    [tasks, selectedTaskId],
  );
  const currentCheckpoint = useMemo(() => {
    const checkpointMessage = [...taskMessages]
      .reverse()
      .find((message) => message.metadata?.source === "orax-task-checkpoint");
    return (
      checkpointMessage?.metadata?.checkpoint ?? selectedTask?.result?.currentCheckpoint ?? null
    );
  }, [selectedTask, taskMessages]);
  const latestDraftPatch = artifacts.find((artifact) => artifact.type === "draft_patch") ?? null;
  const latestSandboxResult =
    artifacts.find((artifact) => artifact.type === "sandbox_result") ?? null;
  const latestCommandResult =
    artifacts.find((artifact) => artifact.type === "command_result") ?? null;
  const latestGithubPrResult =
    artifacts.find((artifact) => artifact.type === "github_pr_result") ?? null;
  const pendingApprovals = approvals.filter((approval) => approval.status === "pending");
  const latestArtifact = artifacts[0] ?? null;
  const timelineMessageCount = taskMessages.filter(
    (message) => message.role === "system" || message.role === "tool",
  ).length;
  const latestAssistantSuggestions = useMemo(() => {
    const assistantMessage = [...taskMessages]
      .reverse()
      .find(
        (message) => message.role === "assistant" && message.metadata?.actionSuggestions?.length,
      );
    return assistantMessage?.metadata?.actionSuggestions ?? [];
  }, [taskMessages]);
  const primaryThreadSuggestion = latestAssistantSuggestions[0] ?? null;
  const threadNextAction = pendingApprovals.length
    ? `Review ${pendingApprovals.length} pending approval${
        pendingApprovals.length === 1 ? "" : "s"
      } before ORAX continues.`
    : pendingSuggestionConfirmation
      ? `Confirm or cancel: ${pendingSuggestionConfirmation.title}`
      : primaryThreadSuggestion
        ? primaryThreadSuggestion.title
        : (currentCheckpoint?.nextStep ?? "Ask ORAX what to inspect or approve next.");
  const threadLifecycleItems = useMemo<OraxThreadLifecycleItem[]>(() => {
    const approvalItems: OraxThreadLifecycleItem[] = approvals.map((approval) => ({
      id: `approval-${approval.id}`,
      source: "approval",
      label: approval.status === "pending" ? "Approval requested" : "Approval decision",
      title: formatOraxApprovalAction(approval.action),
      status: approval.status,
      description: describeOraxApprovalLifecycle(approval),
      createdAt: approval.decidedAt ?? approval.completedAt ?? approval.createdAt,
      approval,
    }));
    const artifactItems: OraxThreadLifecycleItem[] = artifacts.map((artifact) => ({
      id: `artifact-${artifact.id}`,
      source: "artifact",
      label: formatOraxArtifactLifecycleLabel(artifact.type),
      title: artifact.title,
      status: artifact.status,
      description: describeOraxArtifactLifecycle(artifact),
      createdAt: artifact.updatedAt ?? artifact.createdAt,
      artifact,
    }));

    return [...approvalItems, ...artifactItems]
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 10);
  }, [approvals, artifacts]);
  const commandFailureCount =
    latestCommandResult?.payload.commands?.filter((command) => command.status === "failed")
      .length ?? 0;
  const commandPassedCount =
    latestCommandResult?.payload.commands?.filter((command) => command.status === "passed")
      .length ?? 0;
  const readyForPrApproval =
    latestCommandResult?.status === "completed" && latestCommandResult.payload.passed === true;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [capRes, repoRes, taskRes] = await Promise.all([
        authFetch("/api/orax/capabilities"),
        authFetch("/api/orax/repositories"),
        authFetch("/api/orax/tasks"),
      ]);
      if (!capRes.ok || !repoRes.ok || !taskRes.ok) {
        throw new Error("Could not load ORAX workspace");
      }
      const capData = (await capRes.json()) as OraxCapabilities;
      const repoData = (await repoRes.json()) as { repositories: OraxRepository[] };
      const taskData = (await taskRes.json()) as { tasks: OraxTask[] };
      setCapabilities(capData);
      setRepositories(repoData.repositories);
      setTasks(taskData.tasks);
      setSelectedRepoId((current) => current ?? repoData.repositories[0]?.id ?? null);
      setSelectedTaskId((current) => current ?? taskData.tasks[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load ORAX");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadScans = useCallback(async (repositoryId: number) => {
    setLoadingScans(true);
    try {
      const res = await authFetch(`/api/orax/repositories/${repositoryId}/scans`);
      if (!res.ok) {
        throw new Error("Could not load repository scans");
      }
      const body = (await res.json()) as { scans: OraxScan[] };
      setScans(body.scans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load repository scans");
      setScans([]);
    } finally {
      setLoadingScans(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedRepository) {
      setScans([]);
      return;
    }
    void loadScans(selectedRepository.id);
  }, [loadScans, selectedRepository]);

  const loadApprovals = useCallback(async (taskId: number) => {
    setLoadingApprovals(true);
    try {
      const res = await authFetch(`/api/orax/tasks/${taskId}/approvals`);
      if (!res.ok) {
        throw new Error("Could not load approvals");
      }
      const body = (await res.json()) as { approvals: OraxApproval[] };
      if (activeTaskIdRef.current !== taskId) return;
      setApprovals(body.approvals);
    } catch (err) {
      if (activeTaskIdRef.current !== taskId) return;
      setError(err instanceof Error ? err.message : "Could not load approvals");
      setApprovals([]);
    } finally {
      if (activeTaskIdRef.current === taskId) {
        setLoadingApprovals(false);
      }
    }
  }, []);

  const loadArtifacts = useCallback(async (taskId: number) => {
    setLoadingArtifacts(true);
    try {
      const res = await authFetch(`/api/orax/tasks/${taskId}/artifacts`);
      if (!res.ok) {
        throw new Error("Could not load draft artifacts");
      }
      const body = (await res.json()) as { artifacts: OraxArtifact[] };
      if (activeTaskIdRef.current !== taskId) return;
      setArtifacts(body.artifacts);
    } catch (err) {
      if (activeTaskIdRef.current !== taskId) return;
      setError(err instanceof Error ? err.message : "Could not load draft artifacts");
      setArtifacts([]);
    } finally {
      if (activeTaskIdRef.current === taskId) {
        setLoadingArtifacts(false);
      }
    }
  }, []);

  const loadTaskMessages = useCallback(async (taskId: number) => {
    setLoadingTaskMessages(true);
    try {
      const res = await authFetch(`/api/orax/tasks/${taskId}/messages`);
      if (!res.ok) {
        throw new Error("Could not load task conversation");
      }
      const body = (await res.json()) as { messages: OraxTaskMessage[] };
      if (activeTaskIdRef.current !== taskId) return;
      setTaskMessages(body.messages);
    } catch (err) {
      if (activeTaskIdRef.current !== taskId) return;
      setError(err instanceof Error ? err.message : "Could not load task conversation");
      setTaskMessages([]);
    } finally {
      if (activeTaskIdRef.current === taskId) {
        setLoadingTaskMessages(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!selectedTask) {
      activeTaskIdRef.current = null;
      setApprovals([]);
      setArtifacts([]);
      setTaskMessages([]);
      setReadResult(null);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
      setLoadingApprovals(false);
      setLoadingArtifacts(false);
      setLoadingTaskMessages(false);
      return;
    }
    const switchedTasks = activeTaskIdRef.current !== selectedTask.id;
    activeTaskIdRef.current = selectedTask.id;

    if (switchedTasks) {
      setApprovals([]);
      setArtifacts([]);
      setTaskMessages([]);
      setReadResult(null);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
    }

    void loadApprovals(selectedTask.id);
    void loadArtifacts(selectedTask.id);
    void loadTaskMessages(selectedTask.id);
  }, [loadApprovals, loadArtifacts, loadTaskMessages, selectedTask]);

  async function addRepository() {
    if (!repositoryUrl.trim() || submittingRepo) return;
    setSubmittingRepo(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/repositories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repositoryUrl, defaultBranch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not save repository");
      }
      const body = (await res.json()) as { repository: OraxRepository };
      setRepositories((prev) => [body.repository, ...prev]);
      setSelectedRepoId(body.repository.id);
      setRepositoryUrl("");
      setDefaultBranch("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function connectGithub() {
    if (!selectedRepository || !githubToken.trim() || connectingGithub) return;
    setConnectingGithub(true);
    setError(null);
    try {
      const res = await authFetch(
        `/api/orax/repositories/${selectedRepository.id}/github/connect`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: githubToken }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not connect GitHub repository");
      }
      const body = (await res.json()) as { repository: OraxRepository };
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === body.repository.id ? body.repository : repo)),
      );
      setGithubToken("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not connect GitHub repository");
    } finally {
      setConnectingGithub(false);
    }
  }

  async function scanRepository() {
    if (!selectedRepository || scanningRepository) return;
    setScanningRepository(true);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/repositories/${selectedRepository.id}/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ branch: selectedRepository.defaultBranch }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not scan repository");
      }
      const body = (await res.json()) as { repository: OraxRepository; scan: OraxScan };
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === body.repository.id ? body.repository : repo)),
      );
      setScans((prev) => [body.scan, ...prev.filter((scan) => scan.id !== body.scan.id)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not scan repository");
      if (selectedRepository) {
        void loadScans(selectedRepository.id);
      }
    } finally {
      setScanningRepository(false);
    }
  }

  async function appendTaskMessage(taskId: number, content: string): Promise<OraxTaskMessage[]> {
    const res = await authFetch(`/api/orax/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not save task message");
    }
    const body = (await res.json()) as { messages: OraxTaskMessage[] };
    return body.messages;
  }

  async function createTask(options: { startThread?: boolean } = {}) {
    const firstMessage = prompt.trim();
    if (!selectedRepository || !firstMessage || submittingTask) return;
    setSubmittingTask(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId: selectedRepository.id,
          kind: taskKind,
          prompt: firstMessage,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not create ORAX task");
      }
      const body = (await res.json()) as { task: OraxTask };
      const targetTaskId = body.task.id;
      setTasks((prev) => [body.task, ...prev]);
      activeTaskIdRef.current = targetTaskId;
      setSelectedTaskId(targetTaskId);
      setApprovals([]);
      setArtifacts([]);
      setTaskMessages([]);
      setReadResult(null);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
      setPrompt("");
      if (options.startThread) {
        try {
          const messages = await appendTaskMessage(targetTaskId, firstMessage);
          if (activeTaskIdRef.current !== targetTaskId) return;
          setTaskMessages(messages);
        } catch (messageErr) {
          if (activeTaskIdRef.current !== targetTaskId) return;
          setTaskMessageDraft(firstMessage);
          setError(
            messageErr instanceof Error
              ? `Task created, but first message failed to save. Retry message: ${messageErr.message}`
              : "Task created, but first message failed to save. Retry message.",
          );
          return;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create ORAX task");
    } finally {
      setSubmittingTask(false);
    }
  }

  async function sendTaskMessage() {
    if (!selectedTask || !taskMessageDraft.trim() || sendingTaskMessage) return;
    const targetTaskId = selectedTask.id;
    const content = taskMessageDraft.trim();
    setSendingTaskMessage(true);
    setError(null);
    try {
      const messages = await appendTaskMessage(targetTaskId, content);
      if (activeTaskIdRef.current !== targetTaskId) return;
      setTaskMessages((prev) => [...prev, ...messages]);
      setTaskMessageDraft("");
    } catch (err) {
      if (activeTaskIdRef.current !== targetTaskId) return;
      setError(err instanceof Error ? err.message : "Could not save task message");
    } finally {
      setSendingTaskMessage(false);
    }
  }

  function applyTaskActionSuggestion(suggestion: OraxTaskActionSuggestion) {
    setPendingSuggestionConfirmation(null);
    setSuggestionPrConfirmationText("");

    if (suggestion.type === "read_files") {
      if (suggestion.paths?.length) {
        setApprovalPaths(suggestion.paths.join("\n"));
      }
      if (suggestion.reason) {
        setApprovalReason(suggestion.reason);
      }
      if (suggestion.paths?.length) {
        setPendingSuggestionConfirmation(suggestion);
      }
      return;
    }

    if (suggestion.type === "draft_patch") {
      setDraftInstructions(suggestion.instructions ?? "");
      return;
    }

    if (suggestion.type === "controlled_checks" && suggestion.commands?.length) {
      const allowed = suggestion.commands.filter((command) =>
        ORAX_COMMAND_OPTIONS.some((option) => option.id === command),
      );
      if (allowed.length) {
        setSelectedCommandIds(allowed);
      }
      setPendingSuggestionConfirmation(suggestion);
      return;
    }

    if (suggestion.type === "sandbox_run" || suggestion.type === "github_pr") {
      setPendingSuggestionConfirmation(suggestion);
    }
  }

  async function requestFileReadApproval(): Promise<boolean> {
    if (!selectedTask || requestingApproval) return false;
    const paths = approvalPaths
      .split(/[\n,]/)
      .map((path) => path.trim())
      .filter(Boolean);
    if (!paths.length) {
      setError("Add at least one repository-relative file path");
      return false;
    }
    setRequestingApproval(true);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "read_files",
          paths,
          reason: approvalReason,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not request approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) => [body.approval, ...prev]);
      setApprovalPaths("");
      setApprovalReason("");
      void load();
      void loadTaskMessages(selectedTask.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request approval");
      return false;
    } finally {
      setRequestingApproval(false);
    }
  }

  async function decideApproval(approvalId: number, decision: "approved" | "denied") {
    if (decidingApprovalId) return;
    setDecidingApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not update approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      void load();
      void loadTaskMessages(body.approval.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update approval");
    } finally {
      setDecidingApprovalId(null);
    }
  }

  async function readApprovedFiles(approvalId: number) {
    if (readingApprovalId) return;
    setReadingApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}/read-files`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not read approved files");
      }
      const body = (await res.json()) as OraxReadResult & { approval: OraxApproval };
      setReadResult({ branch: body.branch, files: body.files, skipped: body.skipped });
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      void load();
      void loadTaskMessages(body.approval.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read approved files");
    } finally {
      setReadingApprovalId(null);
    }
  }

  async function generateDraftPatch(approvalId: number) {
    if (!selectedTask || generatingArtifactApprovalId) return;
    setGeneratingArtifactApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/draft-patch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalId,
          instructions: draftInstructions,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not generate draft patch");
      }
      const body = (await res.json()) as { artifact: OraxArtifact };
      setArtifacts((prev) => [
        body.artifact,
        ...prev.filter((artifact) => artifact.id !== body.artifact.id),
      ]);
      void load();
      void loadTaskMessages(selectedTask.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not generate draft patch");
    } finally {
      setGeneratingArtifactApprovalId(null);
    }
  }

  async function requestSandboxApproval(artifactId: number): Promise<boolean> {
    if (!selectedTask || requestingSandboxApprovalArtifactId) return false;
    setRequestingSandboxApprovalArtifactId(artifactId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/sandbox-approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          reason: "Validate the draft patch in an isolated sandbox before any GitHub action.",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not request sandbox approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) => [body.approval, ...prev]);
      void load();
      void loadTaskMessages(selectedTask.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request sandbox approval");
      return false;
    } finally {
      setRequestingSandboxApprovalArtifactId(null);
    }
  }

  async function requestCommandApproval(artifactId: number): Promise<boolean> {
    if (!selectedTask || requestingCommandApprovalArtifactId) return false;
    if (!selectedCommandIds.length) {
      setError("Select at least one ORAX check to request approval.");
      return false;
    }
    setRequestingCommandApprovalArtifactId(artifactId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/command-approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          commands: selectedCommandIds,
          reason:
            "Run approval-gated ORAX checks in a temporary workspace before any GitHub pull request approval.",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not request controlled-check approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) => [body.approval, ...prev]);
      void load();
      void loadTaskMessages(selectedTask.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request controlled-check approval");
      return false;
    } finally {
      setRequestingCommandApprovalArtifactId(null);
    }
  }

  function toggleCommandId(commandId: string) {
    setSelectedCommandIds((current) => {
      if (current.includes(commandId)) {
        return current.filter((id) => id !== commandId);
      }
      return [...current, commandId];
    });
  }

  async function runSandboxValidation(approvalId: number) {
    if (runningSandboxApprovalId) return;
    setRunningSandboxApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}/run-sandbox`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not run sandbox validation");
      }
      const body = (await res.json()) as { approval: OraxApproval; artifact: OraxArtifact };
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      setArtifacts((prev) => [
        body.artifact,
        ...prev.filter((artifact) => artifact.id !== body.artifact.id),
      ]);
      void load();
      void loadTaskMessages(body.approval.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run sandbox validation");
    } finally {
      setRunningSandboxApprovalId(null);
    }
  }

  async function runControlledChecks(approvalId: number) {
    if (runningCommandApprovalId) return;
    setRunningCommandApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}/run-commands`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not run controlled checks");
      }
      const body = (await res.json()) as { approval: OraxApproval; artifact: OraxArtifact };
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      setArtifacts((prev) => [
        body.artifact,
        ...prev.filter((artifact) => artifact.id !== body.artifact.id),
      ]);
      void load();
      void loadTaskMessages(body.approval.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run controlled checks");
    } finally {
      setRunningCommandApprovalId(null);
    }
  }

  async function requestGithubPrApproval(
    artifactId: number,
    confirmationText = prConfirmationText,
  ): Promise<boolean> {
    if (!selectedTask || requestingPrApprovalArtifactId) return false;
    if (confirmationText.trim() !== "CREATE PR") {
      setError('Type "CREATE PR" before requesting GitHub PR approval.');
      return false;
    }
    setRequestingPrApprovalArtifactId(artifactId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${selectedTask.id}/github-pr-approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          artifactId,
          title: `ORAX: ${selectedTask.title}`,
          confirmationText: "CREATE PR",
          reason: "Create a GitHub branch and pull request from the sandbox-passed patch.",
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not request GitHub PR approval");
      }
      const body = (await res.json()) as { approval: OraxApproval };
      setApprovals((prev) => [body.approval, ...prev]);
      setPrConfirmationText("");
      void load();
      void loadTaskMessages(selectedTask.id);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request GitHub PR approval");
      return false;
    } finally {
      setRequestingPrApprovalArtifactId(null);
    }
  }

  async function confirmTaskActionSuggestion() {
    const suggestion = pendingSuggestionConfirmation;
    if (!suggestion) return;

    let created = false;
    if (suggestion.type === "read_files") {
      created = await requestFileReadApproval();
    } else if (suggestion.type === "sandbox_run" && suggestion.artifactId) {
      created = await requestSandboxApproval(suggestion.artifactId);
    } else if (suggestion.type === "controlled_checks" && suggestion.artifactId) {
      created = await requestCommandApproval(suggestion.artifactId);
    } else if (suggestion.type === "github_pr" && suggestion.artifactId) {
      if (suggestionPrConfirmationText.trim() !== "CREATE PR") {
        setError("Type CREATE PR to enable approval");
        return;
      }
      created = await requestGithubPrApproval(suggestion.artifactId, suggestionPrConfirmationText);
    }

    if (created) {
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
    }
  }

  async function createGithubPr(approvalId: number) {
    if (creatingPrApprovalId) return;
    setCreatingPrApprovalId(approvalId);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/approvals/${approvalId}/create-github-pr`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not create GitHub pull request");
      }
      const body = (await res.json()) as { approval: OraxApproval; artifact: OraxArtifact };
      setApprovals((prev) =>
        prev.map((approval) => (approval.id === body.approval.id ? body.approval : approval)),
      );
      setArtifacts((prev) => [
        body.artifact,
        ...prev.filter((artifact) => artifact.id !== body.artifact.id),
      ]);
      void load();
      void loadTaskMessages(body.approval.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create GitHub pull request");
    } finally {
      setCreatingPrApprovalId(null);
    }
  }

  const selectedTaskRepository = selectedTask
    ? repositories.find((repo) => repo.id === selectedTask.repositoryId) ?? selectedRepository
    : selectedRepository;

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground lg:h-[100dvh] lg:min-h-0 lg:overflow-hidden">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/mode-select"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Back to mode select"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
            <Code2 className="h-4 w-4 text-foreground" />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">ORAX</h1>
            <p className="truncate text-xs text-muted-foreground">
              Codex workspace for repository tasks
            </p>
          </div>
        </div>
        <ThemeToggle />
      </header>

      <main className="grid flex-1 grid-cols-1 lg:min-h-0 lg:overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)_360px]">
        <aside className="order-2 flex flex-col border-y border-border bg-muted/20 lg:order-none lg:min-h-0 lg:border-y-0 lg:border-r">
          <div className="border-b border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold uppercase text-muted-foreground">Tasks</div>
                <div className="text-sm font-semibold">Task history</div>
              </div>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Ask ORAX to inspect, plan, review, or fix code..."
              className="mt-3 min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-2 flex flex-wrap gap-1.5">
              {TASK_KINDS.map((kind) => (
                <button
                  key={kind.value}
                  type="button"
                  onClick={() => setTaskKind(kind.value)}
                  className={cn(
                    "rounded-md border px-2 py-1 text-[11px] font-medium",
                    taskKind === kind.value
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {kind.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => void createTask({ startThread: true })}
              disabled={!selectedRepository || !prompt.trim() || submittingTask}
              className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submittingTask ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Play className="h-4 w-4" />
              )}
              Start ORAX chat
            </button>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              The first message becomes the task prompt, stored separately from Ora chat and
              normal Ora history or AI Builder. Orax is not Ora and not AI Builder.
            </p>
          </div>

          <div className="p-2 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            {tasks.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                No tasks yet. Start a chat to create a Codex-style ORAX thread.
              </div>
            ) : (
              <div className="space-y-1.5">
                {tasks.map((task) => {
                  const repo = repositories.find((item) => item.id === task.repositoryId);
                  const active = task.id === selectedTask?.id;
                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => {
                        setSelectedTaskId(task.id);
                        setSelectedRepoId(task.repositoryId);
                      }}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left transition-colors",
                        active
                          ? "border-primary bg-background shadow-sm"
                          : "border-transparent hover:border-border hover:bg-background",
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">
                            {task.title || task.prompt || `Task #${task.id}`}
                          </div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {repo ? `${repo.owner}/${repo.name}` : "repository"} - {task.status}
                          </div>
                        </div>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {task.kind}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-border p-3">
            <div className="text-xs font-semibold uppercase text-muted-foreground">Repository</div>
            <div className="mt-2 space-y-2">
              <input
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="flex gap-2">
                <input
                  value={defaultBranch}
                  onChange={(event) => setDefaultBranch(event.target.value)}
                  placeholder="main"
                  className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => void addRepository()}
                  disabled={submittingRepo || !repositoryUrl.trim()}
                  className="inline-flex h-9 items-center justify-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
                >
                  {submittingRepo ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <GitBranch className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </aside>

        <section className="order-1 flex min-h-[calc(100dvh-3.5rem)] flex-col bg-background lg:order-none lg:min-h-0">
          {error ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                ORAX task thread
              </div>
              <h2 className="truncate text-base font-semibold">
                {selectedTask?.title || selectedTask?.prompt || "Start an ORAX task"}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {selectedTaskRepository
                  ? `${selectedTaskRepository.owner}/${selectedTaskRepository.name}`
                  : "Connect a repository to begin"}
                {selectedTask ? ` - task #${selectedTask.id} - ${selectedTask.status}` : ""}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="rounded-full border border-border px-2 py-1">
                Thread status: {selectedTask?.status ?? "idle"}
              </span>
              <span className="rounded-full border border-border px-2 py-1">
                {taskMessages.length} messages
              </span>
              <span className="rounded-full border border-border px-2 py-1">
                Pending approval: {pendingApprovals.length}
              </span>
              <span className="rounded-full border border-border px-2 py-1">
                {artifacts.length} artifacts
              </span>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {!selectedTask ? (
              <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-md border border-border bg-muted">
                  <Bot className="h-5 w-5 text-muted-foreground" />
                </div>
                <h3 className="mt-4 text-lg font-semibold">Create a Codex-style ORAX thread</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  Pick a repository, describe the work, and ORAX will keep the task conversation,
                  approvals, artifacts, and pull request flow in one isolated workspace.
                </p>
              </div>
            ) : taskMessages.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
                No messages yet. Ask ORAX to inspect files, explain pending approvals, or continue
                from the current checkpoint.
              </div>
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-3">
                {taskMessages.map((message) => {
                  const isUser = message.role === "user";
                  const isTimeline = message.role === "system" || message.role === "tool";
                  const suggestions =
                    message.role === "assistant" ? (message.metadata?.actionSuggestions ?? []) : [];
                  return (
                    <article
                      key={message.id}
                      className={cn(
                        "rounded-md border px-4 py-3 text-sm",
                        isUser
                          ? "ml-auto max-w-[78%] border-border bg-muted/60 text-foreground"
                          : isTimeline
                            ? "border-dashed border-border bg-muted/40 text-muted-foreground"
                            : "border-border bg-card",
                      )}
                    >
                      <div
                        className={cn(
                          "mb-1 text-[11px] font-semibold uppercase",
                          "text-muted-foreground",
                        )}
                      >
                        {isUser
                          ? "You"
                          : message.role === "tool"
                            ? "Tool result"
                            : isTimeline
                              ? "Timeline"
                              : "ORAX"}
                        {message.createdAt
                          ? ` - ${new Date(message.createdAt).toLocaleString()}`
                          : ""}
                      </div>
                      <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
                      {message.approvalId || message.artifactId ? (
                        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
                          {message.approvalId ? (
                            <span className="rounded-full border border-border px-2 py-0.5">
                              Approval #{message.approvalId}
                            </span>
                          ) : null}
                          {message.artifactId ? (
                            <span className="rounded-full border border-border px-2 py-0.5">
                              Artifact #{message.artifactId}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      {suggestions.length ? (
                        <div className="mt-3 grid gap-2">
                          {suggestions.map((suggestion, index) => (
                            <button
                              key={`${suggestion.type}-${suggestion.artifactId ?? suggestion.approvalId ?? index}`}
                              type="button"
                              onClick={() => applyTaskActionSuggestion(suggestion)}
                              className="rounded-md border border-border bg-background px-3 py-2 text-left hover:bg-muted"
                            >
                              <div className="text-xs font-semibold text-foreground">
                                {suggestion.title}
                              </div>
                              <div className="mt-1 text-xs text-muted-foreground">
                                {suggestion.description}
                              </div>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-border bg-background p-3">
            <div className="mx-auto mb-2 flex max-w-4xl flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                Task conversation
              </span>
              <button
                type="button"
                onClick={() =>
                  setTaskMessageDraft("Where are we right now, and what is the next approved step?")
                }
                className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
              >
                Resume task
              </button>
              <button
                type="button"
                onClick={() =>
                  setTaskMessageDraft(
                    "Explain approval: what is pending, what is the risk, and what happens if I approve it?",
                  )
                }
                className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
              >
                Explain approval
              </button>
              <button
                type="button"
                onClick={() =>
                  setTaskMessageDraft(
                    "Summarize result: what changed, what checks ran, and what remains?",
                  )
                }
                className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
              >
                Summarize result
              </button>
            </div>
            <div className="mx-auto flex max-w-4xl gap-2">
              <textarea
                value={taskMessageDraft}
                onChange={(event) => setTaskMessageDraft(event.target.value)}
                placeholder={
                  selectedTask
                    ? "Message ORAX about this task..."
                    : "Create a task from the left panel first..."
                }
                className="min-h-12 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => void sendTaskMessage()}
                disabled={!selectedTask || !taskMessageDraft.trim() || sendingTaskMessage}
                className="inline-flex h-12 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sendingTaskMessage ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
                Send
              </button>
            </div>
          </div>
        </section>

        <aside className="order-3 flex flex-col border-t border-border bg-muted/20 lg:order-none lg:min-h-0 lg:border-l lg:border-t-0">
          <div className="p-3 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
            <section className="rounded-md border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold uppercase text-muted-foreground">
                    Current checkpoint
                  </div>
                  <div className="text-sm font-semibold">Current state</div>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    setTaskMessageDraft(
                      "Where are we right now, and what is the next approved step?",
                    )
                  }
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border px-2 text-xs hover:bg-muted"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Resume
                </button>
              </div>
              <div className="mt-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Next action in this thread: {threadNextAction}
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {currentCheckpoint?.nextStep ??
                  threadNextAction ??
                  "ORAX is isolated from Ora and only uses task-scoped repository context."}
              </p>
              <div className="mt-3 grid grid-cols-3 gap-2">
                <Metric label="Pending" value={String(pendingApprovals.length)} />
                <Metric label="Timeline" value={String(timelineMessageCount)} />
                <Metric
                  label="Checks"
                  value={`${commandPassedCount}/${commandPassedCount + commandFailureCount}`}
                />
              </div>
            </section>

            <section className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Approvals</div>
              <div className="mt-3 space-y-2">
                {approvals.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No approvals requested yet.</p>
                ) : (
                  approvals.slice(0, 5).map((approval) => (
                    <div key={approval.id} className="rounded-md border border-border bg-background p-2">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="text-sm font-medium">
                            {formatOraxApprovalAction(approval.action)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            #{approval.id} - {approval.status}
                          </div>
                        </div>
                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                          {approval.status}
                        </span>
                      </div>
                      {approval.status === "pending" ? (
                        <div className="mt-2 flex gap-2">
                          <button
                            onClick={() => void decideApproval(approval.id, "approved")}
                            disabled={decidingApprovalId === approval.id}
                            className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Approve
                          </button>
                          <button
                            onClick={() => void decideApproval(approval.id, "denied")}
                            disabled={decidingApprovalId === approval.id}
                            className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                          >
                            <X className="h-3.5 w-3.5" />
                            Deny
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Execution lifecycle
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Every lifecycle action still uses the existing explicit approval buttons.
              </p>
              <div className="mt-3 space-y-2">
                {threadLifecycleItems.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No lifecycle events yet.</p>
                ) : (
                  threadLifecycleItems.slice(0, 6).map((item) => (
                    <div key={item.id} className="rounded-md border border-border bg-background p-2">
                      <div className="text-[11px] font-semibold uppercase text-muted-foreground">
                        {item.label}
                      </div>
                      <div className="mt-1 text-sm font-medium">{item.title}</div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {item.description}
                      </p>
                    </div>
                  ))
                )}
              </div>
            </section>

            <section className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Workflow controls
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">
                Execution still requires explicit approval controls.
              </p>
              <textarea
                value={approvalPaths}
                onChange={(event) => setApprovalPaths(event.target.value)}
                placeholder="Files to read, one per line"
                className="mt-3 min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={approvalReason}
                onChange={(event) => setApprovalReason(event.target.value)}
                placeholder="Why ORAX needs these files"
                className="mt-2 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => void requestFileReadApproval()}
                disabled={!selectedTask || requestingApproval || !approvalPaths.trim()}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                {requestingApproval ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FileText className="h-4 w-4" />
                )}
                Create approval request
              </button>
              <textarea
                value={draftInstructions}
                onChange={(event) => setDraftInstructions(event.target.value)}
                placeholder="Draft patch instructions"
                className="mt-3 min-h-16 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() =>
                  latestDraftPatch
                    ? void requestSandboxApproval(latestDraftPatch.id)
                    : readResult
                      ? void generateDraftPatch(
                          approvals.find(
                            (approval) =>
                              approval.action === "read_files" &&
                              approval.status === "completed",
                          )?.id ?? 0,
                        )
                      : undefined
                }
                disabled={!selectedTask || (!latestDraftPatch && !readResult)}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
              >
                <ShieldCheck className="h-4 w-4" />
                {latestDraftPatch ? "Request sandbox approval" : "Generate draft patch"}
              </button>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {ORAX_COMMAND_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => toggleCommandId(option.id)}
                    className={cn(
                      "rounded-md border px-2 py-1 text-[11px]",
                      selectedCommandIds.includes(option.id)
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {option.id.replace("pnpm-", "")}
                  </button>
                ))}
              </div>
              <button
                onClick={() =>
                  latestSandboxResult ? void requestCommandApproval(latestSandboxResult.id) : undefined
                }
                disabled={!latestSandboxResult || selectedCommandIds.length === 0}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <Terminal className="h-4 w-4" />
                Request controlled checks
              </button>
              <input
                value={prConfirmationText}
                onChange={(event) => setPrConfirmationText(event.target.value)}
                placeholder="Type CREATE PR"
                className="mt-3 h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Type CREATE PR in Workflow controls to request PR approval.
              </p>
              <button
                onClick={() =>
                  latestCommandResult ? void requestGithubPrApproval(latestCommandResult.id) : undefined
                }
                disabled={!readyForPrApproval || prConfirmationText.trim() !== "CREATE PR"}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
              >
                <GitPullRequest className="h-4 w-4" />
                Request PR approval
              </button>
            </section>

            <section className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Latest execution result
              </div>
              {latestArtifact ? (
                <div className="mt-2 rounded-md border border-border bg-background p-2 text-sm">
                  <div className="font-medium">{latestArtifact.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {latestArtifact.type.replace(/_/g, " ")} - {latestArtifact.status}
                  </div>
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No execution result yet.</p>
              )}
            </section>

            <section className="mt-3 rounded-md border border-border bg-card p-3">
              <div className="text-xs font-semibold uppercase text-muted-foreground">Repository</div>
              {selectedRepository ? (
                <div className="mt-2 text-sm">
                  <div className="font-medium">
                    {selectedRepository.owner}/{selectedRepository.name}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {selectedRepository.defaultBranch} - {selectedRepository.connectionStatus}
                  </div>
                  <button
                    onClick={() => void scanRepository()}
                    disabled={scanningRepository}
                    className="mt-2 inline-flex h-8 w-full items-center justify-center gap-2 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                  >
                    {scanningRepository ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3.5 w-3.5" />
                    )}
                    Scan repository
                  </button>
                  {latestScan ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      Last scan: {latestScan.status} - {latestScan.fileCount} files
                    </div>
                  ) : null}
                </div>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">No repository connected.</p>
              )}
            </section>
          </div>
        </aside>
      </main>
    </div>
  );

}

function formatOraxApprovalAction(action: string): string {
  switch (action) {
    case "read_files":
      return "File-read approval";
    case "sandbox_run":
      return "Sandbox approval";
    case "safe_check":
      return "Controlled-check approval";
    case "github_pr":
      return "GitHub PR approval";
    default:
      return action.replace(/_/g, " ");
  }
}

function formatOraxArtifactLifecycleLabel(type: string): string {
  switch (type) {
    case "draft_patch":
      return "Draft patch generated";
    case "sandbox_result":
      return "Sandbox result";
    case "command_result":
      return "Controlled checks result";
    case "github_pr_result":
      return "Pull request result";
    default:
      return "Workflow result";
  }
}

function describeOraxApprovalLifecycle(approval: OraxApproval): string {
  if (approval.action === "read_files") {
    const files = approval.request.paths?.length
      ? approval.request.paths.join(", ")
      : "selected files";
    if (approval.status === "completed" && approval.result?.files?.length) {
      return `Files read: ${approval.result.files.length}; total ${formatBytes(
        approval.result.totalBytes ?? 0,
      )}.`;
    }
    return `Requested source access for ${files}.`;
  }
  if (approval.action === "sandbox_run") {
    return `Sandbox validation request for artifact #${approval.request.artifactId ?? "unknown"}.`;
  }
  if (approval.action === "safe_check") {
    return approval.request.scope ?? "Controlled workspace checks require explicit approval.";
  }
  if (approval.action === "github_pr") {
    if (approval.result?.pullRequestUrl) {
      return `Pull request created: ${approval.result.pullRequestUrl}`;
    }
    return "GitHub PR creation requires completed checks and explicit CREATE PR confirmation.";
  }
  return approval.riskSummary ?? "Approval-gated ORAX workflow step.";
}

function describeOraxArtifactLifecycle(artifact: OraxArtifact): string {
  if (artifact.type === "draft_patch") {
    return artifact.summary ?? "Review-only patch preview generated from approved source files.";
  }
  if (artifact.type === "sandbox_result") {
    const changedFiles = artifact.payload.changedFiles?.length ?? 0;
    return artifact.payload.applied
      ? `Sandbox applied the patch preview to ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`
      : "Sandbox could not apply the patch preview. Review the blocker before continuing.";
  }
  if (artifact.type === "command_result") {
    const passed =
      artifact.payload.commands?.filter((command) => command.status === "passed").length ?? 0;
    const failed =
      artifact.payload.commands?.filter((command) => command.status === "failed").length ?? 0;
    return `Controlled checks completed: ${passed} passed, ${failed} failed.`;
  }
  if (artifact.type === "github_pr_result") {
    if (artifact.payload.pullRequestUrl) {
      return `Pull request created on ${artifact.payload.branchName ?? "the ORAX branch"}.`;
    }
    return artifact.payload.error?.message ?? "GitHub PR result recorded.";
  }
  return artifact.summary ?? "ORAX workflow artifact recorded.";
}

function OraxThreadLifecycleDetails({ item }: { item: OraxThreadLifecycleItem }) {
  if (item.source === "approval") {
    const { approval } = item;
    if (approval.action !== "read_files" || !approval.result) return null;
    const files = approval.result.files ?? [];
    const skipped = approval.result.skipped ?? [];
    if (!files.length && !skipped.length && !approval.result.totalBytes) return null;

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">File-read details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Files read" value={String(files.length)} />
          <Metric label="Skipped" value={String(skipped.length)} />
          <Metric label="Total bytes" value={formatBytes(approval.result.totalBytes ?? 0)} />
        </div>
        {files.length ? (
          <div className="mt-2">
            Read: {files.map((file) => `${file.path} (${formatBytes(file.size)})`).join(", ")}
          </div>
        ) : null}
        {skipped.length ? (
          <div className="mt-1">
            Skipped: {skipped.map((item) => `${item.path} (${item.reason})`).join(", ")}
          </div>
        ) : null}
      </div>
    );
  }

  const { artifact } = item;
  if (artifact.type === "draft_patch") {
    const diffSummary = summarizeUnifiedDiff(artifact.payload.unifiedDiff);
    const changedFiles = extractUnifiedDiffFileNames(artifact.payload.unifiedDiff);
    const risks = artifact.payload.risks ?? [];
    const tests = artifact.payload.tests ?? [];
    const filesRead = artifact.payload.filesRead ?? [];

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">Draft patch details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Files used" value={String(filesRead.length)} />
          <Metric label="Changed files" value={String(changedFiles.length)} />
          <Metric
            label="Diff"
            value={diffSummary ? `+${diffSummary.additions} / -${diffSummary.deletions}` : "none"}
          />
        </div>
        {changedFiles.length ? (
          <div className="mt-2">Changes: {changedFiles.join(", ")}</div>
        ) : null}
        {risks.length ? <div className="mt-1">Risks: {risks.join("; ")}</div> : null}
        {tests.length ? <div className="mt-1">Suggested tests: {tests.join("; ")}</div> : null}
      </div>
    );
  }

  if (artifact.type === "sandbox_result") {
    const changedFiles = artifact.payload.changedFiles ?? [];
    const errors = artifact.payload.errors ?? [];

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">Sandbox details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Applied" value={artifact.payload.applied ? "yes" : "no"} />
          <Metric label="Changed files" value={String(changedFiles.length)} />
          <Metric label="Errors" value={String(errors.length)} />
        </div>
        {changedFiles.length ? (
          <div className="mt-2">
            Changed:{" "}
            {changedFiles
              .map((file) => `${file.path} (+${file.additions} / -${file.deletions})`)
              .join(", ")}
          </div>
        ) : null}
        {errors.length ? (
          <div className="mt-1 text-destructive">Errors: {errors.join(" ")}</div>
        ) : null}
      </div>
    );
  }

  if (artifact.type === "command_result") {
    const commands = artifact.payload.commands ?? [];
    const passed = commands.filter((command) => command.status === "passed");
    const failed = commands.filter((command) => command.status === "failed");

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">Checks details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Passed" value={String(passed.length)} />
          <Metric label="Failed" value={String(failed.length)} />
          <Metric label="Total" value={String(commands.length)} />
        </div>
        {failed.length ? (
          <div className="mt-2 text-destructive">
            Failed:{" "}
            {failed
              .map((command) => `${command.label || command.id}: ${command.message}`)
              .join("; ")}
          </div>
        ) : null}
      </div>
    );
  }

  if (artifact.type === "github_pr_result") {
    const filesChanged = artifact.payload.filesChanged ?? [];

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">Pull request details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Branch" value={artifact.payload.branchName ?? "unknown"} />
          <Metric
            label="PR"
            value={
              artifact.payload.pullRequestNumber ? `#${artifact.payload.pullRequestNumber}` : "none"
            }
          />
          <Metric label="Files changed" value={String(filesChanged.length)} />
        </div>
        {filesChanged.length ? <div className="mt-2">Files: {filesChanged.join(", ")}</div> : null}
        {artifact.payload.pullRequestUrl ? (
          <a
            href={artifact.payload.pullRequestUrl}
            target="_blank"
            rel="noreferrer"
            className="mt-2 inline-flex text-xs font-medium text-primary hover:underline"
          >
            Open pull request
          </a>
        ) : null}
        {artifact.payload.error ? <FailureNotice failure={artifact.payload.error} /> : null}
      </div>
    );
  }

  return null;
}

function extractUnifiedDiffFileNames(diff?: string): string[] {
  if (!diff?.trim()) return [];
  const paths = diff
    .split("\n")
    .filter((line) => line.startsWith("+++ b/"))
    .map((line) => line.replace("+++ b/", "").trim())
    .filter((path) => path && path !== "/dev/null");
  return Array.from(new Set(paths)).slice(0, 12);
}

function summarizeUnifiedDiff(diff?: string): { additions: number; deletions: number } | null {
  if (!diff?.trim()) return null;
  return diff.split("\n").reduce(
    (summary, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) summary.additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) summary.deletions += 1;
      return summary;
    },
    { additions: 0, deletions: 0 },
  );
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={cn(
        "rounded-md border border-border bg-muted/30 px-3 py-2",
        wide ? "sm:col-span-2" : "",
      )}
    >
      <div className="text-[11px] font-medium uppercase text-muted-foreground">{label}</div>
      <div className="mt-1 truncate text-sm font-semibold">{value}</div>
    </div>
  );
}

function FailureNotice({ failure }: { failure: OraxFailureInfo }) {
  return (
    <div className="mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <div className="font-medium">
        {failure.code ? `${failure.code}: ` : ""}
        {failure.message ?? "GitHub PR creation failed."}
      </div>
      {failure.hint ? <div className="mt-1 text-destructive/90">{failure.hint}</div> : null}
      {failure.rawMessage ? (
        <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap rounded bg-background/80 px-2 py-2 text-[11px] text-destructive">
          {failure.rawMessage}
        </pre>
      ) : null}
    </div>
  );
}

function ArtifactTrace({ artifact }: { artifact: OraxArtifact }) {
  const payload = artifact.payload;
  const items = [
    { label: "Read approval", id: payload.sourceApprovalId, kind: "approval" },
    { label: "Draft patch", id: payload.draftArtifactId, kind: "artifact" },
    { label: "Sandbox validation", id: payload.sourceArtifactId, kind: "artifact" },
    { label: "Workspace checks", id: payload.commandArtifactId ?? artifact.id, kind: "artifact" },
    ...(payload.auditTrail ?? []),
  ]
    .filter((item): item is { label: string; id: number; kind: string } =>
      Number.isInteger(item.id),
    )
    .filter(
      (item, index, all) =>
        all.findIndex((candidate) => candidate.kind === item.kind && candidate.id === item.id) ===
        index,
    );

  if (!items.length) return null;

  return (
    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
      <div className="text-[11px] font-medium uppercase text-muted-foreground">Audit trail</div>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <span
            key={`${item.kind}-${item.id}`}
            className="rounded-full border border-border bg-card px-2 py-1 text-xs text-muted-foreground"
          >
            {item.label} #{item.id}
          </span>
        ))}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}
