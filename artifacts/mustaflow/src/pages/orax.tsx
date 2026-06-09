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

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              href="/mode-select"
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Back to mode select"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Code2 className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold">ORAX</h1>
              <p className="text-xs text-muted-foreground">Coding agent foundation</p>
            </div>
          </div>
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl gap-4 px-4 py-4 lg:grid-cols-[360px_1fr]">
        <aside className="space-y-4">
          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Repositories</h2>
            </div>
            <div className="mt-4 space-y-2">
              <input
                value={repositoryUrl}
                onChange={(event) => setRepositoryUrl(event.target.value)}
                placeholder="https://github.com/owner/repo"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                value={defaultBranch}
                onChange={(event) => setDefaultBranch(event.target.value)}
                placeholder="main"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => void addRepository()}
                disabled={submittingRepo || !repositoryUrl.trim()}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submittingRepo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <GitBranch className="h-4 w-4" />
                )}
                Add repository
              </button>
            </div>

            <div className="mt-4 space-y-2">
              {repositories.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                  Add a repository URL to create the first ORAX workspace target.
                </p>
              ) : (
                repositories.map((repo) => (
                  <button
                    key={repo.id}
                    onClick={() => setSelectedRepoId(repo.id)}
                    className={cn(
                      "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors",
                      selectedRepository?.id === repo.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <div className="font-medium">
                      {repo.owner}/{repo.name}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {repo.provider} - {repo.defaultBranch} - {repo.connectionStatus}
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Read-only GitHub access</h2>
            </div>
            {selectedRepository ? (
              <div className="mt-4 space-y-3">
                <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {selectedRepository.githubAccountName ? (
                    <>
                      Connected as{" "}
                      <span className="font-medium text-foreground">
                        {selectedRepository.githubAccountName}
                      </span>
                      {selectedRepository.tokenScopes ? (
                        <span> with scopes: {selectedRepository.tokenScopes}</span>
                      ) : null}
                    </>
                  ) : (
                    "Public repositories can scan without a token. Private repositories need a read-only GitHub token."
                  )}
                </div>
                <input
                  value={githubToken}
                  onChange={(event) => setGithubToken(event.target.value)}
                  type="password"
                  autoComplete="off"
                  placeholder="GitHub token for read-only access"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => void connectGithub()}
                  disabled={connectingGithub || !githubToken.trim()}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {connectingGithub ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  Connect read-only token
                </button>
                <button
                  onClick={() => void scanRepository()}
                  disabled={scanningRepository}
                  className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {scanningRepository ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Scan repository
                </button>
                <div className="text-xs text-muted-foreground">
                  Last scan:{" "}
                  {selectedRepository.lastScanAt
                    ? new Date(selectedRepository.lastScanAt).toLocaleString()
                    : "Not scanned yet"}
                  {selectedRepository.scanStatus ? ` - ${selectedRepository.scanStatus}` : null}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">
                Add a repository before connecting GitHub access.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-primary" />
              <h2 className="text-sm font-semibold">Current capabilities</h2>
            </div>
            <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
              {(capabilities?.available ?? []).map((item) => (
                <li key={item} className="flex gap-2">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-green-500" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
            <div className="mt-4 rounded-md border border-yellow-500/20 bg-yellow-500/10 p-3">
              <div className="flex items-center gap-2 text-xs font-semibold text-yellow-700 dark:text-yellow-400">
                <LockKeyhole className="h-3.5 w-3.5" />
                Locked until approval layer
              </div>
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {(capabilities?.lockedUntilApprovalLayer ?? []).map((item) => (
                  <li key={item}>- {item}</li>
                ))}
              </ul>
            </div>
          </section>
        </aside>

        <section className="space-y-4">
          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <FileSearch className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Repository scan</h2>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Read-only repository metadata and file-tree summary. Source editing and terminal
                  execution remain locked.
                </p>
              </div>
              {loadingScans ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            {latestScan ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <Metric label="Status" value={latestScan.status} />
                  <Metric label="Branch" value={latestScan.branch} />
                  <Metric
                    label="Commit"
                    value={latestScan.commitSha ? latestScan.commitSha.slice(0, 10) : "Unknown"}
                  />
                  <Metric label="Size" value={formatBytes(latestScan.totalBytes)} />
                  <Metric label="Files" value={String(latestScan.fileCount)} />
                  <Metric label="Folders" value={String(latestScan.directoryCount)} />
                  <Metric
                    label="Scanned"
                    value={new Date(latestScan.createdAt).toLocaleString()}
                    wide
                  />
                </div>

                {latestScan.error ? (
                  <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {latestScan.error}
                  </div>
                ) : null}

                {latestScanLanguages.length ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                      Languages
                    </h3>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {latestScanLanguages.map(([language, count]) => (
                        <span
                          key={language}
                          className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
                        >
                          {language}: {count}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}

                {latestScan.summary?.sampleFiles?.length ? (
                  <div>
                    <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                      Sample files
                    </h3>
                    <div className="mt-2 grid gap-1 rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                      {latestScan.summary.sampleFiles.slice(0, 20).map((file) => (
                        <div key={file} className="truncate">
                          {file}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                No scans yet. Add a GitHub repository, then run a read-only scan.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">Start ORAX chat</h2>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                  Start by describing the coding work. ORAX will create a task from this message,
                  save it in the task thread, and continue with approval-gated next steps.
                </p>
              </div>
              <div className="flex rounded-md border border-border p-1">
                {TASK_KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    onClick={() => setTaskKind(kind.value)}
                    className={cn(
                      "rounded px-2.5 py-1 text-xs font-medium",
                      taskKind === kind.value
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Chat with ORAX. Example: review this repository and prepare a safe fix for the login bug..."
              className="mt-4 min-h-32 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Target:{" "}
                {selectedRepository ? (
                  <span className="font-medium text-foreground">
                    {selectedRepository.owner}/{selectedRepository.name}
                  </span>
                ) : (
                  "Add a repository first"
                )}
              </p>
              <button
                onClick={() => void createTask({ startThread: true })}
                disabled={!selectedRepository || !prompt.trim() || submittingTask}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submittingTask ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Start chat
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              The first message becomes the task prompt and the first message in the ORAX-only task
              conversation. It never enters normal Ora history or AI Builder.
            </p>
          </section>

          <section className="rounded-lg border border-border bg-card p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Bot className="h-4 w-4 text-primary" />
                  <h2 className="text-sm font-semibold">ORAX task thread</h2>
                </div>
                <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
                  Chat with ORAX inside one coding task. Checkpoints, timeline events, pending
                  approvals, and workflow results stay in this ORAX-only thread.
                </p>
              </div>
              {loadingApprovals ? (
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              ) : null}
            </div>

            {selectedTask ? (
              <div className="mt-4 space-y-4">
                <select
                  value={selectedTask.id}
                  onChange={(event) => setSelectedTaskId(Number(event.target.value))}
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                >
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>
                      #{task.id} - {task.title}
                    </option>
                  ))}
                </select>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Thread status</div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Live task context for this ORAX conversation. These counts are task-scoped
                        and never enter normal Ora history or AI Builder.
                      </p>
                    </div>
                    <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                      Task #{selectedTask.id}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-5">
                    <Metric label="Messages" value={String(taskMessages.length)} />
                    <Metric label="Timeline" value={String(timelineMessageCount)} />
                    <Metric label="Pending approvals" value={String(pendingApprovals.length)} />
                    <Metric label="Artifacts" value={String(artifacts.length)} />
                    <Metric label="Latest artifact" value={latestArtifact?.type ?? "none"} />
                  </div>
                </div>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-primary" />
                        <h3 className="text-sm font-semibold">Current checkpoint</h3>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        ORAX summarizes this task state inside the ORAX thread only. It is not Ora
                        memory and it is not AI Builder context.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {currentCheckpoint ? (
                        <span className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                          {new Date(currentCheckpoint.updatedAt).toLocaleString()}
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() =>
                          setTaskMessageDraft(
                            "Where are we right now, and what is the next approved step?",
                          )
                        }
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                        Resume
                      </button>
                    </div>
                  </div>

                  {currentCheckpoint ? (
                    <div className="mt-3 space-y-3">
                      <div>
                        <div className="text-xs font-semibold uppercase text-muted-foreground">
                          Goal
                        </div>
                        <p className="mt-1 text-sm text-foreground">{currentCheckpoint.goal}</p>
                      </div>
                      <div className="grid gap-2 text-xs sm:grid-cols-4">
                        <div className="rounded-md border border-border bg-background px-3 py-2">
                          <div className="text-muted-foreground">Status</div>
                          <div className="mt-1 font-medium text-foreground">
                            {currentCheckpoint.status}
                          </div>
                        </div>
                        <div className="rounded-md border border-border bg-background px-3 py-2">
                          <div className="text-muted-foreground">Approvals</div>
                          <div className="mt-1 font-medium text-foreground">
                            {currentCheckpoint.approvals.completed}/
                            {currentCheckpoint.approvals.total} complete
                          </div>
                        </div>
                        <div className="rounded-md border border-border bg-background px-3 py-2">
                          <div className="text-muted-foreground">Pending</div>
                          <div className="mt-1 font-medium text-foreground">
                            {currentCheckpoint.approvals.pending}
                          </div>
                        </div>
                        <div className="rounded-md border border-border bg-background px-3 py-2">
                          <div className="text-muted-foreground">Artifacts</div>
                          <div className="mt-1 font-medium text-foreground">
                            {currentCheckpoint.artifacts.total}
                          </div>
                        </div>
                      </div>
                      {currentCheckpoint.filesReviewed.length ? (
                        <div>
                          <div className="text-xs font-semibold uppercase text-muted-foreground">
                            Files reviewed
                          </div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {currentCheckpoint.filesReviewed.map((file) => (
                              <span
                                key={file}
                                className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground"
                              >
                                {file}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}
                      {currentCheckpoint.latestBlocker ? (
                        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {currentCheckpoint.latestBlocker}
                        </div>
                      ) : null}
                      <div className="rounded-md border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">
                        Next: {currentCheckpoint.nextStep}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No checkpoint yet. Create a task milestone, approval, or workflow result to
                      generate the first checkpoint.
                    </p>
                  )}
                </div>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Bot className="h-4 w-4 text-primary" />
                        <h3 className="text-sm font-semibold">Task conversation</h3>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Discuss this ORAX task. This thread is stored separately from Ora chat and
                        AI Builder.
                      </p>
                    </div>
                    {loadingTaskMessages ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>

                  <div className="mt-3 rounded-md border border-primary/25 bg-primary/10 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-xs font-semibold uppercase text-primary">
                          Next action in this thread
                        </div>
                        <p className="mt-1 text-sm font-medium text-foreground">
                          {threadNextAction}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          ORAX can discuss, prepare approval requests, and summarize results here.
                          Execution still requires explicit approval controls.
                        </p>
                      </div>
                      {primaryThreadSuggestion?.buttonLabel ? (
                        <button
                          type="button"
                          onClick={() => applyTaskActionSuggestion(primaryThreadSuggestion)}
                          className="inline-flex h-8 items-center rounded-md border border-primary/30 bg-background px-2 text-xs font-medium text-foreground hover:bg-muted"
                        >
                          {primaryThreadSuggestion.buttonLabel}
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setTaskMessageDraft(
                            "Where are we right now, and what is the next approved step?",
                          )
                        }
                        className="inline-flex h-8 items-center rounded-md border border-primary/30 bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Resume task
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setTaskMessageDraft("What should I approve next, and why is it safe?")
                        }
                        className="inline-flex h-8 items-center rounded-md border border-primary/30 bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Explain approval
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setTaskMessageDraft(
                            "Summarize the latest result, blocker, and safest next step.",
                          )
                        }
                        className="inline-flex h-8 items-center rounded-md border border-primary/30 bg-background px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        Summarize result
                      </button>
                    </div>
                  </div>

                  {pendingApprovals.length ? (
                    <div className="mt-3 space-y-2">
                      {pendingApprovals.map((approval) => (
                        <article
                          key={`thread-pending-${approval.id}`}
                          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="text-xs font-semibold uppercase">
                                Pending approval
                              </div>
                              <div className="mt-1 font-medium">
                                {approval.action} request #{approval.id}
                              </div>
                              <p className="mt-1 text-xs">
                                {approval.action === "read_files"
                                  ? (approval.request.paths ?? []).join(", ")
                                  : (approval.request.scope ??
                                    `Artifact #${approval.request.artifactId ?? "unknown"}`)}
                              </p>
                              {approval.riskSummary ? (
                                <p className="mt-1 text-xs">{approval.riskSummary}</p>
                              ) : null}
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                onClick={() => void decideApproval(approval.id, "approved")}
                                disabled={decidingApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-amber-300 bg-background px-2 text-xs font-medium text-foreground hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:hover:bg-amber-900/30"
                              >
                                <Check className="h-3.5 w-3.5" />
                                Approve
                              </button>
                              <button
                                onClick={() => void decideApproval(approval.id, "denied")}
                                disabled={decidingApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-amber-300 bg-background px-2 text-xs font-medium text-foreground hover:bg-amber-100 disabled:opacity-60 dark:border-amber-700 dark:hover:bg-amber-900/30"
                              >
                                <X className="h-3.5 w-3.5" />
                                Deny
                              </button>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-3 max-h-72 space-y-2 overflow-auto rounded-md border border-border bg-background p-3">
                    {taskMessages.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No messages yet. Ask ORAX how to approach this task, what is pending, or
                        what the next approved step should be.
                      </p>
                    ) : (
                      taskMessages.map((message) => {
                        const isAssistant = message.role === "assistant";
                        const isTimeline = message.role === "system" || message.role === "tool";
                        const timelineLabel =
                          message.metadata?.source === "orax-task-checkpoint"
                            ? "Checkpoint"
                            : message.role === "tool"
                              ? "Tool result"
                              : "Timeline";
                        const suggestions = isAssistant
                          ? (message.metadata?.actionSuggestions ?? [])
                          : [];
                        return (
                          <div
                            key={message.id}
                            className={cn(
                              "rounded-md px-3 py-2 text-sm",
                              isAssistant
                                ? "border border-border bg-muted/40"
                                : isTimeline
                                  ? "border border-dashed border-border bg-muted/30 text-muted-foreground"
                                  : "ml-auto max-w-[88%] bg-primary text-primary-foreground",
                            )}
                          >
                            <div
                              className={cn(
                                "mb-1 text-[11px] font-medium uppercase",
                                isAssistant || isTimeline
                                  ? "text-muted-foreground"
                                  : "text-primary-foreground/80",
                              )}
                            >
                              {isAssistant ? "ORAX" : isTimeline ? timelineLabel : "You"} -{" "}
                              {new Date(message.createdAt).toLocaleString()}
                            </div>
                            {isTimeline ? (
                              <div className="mb-2 flex flex-wrap gap-1.5">
                                {message.approvalId ? (
                                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                                    Approval #{message.approvalId}
                                  </span>
                                ) : null}
                                {message.artifactId ? (
                                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
                                    Artifact #{message.artifactId}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="whitespace-pre-wrap leading-relaxed">
                              {message.content}
                            </div>
                            {suggestions.length ? (
                              <div className="mt-3 space-y-2">
                                {suggestions.map((suggestion, index) => {
                                  const canApply = Boolean(suggestion.buttonLabel);
                                  return (
                                    <div
                                      key={`${suggestion.type}-${suggestion.artifactId ?? suggestion.approvalId ?? index}`}
                                      className="rounded-md border border-border bg-background px-3 py-2"
                                    >
                                      <div className="text-xs font-semibold text-foreground">
                                        {suggestion.title}
                                      </div>
                                      <p className="mt-1 text-xs text-muted-foreground">
                                        {suggestion.description}
                                      </p>
                                      {suggestion.paths?.length ? (
                                        <div className="mt-2 text-xs text-muted-foreground">
                                          Files: {suggestion.paths.join(", ")}
                                        </div>
                                      ) : null}
                                      {suggestion.commands?.length ? (
                                        <div className="mt-2 text-xs text-muted-foreground">
                                          Checks: {suggestion.commands.join(", ")}
                                        </div>
                                      ) : null}
                                      {suggestion.requiresManualConfirmation ? (
                                        <div className="mt-2 text-xs font-medium text-amber-600 dark:text-amber-300">
                                          Manual confirmation is required in the PR section.
                                        </div>
                                      ) : null}
                                      {canApply ? (
                                        <button
                                          type="button"
                                          onClick={() => applyTaskActionSuggestion(suggestion)}
                                          className="mt-2 inline-flex h-8 items-center rounded-md border border-border px-2 text-xs font-medium hover:bg-muted"
                                        >
                                          {suggestion.buttonLabel}
                                        </button>
                                      ) : null}
                                    </div>
                                  );
                                })}
                              </div>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>

                  {latestArtifact ? (
                    <div className="mt-3 rounded-md border border-border bg-background px-3 py-2 text-sm">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <div className="text-xs font-semibold uppercase text-muted-foreground">
                            Latest execution result
                          </div>
                          <div className="mt-1 font-medium text-foreground">
                            {latestArtifact.title}
                          </div>
                        </div>
                        <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
                          {latestArtifact.type} - {latestArtifact.status}
                        </span>
                      </div>
                      {latestArtifact.summary ? (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {latestArtifact.summary}
                        </p>
                      ) : null}
                      {latestArtifact.payload.error ? (
                        <FailureNotice failure={latestArtifact.payload.error} />
                      ) : null}
                    </div>
                  ) : null}

                  {pendingSuggestionConfirmation ? (
                    <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
                      <div className="font-semibold">Confirm approval request</div>
                      <p className="mt-1 text-xs">
                        ORAX will create an approval request for:{" "}
                        <span className="font-medium">{pendingSuggestionConfirmation.title}</span>.
                        It will not execute the approval, run commands, push branches, or open a PR.
                      </p>
                      {pendingSuggestionConfirmation.type === "read_files" &&
                      pendingSuggestionConfirmation.paths?.length ? (
                        <div className="mt-2 text-xs">
                          Files: {pendingSuggestionConfirmation.paths.join(", ")}
                        </div>
                      ) : null}
                      {pendingSuggestionConfirmation.type === "controlled_checks" &&
                      pendingSuggestionConfirmation.commands?.length ? (
                        <div className="mt-2 text-xs">
                          Checks: {pendingSuggestionConfirmation.commands.join(", ")}
                        </div>
                      ) : null}
                      {pendingSuggestionConfirmation.type === "github_pr" ? (
                        <input
                          value={suggestionPrConfirmationText}
                          onChange={(event) => setSuggestionPrConfirmationText(event.target.value)}
                          placeholder="Type CREATE PR to confirm"
                          className="mt-3 h-9 w-full rounded-md border border-amber-300 bg-background px-3 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring dark:border-amber-700"
                        />
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void confirmTaskActionSuggestion()}
                          disabled={
                            pendingSuggestionConfirmation.type === "github_pr" &&
                            suggestionPrConfirmationText.trim() !== "CREATE PR"
                          }
                          className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Create approval request
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setPendingSuggestionConfirmation(null);
                            setSuggestionPrConfirmationText("");
                          }}
                          className="inline-flex h-8 items-center rounded-md border border-amber-300 px-3 text-xs font-medium hover:bg-amber-100 dark:border-amber-700 dark:hover:bg-amber-900/30"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <textarea
                      value={taskMessageDraft}
                      onChange={(event) => setTaskMessageDraft(event.target.value)}
                      placeholder="Discuss this task with ORAX..."
                      className="min-h-16 flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                    <button
                      onClick={() => void sendTaskMessage()}
                      disabled={!taskMessageDraft.trim() || sendingTaskMessage}
                      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
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

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 text-primary" />
                    <div className="text-sm font-semibold">Workflow controls</div>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Approval-gated file reads, draft patches, sandbox validation, controlled checks,
                    and PR creation stay secondary to the task thread. ORAX still cannot edit,
                    execute arbitrary commands, push, open PRs, or deploy without explicit approval.
                  </p>
                </div>

                <textarea
                  value={approvalPaths}
                  onChange={(event) => setApprovalPaths(event.target.value)}
                  placeholder="src/main.ts&#10;package.json&#10;README.md"
                  className="min-h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <input
                  value={approvalReason}
                  onChange={(event) => setApprovalReason(event.target.value)}
                  placeholder="Reason for reading these files"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  onClick={() => void requestFileReadApproval()}
                  disabled={requestingApproval || !approvalPaths.trim()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {requestingApproval ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-4 w-4" />
                  )}
                  Request approval
                </button>

                <textarea
                  value={draftInstructions}
                  onChange={(event) => setDraftInstructions(event.target.value)}
                  placeholder="Optional draft patch instructions. Example: keep the fix small and avoid changing public API."
                  className="min-h-20 w-full resize-none rounded-md border border-input bg-background px-3 py-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                />

                <div className="space-y-2">
                  {approvals.length === 0 ? (
                    <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No approval requests for this task yet.
                    </p>
                  ) : (
                    approvals.map((approval) => (
                      <article
                        key={approval.id}
                        className="rounded-md border border-border bg-muted/20 px-3 py-3"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div>
                            <div className="text-sm font-medium">
                              {approval.action} - {approval.status}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {approval.action === "read_files"
                                ? (approval.request.paths ?? []).join(", ")
                                : `Draft artifact #${approval.request.artifactId ?? "unknown"}`}
                            </div>
                            {approval.request.scope ? (
                              <div className="mt-2 text-xs text-muted-foreground">
                                {approval.request.scope}
                              </div>
                            ) : null}
                            {approval.riskSummary ? (
                              <div className="mt-2 text-xs text-muted-foreground">
                                {approval.riskSummary}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            {approval.status === "pending" ? (
                              <>
                                <button
                                  onClick={() => void decideApproval(approval.id, "approved")}
                                  disabled={decidingApprovalId === approval.id}
                                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <Check className="h-3.5 w-3.5" />
                                  Approve
                                </button>
                                <button
                                  onClick={() => void decideApproval(approval.id, "denied")}
                                  disabled={decidingApprovalId === approval.id}
                                  className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                                >
                                  <X className="h-3.5 w-3.5" />
                                  Deny
                                </button>
                              </>
                            ) : null}
                            {approval.action === "read_files" && approval.status === "approved" ? (
                              <button
                                onClick={() => void readApprovedFiles(approval.id)}
                                disabled={readingApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {readingApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <FileSearch className="h-3.5 w-3.5" />
                                )}
                                Read files
                              </button>
                            ) : null}
                            {approval.action === "read_files" &&
                            ["approved", "completed"].includes(approval.status) ? (
                              <button
                                onClick={() => void generateDraftPatch(approval.id)}
                                disabled={generatingArtifactApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md border border-border px-2 text-xs font-medium hover:bg-muted disabled:opacity-60"
                              >
                                {generatingArtifactApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Code2 className="h-3.5 w-3.5" />
                                )}
                                Generate draft patch
                              </button>
                            ) : null}
                            {approval.action === "sandbox_run" && approval.status === "approved" ? (
                              <button
                                onClick={() => void runSandboxValidation(approval.id)}
                                disabled={runningSandboxApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {runningSandboxApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Play className="h-3.5 w-3.5" />
                                )}
                                Run sandbox
                              </button>
                            ) : null}
                            {approval.action === "safe_check" && approval.status === "approved" ? (
                              <button
                                onClick={() => void runControlledChecks(approval.id)}
                                disabled={runningCommandApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {runningCommandApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Terminal className="h-3.5 w-3.5" />
                                )}
                                Run checks
                              </button>
                            ) : null}
                            {approval.action === "github_pr" && approval.status === "approved" ? (
                              <button
                                onClick={() => void createGithubPr(approval.id)}
                                disabled={creatingPrApprovalId === approval.id}
                                className="inline-flex h-8 items-center justify-center gap-1 rounded-md bg-primary px-2 text-xs font-medium text-primary-foreground disabled:opacity-60"
                              >
                                {creatingPrApprovalId === approval.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <GitPullRequest className="h-3.5 w-3.5" />
                                )}
                                Create PR
                              </button>
                            ) : null}
                          </div>
                        </div>
                        {approval.result?.files?.length ? (
                          <div className="mt-2 text-xs text-muted-foreground">
                            Read {approval.result.files.length} file(s),{" "}
                            {formatBytes(approval.result.totalBytes ?? 0)}
                          </div>
                        ) : null}
                        {approval.action === "github_pr" && approval.result?.pullRequestUrl ? (
                          <a
                            href={approval.result.pullRequestUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="mt-2 inline-flex text-xs font-medium text-primary hover:underline"
                          >
                            Open created pull request
                          </a>
                        ) : null}
                        {approval.action === "github_pr" && approval.result?.error ? (
                          <FailureNotice failure={approval.result.error} />
                        ) : null}
                      </article>
                    ))
                  )}
                </div>

                {readResult ? (
                  <div className="rounded-md border border-border bg-muted/20 p-3">
                    <div className="text-sm font-semibold">
                      Approved file read result - {readResult.branch}
                    </div>
                    {readResult.skipped.length ? (
                      <div className="mt-2 text-xs text-muted-foreground">
                        Skipped:{" "}
                        {readResult.skipped
                          .map((item) => `${item.path} (${item.reason})`)
                          .join(", ")}
                      </div>
                    ) : null}
                    <div className="mt-3 space-y-3">
                      {readResult.files.map((file) => (
                        <div key={file.path} className="rounded-md border border-border bg-card">
                          <div className="border-b border-border px-3 py-2 text-xs font-medium">
                            {file.path} - {formatBytes(file.size)}
                          </div>
                          <pre className="max-h-72 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-muted-foreground">
                            {file.content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold">Draft patch preview</div>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Generated artifacts are review-only. ORAX still cannot apply files, run
                        terminal commands, push branches, open PRs, or deploy.
                      </p>
                    </div>
                    {loadingArtifacts ? (
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    ) : null}
                  </div>

                  {latestDraftPatch ? (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                        <Metric label="Status" value={latestDraftPatch.status} />
                        <Metric
                          label="Branch"
                          value={latestDraftPatch.payload.branch ?? "unknown"}
                        />
                        <Metric label="Model" value={latestDraftPatch.payload.model ?? "unknown"} />
                        <Metric
                          label="Generated"
                          value={new Date(latestDraftPatch.createdAt).toLocaleString()}
                        />
                      </div>
                      {latestDraftPatch.summary ? (
                        <p className="text-sm text-foreground">{latestDraftPatch.summary}</p>
                      ) : null}
                      {latestDraftPatch.payload.explanation ? (
                        <p className="text-sm text-muted-foreground">
                          {latestDraftPatch.payload.explanation}
                        </p>
                      ) : null}
                      {latestDraftPatch.payload.filesRead?.length ? (
                        <div className="text-xs text-muted-foreground">
                          Files used:{" "}
                          {latestDraftPatch.payload.filesRead
                            .map((file) => `${file.path} (${formatBytes(file.size)})`)
                            .join(", ")}
                        </div>
                      ) : null}
                      {latestDraftPatch.payload.skipped?.length ? (
                        <div className="text-xs text-muted-foreground">
                          Skipped:{" "}
                          {latestDraftPatch.payload.skipped
                            .map((item) => `${item.path} (${item.reason})`)
                            .join(", ")}
                        </div>
                      ) : null}
                      {latestDraftPatch.payload.risks?.length ? (
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">
                            Risks
                          </div>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                            {latestDraftPatch.payload.risks.map((risk) => (
                              <li key={risk}>{risk}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {latestDraftPatch.payload.tests?.length ? (
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">
                            Suggested checks
                          </div>
                          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                            {latestDraftPatch.payload.tests.map((test) => (
                              <li key={test}>{test}</li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                      {latestDraftPatch.payload.unifiedDiff?.trim() ? (
                        <pre className="max-h-96 overflow-auto rounded-md border border-border bg-background px-3 py-3 text-xs text-muted-foreground">
                          {latestDraftPatch.payload.unifiedDiff}
                        </pre>
                      ) : (
                        <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                          No diff was generated. Approve more relevant files, then generate a new
                          draft patch.
                        </p>
                      )}
                      {latestDraftPatch.payload.unifiedDiff?.trim() ? (
                        <button
                          onClick={() => void requestSandboxApproval(latestDraftPatch.id)}
                          disabled={requestingSandboxApprovalArtifactId === latestDraftPatch.id}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60"
                        >
                          {requestingSandboxApprovalArtifactId === latestDraftPatch.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-3.5 w-3.5" />
                          )}
                          Request sandbox approval
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No draft patch yet. Generate one from an approved file-read request.
                    </p>
                  )}
                </div>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="text-sm font-semibold">Sandbox validation</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Sandbox validation applies the draft patch to approved file contents only. It
                    does not modify the repository, run unrestricted terminal commands, push, open
                    PRs, or deploy.
                  </p>

                  {latestSandboxResult ? (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                        <Metric label="Status" value={latestSandboxResult.status} />
                        <Metric
                          label="Applied"
                          value={latestSandboxResult.payload.applied ? "yes" : "no"}
                        />
                        <Metric
                          label="Changed files"
                          value={String(latestSandboxResult.payload.changedFiles?.length ?? 0)}
                        />
                        <Metric
                          label="Validated"
                          value={new Date(latestSandboxResult.createdAt).toLocaleString()}
                        />
                      </div>

                      {latestSandboxResult.payload.changedFiles?.length ? (
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">
                            Changed files
                          </div>
                          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                            {latestSandboxResult.payload.changedFiles.map((file) => (
                              <li key={file.path}>
                                {file.path}: +{file.additions} / -{file.deletions},{" "}
                                {formatBytes(file.beforeBytes)} to {formatBytes(file.afterBytes)}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {latestSandboxResult.payload.checks?.length ? (
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">
                            Sandbox checks
                          </div>
                          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                            {latestSandboxResult.payload.checks.map((check) => (
                              <li key={`${check.name}-${check.status}`}>
                                {check.status}: {check.name} - {check.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {latestSandboxResult.payload.testPreview?.length ? (
                        <div>
                          <div className="text-xs font-medium uppercase text-muted-foreground">
                            Suggested tests
                          </div>
                          <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                            {latestSandboxResult.payload.testPreview.map((check) => (
                              <li key={check.name}>
                                {check.status}: {check.name} - {check.message}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}

                      {latestSandboxResult.payload.errors?.length ? (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          {latestSandboxResult.payload.errors.join(" ")}
                        </div>
                      ) : null}

                      {latestSandboxResult.payload.applied ? (
                        <div className="space-y-3">
                          <div>
                            <div className="text-xs font-medium uppercase text-muted-foreground">
                              Checks to request
                            </div>
                            <div className="mt-2 grid gap-2 md:grid-cols-2">
                              {ORAX_COMMAND_OPTIONS.map((option) => (
                                <label
                                  key={option.id}
                                  className="flex min-h-16 cursor-pointer items-start gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs hover:bg-muted/50"
                                >
                                  <input
                                    type="checkbox"
                                    checked={selectedCommandIds.includes(option.id)}
                                    onChange={() => toggleCommandId(option.id)}
                                    className="mt-0.5 h-4 w-4 rounded border-border"
                                  />
                                  <span>
                                    <span className="block font-medium text-foreground">
                                      {option.label}
                                    </span>
                                    <span className="mt-0.5 block text-muted-foreground">
                                      {option.description}
                                    </span>
                                  </span>
                                </label>
                              ))}
                            </div>
                          </div>
                          <button
                            onClick={() => void requestCommandApproval(latestSandboxResult.id)}
                            disabled={
                              requestingCommandApprovalArtifactId === latestSandboxResult.id ||
                              selectedCommandIds.length === 0
                            }
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60"
                          >
                            {requestingCommandApprovalArtifactId === latestSandboxResult.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Terminal className="h-3.5 w-3.5" />
                            )}
                            Request selected checks
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No sandbox validation yet. Request approval from a draft patch, approve it,
                      then run the sandbox.
                    </p>
                  )}
                </div>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="text-sm font-semibold">Controlled checks</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Controlled checks run fixed ORAX validators and selected pnpm scripts in a
                    temporary workspace. They do not accept arbitrary shell text, deployment
                    commands, or default-branch writes.
                  </p>

                  {latestCommandResult ? (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                        <Metric label="Status" value={latestCommandResult.status} />
                        <Metric
                          label="Passed"
                          value={latestCommandResult.payload.passed ? "yes" : "no"}
                        />
                        <Metric
                          label="Commands"
                          value={String(latestCommandResult.payload.commands?.length ?? 0)}
                        />
                        <Metric
                          label="Executed"
                          value={new Date(latestCommandResult.createdAt).toLocaleString()}
                        />
                      </div>

                      {latestCommandResult.summary ? (
                        <p className="text-sm text-foreground">{latestCommandResult.summary}</p>
                      ) : null}

                      <div className="rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
                        Command summary: {commandPassedCount} passed, {commandFailureCount} failed.
                      </div>

                      {latestCommandResult.payload.commands?.length ? (
                        <div className="space-y-2">
                          {latestCommandResult.payload.commands.map((command) => (
                            <div
                              key={`${command.id}-${command.status}`}
                              className="rounded-md border border-border bg-card px-3 py-2"
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                                <span className="font-medium text-foreground">
                                  {command.label || command.id}
                                </span>
                                <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-muted-foreground">
                                  {command.status}
                                  {typeof command.exitCode === "number"
                                    ? ` / exit ${command.exitCode}`
                                    : ""}
                                </span>
                              </div>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {command.message}
                              </p>
                              {command.stdout ? (
                                <pre className="mt-2 max-h-32 overflow-auto rounded bg-background px-2 py-2 text-[11px] text-muted-foreground">
                                  {command.stdout}
                                </pre>
                              ) : null}
                              {command.stderr ? (
                                <pre className="mt-2 max-h-32 overflow-auto rounded border border-destructive/30 bg-destructive/10 px-2 py-2 text-[11px] text-destructive">
                                  {command.stderr}
                                </pre>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}

                      {latestCommandResult.payload.passed === false ? (
                        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                          GitHub PR approval is blocked until every selected check passes. Review
                          the failed command output, update the draft patch, then rerun the
                          approval-gated checks.
                        </div>
                      ) : null}

                      {readyForPrApproval ? (
                        <div className="space-y-3 rounded-md border border-border bg-background px-3 py-3">
                          <div>
                            <div className="text-xs font-medium uppercase text-muted-foreground">
                              PR approval review
                            </div>
                            <p className="mt-1 text-xs text-muted-foreground">
                              This creates a new branch and pull request only. It does not push to
                              the default branch or deploy.
                            </p>
                          </div>
                          <ArtifactTrace artifact={latestCommandResult} />
                          <label className="block text-xs">
                            <span className="font-medium text-foreground">
                              Type CREATE PR to enable approval
                            </span>
                            <input
                              value={prConfirmationText}
                              onChange={(event) => setPrConfirmationText(event.target.value)}
                              className="mt-1 h-9 w-full rounded-md border border-border bg-card px-3 text-sm outline-none focus:border-primary"
                              placeholder="CREATE PR"
                            />
                          </label>
                          <button
                            onClick={() => void requestGithubPrApproval(latestCommandResult.id)}
                            disabled={
                              requestingPrApprovalArtifactId === latestCommandResult.id ||
                              prConfirmationText.trim() !== "CREATE PR"
                            }
                            className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground disabled:opacity-60"
                          >
                            {requestingPrApprovalArtifactId === latestCommandResult.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <GitPullRequest className="h-3.5 w-3.5" />
                            )}
                            Request GitHub PR approval
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No controlled checks yet. Request approval from a passed sandbox result,
                      approve it, then run the checks.
                    </p>
                  )}
                </div>

                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <div className="text-sm font-semibold">GitHub pull request</div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    ORAX can create a new branch and pull request only after controlled checks pass
                    and you explicitly approve the GitHub action. It never pushes directly to the
                    default branch.
                  </p>

                  {latestGithubPrResult ? (
                    <div className="mt-3 space-y-3">
                      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                        <Metric label="Status" value={latestGithubPrResult.status} />
                        <Metric
                          label="Branch"
                          value={latestGithubPrResult.payload.branchName ?? "unknown"}
                        />
                        <Metric
                          label="Base"
                          value={latestGithubPrResult.payload.baseBranch ?? "unknown"}
                        />
                        <Metric
                          label="PR"
                          value={
                            latestGithubPrResult.payload.pullRequestNumber
                              ? `#${latestGithubPrResult.payload.pullRequestNumber}`
                              : "unknown"
                          }
                        />
                      </div>
                      {latestGithubPrResult.summary ? (
                        <p className="text-sm text-foreground">{latestGithubPrResult.summary}</p>
                      ) : null}
                      {latestGithubPrResult.status === "failed" &&
                      latestGithubPrResult.payload.error ? (
                        <FailureNotice failure={latestGithubPrResult.payload.error} />
                      ) : null}
                      {latestGithubPrResult.payload.pullRequestUrl ? (
                        <a
                          href={latestGithubPrResult.payload.pullRequestUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-xs font-medium hover:bg-muted"
                        >
                          <GitPullRequest className="h-3.5 w-3.5" />
                          Open pull request
                        </a>
                      ) : null}
                      {latestGithubPrResult.payload.filesChanged?.length ? (
                        <div className="text-xs text-muted-foreground">
                          Files in PR: {latestGithubPrResult.payload.filesChanged.join(", ")}
                        </div>
                      ) : null}
                      <ArtifactTrace artifact={latestGithubPrResult} />
                      {latestGithubPrResult.payload.commitSha ? (
                        <div className="text-xs text-muted-foreground">
                          Commit: {latestGithubPrResult.payload.commitSha}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-3 rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                      No GitHub pull request yet. Run controlled checks, request GitHub PR approval,
                      approve it, then create the PR.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
                Create an ORAX task before requesting file-read approval.
              </p>
            )}
          </section>

          <section className="rounded-lg border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Terminal className="h-4 w-4 text-primary" />
                <h2 className="text-sm font-semibold">Task history</h2>
              </div>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <div className="divide-y divide-border">
              {tasks.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">
                  No ORAX tasks yet. Create a safe plan to start the coding-agent history.
                </p>
              ) : (
                tasks.map((task) => (
                  <article key={task.id} className="px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <GitPullRequest className="h-4 w-4 text-muted-foreground" />
                          <h3 className="text-sm font-semibold">{task.title}</h3>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {task.kind} - {task.status} - {new Date(task.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span className="rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
                        approval-gated
                      </span>
                    </div>
                    {task.result?.message ? (
                      <p className="mt-3 text-sm text-muted-foreground">{task.result.message}</p>
                    ) : null}
                    {task.plan?.steps?.length ? (
                      <ol className="mt-3 space-y-1 text-sm text-foreground">
                        {task.plan.steps.map((step, index) => (
                          <li key={`${task.id}-${step}`} className="flex gap-2">
                            <span className="text-xs text-muted-foreground">{index + 1}.</span>
                            <span>{step}</span>
                          </li>
                        ))}
                      </ol>
                    ) : null}
                  </article>
                ))
              )}
            </div>
          </section>
        </section>
      </main>
    </div>
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
