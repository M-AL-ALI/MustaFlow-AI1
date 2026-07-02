import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  ArrowUp,
  ArrowLeft,
  Check,
  Code2,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Loader2,
  Menu,
  Mic,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
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
    executionSessionId?: number;
    executionStep?: OraxExecutionStep;
    source?: string;
    [key: string]: unknown;
  };
  artifactId?: number | null;
  approvalId?: number | null;
  createdAt: string;
  updatedAt: string;
};

type OraxExecutionStep = {
  id?: string;
  action?: string;
  label?: string;
  status?: string;
  message?: string;
  approvalId?: number;
  artifactId?: number;
  createdAt?: string;
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

type OraxComposerReasoning = "low" | "medium" | "high" | "extra_high";
type OraxComposerPermissionMode = "ask" | "auto" | "read_only";

type OraxRunnerActivity = {
  label: string;
  status: "running" | "completed" | "waiting" | "failed" | "blocked";
};

type OraxComposerAttachment = {
  id: string;
  name: string;
  type?: string;
  size?: number;
  source: "web";
  contentKind?: "text" | "image" | "binary" | "unsupported";
  contentText?: string;
  dataUrl?: string;
  preview?: string;
  truncated?: boolean;
  ingestionStatus?: "ready" | "unsupported" | "error";
};

type OraxComposerMetadata = {
  composer: {
    model: string;
    reasoning: OraxComposerReasoning;
    permissionMode: OraxComposerPermissionMode;
    inputMode: "text" | "voice";
    attachments: OraxComposerAttachment[];
  };
};

type OraxSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string } }> }) => void)
    | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

type OraxSpeechRecognitionConstructor = new () => OraxSpeechRecognition;

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
    workspaceChangeSetArtifactId?: number;
    sourceApprovalId?: number;
    validatedAt?: string;
    applied?: boolean;
    diffSummary?: { additions?: number; deletions?: number };
    changedFiles?: Array<{
      path: string;
      beforeBytes: number;
      afterBytes: number;
      additions: number;
      deletions: number;
    }>;
    patchedFiles?: Array<{ path: string; size?: number; sourceSha?: string }>;
    rollback?: {
      sourceFiles?: Array<{ path: string; sha?: string; size?: number; truncated?: boolean }>;
    };
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
    steps?: OraxExecutionStep[];
    startedAt?: string;
    updatedAt?: string;
    retryOfArtifactId?: number;
    retryOfArtifactType?: string;
    retryAttempt?: number;
    failureSummary?: string;
    error?: OraxFailureInfo;
    failedAt?: string;
  };
  createdAt: string;
  updatedAt: string;
};

type OraxTaskRunnerResult = {
  status: "continued" | "waiting" | "blocked";
  action: string;
  message: string;
  approvalId?: number;
  artifactId?: number;
  sessionArtifactId?: number;
  approval?: OraxApproval;
  artifact?: OraxArtifact;
  approvals?: OraxApproval[];
  artifacts?: OraxArtifact[];
  runnerResults?: Array<{
    status: "continued" | "waiting" | "blocked";
    action: string;
    message: string;
    approvalId?: number;
    artifactId?: number;
    sessionArtifactId?: number;
  }>;
};

type OraxFailureInfo = {
  code?: string;
  message?: string;
  hint?: string;
  rawMessage?: string;
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

const _TASK_KINDS = [
  { value: "analyze", label: "Analyze" },
  { value: "plan", label: "Plan" },
  { value: "review", label: "Review" },
  { value: "fix", label: "Fix" },
] as const;

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

async function readFileAsText(file: File): Promise<string> {
  return file.text();
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read attachment"));
    reader.readAsDataURL(file);
  });
}

async function readOraxWebAttachment(file: File): Promise<OraxComposerAttachment> {
  const base = {
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    source: "web" as const,
  };

  if (isOraxTextAttachment(file.name, file.type)) {
    try {
      const text = await readFileAsText(file);
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

  if (isOraxImageAttachment(file.type)) {
    try {
      const dataUrl = await readFileAsDataUrl(file);
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

function getMessageComposerAttachments(message: OraxTaskMessage): OraxComposerAttachment[] {
  const composer = message.metadata?.composer as
    | { attachments?: OraxComposerAttachment[] }
    | undefined;
  return Array.isArray(composer?.attachments) ? composer.attachments : [];
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
    const dateDelta = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return dateDelta || a.id - b.id;
  });
}

function shouldRefreshOraxTaskCollections(message: OraxTaskMessage): boolean {
  const source = message.metadata?.source;
  return (
    source === "orax-task-timeline" ||
    source === "orax-task-checkpoint" ||
    Boolean(message.approvalId || message.artifactId)
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

function normalizeOraxUiError(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  if (/invalid orax task/i.test(message)) {
    return "Start a new Orax chat, then send the message again.";
  }
  return message || fallback;
}

export default function OraxPage() {
  const [repositories, setRepositories] = useState<OraxRepository[]>([]);
  const [tasks, setTasks] = useState<OraxTask[]>([]);
  const [approvals, setApprovals] = useState<OraxApproval[]>([]);
  const [artifacts, setArtifacts] = useState<OraxArtifact[]>([]);
  const [taskMessages, setTaskMessages] = useState<OraxTaskMessage[]>([]);
  const [, setCapabilities] = useState<OraxCapabilities | null>(null);
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [defaultBranch, setDefaultBranch] = useState("main");
  const [selectedRepoId, setSelectedRepoId] = useState<number | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<number | null>(null);
  const activeTaskIdRef = useRef<number | null>(null);
  const taskEventStreamAbortRef = useRef<AbortController | null>(null);
  const [githubToken, setGithubToken] = useState("");
  const [scans, setScans] = useState<OraxScan[]>([]);
  const [_taskKind, _setTaskKind] = useState<(typeof _TASK_KINDS)[number]["value"]>("analyze");
  const [prompt, setPrompt] = useState("");
  const [approvalPaths, setApprovalPaths] = useState("");
  const [approvalReason, setApprovalReason] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [taskMessageDraft, setTaskMessageDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const speechRecognitionRef = useRef<OraxSpeechRecognition | null>(null);
  const [composerAttachments, setComposerAttachments] = useState<OraxComposerAttachment[]>([]);
  const [composerModel, setComposerModel] =
    useState<(typeof ORAX_COMPOSER_MODELS)[number]>("Orax 5.5");
  const [composerReasoning, setComposerReasoning] = useState<OraxComposerReasoning>("extra_high");
  const [composerPermissionMode, setComposerPermissionMode] =
    useState<OraxComposerPermissionMode>("ask");
  const [composerInputMode, setComposerInputMode] = useState<"text" | "voice">("text");
  const [composerSettingsOpen, setComposerSettingsOpen] = useState(false);
  const [voiceRecording, setVoiceRecording] = useState(false);
  const [, setShowInspector] = useState(false);
  const [mobileTaskOpen, setMobileTaskOpen] = useState(false);
  const [, setMobileComposeOpen] = useState(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [taskSearch, setTaskSearch] = useState("");
  const [pendingSuggestionConfirmation, setPendingSuggestionConfirmation] =
    useState<OraxTaskActionSuggestion | null>(null);
  const [suggestionPrConfirmationText, setSuggestionPrConfirmationText] = useState("");
  const [selectedCommandIds, setSelectedCommandIds] = useState<string[]>(DEFAULT_ORAX_COMMAND_IDS);
  const [prConfirmationText, setPrConfirmationText] = useState("");
  const [loading, setLoading] = useState(true);
  const [submittingRepo, setSubmittingRepo] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);
  const [scanningRepository, setScanningRepository] = useState(false);
  const [, setLoadingScans] = useState(false);
  const [, setLoadingApprovals] = useState(false);
  const [, setLoadingArtifacts] = useState(false);
  const [, setLoadingTaskMessages] = useState(false);
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
  const [creatingPrApprovalId, setCreatingPrApprovalId] = useState<number | null>(null);
  const [continuingTask, setContinuingTask] = useState(false);
  const [generatingArtifactApprovalId, setGeneratingArtifactApprovalId] = useState<number | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const selectedRepository = useMemo(
    () => repositories.find((repo) => repo.id === selectedRepoId) ?? repositories[0] ?? null,
    [repositories, selectedRepoId],
  );
  const latestScan = scans[0] ?? null;
  const _latestScanLanguages = Object.entries(latestScan?.summary?.languages ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId],
  );
  const visibleTasks = useMemo(() => {
    const query = taskSearch.trim().toLowerCase();
    if (!query) return tasks;
    return tasks.filter((task) => {
      const repo = repositories.find((item) => item.id === task.repositoryId);
      return [task.title, task.prompt, task.kind, task.status, repo?.owner, repo?.name]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [repositories, taskSearch, tasks]);
  const chatPreview = useMemo(() => {
    const latestUserMessage = [...taskMessages]
      .reverse()
      .find((message) => message.role === "user")?.content;
    return latestUserMessage ?? selectedTask?.prompt ?? "Start a chat with Orax";
  }, [selectedTask, taskMessages]);
  const currentCheckpoint = useMemo(() => {
    const checkpointMessage = [...taskMessages]
      .reverse()
      .find((message) => message.metadata?.source === "orax-task-checkpoint");
    return (
      checkpointMessage?.metadata?.checkpoint ?? selectedTask?.result?.currentCheckpoint ?? null
    );
  }, [selectedTask, taskMessages]);
  const latestDraftPatch = artifacts.find((artifact) => artifact.type === "draft_patch") ?? null;
  const completedReadApproval =
    approvals.find(
      (approval) => approval.action === "read_files" && approval.status === "completed",
    ) ?? null;
  const latestSandboxResult =
    artifacts.find((artifact) => artifact.type === "sandbox_result") ?? null;
  const latestWorkspaceChangeSet =
    artifacts.find((artifact) => artifact.type === "workspace_change_set") ?? null;
  const latestCommandResult =
    artifacts.find((artifact) => artifact.type === "command_result") ?? null;
  const _latestGithubPrResult =
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
  const latestAssistantSuggestionMessageId = useMemo(() => {
    return (
      [...taskMessages]
        .reverse()
        .find(
          (message) => message.role === "assistant" && message.metadata?.actionSuggestions?.length,
        )?.id ?? null
    );
  }, [taskMessages]);
  const visibleSlashCommands = useMemo(() => {
    const draft = taskMessageDraft.trimStart();
    if (!draft.startsWith("/") || /\s/.test(draft)) return [];
    const query = draft.slice(1).toLowerCase();
    return ORAX_SLASH_COMMANDS.filter((command) =>
      command.command.slice(1).startsWith(query),
    ).slice(0, 7);
  }, [taskMessageDraft]);
  const primaryThreadSuggestion = latestAssistantSuggestions[0] ?? null;
  const visibleTaskMessages = useMemo(
    () => taskMessages.filter(isOraxVisibleThreadMessage),
    [taskMessages],
  );
  const menuTasks = useMemo(
    () =>
      (selectedRepository
        ? tasks.filter((task) => task.repositoryId === selectedRepository.id)
        : tasks
      ).slice(0, 5),
    [selectedRepository, tasks],
  );
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
      if (!capRes.ok) {
        throw new Error("Could not load Orax connection settings");
      }
      if (!repoRes.ok) {
        throw new Error("Could not load Orax repositories");
      }
      if (!taskRes.ok) {
        throw new Error("Could not load Orax task history");
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
    } catch {
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
    } catch {
      if (activeTaskIdRef.current !== taskId) return;
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
        throw new Error("Orax artifact refresh failed");
      }
      const body = (await res.json()) as { artifacts: OraxArtifact[] };
      if (activeTaskIdRef.current !== taskId) return;
      setArtifacts(body.artifacts);
    } catch {
      if (activeTaskIdRef.current !== taskId) return;
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
      taskEventStreamAbortRef.current?.abort();
      taskEventStreamAbortRef.current = null;
      setApprovals([]);
      setArtifacts([]);
      setTaskMessages([]);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
      setComposerAttachments([]);
      setComposerInputMode("text");
      setComposerSettingsOpen(false);
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
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
      setComposerAttachments([]);
      setComposerInputMode("text");
      setComposerSettingsOpen(false);
    }

    void loadApprovals(selectedTask.id);
    void loadArtifacts(selectedTask.id);
    void loadTaskMessages(selectedTask.id);
  }, [loadApprovals, loadArtifacts, loadTaskMessages, selectedTask]);

  useEffect(() => {
    if (!selectedTask) return;
    const taskId = selectedTask.id;
    const controller = new AbortController();
    taskEventStreamAbortRef.current?.abort();
    taskEventStreamAbortRef.current = controller;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    function processOraxEventBlock(block: string) {
      const lines = block.split("\n");
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event: ")) eventName = line.slice(7).trim();
        if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      if (!dataLines.length || eventName !== "message") return;
      let parsed: { message?: OraxTaskMessage };
      try {
        parsed = JSON.parse(dataLines.join("\n")) as { message?: OraxTaskMessage };
      } catch {
        return;
      }
      const message = parsed.message;
      if (!message || activeTaskIdRef.current !== taskId) return;
      setTaskMessages((prev) => mergeOraxTaskMessages(prev, [message]));
      if (shouldRefreshOraxTaskCollections(message)) {
        void loadApprovals(taskId);
        void loadArtifacts(taskId);
      }
    }

    async function connectOraxTaskEventStream() {
      try {
        const response = await authFetch(`/api/orax/tasks/${taskId}/events`, {
          headers: { Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) return;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            if (block.trim()) processOraxEventBlock(block);
          }
        }
      } catch {
        // Reconnect below unless the effect is being cleaned up.
      }
      if (!controller.signal.aborted) {
        retryTimer = setTimeout(() => {
          void connectOraxTaskEventStream();
        }, 2_000);
      }
    }

    void connectOraxTaskEventStream();

    return () => {
      if (retryTimer) clearTimeout(retryTimer);
      controller.abort();
      if (taskEventStreamAbortRef.current === controller) {
        taskEventStreamAbortRef.current = null;
      }
    };
  }, [loadApprovals, loadArtifacts, selectedTask]);

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
      let nextRepository = body.repository;
      if (githubToken.trim()) {
        nextRepository = await connectGithubRepository(body.repository.id, githubToken.trim());
        setGithubToken("");
      }
      setRepositories((prev) => [nextRepository, ...prev]);
      setSelectedRepoId(nextRepository.id);
      setRepositoryUrl("");
      setDefaultBranch("main");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save repository");
    } finally {
      setSubmittingRepo(false);
    }
  }

  async function connectGithubRepository(repositoryId: number, token: string) {
    const res = await authFetch(`/api/orax/repositories/${repositoryId}/github/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? "Could not connect GitHub repository");
    }
    const body = (await res.json()) as { repository: OraxRepository };
    return body.repository;
  }

  async function _connectGithub() {
    if (!selectedRepository || !githubToken.trim() || connectingGithub) return;
    setConnectingGithub(true);
    setError(null);
    try {
      const repository = await connectGithubRepository(selectedRepository.id, githubToken.trim());
      setRepositories((prev) =>
        prev.map((repo) => (repo.id === repository.id ? repository : repo)),
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

  async function addComposerFiles(files: FileList | null) {
    if (!files?.length) return;
    const slots = Math.max(0, 6 - composerAttachments.length);
    const selected = Array.from(files).slice(0, slots);
    const attachments = await Promise.all(selected.map((file) => readOraxWebAttachment(file)));
    setComposerAttachments((prev) => [...prev, ...attachments]);
    if (files.length > slots) {
      setError("Orax can attach up to 6 files to one message.");
    }
  }

  function removeComposerAttachment(id: string) {
    setComposerAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  }

  function cycleComposerPermissionMode() {
    setComposerPermissionMode((current) => {
      const index = ORAX_PERMISSION_OPTIONS.findIndex((option) => option.value === current);
      return ORAX_PERMISSION_OPTIONS[(index + 1) % ORAX_PERMISSION_OPTIONS.length].value;
    });
  }

  function buildComposerMetadata(
    inputMode: "text" | "voice" = composerInputMode,
  ): OraxComposerMetadata {
    return {
      composer: {
        model: composerModel,
        reasoning: composerReasoning,
        permissionMode: composerPermissionMode,
        inputMode,
        attachments: composerAttachments,
      },
    };
  }

  function getSpeechRecognitionConstructor(): OraxSpeechRecognitionConstructor | null {
    const win = window as unknown as {
      SpeechRecognition?: OraxSpeechRecognitionConstructor;
      webkitSpeechRecognition?: OraxSpeechRecognitionConstructor;
    };
    return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
  }

  function toggleComposerVoiceInput() {
    if (voiceRecording) {
      speechRecognitionRef.current?.stop();
      setVoiceRecording(false);
      return;
    }
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setError("Voice input is not supported in this browser.");
      return;
    }
    const recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      const text = Array.from(event.results)
        .slice(event.resultIndex)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (text) {
        setTaskMessageDraft((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
        setComposerInputMode("voice");
      }
    };
    recognition.onerror = () => {
      setVoiceRecording(false);
      setError("Could not capture voice input. Please try again.");
    };
    recognition.onend = () => {
      setVoiceRecording(false);
      speechRecognitionRef.current = null;
    };
    speechRecognitionRef.current = recognition;
    setVoiceRecording(true);
    recognition.start();
  }

  function mergeRunnerResultCollections(result?: OraxTaskRunnerResult) {
    if (!result) return;
    const nextApprovals = [
      ...(result.approvals ?? []),
      ...(result.approval ? [result.approval] : []),
    ];
    if (nextApprovals.length) {
      setApprovals((prev) => {
        const byId = new Map(prev.map((approval) => [approval.id, approval]));
        for (const approval of nextApprovals) byId.set(approval.id, approval);
        return Array.from(byId.values()).sort((a, b) => b.id - a.id);
      });
    }
    const nextArtifacts = [
      ...(result.artifacts ?? []),
      ...(result.artifact ? [result.artifact] : []),
    ];
    if (nextArtifacts.length) {
      setArtifacts((prev) => {
        const byId = new Map(prev.map((artifact) => [artifact.id, artifact]));
        for (const artifact of nextArtifacts) byId.set(artifact.id, artifact);
        return Array.from(byId.values()).sort((a, b) => b.id - a.id);
      });
    }
  }

  async function appendTaskMessage(
    taskId: number,
    content: string,
    metadata?: OraxComposerMetadata,
  ): Promise<OraxTaskMessage[]> {
    if (!Number.isInteger(taskId) || taskId <= 0) {
      throw new Error("Start a new Orax chat, then send the message again.");
    }
    const res = await authFetch(`/api/orax/tasks/${taskId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(metadata ? { content, metadata } : { content }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(
        normalizeOraxUiError(new Error(body.error ?? ""), "Could not save task message"),
      );
    }
    const body = (await res.json()) as {
      messages: OraxTaskMessage[];
      runnerResult?: OraxTaskRunnerResult;
    };
    mergeRunnerResultCollections(body.runnerResult);
    return body.messages;
  }

  async function createTask(
    options: {
      startThread?: boolean;
      firstMessage?: string;
      firstMessageMetadata?: OraxComposerMetadata;
    } = {},
  ) {
    const firstMessage = (options.firstMessage ?? prompt).trim();
    if (!selectedRepository || !firstMessage || submittingTask) return;
    setSubmittingTask(true);
    setError(null);
    try {
      const res = await authFetch("/api/orax/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repositoryId: selectedRepository.id,
          kind: _taskKind,
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
      setMobileTaskOpen(true);
      setMobileComposeOpen(false);
      setApprovals([]);
      setArtifacts([]);
      setTaskMessages([]);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      setPrConfirmationText("");
      setTaskMessageDraft("");
      setComposerAttachments([]);
      setComposerInputMode("text");
      setComposerSettingsOpen(false);
      setPrompt("");
      if (options.startThread) {
        try {
          const messages = await appendTaskMessage(
            targetTaskId,
            firstMessage,
            options.firstMessageMetadata,
          );
          if (activeTaskIdRef.current !== targetTaskId) return;
          setTaskMessages((prev) => mergeOraxTaskMessages(prev, messages));
        } catch (messageErr) {
          if (activeTaskIdRef.current !== targetTaskId) return;
          setTaskMessageDraft(firstMessage);
          setError(
            `Task created, but the first message did not attach. Retry it here: ${normalizeOraxUiError(
              messageErr,
              "Could not save task message",
            )}`,
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

  function startNewThread() {
    activeTaskIdRef.current = null;
    setSelectedTaskId(null);
    setMobileTaskOpen(Boolean(selectedRepository));
    setMobileComposeOpen(false);
    setApprovals([]);
    setArtifacts([]);
    setTaskMessages([]);
    setPendingSuggestionConfirmation(null);
    setSuggestionPrConfirmationText("");
    setPrConfirmationText("");
    setTaskMessageDraft("");
    setComposerAttachments([]);
    setComposerInputMode("text");
    setComposerSettingsOpen(false);
    setPrompt("");
    if (!selectedRepository) {
      setError(null);
    }
  }

  async function sendTaskMessage() {
    if (sendingTaskMessage) return;
    const content = taskMessageDraft.trim() || "Review the attached Orax context.";
    if (!taskMessageDraft.trim() && composerAttachments.length === 0) return;
    const metadata = buildComposerMetadata();
    if (!selectedTask && !selectedRepository) {
      setError("Connect a GitHub repository before starting an Orax chat.");
      setMobileTaskOpen(false);
      return;
    }
    if (!selectedTask) {
      await createTask({
        startThread: true,
        firstMessage: content,
        firstMessageMetadata: metadata,
      });
      return;
    }
    const targetTaskId = selectedTask.id;
    setSendingTaskMessage(true);
    setError(null);
    try {
      const messages = await appendTaskMessage(targetTaskId, content, metadata);
      if (activeTaskIdRef.current !== targetTaskId) return;
      setTaskMessages((prev) => mergeOraxTaskMessages(prev, messages));
      setTaskMessageDraft("");
      setComposerAttachments([]);
      setComposerInputMode("text");
      setComposerSettingsOpen(false);
    } catch (err) {
      if (activeTaskIdRef.current !== targetTaskId) return;
      setError(normalizeOraxUiError(err, "Could not save task message"));
    } finally {
      setSendingTaskMessage(false);
    }
  }

  function applyTaskActionSuggestion(suggestion: OraxTaskActionSuggestion) {
    setPendingSuggestionConfirmation(null);
    setSuggestionPrConfirmationText("");

    if (suggestion.requiresManualConfirmation || suggestion.type === "github_pr") {
      setPendingSuggestionConfirmation(suggestion);
      return;
    }

    void continueSelectedTask();
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
      if (decision === "approved") {
        if (body.approval.action === "github_pr") {
          void createGithubPr(body.approval.id);
        } else {
          void continueTaskById(body.approval.taskId);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update approval");
    } finally {
      setDecidingApprovalId(null);
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

    if (suggestion.type === "github_pr" && suggestion.artifactId) {
      if (suggestionPrConfirmationText.trim() !== "CREATE PR") {
        setError("Type CREATE PR to enable approval");
        return;
      }
      const created = await requestGithubPrApproval(
        suggestion.artifactId,
        suggestionPrConfirmationText,
      );
      if (!created) return;
    }

    setPendingSuggestionConfirmation(null);
    setSuggestionPrConfirmationText("");
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

  async function continueTaskById(taskId: number) {
    if (continuingTask) return;
    setContinuingTask(true);
    setError(null);
    try {
      const res = await authFetch(`/api/orax/tasks/${taskId}/continue`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not continue Orax task");
      }
      const body = (await res.json()) as OraxTaskRunnerResult;
      mergeRunnerResultCollections(body);
      setPendingSuggestionConfirmation(null);
      setSuggestionPrConfirmationText("");
      void load();
      void loadTaskMessages(taskId);
    } catch (err) {
      setError(normalizeOraxUiError(err, "Could not continue Orax task"));
    } finally {
      setContinuingTask(false);
    }
  }

  async function continueSelectedTask() {
    if (!selectedTask) return;
    await continueTaskById(selectedTask.id);
  }

  function selectRepositoryFromMenu(repo: OraxRepository) {
    const nextTask = tasks.find((task) => task.repositoryId === repo.id) ?? null;
    setSelectedRepoId(repo.id);
    setSelectedTaskId(nextTask?.id ?? null);
    setTaskSearch(repo.name);
    setMobileTaskOpen(Boolean(nextTask));
    setWorkspaceMenuOpen(false);
  }

  function selectTaskFromMenu(task: OraxTask) {
    setSelectedTaskId(task.id);
    setSelectedRepoId(task.repositoryId);
    setMobileTaskOpen(true);
    setWorkspaceMenuOpen(false);
  }

  const selectedTaskRepository = selectedTask
    ? (repositories.find((repo) => repo.id === selectedTask.repositoryId) ?? selectedRepository)
    : selectedRepository;

  function renderRepositoryConnectionPanel(compact = false) {
    return (
      <section
        className={cn(
          "rounded-3xl border border-border bg-card p-4 shadow-sm",
          compact ? "space-y-3" : "mx-auto max-w-xl space-y-4",
        )}
      >
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-muted">
            <GitBranch className="h-5 w-5 text-foreground" />
          </div>
          <div className="min-w-0">
            <div className="font-semibold">Connect GitHub repository</div>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Orax needs a repository before it can inspect files, run checks, or prepare code
              changes.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center text-[11px] text-muted-foreground">
          {["Connect repo", "Scan files", "Start chat"].map((step, index) => (
            <div
              key={step}
              className="rounded-full border border-border bg-background px-2 py-1 font-medium"
            >
              {index + 1}. {step}
            </div>
          ))}
        </div>
        <input
          value={repositoryUrl}
          onChange={(event) => setRepositoryUrl(event.target.value)}
          placeholder="https://github.com/owner/repo"
          className="h-11 w-full rounded-2xl border border-input bg-background px-4 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <div className={cn("grid gap-2", compact ? "grid-cols-1" : "sm:grid-cols-[1fr_1.6fr]")}>
          <input
            value={defaultBranch}
            onChange={(event) => setDefaultBranch(event.target.value)}
            placeholder="main"
            className="h-11 min-w-0 rounded-2xl border border-input bg-background px-4 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
          <input
            type="password"
            value={githubToken}
            onChange={(event) => setGithubToken(event.target.value)}
            placeholder="GitHub token for private repos (optional)"
            className="h-11 min-w-0 rounded-2xl border border-input bg-background px-4 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <button
          type="button"
          onClick={() => void addRepository()}
          disabled={submittingRepo || !repositoryUrl.trim()}
          className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-full bg-foreground px-4 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submittingRepo ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <GitBranch className="h-4 w-4" />
          )}
          Connect repository
        </button>
        <p className="text-xs leading-5 text-muted-foreground">
          Public GitHub repositories can be scanned from the URL. Private repositories need a token
          with read access; Orax keeps repository work separate from Ora chat.
        </p>
      </section>
    );
  }

  function renderRepositoryStatusPanel(compact = false) {
    if (!selectedRepository) return null;
    const connected = selectedRepository.connectionStatus === "read_only";
    const scanned = latestScan?.status === "completed" || Boolean(selectedRepository.lastScanAt);
    const nextAction = !connected
      ? "Connect token or scan public repo"
      : !scanned
        ? "Scan repository"
        : "Start chat";
    return (
      <section
        className={cn(
          "rounded-3xl border border-border bg-card p-4 shadow-sm",
          compact ? "space-y-3" : "mx-auto max-w-xl space-y-4",
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Workspace ready</div>
            <div className="mt-1 truncate text-base font-semibold">
              {selectedRepository.owner}/{selectedRepository.name}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {connected
                ? selectedRepository.githubAccountName
                  ? `Connected as ${selectedRepository.githubAccountName}`
                  : "GitHub access connected"
                : "Public scan available; add a token for private repository access."}
            </p>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
              connected
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "border-border bg-muted text-muted-foreground",
            )}
          >
            {connected ? "Connected" : "Metadata only"}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <Metric label="Branch" value={selectedRepository.defaultBranch || "main"} />
          <Metric
            label="Scan"
            value={latestScan?.status ?? selectedRepository.scanStatus ?? "idle"}
          />
          <Metric label="Files" value={latestScan ? String(latestScan.fileCount) : "not scanned"} />
          <Metric label="Next" value={nextAction} />
        </div>
        {!connected ? (
          <div className="space-y-2">
            <input
              type="password"
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="Optional GitHub token for private repos"
              className="h-10 w-full rounded-2xl border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => void _connectGithub()}
                disabled={connectingGithub || !githubToken.trim()}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-foreground px-3 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                {connectingGithub ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShieldCheck className="h-4 w-4" />
                )}
                Connect
              </button>
              <button
                type="button"
                onClick={() => void scanRepository()}
                disabled={scanningRepository}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border px-3 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
              >
                {scanningRepository ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Scan
              </button>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => void scanRepository()}
              disabled={scanningRepository}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full border border-border px-3 text-sm font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {scanningRepository ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              Scan
            </button>
            <button
              type="button"
              onClick={startNewThread}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-foreground px-3 text-sm font-semibold text-background"
            >
              <PenLine className="h-4 w-4" />
              Start chat
            </button>
          </div>
        )}
      </section>
    );
  }

  function renderWorkspaceChips() {
    return (
      <div data-orax-workspace-chips className="mb-6 flex gap-2 overflow-x-auto lg:mb-3">
        <button
          type="button"
          onClick={() => setTaskSearch("")}
          className={cn(
            "shrink-0 rounded-full px-4 py-2 text-sm font-semibold",
            taskSearch.trim() ? "bg-muted text-foreground" : "bg-foreground text-background",
          )}
        >
          All
        </button>
        {repositories.slice(0, 6).map((repo) => {
          const active = repo.id === selectedRepository?.id;
          return (
            <button
              key={repo.id}
              type="button"
              onClick={() => {
                setSelectedRepoId(repo.id);
                setTaskSearch(repo.name);
                setMobileTaskOpen(false);
              }}
              className={cn(
                "inline-flex max-w-[240px] shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-medium",
                active ? "bg-muted text-foreground" : "border border-border text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-2 w-2 shrink-0 rounded-full",
                  repo.connectionStatus === "read_only" ? "bg-emerald-500" : "bg-amber-500",
                )}
              />
              <Code2 className="h-4 w-4 shrink-0" />
              <span className="truncate">{repo.name}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setWorkspaceMenuOpen(true)}
          className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Open workspace menu"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>
    );
  }

  function renderOraxCommandCenter() {
    const workspaceScanned =
      latestScan?.status === "completed" || Boolean(selectedRepository?.lastScanAt);
    const primaryWorkspaceActionLabel = !selectedRepository
      ? "Connect GitHub"
      : !workspaceScanned
        ? "Scan files"
        : "New chat";
    const primaryWorkspaceActionIcon = !selectedRepository ? (
      <GitBranch className="h-4 w-4" />
    ) : !workspaceScanned ? (
      <RefreshCw className={cn("h-4 w-4", scanningRepository ? "animate-spin" : "")} />
    ) : (
      <PenLine className="h-4 w-4" />
    );

    function runPrimaryWorkspaceAction() {
      if (!selectedRepository) {
        setWorkspaceMenuOpen(false);
        setMobileTaskOpen(false);
        return;
      }
      if (!workspaceScanned) {
        void scanRepository();
        return;
      }
      setWorkspaceMenuOpen(false);
      startNewThread();
    }

    return (
      <div
        className="fixed inset-0 z-50 bg-background/55 backdrop-blur-sm"
        onClick={() => setWorkspaceMenuOpen(false)}
      >
        <div
          className="absolute inset-x-4 top-20 max-h-[calc(100dvh-6rem)] overflow-y-auto rounded-3xl border border-border bg-card p-4 shadow-2xl lg:left-auto lg:right-4 lg:top-16 lg:w-[420px]"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-base font-semibold">Orax Command Center</div>
              <div className="text-xs text-muted-foreground">Workspace, repos, and next moves</div>
            </div>
            <button
              type="button"
              onClick={() => setWorkspaceMenuOpen(false)}
              className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-muted"
              aria-label="Close Orax menu"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-4 rounded-2xl border border-border bg-background p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold">
                  {selectedRepository
                    ? `${selectedRepository.owner}/${selectedRepository.name}`
                    : "No repository connected"}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {selectedRepository
                    ? `${selectedRepository.defaultBranch || "main"} - ${
                        selectedRepository.connectionStatus === "read_only"
                          ? "GitHub connected"
                          : "metadata only"
                      }`
                    : "Connect a repository to start Orax work."}
                </div>
              </div>
              <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {latestScan ? `${latestScan.fileCount} files` : "not scanned"}
              </span>
            </div>
            <div className="mt-3 space-y-2">
              <button
                type="button"
                onClick={runPrimaryWorkspaceAction}
                disabled={scanningRepository}
                className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full bg-foreground px-3 text-sm font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
              >
                {primaryWorkspaceActionIcon}
                {primaryWorkspaceActionLabel}
              </button>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => void scanRepository()}
                  disabled={!selectedRepository || scanningRepository}
                  className="inline-flex h-9 items-center justify-center gap-1 rounded-full border border-border px-2 text-xs font-semibold hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {scanningRepository ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                  Scan
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setWorkspaceMenuOpen(false);
                    setMobileTaskOpen(false);
                  }}
                  className="inline-flex h-9 items-center justify-center gap-1 rounded-full border border-border px-2 text-xs font-semibold hover:bg-muted"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                  Connect
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs font-semibold uppercase text-muted-foreground">
              Switch workspace
            </div>
            <div className="mt-2 space-y-1.5">
              {repositories.length ? (
                repositories.slice(0, 6).map((repo) => (
                  <button
                    key={repo.id}
                    type="button"
                    onClick={() => selectRepositoryFromMenu(repo)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-left text-sm",
                      repo.id === selectedRepository?.id
                        ? "border-foreground bg-muted"
                        : "border-border hover:bg-muted",
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {repo.owner}/{repo.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {repo.connectionStatus === "read_only" ? "GitHub connected" : "metadata"}
                      </span>
                    </span>
                    {repo.id === selectedRepository?.id ? <Check className="h-4 w-4" /> : null}
                  </button>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
                  No repositories yet.
                </div>
              )}
            </div>
          </div>

          <div className="mt-4">
            <div className="text-xs font-semibold uppercase text-muted-foreground">
              Recent tasks
            </div>
            <div className="mt-2 space-y-1.5">
              {menuTasks.length ? (
                menuTasks.map((task) => (
                  <button
                    key={task.id}
                    type="button"
                    onClick={() => selectTaskFromMenu(task)}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border px-3 py-2 text-left text-sm hover:bg-muted"
                  >
                    <span className="min-w-0 truncate">{task.title || task.prompt}</span>
                    <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                      {task.status}
                    </span>
                  </button>
                ))
              ) : (
                <div className="rounded-2xl border border-dashed border-border px-3 py-5 text-sm text-muted-foreground">
                  No Orax tasks in this workspace yet.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background text-foreground lg:h-[100dvh] lg:min-h-0 lg:overflow-hidden">
      <header className="flex h-20 shrink-0 items-center justify-between bg-background px-5 lg:hidden">
        <button
          type="button"
          onClick={() => (mobileTaskOpen ? setMobileTaskOpen(false) : setWorkspaceMenuOpen(true))}
          className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-foreground"
          aria-label={mobileTaskOpen ? "Back to Orax tasks" : "Open menu"}
        >
          {mobileTaskOpen ? <ArrowLeft className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
        <div className="min-w-0 px-3 text-center">
          <h1 className="truncate text-lg font-semibold">
            {mobileTaskOpen ? (selectedTask?.title ?? "New chat") : "Orax"}
          </h1>
          {mobileTaskOpen && selectedTaskRepository ? (
            <p className="truncate text-xs text-muted-foreground">
              {selectedTaskRepository.owner}/{selectedTaskRepository.name}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => setWorkspaceMenuOpen(true)}
          className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-muted text-foreground"
          aria-label="Orax options"
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      </header>

      <header className="hidden h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4 lg:flex">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href="/mode-select"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Back to mode select"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">Orax</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setWorkspaceMenuOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Open Orax menu"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
          <ThemeToggle />
        </div>
      </header>

      {workspaceMenuOpen ? renderOraxCommandCenter() : null}

      <main
        className={cn(
          "grid flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)] lg:min-h-0 lg:overflow-hidden",
        )}
      >
        <aside
          className={cn(
            "order-1 flex flex-col bg-background lg:order-none lg:min-h-0 lg:border-r lg:border-border lg:bg-muted/20",
            mobileTaskOpen ? "hidden lg:flex" : "flex",
          )}
        >
          <div className="p-5 lg:border-b lg:border-border lg:p-3">
            {renderWorkspaceChips()}
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-xl font-semibold lg:text-base lg:font-semibold lg:text-foreground">
                  Projects
                </div>
                <div className="mt-8 flex items-center gap-3 text-lg font-medium lg:mt-0 lg:text-sm lg:font-semibold">
                  <Folder className="h-5 w-5 text-muted-foreground lg:hidden" />
                  <span className="truncate">
                    {selectedRepository
                      ? `${selectedRepository.owner}/${selectedRepository.name}`
                      : "Connect a repository"}
                  </span>
                </div>
              </div>
              {loading ? <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /> : null}
            </div>
            <button
              type="button"
              onClick={startNewThread}
              className="mt-4 hidden h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-background px-3 text-sm font-medium hover:bg-muted lg:inline-flex"
            >
              <PenLine className="h-4 w-4" />
              New chat
            </button>
          </div>

          <div className="flex-1 px-5 pb-28 lg:min-h-0 lg:overflow-y-auto lg:p-2">
            {!selectedRepository ? (
              renderRepositoryConnectionPanel(true)
            ) : (
              <div className="space-y-5 lg:space-y-2">
                {renderRepositoryStatusPanel(true)}
                {visibleTasks.length === 0 ? (
                  <div className="rounded-md border border-dashed border-border bg-background px-3 py-8 text-center text-sm text-muted-foreground">
                    No tasks yet. Start a chat to create an Orax thread.
                  </div>
                ) : (
                  <div className="space-y-5 lg:space-y-1.5">
                    {visibleTasks.map((task) => {
                      const repo = repositories.find((item) => item.id === task.repositoryId);
                      const active = task.id === selectedTask?.id;
                      return (
                        <button
                          key={task.id}
                          type="button"
                          onClick={() => {
                            setSelectedTaskId(task.id);
                            setSelectedRepoId(task.repositoryId);
                            setMobileTaskOpen(true);
                          }}
                          className={cn(
                            "w-full text-left transition-colors lg:rounded-md lg:border lg:px-3 lg:py-2",
                            active
                              ? "lg:border-primary lg:bg-background lg:shadow-sm"
                              : "lg:border-transparent lg:hover:border-border lg:hover:bg-background",
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="truncate text-lg font-normal lg:text-sm lg:font-medium">
                                {task.title || task.prompt || `Task #${task.id}`}
                              </div>
                              <div className="mt-1 hidden truncate text-xs text-muted-foreground lg:block">
                                {repo ? `${repo.owner}/${repo.name}` : "repository"} - {task.status}
                              </div>
                            </div>
                            <span className="hidden rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground lg:inline-flex">
                              {task.kind}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
            <div className="mt-12 space-y-5 lg:hidden">
              <div className="flex items-center gap-2 text-xl font-semibold">Chats</div>
              <button
                type="button"
                onClick={() => {
                  if (selectedTask) {
                    setMobileTaskOpen(true);
                    return;
                  }
                  startNewThread();
                }}
                className="block max-w-full truncate text-left text-lg text-foreground"
              >
                {selectedRepository ? chatPreview : "Connect GitHub repository"}
              </button>
            </div>
          </div>

          <div className="hidden" aria-hidden="true">
            <details className="rounded-md border border-border bg-background">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Repository</summary>
              <div className="space-y-2 border-t border-border p-3">
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
            </details>
          </div>
          <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-3 bg-background/95 px-6 py-4 backdrop-blur lg:hidden">
            <label className="flex min-w-0 flex-1 items-center gap-3 rounded-full bg-muted px-4 py-3 text-muted-foreground shadow-sm">
              <Search className="h-5 w-5 shrink-0" />
              <input
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder="Search Chats"
                className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
              />
            </label>
            <button
              type="button"
              onClick={selectedRepository ? startNewThread : () => setMobileTaskOpen(false)}
              className="inline-flex h-12 shrink-0 items-center gap-2 rounded-full bg-foreground px-5 text-base font-semibold text-background"
            >
              {selectedRepository ? (
                <PenLine className="h-5 w-5" />
              ) : (
                <GitBranch className="h-5 w-5" />
              )}
              {selectedRepository ? "Chat" : "Connect"}
            </button>
          </div>
        </aside>

        <section
          className={cn(
            "order-2 min-h-[calc(100dvh-5rem)] flex-col bg-background lg:order-none lg:flex lg:min-h-0",
            mobileTaskOpen ? "flex" : "hidden",
          )}
        >
          {error ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <div className="hidden shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 lg:flex">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">
                {selectedTask?.title || selectedTask?.prompt || "Start an Orax task"}
              </h2>
              <p className="truncate text-xs text-muted-foreground">
                {selectedTaskRepository
                  ? `${selectedTaskRepository.owner}/${selectedTaskRepository.name}`
                  : "Connect a repository to begin"}
                {selectedTask ? ` - task #${selectedTask.id} - ${selectedTask.status}` : ""}
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 lg:px-4">
            {!selectedRepository ? (
              <div className="flex h-full items-center justify-center py-10">
                {renderRepositoryConnectionPanel(false)}
              </div>
            ) : !selectedTask ? (
              <div className="flex h-full items-center justify-center py-10">
                {renderRepositoryStatusPanel(false)}
              </div>
            ) : visibleTaskMessages.length === 0 ? (
              <div className="h-full" aria-label="Empty Orax thread" />
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col gap-3">
                {visibleTaskMessages.map((message) => {
                  const isUser = message.role === "user";
                  const runnerActivity = getOraxRunnerActivity(message);
                  const messageAttachments = getMessageComposerAttachments(message);
                  const suggestions =
                    message.role === "assistant" &&
                    message.id === latestAssistantSuggestionMessageId &&
                    !pendingSuggestionConfirmation
                      ? (message.metadata?.actionSuggestions ?? []).slice(0, 1)
                      : [];
                  return (
                    <article
                      key={message.id}
                      className={cn(
                        "px-4 py-3 text-base lg:rounded-md lg:border lg:text-sm",
                        isUser
                          ? "ml-auto max-w-[78%] rounded-3xl bg-muted/70 text-foreground lg:border-border"
                          : "bg-transparent lg:border-transparent lg:bg-transparent",
                      )}
                    >
                      <div className="hidden">
                        {isUser ? "You" : message.role === "tool" ? "Tool result" : "Orax"}
                        {message.createdAt
                          ? ` - ${new Date(message.createdAt).toLocaleString()}`
                          : ""}
                      </div>
                      {runnerActivity ? (
                        <OraxRunnerActivityRow activity={runnerActivity} />
                      ) : (
                        <div className="whitespace-pre-wrap leading-relaxed">
                          {formatOraxVisibleThreadContent(message)}
                        </div>
                      )}
                      {messageAttachments.length ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {messageAttachments.map((attachment) => (
                            <span
                              key={attachment.id}
                              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground"
                            >
                              <FileText className="h-3.5 w-3.5 shrink-0" />
                              <span className="truncate">{attachment.name}</span>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {suggestions.length ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {suggestions.map((suggestion, index) => (
                            <button
                              key={`${suggestion.type}-${suggestion.artifactId ?? suggestion.approvalId ?? index}`}
                              type="button"
                              title={suggestion.description}
                              onClick={() => applyTaskActionSuggestion(suggestion)}
                              className="inline-flex h-9 items-center rounded-full bg-foreground px-4 text-sm font-medium text-background transition hover:opacity-90"
                            >
                              {suggestion.buttonLabel ?? suggestion.title}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
                {pendingSuggestionConfirmation ? (
                  <section className="rounded-md border border-border bg-card px-4 py-3 text-sm">
                    <div className="text-[11px] font-semibold uppercase text-muted-foreground">
                      Confirm action
                    </div>
                    <div className="mt-1 font-medium">{pendingSuggestionConfirmation.title}</div>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {pendingSuggestionConfirmation.description}
                    </p>
                    {pendingSuggestionConfirmation.type === "github_pr" ? (
                      <input
                        value={suggestionPrConfirmationText}
                        onChange={(event) => setSuggestionPrConfirmationText(event.target.value)}
                        placeholder="Type CREATE PR"
                        className="mt-3 h-10 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
                      />
                    ) : null}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void confirmTaskActionSuggestion()}
                        className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
                      >
                        {pendingSuggestionConfirmation.buttonLabel ??
                          pendingSuggestionConfirmation.title}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setPendingSuggestionConfirmation(null);
                          setSuggestionPrConfirmationText("");
                        }}
                        className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  </section>
                ) : null}
                {selectedTask &&
                !primaryThreadSuggestion &&
                !pendingSuggestionConfirmation &&
                pendingApprovals.length === 0 ? (
                  <div className="flex justify-start">
                    <button
                      type="button"
                      onClick={() => void continueSelectedTask()}
                      disabled={continuingTask}
                      className="inline-flex h-9 items-center gap-2 rounded-full border border-border bg-background px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
                    >
                      {continuingTask ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Continue
                    </button>
                  </div>
                ) : null}
                {approvals
                  .filter(
                    (approval) => approval.status === "pending" || approval.status === "approved",
                  )
                  .map((approval) => (
                    <section
                      key={approval.id}
                      className="max-w-xl rounded-3xl border border-border bg-card px-4 py-3 text-sm shadow-sm"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium">
                            {formatOraxApprovalAction(approval.action)}
                          </div>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {approval.status === "pending"
                              ? "Waiting for your approval"
                              : "Ready to continue"}
                          </p>
                        </div>
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      </div>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {describeOraxApprovalLifecycle(approval)}
                      </p>
                      {approval.status === "pending" ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void decideApproval(approval.id, "approved")}
                            disabled={decidingApprovalId === approval.id}
                            className="inline-flex h-9 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-60"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() => void decideApproval(approval.id, "denied")}
                            disabled={decidingApprovalId === approval.id}
                            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-60"
                          >
                            Deny
                          </button>
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (approval.action === "read_files") {
                                void continueTaskById(approval.taskId);
                              } else if (approval.action === "sandbox_run") {
                                void continueTaskById(approval.taskId);
                              } else if (approval.action === "safe_check") {
                                void continueTaskById(approval.taskId);
                              } else if (approval.action === "github_pr") {
                                void createGithubPr(approval.id);
                              }
                            }}
                            className="inline-flex h-9 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
                          >
                            Continue
                          </button>
                        </div>
                      )}
                    </section>
                  ))}
              </div>
            )}
          </div>

          <div className="shrink-0 border-t border-border bg-background p-3">
            <div className="mx-auto max-w-4xl">
              <div className="rounded-[2rem] border border-border bg-card p-3 shadow-[0_18px_45px_rgba(15,23,42,0.12)]">
                {composerAttachments.length ? (
                  <div className="mb-2 flex flex-wrap gap-2 px-1">
                    {composerAttachments.map((attachment) => (
                      <span
                        key={attachment.id}
                        className="inline-flex max-w-full items-center gap-2 rounded-xl bg-muted px-2 py-1 text-sm text-foreground"
                      >
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{attachment.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {attachment.ingestionStatus === "ready" ? "read" : "not read"}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeComposerAttachment(attachment.id)}
                          className="rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                          aria-label={`Remove ${attachment.name}`}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                ) : null}
                {visibleSlashCommands.length ? (
                  <div
                    data-orax-slash-command-menu
                    className="mb-2 grid gap-1 rounded-2xl border border-border bg-background p-2"
                  >
                    {visibleSlashCommands.map((command) => (
                      <button
                        key={command.command}
                        type="button"
                        onClick={() => setTaskMessageDraft(`${command.command} `)}
                        className="flex items-start gap-3 rounded-xl px-3 py-2 text-left hover:bg-muted"
                      >
                        <span className="shrink-0 font-semibold text-foreground">
                          {command.command}
                        </span>
                        <span className="min-w-0 text-sm">
                          <span className="block font-medium">{command.label}</span>
                          <span className="block text-muted-foreground">{command.description}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}
                <textarea
                  value={taskMessageDraft}
                  onChange={(event) => setTaskMessageDraft(event.target.value)}
                  placeholder="Ask Orax"
                  className="min-h-[86px] w-full resize-none bg-transparent px-2 py-2 text-xl leading-7 outline-none placeholder:text-muted-foreground"
                />
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void addComposerFiles(event.currentTarget.files);
                    event.currentTarget.value = "";
                  }}
                />
                <div className="flex items-center gap-3 px-1 pb-1">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted"
                    aria-label="Attach files to Orax message"
                  >
                    <Plus className="h-7 w-7" />
                  </button>
                  <button
                    type="button"
                    onClick={cycleComposerPermissionMode}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950/30"
                    aria-label={`Orax permission mode: ${composerPermissionMode}`}
                    title={`Permission: ${composerPermissionMode.replace("_", " ")}`}
                  >
                    <ShieldAlert className="h-7 w-7" />
                  </button>
                  <div className="relative min-w-0 flex-1 text-center">
                    <button
                      type="button"
                      onClick={() => setComposerSettingsOpen((value) => !value)}
                      className="max-w-full rounded-full px-3 py-1 text-lg font-semibold text-foreground hover:bg-muted"
                      aria-label="Choose Orax model and reasoning"
                    >
                      <span>{composerModel.replace("Orax ", "")}</span>{" "}
                      <span className="font-normal text-muted-foreground">
                        {ORAX_REASONING_OPTIONS.find((option) => option.value === composerReasoning)
                          ?.label ?? "Extra High"}
                      </span>
                    </button>
                    {composerSettingsOpen ? (
                      <div className="absolute bottom-11 left-1/2 z-20 w-64 -translate-x-1/2 rounded-2xl border border-border bg-popover p-3 text-left shadow-xl">
                        <div className="text-xs font-semibold uppercase text-muted-foreground">
                          Model
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {ORAX_COMPOSER_MODELS.map((model) => (
                            <button
                              key={model}
                              type="button"
                              onClick={() => setComposerModel(model)}
                              className={cn(
                                "rounded-full border px-3 py-1 text-sm",
                                composerModel === model
                                  ? "border-foreground bg-foreground text-background"
                                  : "border-border hover:bg-muted",
                              )}
                            >
                              {model}
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 text-xs font-semibold uppercase text-muted-foreground">
                          Reasoning
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2">
                          {ORAX_REASONING_OPTIONS.map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              onClick={() => setComposerReasoning(option.value)}
                              className={cn(
                                "rounded-full border px-3 py-1 text-sm",
                                composerReasoning === option.value
                                  ? "border-foreground bg-foreground text-background"
                                  : "border-border hover:bg-muted",
                              )}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={toggleComposerVoiceInput}
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-foreground hover:bg-muted",
                      voiceRecording && "bg-muted text-primary",
                    )}
                    aria-label={voiceRecording ? "Stop Orax voice input" : "Start Orax voice input"}
                  >
                    <Mic className="h-7 w-7" />
                  </button>
                  <button
                    onClick={() => void sendTaskMessage()}
                    disabled={
                      (!taskMessageDraft.trim() && composerAttachments.length === 0) ||
                      (!selectedTask && !selectedRepository) ||
                      sendingTaskMessage ||
                      submittingTask
                    }
                    aria-label="Send Orax message"
                    className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-foreground text-background disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    {sendingTaskMessage || submittingTask ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUp className="h-7 w-7" strokeWidth={3} />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>

        <aside className="hidden" aria-hidden="true">
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
                  onClick={() => setShowInspector(false)}
                  className="inline-flex h-8 items-center rounded-md border border-border px-2 text-xs hover:bg-muted"
                >
                  Close
                </button>
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
                    <div
                      key={approval.id}
                      className="rounded-md border border-border bg-background p-2"
                    >
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
                    <div
                      key={item.id}
                      className="rounded-md border border-border bg-background p-2"
                    >
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
                    : completedReadApproval
                      ? void generateDraftPatch(completedReadApproval.id)
                      : undefined
                }
                disabled={!selectedTask || (!latestDraftPatch && !completedReadApproval)}
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
                  latestWorkspaceChangeSet || latestSandboxResult
                    ? void requestCommandApproval(
                        (latestWorkspaceChangeSet ?? latestSandboxResult)!.id,
                      )
                    : undefined
                }
                disabled={
                  (!latestWorkspaceChangeSet && !latestSandboxResult) ||
                  selectedCommandIds.length === 0
                }
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
                  latestCommandResult
                    ? void requestGithubPrApproval(latestCommandResult.id)
                    : undefined
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
              <div className="text-xs font-semibold uppercase text-muted-foreground">
                Repository
              </div>
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

function OraxRunnerActivityRow({ activity }: { activity: OraxRunnerActivity }) {
  const isRunning = activity.status === "running" || activity.status === "waiting";
  const isProblem = activity.status === "failed" || activity.status === "blocked";
  return (
    <div
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-sm",
        isProblem
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted/60 text-muted-foreground",
      )}
    >
      {isRunning ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
      ) : isProblem ? (
        <ShieldAlert className="h-4 w-4 shrink-0" />
      ) : (
        <Check className="h-4 w-4 shrink-0" />
      )}
      <span className="truncate font-medium">{activity.label}</span>
    </div>
  );
}

function formatOraxApprovalAction(action: string): string {
  switch (action) {
    case "read_files":
      return "Inspect files";
    case "sandbox_run":
      return "Check changes";
    case "safe_check":
      return "Run checks";
    case "github_pr":
      return "Prepare pull request";
    default:
      return action.replace(/_/g, " ");
  }
}

function formatOraxArtifactLifecycleLabel(type: string): string {
  switch (type) {
    case "execution_session":
      return "Execution session";
    case "draft_patch":
      return "Draft patch generated";
    case "sandbox_result":
      return "Sandbox result";
    case "workspace_change_set":
      return "Workspace change set";
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
    if (approval.status === "completed" && approval.result?.files?.length) {
      return `Inspected ${approval.result.files.length} file${
        approval.result.files.length === 1 ? "" : "s"
      }; total ${formatBytes(approval.result.totalBytes ?? 0)}.`;
    }
    const fileCount = approval.request.paths?.length ?? 0;
    return fileCount
      ? `Will inspect ${fileCount} file${fileCount === 1 ? "" : "s"}.`
      : "Will inspect selected files.";
  }
  if (approval.action === "sandbox_run") {
    return "Will check the prepared change.";
  }
  if (approval.action === "safe_check") {
    return approval.request.scope ? `Will run ${approval.request.scope}.` : "Will run checks.";
  }
  if (approval.action === "github_pr") {
    if (approval.result?.pullRequestUrl) {
      return `Pull request created: ${approval.result.pullRequestUrl}`;
    }
    return "Will prepare the pull request.";
  }
  return approval.riskSummary ?? "Confirm the next step.";
}

function describeOraxArtifactLifecycle(artifact: OraxArtifact): string {
  if (artifact.type === "execution_session") {
    const steps = artifact.payload.steps?.length ?? 0;
    return `Execution session ${artifact.status}; ${steps} step${steps === 1 ? "" : "s"} recorded.`;
  }
  if (artifact.type === "draft_patch") {
    if (artifact.payload.retryOfArtifactId) {
      return (
        artifact.summary ??
        `Retry patch attempt ${artifact.payload.retryAttempt ?? 1} for failed artifact #${artifact.payload.retryOfArtifactId}.`
      );
    }
    return artifact.summary ?? "Review-only patch preview generated from approved source files.";
  }
  if (artifact.type === "sandbox_result") {
    const changedFiles = artifact.payload.changedFiles?.length ?? 0;
    return artifact.payload.applied
      ? `Sandbox applied the patch preview to ${changedFiles} file${changedFiles === 1 ? "" : "s"}.`
      : "Sandbox could not apply the patch preview. Review the blocker before continuing.";
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
    if (artifact.payload.pullRequestUrl) {
      return `Pull request created on ${artifact.payload.branchName ?? "the ORAX branch"}.`;
    }
    return artifact.payload.error?.message ?? "GitHub PR result recorded.";
  }
  return artifact.summary ?? "ORAX workflow artifact recorded.";
}

function _OraxThreadLifecycleDetails({ item }: { item: OraxThreadLifecycleItem }) {
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

  if (artifact.type === "workspace_change_set") {
    const changedFiles = artifact.payload.changedFiles ?? [];
    const patchedFiles = artifact.payload.patchedFiles ?? [];
    const rollbackFiles = artifact.payload.rollback?.sourceFiles ?? [];
    const diff = artifact.payload.diffSummary ?? summarizeUnifiedDiff(artifact.payload.unifiedDiff);
    const fileDiffs = parseOraxUnifiedDiffFiles(artifact.payload.unifiedDiff);

    return (
      <div className="mt-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
        <div className="font-medium uppercase text-foreground">Workspace change-set details</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <Metric label="Changed files" value={String(changedFiles.length)} />
          <Metric label="Snapshots" value={String(patchedFiles.length)} />
          <Metric
            label="Diff"
            value={diff ? `+${diff.additions ?? 0} / -${diff.deletions ?? 0}` : "none"}
          />
        </div>
        <WorkspaceChangeSetDiffReview changedFiles={changedFiles} fileDiffs={fileDiffs} />
        {rollbackFiles.length ? (
          <div className="mt-1">
            Rollback snapshot:{" "}
            {rollbackFiles
              .map((file) => `${file.path}${file.sha ? ` @ ${file.sha.slice(0, 7)}` : ""}`)
              .join(", ")}
          </div>
        ) : null}
        <_ArtifactTrace artifact={artifact} />
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
    if (current.lines.length < 220) {
      current.lines.push({ type, content: rawLine });
    } else {
      current.truncated = true;
    }
  }

  if (current) files.push(current);
  return files.filter((file) => file.path && file.path !== "/dev/null").slice(0, 12);
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

function WorkspaceChangeSetDiffReview({
  changedFiles,
  fileDiffs,
}: {
  changedFiles: NonNullable<OraxArtifact["payload"]["changedFiles"]>;
  fileDiffs: OraxFileDiff[];
}) {
  if (!changedFiles.length && !fileDiffs.length) return null;
  const diffByPath = new Map(fileDiffs.map((file) => [file.path, file]));
  const ordered = changedFiles.length
    ? changedFiles.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        diff: diffByPath.get(file.path),
      }))
    : fileDiffs.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
        diff: file,
      }));

  return (
    <div className="mt-2 space-y-2">
      {ordered.map((file) => (
        <details key={file.path} className="group rounded-md border border-border bg-muted/20">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-foreground">
            <span className="min-w-0 truncate font-medium">{file.path}</span>
            <span className="shrink-0 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground">
              +{file.additions ?? file.diff?.additions ?? 0} / -
              {file.deletions ?? file.diff?.deletions ?? 0}
            </span>
          </summary>
          {file.diff?.lines.length ? (
            <pre className="max-h-72 overflow-auto border-t border-border bg-background px-0 py-2 text-[11px] leading-5">
              {file.diff.lines.map((line, index) => (
                <div
                  key={`${file.path}-${index}`}
                  className={cn(
                    "whitespace-pre px-3 font-mono",
                    line.type === "add" &&
                      "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                    line.type === "remove" && "bg-destructive/10 text-destructive",
                    line.type === "meta" && "bg-muted text-muted-foreground",
                  )}
                >
                  {line.content || " "}
                </div>
              ))}
              {file.diff.truncated ? (
                <div className="px-3 py-1 text-[11px] text-muted-foreground">
                  Diff preview truncated.
                </div>
              ) : null}
            </pre>
          ) : (
            <div className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
              Diff preview unavailable for this file.
            </div>
          )}
        </details>
      ))}
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

function _ArtifactTrace({ artifact }: { artifact: OraxArtifact }) {
  const payload = artifact.payload;
  const items = [
    { label: "Read approval", id: payload.sourceApprovalId, kind: "approval" },
    { label: "Draft patch", id: payload.draftArtifactId, kind: "artifact" },
    { label: "Sandbox validation", id: payload.sourceArtifactId, kind: "artifact" },
    {
      label: "Workspace change set",
      id:
        payload.workspaceChangeSetArtifactId ??
        (artifact.type === "workspace_change_set" ? artifact.id : undefined),
      kind: "artifact",
    },
    {
      label: "Workspace checks",
      id:
        artifact.type === "command_result" ? (payload.commandArtifactId ?? artifact.id) : undefined,
      kind: "artifact",
    },
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
