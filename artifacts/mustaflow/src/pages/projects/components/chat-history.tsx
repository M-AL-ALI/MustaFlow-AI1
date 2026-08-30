import { authFetch } from "@/lib/api-fetch";
import { useEffect, useRef, useState, useCallback, isValidElement } from "react";
import {
  Search,
  X,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Lightbulb,
  ShieldAlert,
  ShieldCheck,
  Check,
  Ban,
  RotateCcw,
  History,
  Cpu,
  Zap,
  Navigation,
  Loader2,
  MessageCircle,
  Wand2,
  Wrench,
  FlaskConical,
  RefreshCw,
  XCircle,
  FileCode,
  Sparkles,
  MessageSquarePlus,
  Bug,
  KeySquare,
  Eye,
  Paperclip,
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { cn } from "@/lib/utils";
import { InlineBuildResults } from "./inline-build-results";
import { ZeroAvatar } from "./zero-avatar";
import { PersistedRunReplay } from "./inline-run-group";
import { InlineBuilderError } from "./inline-builder-error";
import { ApplyFailureNotice } from "./apply-failure-notice";
import { EditAndResend, latestUserMessageId } from "./edit-and-resend";
import { JumpToLatestButton, nextChatFollowState, scrollChatToLatest } from "./smart-auto-scroll";
import { BuilderModeIcon, isBuilderAgentMode } from "@/components/builder-mode-icon";
import {
  getBuilderCompletionMessage,
  getBuilderWarningCompletionMessage,
} from "@/lib/builder-completion";
import { AgentIcon } from "@/components/agent-icon";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.min.css";
import {
  useCancelTask,
  getListTasksQueryKey,
  useApplyTaskStaging,
  useDiscardTaskStaging,
  getListMessagesQueryKey,
  getGetProjectQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  useRerunTaskTests,
  useListTasks,
  useListTaskEvents,
  getListTaskEventsQueryKey,
  useListTestRuns,
  getListTestRunsQueryKey,
  useListProjectFiles,
  useGetProjectFile,
  useRestoreCheckpoint,
  useListNabuflowUsage,
  getListNabuflowUsageQueryKey,
  type NabuflowUsageEvent,
} from "@workspace/api-client-react";
import { unifiedDiff } from "@/lib/line-diff";
import {
  Download,
  FileBox,
  GitCompare,
  BookOpen,
  Minus,
  Info,
  Image as ImageIcon,
  Pencil,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { terminalPresentationFor } from "@/lib/zero-terminal";

type TaskReport = {
  userRequest: string;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  /** Alias used by the staged review gate */
  filesModified?: string[];
  /** Alias used by the staged review gate */
  filesDeleted?: string[];
  /** Summary of what changed in the staged review gate */
  summary?: string;
  filesUnchanged?: string[];
  previewUpdated: boolean;
  warnings: string[];
  warningChecks?: Array<{ id: string; label: string; message: string }>;
  agentLoop?: {
    completionKind?: string | null;
    terminationReason?: string;
    skillsLoaded?: string[];
  } | null;
  integrationsNeeded?: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
  nextRecommendation?: string;
  versionId?: number | null;
  codeSmells?: string[];
  securityNotices?: Array<{
    packageName: string;
    description: string;
    upgradeTo: string;
    severity: "error" | "warning";
    cve?: string;
  }>;
  modulesWired?: Array<{ id: string }>;
  checkSummary?: string;
  checkRunsSummary?: {
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    failedChecks?: string[];
    warnChecks?: string[];
  };
  testResults?: Array<{
    name: string;
    passed: boolean;
    message: string;
    screenshotBase64?: string | null;
    durationMs: number;
  }> | null;
  testScript?: string | null;
  testRanAt?: string | null;
  syntaxValid?: boolean;
  /** Populated when a Power/Pro critique pass runs after the build */
  critiquePass?: {
    issuesFound: string[];
    autoFixed: boolean;
  } | null;
  /** Structured record of the structural/per-file validation cycle */
  validationReport?: {
    initialIssues: string[];
    fixupAttempted: boolean;
    remainingIssues: string[];
    passed: boolean;
  } | null;
  /** Architect review subagent output (Task #507) */
  architectReview?: {
    verdict: "pass" | "partial" | "fail";
    summary: string;
    findings: Array<{
      severity: "critical" | "high" | "medium" | "low";
      title: string;
      detail: string;
      file?: string | null;
    }>;
    nextActions: string[];
    autoFixQueued: boolean;
    autoFixTaskId?: number | null;
    creditsCharged?: number;
    reviewedAt: string;
    model: string;
    skipped?: boolean;
    skipReason?: string;
    isReReview?: boolean;
    completedWithWarnings?: boolean;
  };
  /** Playwright E2E run summary, populated by the agentic builder loop. */
  e2eResults?: {
    targetUrl: string | null;
    ranAt: string;
    totalDurationMs: number;
    passed: number;
    failed: number;
    skipped: number;
    skippedReason?: string | null;
    budgetExceeded: boolean;
    autoFixAttempted: boolean;
    scenarios: Array<{
      name: string;
      source: "smoke" | "user";
      passed: boolean;
      durationMs: number;
      message: string;
      consoleErrors: string[];
      networkFailures: Array<{ url: string; status: number | null; message: string }>;
      screenshotBase64?: string | null;
    }>;
  } | null;
  /** Downloadable assets the agent explicitly presented to the user (Task #531). */
  assets?: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    description?: string;
  }>;
  /** Knowledge Vault lessons that were injected into this build's context. */
  knowledgeApplied?: Array<{ id: number; title: string; type: string }> | null;
  /**
   * Quality gate result — TypeScript, ESLint, and (for server stacks) smoke test.
   * Only populated for container-based JS/TS stacks.
   */
  qualityGate?: {
    passed: boolean;
    allPassed: boolean;
    checks: Array<{
      id: string;
      label: string;
      passed: boolean;
      skipped: boolean;
      skipReason?: string;
      output: string;
      durationMs: number;
    }>;
  } | null;
  /**
   * `process.env.FOO` references in the generated code that don't map to a
   * declared project secret.
   */
  undeclaredEnvVars?: Array<{ varName: string; file: string }> | null;
  /**
   * True when all quality gate checks passed and the architect review found no
   * critical issues. Drives the "All checks passed" green banner.
   */
  allChecksPassed?: boolean | null;
  /**
   * Populated when the repair loop ran after a check-failed build/refine.
   * Null when not triggered.
   */
  repairLoop?: {
    totalAttempts: number;
    maxAttempts: number;
    finalStatus: "passed" | "exhausted";
  } | null;
  /**
   * True when the task completed but the TypeScript repair loop was exhausted.
   * Snapshot was saved with remaining validation errors.
   */
  completedWithErrors?: boolean | null;
  /**
   * Lightweight pre-review checks (JSON syntax, import resolution, E2E spec
   * detection) run server-side before the staging snapshot reaches "needs_review".
   */
  preReviewChecks?: {
    checks: Array<{
      id: string;
      label: string;
      passed: boolean;
      skipped: boolean;
      errorCount: number;
      errors: string[];
      durationMs: number;
    }>;
    allPassed: boolean;
    anyFailed: boolean;
    ranAt: string;
  } | null;
};

type StructuredPlan = {
  summary?: string;
  goal?: string;
  approach?: string;
  pages?: string[];
  backend?: string[];
  database?: string[];
  integrations?: string[];
  keysNeeded?: string[];
  filesAffected?: string[];
  risks?: string[];
  testPlan?: string[];
};

type ChatPlanPayload =
  | {
      kind: "report";
      report: TaskReport;
      taskId?: number;
      agentIdentity?: string;
      needsReview?: boolean;
      /** Quality gate failed — shows QualityGateFailureCard instead of TaskReviewCard */
      needsFix?: boolean;
    }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | { kind: "converse"; taskId?: number }
  | { kind: "clarifying"; question: string; options: string[]; taskId?: number }
  | Record<string, unknown>;

type ChatAttachment = {
  kind: "image" | "file";
  assetId?: number;
  url: string;
  alt?: string;
  name?: string;
  mime?: string;
  size?: number;
  width?: number;
  height?: number;
  generated?: boolean;
  savedPath?: string;
};

type Message = {
  id: number;
  role: string;
  content: string;
  agentMode: string;
  planMode: boolean;
  plan?: ChatPlanPayload | null | Record<string, unknown>;
  attachments?: ChatAttachment[] | null;
  createdAt: string;
  agentIdentity?: string | null;
  checkpointId?: number | null;
};

function AttachmentGallery({ attachments }: { attachments: ChatAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => {
        if (att.kind === "file") {
          return (
            <a
              key={`file-${att.assetId ?? i}`}
              href={att.url}
              className="inline-flex max-w-[220px] items-center gap-1.5 rounded-md border border-border bg-background/60 px-2 py-1.5 text-[10px] text-foreground hover:bg-muted"
              title={att.mime ?? att.name ?? "Attached file"}
            >
              <Paperclip className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{att.name ?? "Attached file"}</span>
            </a>
          );
        }
        if (!att.url) return null;
        const src = att.url.startsWith("/objects/")
          ? `/api/storage${att.url}`
          : att.url.startsWith("http")
            ? att.url
            : `/api/storage${att.url.startsWith("/") ? att.url : `/${att.url}`}`;
        return (
          <a
            key={i}
            href={src}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg overflow-hidden border border-border bg-background/60 hover:border-primary/40 transition-colors"
            title={att.alt ?? (att.generated ? "AI-generated image" : "Attached image")}
          >
            <img
              src={src}
              alt={att.alt ?? "image"}
              className="block max-h-44 max-w-[220px] object-contain"
              loading="lazy"
            />
          </a>
        );
      })}
    </div>
  );
}

function getDateLabel(dateStr: string): string {
  const d = new Date(dateStr);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return format(d, "EEE d MMM");
}

function getDateKey(dateStr: string): string {
  return new Date(dateStr).toISOString().slice(0, 10);
}

function highlightText(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const parts = text.split(regex);
  return parts.map((part, i) =>
    regex.test(part) ? (
      <mark key={i} className="bg-yellow-400/30 text-foreground rounded-sm px-0.5">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

function extractCodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractCodeText).join("");
  if (isValidElement(node)) {
    return extractCodeText((node.props as { children?: React.ReactNode }).children);
  }
  return "";
}

// Task #531: detects `path/to/file.ext` or `path/to/file.ext:42` inside an
// inline <code> block so we can render it as a clickable deep-link into the
// Code tab. Requires a slash to avoid matching ordinary inline code like
// `useState` or `npm install` — only path-shaped strings should turn into
// links.
const FILE_PATH_REF_RE = /^([\w.-]+(?:\/[\w.-]+)+)(?::(\d+))?$/;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Task #531: per-file diff row in the staged review. Lazy-fetches
 * the current file content from the project (the "before" side) and diffs it
 * against the staged content (the "after" side) when the user expands it.
 * Net-new files render as add-only; deleted files as del-only.
 */
function StagingFileDiffRow({
  projectId,
  taskId,
  path,
  stagingContent,
  status,
  onViewFile,
}: {
  projectId: number;
  taskId: number;
  path: string;
  stagingContent: string | null;
  status: "created" | "modified" | "deleted";
  onViewFile?: (path: string, line?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [explanation, setExplanation] = useState<string | null>(null);
  // explaining=true means we want an explanation but may still be waiting for file content.
  const [explaining, setExplaining] = useState(false);
  // pendingExplain=true means the streaming call should fire once currentFile is available.
  const [pendingExplain, setPendingExplain] = useState(false);

  // Fetch the file list whenever we need diff content (expanded) OR an explanation.
  // Note: deleted files need their before-content fetched too, so we exclude only "created".
  const { data: filesList } = useListProjectFiles(projectId, {
    query: {
      enabled: (open || explaining) && status !== "created",
      queryKey: getListProjectFilesQueryKey(projectId),
    },
  });
  const fileId = (filesList ?? []).find((f: { id: number; path: string }) => f.path === path)?.id;
  const {
    data: currentFile,
    isLoading: loadingCurrent,
    isError: errorLoadingCurrent,
  } = useGetProjectFile(projectId, fileId ?? 0, {
    query: {
      enabled: (open || explaining) && status !== "created" && !!fileId,
      queryKey: ["getProjectFile", projectId, fileId ?? 0] as const,
    },
  });

  // Distinguishes "couldn't fetch the before-side content" from a true empty
  // diff so the reviewer isn't shown a false "no changes" message.
  const beforeUnavailable =
    open &&
    status !== "created" &&
    !loadingCurrent &&
    (!fileId || errorLoadingCurrent || !currentFile);

  const colorClass =
    status === "created"
      ? "text-green-400 border-green-500/20 bg-green-500/10 hover:bg-green-500/20"
      : status === "modified"
        ? "text-yellow-400 border-yellow-500/20 bg-yellow-500/10 hover:bg-yellow-500/20"
        : "text-red-400 border-red-500/20 bg-red-500/10 hover:bg-red-500/20";

  const before = status === "created" ? "" : (currentFile?.content ?? "");
  const after = status === "deleted" ? "" : (stagingContent ?? "");
  const hunks =
    open && !beforeUnavailable && (status === "created" || currentFile || status === "deleted")
      ? unifiedDiff(before, after, 2)
      : [];

  // Stream the explanation from the backend, rendering tokens as they arrive.
  const fireExplain = async (beforeContent: string) => {
    // For deleted files: beforeContent = existing file content, after = "" (file removed).
    // For created files: beforeContent = "", after = new content.
    const afterContent = status === "deleted" ? "" : (stagingContent ?? "");
    try {
      const resp = await authFetch(`/api/projects/${projectId}/tasks/${taskId}/explain-change`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ path, before: beforeContent, after: afterContent }),
      });
      if (!resp.ok || !resp.body) {
        setExplanation("Unable to generate explanation.");
        setExplaining(false);
        setPendingExplain(false);
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let partial = "";
      setExplanation(""); // start streaming (empty → triggers the rendering area)
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        setExplanation(partial);
      }
    } catch {
      setExplanation("Unable to generate explanation.");
    } finally {
      setExplaining(false);
      setPendingExplain(false);
    }
  };

  // When a pending explain fires after file content becomes available.
  useEffect(() => {
    if (!pendingExplain) return;
    if (status === "created") {
      // Net-new file: no before-content to wait for.
      setPendingExplain(false);
      void fireExplain("");
      return;
    }
    if (currentFile !== undefined) {
      // File content ready (modified or deleted — both need before-content).
      setPendingExplain(false);
      void fireExplain(currentFile?.content ?? "");
    }
    // else: still loading — effect re-runs once currentFile lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExplain, currentFile, status]);

  const handleExplain = () => {
    if (explanation !== null || explaining) return;
    setExplaining(true);
    if (status === "created") {
      // Net-new file: no before-content needed.
      void fireExplain("");
    } else if (currentFile !== undefined) {
      // Before-content already in cache (works for both modified and deleted).
      void fireExplain(currentFile?.content ?? "");
    } else {
      // Need to load before-content first; effect above will fire when ready.
      setPendingExplain(true);
    }
  };

  return (
    <div className="border border-border/50 rounded overflow-hidden">
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex-1 flex items-center gap-1 text-[10px] px-1.5 py-1 font-mono rounded-l border-r-0 transition-colors",
            colorClass,
          )}
        >
          {open ? (
            <ChevronDown className="h-2.5 w-2.5" />
          ) : (
            <ChevronRight className="h-2.5 w-2.5" />
          )}
          <GitCompare className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate text-left flex-1">{path}</span>
        </button>
        <button
          type="button"
          onClick={handleExplain}
          disabled={explaining}
          className="text-[9px] px-1.5 py-1 text-muted-foreground hover:text-primary border-l border-border/50 transition-colors flex items-center gap-0.5 shrink-0"
          title="Explain this change"
        >
          {explaining ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
          ) : (
            <Sparkles className="h-2.5 w-2.5" />
          )}
        </button>
        {onViewFile && status !== "deleted" && (
          <button
            type="button"
            onClick={() => onViewFile(path)}
            className="text-[9px] px-1.5 py-1 text-muted-foreground hover:text-foreground border-l border-border/50 transition-colors"
            title="Open in Code tab"
          >
            <ExternalLink className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
      {explanation && (
        <div className="px-2.5 py-1.5 bg-primary/5 border-t border-border/30 text-[10px] text-muted-foreground italic flex items-start gap-1.5">
          <Sparkles className="h-2.5 w-2.5 text-primary/70 shrink-0 mt-0.5" />
          <span>{explanation}</span>
        </div>
      )}
      {open && (
        <div className="bg-background/60 px-1 py-1 max-h-64 overflow-auto font-mono text-[10px] leading-snug">
          {status !== "created" && loadingCurrent ? (
            <div className="text-muted-foreground italic px-2 py-1">Loading current contents…</div>
          ) : beforeUnavailable ? (
            <div className="text-amber-400/80 italic px-2 py-1">
              Unable to load current file contents — diff preview unavailable.
            </div>
          ) : hunks.length === 0 ? (
            <div className="text-muted-foreground italic px-2 py-1">No textual changes.</div>
          ) : (
            hunks.map((h, hi) => (
              <div key={hi} className="mb-1">
                <div className="text-muted-foreground/60 text-[9px] px-1">
                  @@ -{h.oldStart} +{h.newStart} @@
                </div>
                {h.lines.map((l, li) => (
                  <div
                    key={li}
                    className={cn(
                      "px-1 whitespace-pre",
                      l.type === "add" && "bg-green-500/10 text-green-300",
                      l.type === "del" && "bg-red-500/10 text-red-300",
                      l.type === "context" && "text-muted-foreground/80",
                    )}
                  >
                    {l.type === "add" ? "+" : l.type === "del" ? "-" : " "}
                    {l.text}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function MarkdownMessage({
  content,
  onApply,
  onViewFile,
}: {
  content: string;
  onApply?: (code: string) => void;
  onViewFile?: (path: string, line?: number) => void;
}) {
  return (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none text-foreground",
        "[&_p]:text-xs [&_p]:leading-relaxed [&_p:last-child]:mb-0 [&_p]:my-1",
        "[&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1",
        "[&_h2]:text-xs [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1",
        "[&_h3]:text-xs [&_h3]:font-medium [&_h3]:mt-1.5 [&_h3]:mb-0.5",
        "[&_ul]:text-xs [&_ul]:pl-4 [&_ul]:my-1 [&_ul_li]:my-0.5",
        "[&_ol]:text-xs [&_ol]:pl-4 [&_ol]:my-1 [&_ol_li]:my-0.5",
        "[&_code]:text-[11px] [&_code]:bg-background/70 [&_code]:border [&_code]:border-border/50 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono",
        "[&_pre]:bg-background [&_pre]:border [&_pre]:border-border/60 [&_pre]:rounded-lg [&_pre]:overflow-x-auto [&_pre]:p-3 [&_pre]:my-2",
        "[&_pre_code]:bg-transparent [&_pre_code]:border-0 [&_pre_code]:p-0 [&_pre_code]:text-[11px]",
        "[&_blockquote]:border-l-2 [&_blockquote]:border-primary/30 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground",
        "[&_strong]:font-semibold [&_strong]:text-foreground",
        "[&_a]:text-primary [&_a]:underline-offset-2 [&_a]:hover:underline",
        "[&_hr]:border-border/40 [&_hr]:my-2",
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          ...(onApply
            ? {
                pre({ children, ...props }: { children?: React.ReactNode }) {
                  return (
                    <div>
                      <pre {...props}>{children}</pre>
                      <button
                        onClick={() => {
                          const code = extractCodeText(children).replace(/\n$/, "");
                          if (code.trim()) onApply(code.trim());
                        }}
                        className="flex items-center gap-1.5 mt-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 hover:border-primary/40 transition-colors"
                      >
                        <Wand2 className="h-3 w-3 shrink-0" />
                        Apply to app
                      </button>
                    </div>
                  );
                },
              }
            : {}),
          // Task #531: inline file-path references render as a clickable
          // deep-link button. Only inline code (no className set by
          // rehype-highlight, which adds language-* to fenced blocks) is
          // considered; multi-line/fenced code is left alone.
          code(props: { inline?: boolean; className?: string; children?: React.ReactNode }) {
            const { inline, className, children } = props;
            // Only treat true inline code as a candidate for path-link rendering.
            // Fenced code blocks (with or without highlight class) must be left
            // alone so we don't convert a path that happens to appear inside a
            // larger code snippet into a clickable button.
            if (onViewFile && inline === true) {
              const text = extractCodeText(children).trim();
              const m = text.match(FILE_PATH_REF_RE);
              if (m) {
                const path = m[1]!;
                const line = m[2] ? parseInt(m[2], 10) : undefined;
                return (
                  <button
                    type="button"
                    onClick={() => onViewFile(path, line)}
                    className="inline-flex items-center gap-1 align-baseline text-[11px] font-mono px-1 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary hover:bg-primary/20 hover:border-primary/50 transition-colors"
                    title={`Open ${path}${line ? `:${line}` : ""} in Code tab`}
                  >
                    <FileCode className="h-2.5 w-2.5 shrink-0" />
                    {path}
                    {line ? <span className="opacity-70">:{line}</span> : null}
                  </button>
                );
              }
            }
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {content}
      </ReactMarkdown>
      {onApply && !content.includes("```") && ACTIONABLE_PATTERNS.some((p) => p.test(content)) && (
        <button
          onClick={() => onApply(content)}
          className="mt-2 flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium bg-primary/10 border border-primary/20 text-primary hover:bg-primary/20 transition-colors"
        >
          Build this
        </button>
      )}
    </div>
  );
}

const ACTIONABLE_PATTERNS = [
  /\bhere'?s? how\b/i,
  /\byou could\b/i,
  /\bi'?d suggest\b/i,
  /\bhere'?s? an example\b/i,
  /\bhere'?s? a suggestion\b/i,
  /\btry adding\b/i,
  /\bconsider adding\b/i,
  /\byou can add\b/i,
  /\byou might want to\b/i,
  /\bhere'?s? what you'?d?\b/i,
];

const completedAnimations = new Set<number>();

export function TypingIndicator() {
  return (
    <div className="flex justify-start items-end gap-2">
      <ZeroAvatar active />
      <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2.5 flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-foreground/35 animate-bounce"
            style={{ animationDelay: `${i * 160}ms` }}
          />
        ))}
      </div>
    </div>
  );
}

export function StreamingText({
  content,
  messageId,
  animate = false,
  onApply,
  onViewFile,
}: {
  content: string;
  messageId: number;
  animate?: boolean;
  onApply?: (code: string) => void;
  onViewFile?: (path: string, line?: number) => void;
}) {
  const words = content.split(" ");
  const shouldAnimate = animate && !completedAnimations.has(messageId);
  const [count, setCount] = useState(shouldAnimate ? 0 : words.length);

  useEffect(() => {
    if (!shouldAnimate) return;
    let i = 0;
    const batchSize = Math.max(1, Math.ceil(words.length / 40));
    const iv = setInterval(() => {
      i += batchSize;
      const next = Math.min(i, words.length);
      setCount(next);
      if (next >= words.length) {
        clearInterval(iv);
        completedAnimations.add(messageId);
      }
    }, 25);
    return () => clearInterval(iv);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isDone = count >= words.length;

  if (isDone) {
    return <MarkdownMessage content={content} onApply={onApply} onViewFile={onViewFile} />;
  }

  return (
    <div className="text-xs leading-relaxed">
      {words.slice(0, count).join(" ")}
      <span className="inline-block w-0.5 h-3 bg-foreground/50 animate-pulse ml-0.5 align-middle" />
    </div>
  );
}

function AgentBadge({ identity }: { identity: string }) {
  if (identity === "planning") {
    return (
      <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium shrink-0">
        <Navigation className="h-2.5 w-2.5" /> Planning
      </span>
    );
  }
  if (identity === "task") {
    return (
      <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20 font-medium shrink-0">
        <Cpu className="h-2.5 w-2.5" /> Task
      </span>
    );
  }
  return (
    <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-400 border border-green-500/20 font-medium shrink-0">
      <Zap className="h-2.5 w-2.5" /> Main
    </span>
  );
}

function AgentModePill({ mode }: { mode: string }) {
  const normalizedMode = mode.toLowerCase();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border shrink-0",
        normalizedMode === "pro"
          ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
          : normalizedMode === "power"
            ? "bg-primary/10 text-primary border-primary/20"
            : normalizedMode === "eco"
              ? "bg-green-500/10 text-green-400 border-green-500/20"
              : "bg-muted text-muted-foreground border-border",
      )}
    >
      {isBuilderAgentMode(normalizedMode) && (
        <BuilderModeIcon mode={normalizedMode} className="h-2.5 w-2.5" />
      )}
      {mode}
    </span>
  );
}

const TESTS_PENDING_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Architect review card (Task #507) — verdict badge + collapsible findings.
// ─────────────────────────────────────────────────────────────────────────────
export function ArchitectReviewCard({
  review,
  actualCreditsCharged,
}: {
  review: NonNullable<TaskReport["architectReview"]>;
  actualCreditsCharged?: number;
}) {
  const [open, setOpen] = useState(false);
  const verdictStyle = {
    pass: {
      icon: ShieldCheck,
      label: "Pass",
      classes: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
    },
    partial: {
      icon: ShieldAlert,
      label: "Partial",
      classes: "bg-amber-500/10 text-amber-400 border-amber-500/30",
    },
    fail: {
      icon: ShieldAlert,
      label: "Fail",
      classes: "bg-rose-500/10 text-rose-400 border-rose-500/30",
    },
  }[review.verdict];
  const VerdictIcon = verdictStyle.icon;
  const severityClasses: Record<string, string> = {
    critical: "bg-rose-500/15 text-rose-400 border-rose-500/30",
    high: "bg-orange-500/15 text-orange-400 border-orange-500/30",
    medium: "bg-amber-500/15 text-amber-400 border-amber-500/30",
    low: "bg-sky-500/15 text-sky-400 border-sky-500/30",
  };
  const findingCount = review.findings.length;
  const creditsCharged = actualCreditsCharged ?? 0;

  return (
    <div className="pt-1.5 border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-[11px] hover:opacity-80 transition-opacity"
        data-testid="architect-review-toggle"
      >
        <span className="shrink-0 text-violet-400">
          <AgentIcon size={14} />
        </span>
        <span className="font-semibold text-foreground">
          {review.isReReview ? "Architect re-review" : "Architect review"}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold",
            verdictStyle.classes,
          )}
        >
          <VerdictIcon className="h-2.5 w-2.5" />
          {verdictStyle.label}
        </span>
        {findingCount > 0 && (
          <span className="text-muted-foreground">
            {findingCount} finding{findingCount === 1 ? "" : "s"}
          </span>
        )}
        {review.autoFixQueued && (
          <span className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300">
            <Wand2 className="h-2.5 w-2.5" />
            Auto-fix queued
          </span>
        )}
        {review.completedWithWarnings && (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300">
            <AlertTriangle className="h-2.5 w-2.5" />
            Completed with warnings
          </span>
        )}
        {open ? (
          <ChevronDown className="h-3 w-3 ml-auto text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 ml-auto text-muted-foreground" />
        )}
      </button>
      <p className="mt-1 text-[11px] text-muted-foreground leading-relaxed">{review.summary}</p>
      {open && (
        <div className="mt-2 space-y-2">
          {review.findings.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No findings.</p>
          ) : (
            <ul className="space-y-1.5">
              {review.findings.map((f, i) => (
                <li
                  key={i}
                  className="rounded-md border border-border bg-background/40 p-2 text-[11px]"
                  data-testid={`architect-finding-${i}`}
                >
                  <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                        severityClasses[f.severity] ?? severityClasses.low,
                      )}
                    >
                      {f.severity}
                    </span>
                    <span className="font-medium text-foreground">{f.title}</span>
                    {f.file && (
                      <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground font-mono">
                        <FileCode className="h-2.5 w-2.5" />
                        {f.file}
                      </span>
                    )}
                  </div>
                  <p className="text-muted-foreground leading-relaxed">{f.detail}</p>
                </li>
              ))}
            </ul>
          )}
          {review.nextActions.length > 0 && (
            <div className="rounded-md border border-border bg-background/40 p-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Next actions
              </p>
              <ul className="space-y-0.5">
                {review.nextActions.map((a, i) => (
                  <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                    <span className="text-violet-400">›</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[10px] text-muted-foreground/70">
            {creditsCharged > 0
              ? `${creditsCharged} credit${creditsCharged === 1 ? "" : "s"} charged`
              : null}
            {review.model ? `${creditsCharged > 0 ? " · " : ""}${review.model}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}

export function architectCreditsFromLedger(
  events: NabuflowUsageEvent[],
  taskId: number | undefined,
): number {
  if (!taskId) return 0;
  return events
    .filter(
      (event) =>
        event.taskId === taskId && event.source === "architect" && event.reversedAt == null,
    )
    .reduce((total, event) => total + event.credits, 0);
}

function InlineReportCard({
  report,
  onViewFile,
  onOpenCheckpoint,
  onSendMessage,
  taskId,
  projectId,
  taskCreatedAt,
}: {
  report: TaskReport;
  onViewFile?: (path: string, line?: number) => void;
  onOpenCheckpoint?: (checkpointId: number) => void;
  onSendMessage?: (text: string) => void;
  taskId?: number;
  projectId?: number;
  taskCreatedAt?: string;
}) {
  const [smellsOpen, setSmellsOpen] = useState(false);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [testsOpen, setTestsOpen] = useState(false);
  const [testScreenshot, setTestScreenshot] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [e2eOpen, setE2eOpen] = useState(false);
  const [e2eScreenshot, setE2eScreenshot] = useState<string | null>(null);
  const [qualityGateOpen, setQualityGateOpen] = useState(false);
  const rerunTests = useRerunTaskTests();
  const queryClient = useQueryClient();
  const { data: usageData } = useListNabuflowUsage(
    { limit: 200 },
    {
      query: {
        enabled: !!taskId && !!report.architectReview && !report.architectReview.skipped,
        queryKey: getListNabuflowUsageQueryKey({ limit: 200 }),
        staleTime: 30_000,
      },
    },
  );
  const actualArchitectCredits = architectCreditsFromLedger(usageData?.events ?? [], taskId);

  const { data: testRunHistory } = useListTestRuns(projectId ?? 0, undefined, {
    query: {
      enabled: historyOpen && !!projectId,
      queryKey: getListTestRunsQueryKey(projectId ?? 0),
    },
  });

  // Determine if we should poll for pending test results.
  // "Could have tests" means: no results in the static prop, taskId is known,
  // and the task was created recently (within 2 minutes).
  const taskAgeMs = taskCreatedAt ? Date.now() - new Date(taskCreatedAt).getTime() : Infinity;
  const couldHaveTests =
    (report.testResults === null || report.testResults === undefined) &&
    !!taskId &&
    !!projectId &&
    taskAgeMs < TESTS_PENDING_WINDOW_MS;

  // Poll the tasks list while we might still be waiting on test results.
  const { data: liveTasks } = useListTasks(projectId ?? 0, {
    query: {
      enabled: couldHaveTests,
      queryKey: getListTasksQueryKey(projectId ?? 0),
      refetchInterval: couldHaveTests ? 3000 : false,
    },
  });

  // Extract live testResults from the polled task (overrides the stale prop value).
  const liveTask = liveTasks?.find((t: { id: number; report?: unknown }) => t.id === taskId);
  const liveReport = liveTask?.report as TaskReport | null | undefined;
  const effectiveTestResults =
    liveReport?.testResults !== undefined ? liveReport.testResults : report.testResults;
  const effectiveTestRanAt =
    liveReport?.testRanAt !== undefined ? liveReport.testRanAt : report.testRanAt;

  // Show the spinner badge when we're actively waiting (no results yet in either prop or live data).
  const testsPending =
    couldHaveTests && (effectiveTestResults === null || effectiveTestResults === undefined);
  return (
    <div className="mt-2 space-y-1 text-xs">
      <InlineBuildResults
        report={report}
        terminal={(liveTask as (typeof liveTask & { terminal?: unknown }) | undefined)?.terminal}
        projectId={projectId}
        onViewFile={onViewFile}
        onOpenCheckpoint={onOpenCheckpoint}
        onSendMessage={onSendMessage}
      />
      {report.integrationsNeeded && report.integrationsNeeded.length > 0 && (
        <div className="pt-1 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <KeyRound className="h-3 w-3" /> Integrations required
          </div>
        </div>
      )}
      {report.validationReport && (
        <div className="pt-1.5 border-t border-border">
          {report.validationReport.passed ? (
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400">
              <ShieldCheck className="h-3 w-3 shrink-0" />
              <span>Validation fixed {report.validationReport.initialIssues.length} issue(s)</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 text-[10px] font-semibold text-red-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              <span>
                {report.validationReport.remainingIssues.length} validation issue(s) persist after
                fix-up
              </span>
            </div>
          )}
        </div>
      )}
      {report.architectReview && !report.architectReview.skipped && (
        <ArchitectReviewCard
          review={report.architectReview}
          actualCreditsCharged={actualArchitectCredits}
        />
      )}
      {report.agentLoop?.skillsLoaded && report.agentLoop.skillsLoaded.length > 0 && (
        <div className="pt-1.5 border-t border-border/40">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-foreground mb-1">
            <Sparkles className="h-3 w-3 shrink-0 text-primary/70" />
            <span>Skills used ({report.agentLoop.skillsLoaded.length})</span>
          </div>
          <div className="flex flex-wrap gap-1 pl-4">
            {report.agentLoop.skillsLoaded.map((skill) => (
              <span
                key={skill}
                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary border border-primary/20"
                title={`Skill loaded: ${skill}`}
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.critiquePass?.autoFixed && (
        <div className="pt-1.5 border-t border-border">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-400">
            <Wand2 className="h-3 w-3 shrink-0" />
            <span>Auto-fixed by quality review</span>
            {report.critiquePass.issuesFound.length > 0 && (
              <span className="text-muted-foreground font-normal">
                ({report.critiquePass.issuesFound.length} issue
                {report.critiquePass.issuesFound.length > 1 ? "s" : ""} found &amp; patched)
              </span>
            )}
          </div>
        </div>
      )}
      {report.warnings.length > 0 &&
        (() => {
          const DOUBLE_FAIL = "Neither the initial pass nor the retry produced any file changes";
          const doubleFail = report.warnings.some((w) => w.includes(DOUBLE_FAIL));
          const otherWarnings = report.warnings.filter((w) => !w.includes(DOUBLE_FAIL));
          return (
            <>
              {doubleFail && (
                <div className="pt-1.5 border-t border-amber-500/30">
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />I wasn't sure what to change
                    </div>
                    <p className="text-[11px] text-amber-300/80 leading-relaxed">
                      Neither my initial attempt nor a retry produced any edits. Try describing the
                      specific change you'd like — for example, "Change the button color to blue" or
                      "Add a contact form below the hero section".
                    </p>
                    {onSendMessage && (
                      <button
                        className="mt-0.5 text-[10px] font-medium text-amber-400 hover:text-amber-300 underline underline-offset-2 transition-colors"
                        onClick={() =>
                          onSendMessage("Let me describe the change more specifically: ")
                        }
                      >
                        Rephrase my request
                      </button>
                    )}
                  </div>
                </div>
              )}
              {otherWarnings.length > 0 && (
                <div className="pt-1.5 border-t border-border">
                  <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
                    <AlertTriangle className="h-3 w-3" /> {otherWarnings.length} warning(s)
                  </div>
                </div>
              )}
            </>
          );
        })()}
      {report.securityNotices && report.securityNotices.length > 0 && (
        <div className="pt-1.5 border-t border-orange-500/20">
          <button
            className="w-full flex items-center gap-1.5 text-[10px] font-semibold text-orange-400 hover:text-orange-300 transition-colors"
            onClick={() => setSecurityOpen((o) => !o)}
          >
            <ShieldAlert className="h-3 w-3 shrink-0" />
            <span>Security notices ({report.securityNotices.length})</span>
            {securityOpen ? (
              <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
            )}
          </button>
          {securityOpen && (
            <ul className="mt-1.5 space-y-2 pl-1">
              {report.securityNotices.map((notice, i) => (
                <li key={i} className="text-[10px] leading-relaxed">
                  <div className="flex items-center gap-1 font-semibold text-orange-400/90">
                    <span
                      className={cn(
                        "inline-block px-1 rounded text-[9px] font-bold uppercase",
                        notice.severity === "error"
                          ? "bg-red-500/15 text-red-400"
                          : "bg-orange-500/15 text-orange-400",
                      )}
                    >
                      {notice.severity}
                    </span>
                    {notice.packageName}
                    {notice.cve && (
                      <span className="text-muted-foreground font-normal">({notice.cve})</span>
                    )}
                  </div>
                  <p className="text-muted-foreground mt-0.5">{notice.description}</p>
                  <p className="text-muted-foreground/70 mt-0.5">
                    Replace with: <span className="font-mono">{notice.upgradeTo}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {report.syntaxValid !== undefined && (
        <div className="pt-1.5 border-t border-border">
          <div className="flex items-center gap-1.5 text-[10px]">
            <FileCode className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="font-semibold text-foreground/80">Syntax</span>
            {report.syntaxValid ? (
              <span className="flex items-center gap-1 text-green-400">
                <CheckCircle2 className="h-3 w-3" />
                All files valid
              </span>
            ) : (
              <span className="flex items-center gap-1 text-yellow-400">
                <AlertTriangle className="h-3 w-3" />
                Errors detected
              </span>
            )}
          </div>
        </div>
      )}
      {report.codeSmells && report.codeSmells.length > 0 && (
        <div className="pt-1.5 border-t border-blue-500/20">
          <button
            className="w-full flex items-center gap-1.5 text-[10px] font-semibold text-blue-400 hover:text-blue-300 transition-colors"
            onClick={() => setSmellsOpen((o) => !o)}
          >
            <Lightbulb className="h-3 w-3 shrink-0" />
            <span>Code quality notes ({report.codeSmells.length})</span>
            {smellsOpen ? (
              <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
            )}
          </button>
          {smellsOpen && (
            <ul className="mt-1.5 space-y-1 pl-4">
              {report.codeSmells.map((smell, i) => (
                <li key={i} className="text-[10px] text-muted-foreground leading-relaxed list-disc">
                  {smell}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {/* Tests pending badge — shown while browser tests are still running in the background */}
      {testsPending && (
        <div className="pt-1.5 border-t border-border/40">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/60" />
            <span>Running tests...</span>
          </div>
        </div>
      )}
      {/* Tests card — shown when testResults are available (from live poll or prop) */}
      {effectiveTestResults &&
        effectiveTestResults.length > 0 &&
        (() => {
          const passed = effectiveTestResults.filter((r) => r.passed).length;
          const failed = effectiveTestResults.filter((r) => !r.passed).length;
          const allPassed = failed === 0;
          const ranAt = effectiveTestRanAt ? new Date(effectiveTestRanAt) : null;
          return (
            <div
              className={`pt-1.5 border-t ${allPassed ? "border-green-500/20" : "border-red-500/20"}`}
            >
              <div className="flex items-center gap-1.5">
                <button
                  className={`flex-1 flex items-center gap-1.5 text-[10px] font-semibold transition-colors ${allPassed ? "text-green-400 hover:text-green-300" : "text-red-400 hover:text-red-300"}`}
                  onClick={() => setTestsOpen((o) => !o)}
                >
                  <FlaskConical className="h-3 w-3 shrink-0" />
                  <span>
                    Tests — {passed} passed{failed > 0 ? `, ${failed} failed` : ""}
                  </span>
                  {ranAt && (
                    <span className="text-muted-foreground/50 font-normal ml-0.5">
                      {format(ranAt, "HH:mm")}
                    </span>
                  )}
                  {testsOpen ? (
                    <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
                  ) : (
                    <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
                  )}
                </button>
                {projectId && (
                  <button
                    onClick={() => setHistoryOpen((o) => !o)}
                    className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border border-border/50 hover:border-border transition-colors",
                      historyOpen
                        ? "text-foreground border-border"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    title="View test run history"
                  >
                    <FileCode className="h-2.5 w-2.5" />
                    History
                  </button>
                )}
                {taskId && projectId && (
                  <button
                    onClick={() => {
                      rerunTests.mutate(
                        { id: projectId, taskId },
                        {
                          onSuccess: () => {
                            void queryClient.invalidateQueries({
                              queryKey: getListTasksQueryKey(projectId),
                            });
                          },
                        },
                      );
                    }}
                    disabled={rerunTests.isPending}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-muted-foreground hover:text-foreground border border-border/50 hover:border-border transition-colors disabled:opacity-50"
                    title="Re-run tests"
                  >
                    {rerunTests.isPending ? (
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-2.5 w-2.5" />
                    )}
                  </button>
                )}
              </div>
              {testsOpen && (
                <ul className="mt-1.5 space-y-1 pl-1">
                  {effectiveTestResults.map((result, i) => (
                    <li key={i} className="text-[10px]">
                      <div className="flex items-start gap-1.5">
                        {result.passed ? (
                          <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <span
                            className={result.passed ? "text-foreground/80" : "text-foreground"}
                          >
                            {result.name}
                          </span>
                          {!result.passed && (
                            <p className="text-muted-foreground mt-0.5 leading-relaxed">
                              {result.message}
                            </p>
                          )}
                          {result.screenshotBase64 && (
                            <div className="mt-1">
                              <button
                                className="text-[9px] text-primary/70 hover:text-primary underline"
                                onClick={() =>
                                  setTestScreenshot(
                                    testScreenshot === result.screenshotBase64
                                      ? null
                                      : result.screenshotBase64!,
                                  )
                                }
                              >
                                {testScreenshot === result.screenshotBase64
                                  ? "Hide screenshot"
                                  : "View screenshot"}
                              </button>
                              {testScreenshot === result.screenshotBase64 && (
                                <img
                                  src={`data:image/png;base64,${result.screenshotBase64}`}
                                  alt="Test failure screenshot"
                                  className="mt-1 rounded border border-border/50 max-w-full"
                                />
                              )}
                            </div>
                          )}
                        </div>
                        <span className="text-muted-foreground/40 shrink-0 text-[9px] ml-auto">
                          {result.durationMs}ms
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {historyOpen && (
                <div className="mt-2 pt-1.5 border-t border-border/30">
                  <div className="text-[10px] font-semibold text-muted-foreground mb-1.5 flex items-center gap-1">
                    <FileCode className="h-3 w-3" />
                    Test run history
                  </div>
                  {!testRunHistory ? (
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Loading...
                    </div>
                  ) : testRunHistory.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground">No history yet.</p>
                  ) : (
                    <ul className="space-y-1">
                      {testRunHistory.map((run) => {
                        const runAllPassed = run.failed === 0;
                        const runAt = new Date(run.ranAt);
                        const isCurrentTask = run.taskId === taskId;
                        return (
                          <li
                            key={run.id}
                            className={cn(
                              "flex items-center gap-2 text-[10px] px-1.5 py-1 rounded",
                              isCurrentTask ? "bg-muted/60" : "bg-muted/30",
                            )}
                          >
                            {runAllPassed ? (
                              <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                            ) : (
                              <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                            )}
                            <span
                              className={
                                runAllPassed
                                  ? "text-green-400 font-medium"
                                  : "text-red-400 font-medium"
                              }
                            >
                              {run.passed}P / {run.failed}F
                            </span>
                            <span className="text-muted-foreground/60 text-[9px]">
                              {format(runAt, "MMM d, HH:mm")}
                            </span>
                            {isCurrentTask && (
                              <span className="ml-auto text-[9px] text-primary/60 font-medium">
                                this build
                              </span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}
            </div>
          );
        })()}
      {report.e2eResults &&
        (() => {
          const e2e = report.e2eResults!;
          const allPassed = e2e.failed === 0 && !e2e.skippedReason;
          const ranAt = e2e.ranAt ? new Date(e2e.ranAt) : null;
          return (
            <div
              className={`pt-1.5 border-t ${
                e2e.skippedReason
                  ? "border-border/40"
                  : allPassed
                    ? "border-green-500/20"
                    : "border-red-500/20"
              }`}
            >
              <button
                className={`flex items-center gap-1.5 text-[10px] font-semibold w-full transition-colors ${
                  e2e.skippedReason
                    ? "text-muted-foreground"
                    : allPassed
                      ? "text-green-400 hover:text-green-300"
                      : "text-red-400 hover:text-red-300"
                }`}
                onClick={() => setE2eOpen((o) => !o)}
              >
                <FlaskConical className="h-3 w-3 shrink-0" />
                <span>
                  {e2e.skippedReason
                    ? `E2E skipped — ${e2e.skippedReason}`
                    : `E2E — ${e2e.passed} passed${e2e.failed > 0 ? `, ${e2e.failed} failed` : ""}${e2e.autoFixAttempted ? " (auto-fix attempted)" : ""}`}
                </span>
                {ranAt && !e2e.skippedReason && (
                  <span className="text-muted-foreground/50 font-normal ml-0.5">
                    {format(ranAt, "HH:mm")}
                  </span>
                )}
                {e2eOpen ? (
                  <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
                )}
              </button>
              {e2eOpen && e2e.scenarios.length > 0 && (
                <ul className="mt-1.5 space-y-1 pl-1">
                  {e2e.scenarios.map((s, i) => (
                    <li key={i} className="text-[10px]">
                      <div className="flex items-start gap-1.5">
                        {s.passed ? (
                          <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0 mt-0.5" />
                        ) : (
                          <XCircle className="h-3 w-3 text-red-400 shrink-0 mt-0.5" />
                        )}
                        <div className="flex-1 min-w-0">
                          <span className={s.passed ? "text-foreground/80" : "text-foreground"}>
                            {s.name}
                          </span>
                          <span className="ml-1 text-muted-foreground/50 text-[9px]">
                            [{s.source}]
                          </span>
                          {!s.passed && (
                            <p className="text-muted-foreground mt-0.5 leading-relaxed">
                              {s.message}
                            </p>
                          )}
                          {s.consoleErrors.length > 0 && (
                            <p className="text-red-300/80 mt-0.5 leading-relaxed text-[9px]">
                              console: {s.consoleErrors.slice(0, 2).join(" · ")}
                            </p>
                          )}
                          {s.networkFailures.length > 0 && (
                            <p className="text-amber-300/80 mt-0.5 leading-relaxed text-[9px]">
                              network: {s.networkFailures.length} failure(s)
                            </p>
                          )}
                          {s.screenshotBase64 && (
                            <div className="mt-1">
                              <button
                                className="text-[9px] text-primary/70 hover:text-primary underline"
                                onClick={() =>
                                  setE2eScreenshot(
                                    e2eScreenshot === s.screenshotBase64
                                      ? null
                                      : s.screenshotBase64!,
                                  )
                                }
                              >
                                {e2eScreenshot === s.screenshotBase64
                                  ? "Hide screenshot"
                                  : "View screenshot"}
                              </button>
                              {e2eScreenshot === s.screenshotBase64 && (
                                <img
                                  src={`data:image/png;base64,${s.screenshotBase64}`}
                                  alt="E2E failure screenshot"
                                  className="mt-1 rounded border border-border/50 max-w-full"
                                />
                              )}
                            </div>
                          )}
                        </div>
                        <span className="text-muted-foreground/40 shrink-0 text-[9px] ml-auto">
                          {s.durationMs}ms
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {e2eOpen && e2e.budgetExceeded && (
                <p className="mt-1 text-[9px] text-muted-foreground/70">
                  Budget cap reached — some scenarios or screenshots were trimmed.
                </p>
              )}
            </div>
          );
        })()}
      {report.qualityGate && report.qualityGate.checks.length > 0 && (
        <div
          className={`pt-1.5 border-t ${
            report.qualityGate.passed ? "border-border/40" : "border-amber-500/30"
          }`}
        >
          <button
            className={`flex items-center gap-1.5 text-[10px] font-semibold w-full transition-colors ${
              report.qualityGate.allPassed
                ? "text-green-400 hover:text-green-300"
                : report.qualityGate.passed
                  ? "text-muted-foreground hover:text-foreground"
                  : "text-amber-400 hover:text-amber-300"
            }`}
            onClick={() => setQualityGateOpen((o) => !o)}
          >
            <ShieldCheck className="h-3 w-3 shrink-0" />
            <span>
              Quality checks —{" "}
              {report.qualityGate.allPassed
                ? "all passed"
                : report.qualityGate.passed
                  ? "passed (some skipped)"
                  : `${report.qualityGate.checks.filter((c) => !c.skipped && !c.passed).length} issue(s)`}
            </span>
            {qualityGateOpen ? (
              <ChevronDown className="h-3 w-3 ml-auto shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 ml-auto shrink-0" />
            )}
          </button>
          {qualityGateOpen && (
            <ul className="mt-1.5 space-y-1.5 pl-1">
              {report.qualityGate.checks.map((check) => (
                <li key={check.id} className="text-[10px]">
                  <div className="flex items-center gap-1.5">
                    {check.skipped ? (
                      <span className="h-3 w-3 rounded-full border border-muted-foreground/30 shrink-0 inline-block" />
                    ) : check.passed ? (
                      <CheckCircle2 className="h-3 w-3 text-green-400 shrink-0" />
                    ) : (
                      <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
                    )}
                    <span
                      className={
                        check.skipped
                          ? "text-muted-foreground/50"
                          : check.passed
                            ? "text-foreground/80"
                            : "text-amber-300 font-medium"
                      }
                    >
                      {check.label}
                    </span>
                    {check.skipped && (
                      <span className="text-muted-foreground/40 text-[9px]">skipped</span>
                    )}
                    <span className="ml-auto text-muted-foreground/40 text-[9px]">
                      {check.durationMs}ms
                    </span>
                  </div>
                  {!check.skipped && !check.passed && check.output && (
                    <pre className="mt-1 ml-4.5 text-[9px] leading-relaxed text-amber-300/80 bg-amber-500/5 border border-amber-500/20 rounded p-1.5 overflow-x-auto whitespace-pre-wrap max-h-32">
                      {check.output.slice(0, 800)}
                      {check.output.length > 800 ? "\n…output truncated" : ""}
                    </pre>
                  )}
                  {check.skipped && check.skipReason && (
                    <p className="ml-4.5 text-[9px] text-muted-foreground/40 mt-0.5">
                      {check.skipReason}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {report.assets && report.assets.length > 0 && projectId != null && (
        <div className="pt-1.5 border-t border-border space-y-1">
          <div className="text-[10px] uppercase text-muted-foreground/60 font-semibold flex items-center gap-1">
            <FileBox className="h-3 w-3" /> Downloads
          </div>
          {report.assets.map((asset) => (
            <a
              key={asset.path}
              href={`/api/projects/${projectId}/preview/${asset.path}`}
              download={asset.name}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/50 border border-border/60 hover:border-primary/40 hover:bg-muted transition-colors group"
            >
              <FileCode className="h-3.5 w-3.5 text-primary/80 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="text-[11px] font-medium text-foreground truncate">{asset.name}</div>
                {asset.description && (
                  <div className="text-[10px] text-muted-foreground truncate">
                    {asset.description}
                  </div>
                )}
                <div className="text-[9px] text-muted-foreground/60 font-mono truncate">
                  {asset.path} · {formatBytes(asset.sizeBytes)} · {asset.mimeType}
                </div>
              </div>
              <Download className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary shrink-0" />
            </a>
          ))}
        </div>
      )}
      {report.nextRecommendation && (
        <div className="pt-1.5 border-t border-border text-muted-foreground italic text-[10px]">
          {report.nextRecommendation}
        </div>
      )}
    </div>
  );
}

function InlinePlanCard({ plan }: { plan: StructuredPlan }) {
  const PlanSection = ({
    label,
    items,
    color = "text-foreground",
  }: {
    label: string;
    items?: string[];
    color?: string;
  }) => {
    if (!items || items.length === 0) return null;
    return (
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-0.5">
          {label}
        </div>
        <div className="space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className={cn("text-[11px] flex items-start gap-1", color)}>
              <span className="mt-0.5 opacity-50">•</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <span className="text-secondary">
          <AgentIcon size={14} />
        </span>
        Plan
      </div>
      {plan.goal && (
        <div className="text-[11px] text-muted-foreground bg-muted rounded p-2 leading-relaxed">
          {plan.goal}
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <PlanSection label="Pages" items={plan.pages} />
        <PlanSection label="Backend" items={plan.backend} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PlanSection label="Database" items={plan.database} />
        <PlanSection label="Integrations" items={plan.integrations} />
      </div>
      {plan.keysNeeded && plan.keysNeeded.length > 0 && (
        <PlanSection label="API Keys needed" items={plan.keysNeeded} color="text-yellow-400" />
      )}
      {plan.risks && plan.risks.length > 0 && (
        <PlanSection label="Risks" items={plan.risks} color="text-orange-400" />
      )}
    </div>
  );
}

function FeedbackModal({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [category, setCategory] = useState<"bug" | "design" | "feature" | "copy" | "other">("bug");
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");
  const [description, setDescription] = useState("");
  const [screenshotUrl, setScreenshotUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!description.trim()) {
      setError("Please describe what should change.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(`/api/projects/${projectId}/inbox`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          severity,
          description: description.trim(),
          screenshotUrl: screenshotUrl.trim() || null,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-card border border-border rounded-xl shadow-xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <Bug className="h-4 w-4 text-amber-400" />
          <h3 className="text-sm font-semibold">Send Feedback</h3>
          <button onClick={onClose} className="ml-auto text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Category
              </label>
              <select
                value={category}
                onChange={(e) =>
                  setCategory(e.target.value as "bug" | "design" | "feature" | "copy" | "other")
                }
                className="mt-1 w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-primary"
              >
                <option value="bug">Bug</option>
                <option value="design">Design</option>
                <option value="feature">Feature request</option>
                <option value="copy">Copy / wording</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                Severity
              </label>
              <select
                value={severity}
                onChange={(e) => setSeverity(e.target.value as "low" | "medium" | "high")}
                className="mt-1 w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-primary"
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              What should change?
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe the bug, the design issue, or what you want the AI to address next time…"
              rows={5}
              className="mt-1 w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-primary resize-none"
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
              Screenshot URL (optional)
            </label>
            <input
              type="url"
              value={screenshotUrl}
              onChange={(e) => setScreenshotUrl(e.target.value)}
              placeholder="https://…"
              className="mt-1 w-full bg-muted border border-border rounded-md px-2 py-1.5 text-xs focus:outline-none focus:border-primary"
            />
          </div>
          {error && <div className="text-[11px] text-destructive">{error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-border flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground rounded-md hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={submitting || !description.trim()}
            className="px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-md hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1.5"
          >
            {submitting && <Loader2 className="h-3 w-3 animate-spin" />} Send to AI
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Image pending payload + pending card (async image generation) ─────────────

interface ImagePendingPayload {
  kind: "image_pending";
  jobId: string;
  imageId: number;
  prompt?: string;
  creditsCost?: number;
  quality?: string;
  aspectRatio?: string;
  style?: string;
  purpose?: string;
}

interface ImagePendingStatus {
  jobId: string;
  imageId: number;
  status: "pending" | "generating" | "completed" | "failed";
  fileUrl?: string | null;
  thumbnailUrl?: string | null;
  error?: string | null;
}

function InlineImagePendingCard({
  payload,
  onSendMessage,
}: {
  payload: ImagePendingPayload;
  onSendMessage?: (text: string) => void;
}) {
  const {
    jobId,
    imageId,
    prompt = "",
    quality = "standard",
    aspectRatio = "1:1",
    style = "vivid",
    purpose,
  } = payload;
  const [pollStatus, setPollStatus] = useState<ImagePendingStatus | null>(null);
  const [downloaded, setDownloaded] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  const [editQuality, setEditQuality] = useState<"standard" | "high">("standard");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editDone, setEditDone] = useState(false);

  const handleInlineEdit = async () => {
    if (!editInstruction.trim() || editSubmitting || !imageId) return;
    setEditSubmitting(true);
    try {
      const res = await authFetch(`/api/images/${imageId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: editInstruction.trim(), quality: editQuality }),
      });
      if (res.ok) {
        setEditDone(true);
        setEditOpen(false);
        setEditInstruction("");
      }
    } catch {
      // ignore
    } finally {
      setEditSubmitting(false);
    }
  };

  useEffect(() => {
    let stopped = false;

    const poll = async () => {
      try {
        const res = await authFetch(`/api/images/status/${jobId}`);
        if (!res.ok) return;
        const data = (await res.json()) as ImagePendingStatus;
        if (!stopped) {
          setPollStatus(data);
          if (data.status === "completed" || data.status === "failed") {
            if (intervalRef.current) clearInterval(intervalRef.current);
          }
        }
      } catch {
        // ignore transient errors
      }
    };

    void poll();
    intervalRef.current = setInterval(() => void poll(), 2000);

    return () => {
      stopped = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [jobId]);

  const handleDownload = () => {
    const url = pollStatus?.fileUrl;
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `ora-image-${imageId}.webp`;
    a.click();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const handleRegenerate = () => {
    if (onSendMessage && prompt) onSendMessage(prompt);
  };

  // Still processing
  if (!pollStatus || pollStatus.status === "pending" || pollStatus.status === "generating") {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/30 p-4 max-w-xs">
        <div className="flex items-center gap-2.5 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          <div>
            <p className="text-[11px] font-medium text-foreground/80">Generating image…</p>
            <p className="text-[10px]">
              {pollStatus?.status === "generating"
                ? "Processing with AI…"
                : "Queued, starting soon…"}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // Failed
  if (pollStatus.status === "failed") {
    return (
      <div className="mt-2 rounded-lg border border-destructive/20 bg-destructive/5 p-3 max-w-xs">
        <p className="text-[11px] text-destructive font-medium">Image generation failed</p>
        {pollStatus.error && (
          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2">{pollStatus.error}</p>
        )}
        <p className="text-[10px] text-muted-foreground mt-1">Credits have been refunded.</p>
        <button
          onClick={handleRegenerate}
          className="mt-2 flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          Try again
        </button>
      </div>
    );
  }

  // Completed — render full result card
  const fileUrl = pollStatus.fileUrl;
  if (!fileUrl) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/50 p-3 text-[11px] text-muted-foreground max-w-xs">
        Image could not be loaded.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 max-w-xs">
      <img
        src={pollStatus.thumbnailUrl ?? fileUrl}
        alt={prompt}
        className="w-full rounded-lg border border-border object-cover"
        loading="lazy"
      />
      {/* Labels */}
      <div className="flex flex-wrap gap-1">
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {quality}
        </span>
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {aspectRatio}
        </span>
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {style}
        </span>
        {purpose && (
          <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
            {purpose}
          </span>
        )}
      </div>
      {/* Saved indicator */}
      <div className="flex items-center gap-1 text-[10px] text-emerald-500/80">
        <CheckCircle2 className="h-3 w-3" />
        <span>Saved to Image Studio</span>
      </div>
      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <Download className="h-3 w-3" />
          {downloaded ? "Downloaded" : "Download"}
        </button>
        <button
          onClick={handleRegenerate}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Regenerate
        </button>
        {imageId && (
          <button
            onClick={() => setEditOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
        <a
          href="/image-studio"
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <ImageIcon className="h-3 w-3" />
          Image Studio
        </a>
      </div>
      {/* Inline edit form */}
      {editOpen && (
        <div className="mt-1 space-y-1.5">
          <textarea
            value={editInstruction}
            onChange={(e) => setEditInstruction(e.target.value)}
            placeholder="Describe the change you want…"
            rows={2}
            autoFocus
            className="w-full bg-muted border border-border rounded-lg px-2 py-1.5 text-[10px] text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
          />
          <div className="flex gap-1">
            {(["standard", "high"] as const).map((q) => (
              <button
                key={q}
                onClick={() => setEditQuality(q)}
                className={cn(
                  "flex-1 py-1 rounded border text-[10px] font-medium transition-colors",
                  editQuality === q
                    ? "border-primary/50 bg-primary/8 text-foreground"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {q === "standard" ? "Standard · 3cr" : "High · 6cr"}
              </button>
            ))}
          </div>
          <button
            onClick={() => void handleInlineEdit()}
            disabled={!editInstruction.trim() || editSubmitting}
            className="w-full flex items-center justify-center gap-1 py-1 rounded border border-primary/40 bg-primary/8 text-[10px] font-medium text-primary hover:bg-primary/12 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {editSubmitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            {editSubmitting ? "Applying…" : "Apply edit"}
          </button>
        </div>
      )}
      {editDone && (
        <p className="text-[10px] text-emerald-500/80 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Edit queued —{" "}
          <a href="/image-studio" className="underline hover:text-emerald-400">
            check Image Studio
          </a>
        </p>
      )}
      {/* Commercial-use notice */}
      <p className="text-[9px] text-muted-foreground/60 leading-snug">
        Generated images may be used for commercial purposes. You are responsible for ensuring your
        prompt complies with applicable laws and third-party rights.
      </p>
    </div>
  );
}

// ── Image result payload + card (legacy synchronous result) ───────────────────

interface ImageResultPayload {
  kind: "image_result";
  prompt?: string;
  revisedPrompt?: string | null;
  imageUrl?: string | null;
  imageId?: number | null;
  creditsCost?: number;
  quality?: string;
  aspectRatio?: string;
  style?: string;
  purpose?: string;
}

function InlineImageResultCard({
  payload,
  onSendMessage,
}: {
  payload: ImageResultPayload;
  onSendMessage?: (text: string) => void;
}) {
  const [downloaded, setDownloaded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editInstruction, setEditInstruction] = useState("");
  const [editQuality, setEditQuality] = useState<"standard" | "high">("standard");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editDone, setEditDone] = useState(false);
  const {
    imageUrl,
    prompt = "",
    revisedPrompt,
    imageId,
    quality = "standard",
    aspectRatio = "1:1",
    style = "vivid",
    purpose,
  } = payload;

  const handleInlineEdit = async () => {
    if (!editInstruction.trim() || editSubmitting || !imageId) return;
    setEditSubmitting(true);
    try {
      const res = await authFetch(`/api/images/${imageId}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: editInstruction.trim(), quality: editQuality }),
      });
      if (res.ok) {
        setEditDone(true);
        setEditOpen(false);
        setEditInstruction("");
      }
    } catch {
      // ignore
    } finally {
      setEditSubmitting(false);
    }
  };

  const handleDownload = () => {
    if (!imageUrl) return;
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `ora-image-${imageId ?? "result"}.webp`;
    a.click();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  const handleRegenerate = () => {
    if (onSendMessage && prompt) onSendMessage(prompt);
  };

  if (!imageUrl) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/50 p-3 text-[11px] text-muted-foreground max-w-xs">
        Image could not be loaded.
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2 max-w-xs">
      <img
        src={imageUrl}
        alt={revisedPrompt ?? prompt}
        className="w-full rounded-lg border border-border object-cover"
        loading="lazy"
      />
      {revisedPrompt && revisedPrompt !== prompt && (
        <p className="text-[10px] text-muted-foreground italic leading-snug">
          Enhanced: {revisedPrompt.slice(0, 120)}
          {revisedPrompt.length > 120 ? "…" : ""}
        </p>
      )}
      {/* Labels */}
      <div className="flex flex-wrap gap-1">
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {quality}
        </span>
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {aspectRatio}
        </span>
        <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
          {style}
        </span>
        {purpose && (
          <span className="text-[9px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
            {purpose}
          </span>
        )}
      </div>
      {/* Saved indicator */}
      <div className="flex items-center gap-1 text-[10px] text-emerald-500/80">
        <CheckCircle2 className="h-3 w-3" />
        <span>Saved to Image Studio</span>
      </div>
      {/* Actions */}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={handleDownload}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <Download className="h-3 w-3" />
          {downloaded ? "Downloaded" : "Download"}
        </button>
        <button
          onClick={handleRegenerate}
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <RefreshCw className="h-3 w-3" />
          Regenerate
        </button>
        {imageId && (
          <button
            onClick={() => setEditOpen((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
          >
            <Pencil className="h-3 w-3" />
            Edit
          </button>
        )}
        <a
          href="/image-studio"
          className="flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
        >
          <ImageIcon className="h-3 w-3" />
          Image Studio
        </a>
      </div>
      {/* Inline edit form */}
      {editOpen && (
        <div className="mt-1 space-y-1.5">
          <textarea
            value={editInstruction}
            onChange={(e) => setEditInstruction(e.target.value)}
            placeholder="Describe the change you want…"
            rows={2}
            autoFocus
            className="w-full bg-muted border border-border rounded-lg px-2 py-1.5 text-[10px] text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:border-primary/50 transition-colors"
          />
          <div className="flex gap-1">
            {(["standard", "high"] as const).map((q) => (
              <button
                key={q}
                onClick={() => setEditQuality(q)}
                className={cn(
                  "flex-1 py-1 rounded border text-[10px] font-medium transition-colors",
                  editQuality === q
                    ? "border-primary/50 bg-primary/8 text-foreground"
                    : "border-border bg-muted text-muted-foreground hover:text-foreground",
                )}
              >
                {q === "standard" ? "Standard · 3cr" : "High · 6cr"}
              </button>
            ))}
          </div>
          <button
            onClick={() => void handleInlineEdit()}
            disabled={!editInstruction.trim() || editSubmitting}
            className="w-full flex items-center justify-center gap-1 py-1 rounded border border-primary/40 bg-primary/8 text-[10px] font-medium text-primary hover:bg-primary/12 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {editSubmitting ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Wand2 className="h-3 w-3" />
            )}
            {editSubmitting ? "Applying…" : "Apply edit"}
          </button>
        </div>
      )}
      {editDone && (
        <p className="text-[10px] text-emerald-500/80 flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Edit queued —{" "}
          <a href="/image-studio" className="underline hover:text-emerald-400">
            check Image Studio
          </a>
        </p>
      )}
      {/* Commercial-use notice */}
      <p className="text-[9px] text-muted-foreground/60 leading-snug">
        Generated images may be used for commercial purposes. You are responsible for ensuring your
        prompt complies with applicable laws and third-party rights.
      </p>
    </div>
  );
}

function MessageRow({
  msg,
  searchQuery,
  projectId,
  onViewFile,
  onOpenCheckpoint,
  onOpenTask,
  onApply,
  onSendMessage,
  onAutoFix,
  onNavigateToSecret,
  canEditAndResend,
  onEditAndResend,
}: {
  msg: Message;
  searchQuery: string;
  projectId: number;
  onViewFile?: (path: string, line?: number) => void;
  onOpenCheckpoint?: (checkpointId: number) => void;
  onOpenTask?: (taskId: number) => void;
  onApply?: (code: string) => void;
  onSendMessage?: (text: string) => void;
  /** Forwarded to QualityGateFailureCard; always sends with Main Agent identity. */
  onAutoFix?: (text: string) => void;
  onNavigateToSecret?: (secretName: string) => void;
  canEditAndResend?: boolean;
  onEditAndResend?: (text: string) => void;
}) {
  const [reportExpanded, setReportExpanded] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const queryClient = useQueryClient();
  const cancelTask = useCancelTask();

  const planPayload = msg.plan as ChatPlanPayload | null | undefined;
  const payloadKind =
    planPayload && typeof planPayload === "object"
      ? (planPayload as { kind?: string }).kind
      : undefined;
  const isReport = payloadKind === "report";
  const isError = payloadKind === "error";
  const isTaskQueued = payloadKind === "task-queued";
  const isConverse = payloadKind === "converse" && msg.role === "assistant";
  const isClarifying = payloadKind === "clarifying" && msg.role === "assistant";
  const isPlanCard =
    msg.planMode && msg.role === "assistant" && !isReport && planPayload && payloadKind !== "error";
  const structuredPlan = isPlanCard ? (planPayload as StructuredPlan) : null;
  const isImageResult = payloadKind === "image_result" && msg.role === "assistant";
  const isImagePending = payloadKind === "image_pending" && msg.role === "assistant";

  const isUser = msg.role === "user";
  const ts = format(new Date(msg.createdAt), "HH:mm");

  return (
    <div className={cn("flex flex-col gap-0.5", isUser ? "items-end" : "items-start")}>
      {/* Meta row */}
      <div
        className={cn(
          "flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground",
          isUser ? "flex-row-reverse" : "flex-row",
        )}
      >
        <span className={cn("font-semibold", isUser ? "text-primary/80" : "text-foreground/60")}>
          {isUser ? "You" : "Zero"}
        </span>
        {!isUser && <ZeroAvatar className="h-4 w-4 border-0 bg-transparent" />}
        <AgentModePill mode={msg.agentMode} />
        {!isUser && msg.agentIdentity && <AgentBadge identity={msg.agentIdentity} />}
        {!isUser &&
          !msg.agentIdentity &&
          (() => {
            const payloadAgentIdentity =
              planPayload && typeof planPayload === "object"
                ? (planPayload as { agentIdentity?: string }).agentIdentity
                : undefined;
            return payloadAgentIdentity ? <AgentBadge identity={payloadAgentIdentity} /> : null;
          })()}
        {msg.planMode && (
          <span className="text-[9px] px-1 py-0.5 rounded bg-secondary/10 text-secondary border border-secondary/20 font-medium">
            Plan
          </span>
        )}
        {(isConverse || isClarifying) && (
          <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/20 font-medium shrink-0">
            <MessageCircle className="h-2.5 w-2.5" /> Answer
          </span>
        )}
        <span>{ts}</span>
        {!isUser && typeof msg.checkpointId === "number" && msg.checkpointId > 0 && (
          <RewindToCheckpointButton projectId={projectId} checkpointId={msg.checkpointId} />
        )}
      </div>

      {/* Bubble */}
      <div
        className={cn(
          "max-w-[92%] px-3 py-2 rounded-xl text-xs leading-relaxed",
          isUser
            ? "bg-primary/15 text-foreground border border-primary/20 rounded-br-sm"
            : isError
              ? "text-foreground"
              : "bg-muted border border-border text-foreground rounded-bl-sm",
        )}
      >
        {isError ? (
          <InlineBuilderError
            message={(planPayload as { message?: string }).message ?? msg.content}
            suggestions={(planPayload as { suggestions?: string[] }).suggestions}
            recoveryAction={
              (
                planPayload as {
                  recoveryAction?: { label: string; prompt: string };
                }
              ).recoveryAction
            }
            onTryFix={onSendMessage}
          />
        ) : isConverse || isClarifying ? (
          <StreamingText
            content={msg.content}
            messageId={msg.id}
            onApply={onApply}
            onViewFile={onViewFile}
          />
        ) : msg.role === "assistant" && !isReport && !isError && !isPlanCard && !isTaskQueued ? (
          <MarkdownMessage content={msg.content} onApply={onApply} onViewFile={onViewFile} />
        ) : (
          <div className="whitespace-pre-wrap leading-relaxed">
            {highlightText(msg.content, searchQuery)}
          </div>
        )}

        {/* Async image pending card — polls status until completed/failed */}
        {isImagePending && (
          <InlineImagePendingCard
            payload={planPayload as unknown as ImagePendingPayload}
            onSendMessage={onSendMessage}
          />
        )}

        {/* Inline image result card (legacy synchronous path) */}
        {isImageResult && (
          <InlineImageResultCard
            payload={planPayload as unknown as ImageResultPayload}
            onSendMessage={onSendMessage}
          />
        )}

        {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
          <AttachmentGallery attachments={msg.attachments} />
        )}

        {isUser && canEditAndResend && onEditAndResend && (
          <div className="mt-1 flex justify-end">
            <EditAndResend onEdit={() => onEditAndResend(msg.content)} />
          </div>
        )}

        {/* Clarifying quick-reply chips — read-only in history */}
        {isClarifying && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {((planPayload as { options?: string[] }).options ?? []).map((opt) => (
              <span
                key={opt}
                className="px-2 py-0.5 rounded-full text-[10px] border border-blue-500/30 bg-blue-500/8 text-blue-400 font-medium"
              >
                {opt}
              </span>
            ))}
          </div>
        )}

        {/* Persisted QA tape */}
        {isReport &&
          (() => {
            const taskId = (planPayload as { taskId?: number }).taskId;
            return typeof taskId === "number" && taskId > 0 ? (
              <PersistedRunReplay
                projectId={projectId}
                taskId={taskId}
                className="mt-2"
                onRetry={
                  onSendMessage
                    ? () =>
                        onSendMessage(
                          "Fix the remaining runtime issue and verify the preview again.",
                        )
                    : undefined
                }
                onOpenTask={onOpenTask}
              />
            ) : null;
          })()}

        {/* Subagent activity (live) — shows designer/explorer/tester/reviewer events */}
        {isReport &&
          (() => {
            const tId = (planPayload as { taskId?: number }).taskId;
            return typeof tId === "number" && tId > 0 ? (
              <SubagentActivityPanel projectId={projectId} taskId={tId} />
            ) : null;
          })()}

        {/* Expandable report chip */}
        {isReport && (
          <div className="mt-2">
            {(planPayload as { needsFix?: boolean }).needsFix ? (
              <QualityGateFailureCard
                projectId={projectId}
                taskId={(planPayload as { taskId?: number }).taskId ?? 0}
                report={(planPayload as { report: TaskReport }).report}
                onSendMessage={onSendMessage}
                onAutoFix={onAutoFix}
                onNavigateToSecret={onNavigateToSecret}
              />
            ) : (planPayload as { needsReview?: boolean }).needsReview ? (
              <TaskReviewCard
                projectId={projectId}
                taskId={(planPayload as { taskId?: number }).taskId ?? 0}
                report={(planPayload as { report: TaskReport }).report}
                onViewFile={onViewFile}
                onNavigateToSecret={onNavigateToSecret}
                onSendMessage={onSendMessage}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => setReportExpanded((v) => !v)}
                    className="flex items-center gap-1.5 rounded-sm px-1 py-1 text-[10px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    Build details
                    {reportExpanded ? (
                      <ChevronDown className="h-3 w-3 ml-0.5" />
                    ) : (
                      <ChevronRight className="h-3 w-3 ml-0.5" />
                    )}
                  </button>
                </div>
                {reportExpanded && (
                  <InlineReportCard
                    report={(planPayload as { kind: "report"; report: TaskReport }).report}
                    onViewFile={onViewFile}
                    onOpenCheckpoint={onOpenCheckpoint}
                    onSendMessage={onSendMessage}
                    taskId={(planPayload as { taskId?: number }).taskId}
                    projectId={projectId}
                    taskCreatedAt={msg.createdAt}
                  />
                )}
              </>
            )}
          </div>
        )}

        {/* Expandable plan card */}
        {isPlanCard && structuredPlan && (
          <div className="mt-2">
            <button
              onClick={() => setPlanExpanded((v) => !v)}
              className="flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md bg-secondary/10 border border-secondary/20 text-secondary hover:bg-secondary/15 transition-colors"
            >
              <AgentIcon size={12} />
              View plan
              {planExpanded ? (
                <ChevronDown className="h-3 w-3 ml-0.5" />
              ) : (
                <ChevronRight className="h-3 w-3 ml-0.5" />
              )}
            </button>
            {planExpanded && <InlinePlanCard plan={structuredPlan} />}
          </div>
        )}

        {/* Auto-fix queued card with Accept / Dismiss */}
        {isTaskQueued &&
          (() => {
            const queuedTaskId = (planPayload as { taskId: number }).taskId;
            if (dismissed) {
              return (
                <div className="mt-2 bg-background border border-border/40 rounded-lg p-2 text-[11px] flex items-center gap-1.5 text-muted-foreground">
                  <Ban className="h-3 w-3 shrink-0" />
                  Auto-fix dismissed
                </div>
              );
            }
            if (accepted) {
              return (
                <div className="mt-2 bg-background border border-border rounded-lg p-2 text-[11px] flex items-center gap-2">
                  <div className="animate-pulse w-1.5 h-1.5 rounded-full bg-secondary shrink-0" />
                  Background task #{queuedTaskId} running…
                </div>
              );
            }
            return (
              <div className="mt-2 bg-background border border-orange-500/20 rounded-lg p-2.5 text-[11px] space-y-2">
                <div className="flex items-center gap-2 text-orange-400">
                  <div className="w-1.5 h-1.5 rounded-full bg-orange-400 shrink-0" />
                  <span className="font-medium">Auto-fix queued</span>
                </div>
                <p className="text-muted-foreground leading-relaxed">
                  Task #{queuedTaskId} will replace Moment.js with Luxon in the background. Accept
                  to let it run or dismiss to skip it.
                </p>
                <div className="flex items-center gap-1.5 pt-0.5">
                  <button
                    onClick={() => setAccepted(true)}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/20 transition-colors text-[10px] font-medium"
                  >
                    <Check className="h-3 w-3" />
                    Accept
                  </button>
                  <button
                    onClick={() => {
                      cancelTask.mutate(
                        { id: projectId, taskId: queuedTaskId },
                        {
                          onSuccess: () => {
                            setDismissed(true);
                            void queryClient.invalidateQueries({
                              queryKey: getListTasksQueryKey(projectId),
                            });
                          },
                        },
                      );
                    }}
                    disabled={cancelTask.isPending}
                    className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors text-[10px] font-medium disabled:opacity-50"
                  >
                    <Ban className="h-3 w-3" />
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

function RewindToCheckpointButton({
  projectId,
  checkpointId,
}: {
  projectId: number;
  checkpointId: number;
}) {
  const queryClient = useQueryClient();
  const restore = useRestoreCheckpoint();
  const [confirming, setConfirming] = useState(false);
  const rewindDescription =
    "Restores the saved project files and keeps chat history in place. A linked database snapshot is restored when one exists.";

  const onClick = () => {
    if (!confirming) {
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 4000);
      return;
    }
    restore.mutate(
      { id: projectId, checkpointId },
      {
        onSuccess: () => {
          setConfirming(false);
          void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
          void queryClient.invalidateQueries({
            queryKey: getListProjectFilesQueryKey(projectId),
          });
          void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
        },
      },
    );
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={restore.isPending}
      title={confirming ? `Click again to confirm. ${rewindDescription}` : rewindDescription}
      className={cn(
        "flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded border font-medium shrink-0 transition-colors disabled:opacity-50",
        confirming
          ? "bg-orange-500/15 text-orange-400 border-orange-500/40 hover:bg-orange-500/25"
          : "bg-muted text-muted-foreground border-border hover:text-foreground hover:border-primary/30",
      )}
    >
      {restore.isPending ? (
        <Loader2 className="h-2.5 w-2.5 animate-spin" />
      ) : (
        <History className="h-2.5 w-2.5" />
      )}
      {restore.isPending ? "Restoring…" : confirming ? "Confirm rewind" : "Rewind"}
    </button>
  );
}

function SubagentActivityPanel({ projectId, taskId }: { projectId: number; taskId: number }) {
  const { data: events = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
      refetchInterval: 1800,
    },
  });
  const subEvents = (
    events as Array<{
      id: number;
      eventType: string;
      message: string;
      createdAt: string;
    }>
  ).filter((e) => typeof e.eventType === "string" && e.eventType.startsWith("subagent_"));
  if (subEvents.length === 0) return null;
  type Row = { role: string; phase: string; detail: string; key: number };
  const rows: Row[] = subEvents.slice(-8).map((e) => {
    let parsed: { role?: string; detail?: string };
    try {
      parsed = JSON.parse(e.message) as { role?: string; detail?: string };
    } catch {
      parsed = {};
    }
    return {
      role: parsed.role ?? "subagent",
      phase: e.eventType.replace("subagent_", ""),
      detail: parsed.detail ?? "",
      key: e.id || e.createdAt.length + Math.random(),
    };
  });
  const roleColor: Record<string, string> = {
    designer: "text-pink-400 border-pink-500/30 bg-pink-500/10",
    explorer: "text-sky-400 border-sky-500/30 bg-sky-500/10",
    tester: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10",
    reviewer: "text-amber-400 border-amber-500/30 bg-amber-500/10",
  };
  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-card/50 px-2.5 py-1.5">
      <div className="flex items-center gap-1.5 mb-1">
        <Zap className="h-3 w-3 text-muted-foreground" />
        <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
          Subagent activity
        </span>
        <span className="text-[9px] text-muted-foreground/60 ml-auto">
          {subEvents.length} event{subEvents.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-0.5">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-1.5 text-[10px]">
            <span
              className={cn(
                "px-1.5 py-0.5 rounded font-medium border shrink-0",
                roleColor[r.role] ?? "text-muted-foreground border-border bg-muted",
              )}
            >
              {r.role}
            </span>
            <span className="text-muted-foreground shrink-0">
              {r.phase === "started" ? "▶" : r.phase === "done" ? "✓" : "…"}
            </span>
            <span className="text-foreground/80 truncate">{r.detail}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Quality Gate Failure Card ─────────────────────────────────────────────────
// Shown when staged TypeScript / ESLint / smoke-test checks fail.
// Includes an "Auto-fix" button that submits a targeted refine prompt and a
// "Discard" button to abandon the staged changes.

function QualityGateFailureCard({
  projectId,
  taskId,
  report,
  onSendMessage,
  onAutoFix,
  onNavigateToSecret,
}: {
  projectId: number;
  taskId: number;
  report: TaskReport;
  onSendMessage?: (text: string) => void;
  /** Called when the user clicks Auto-fix; always routed with Main Agent identity. */
  onAutoFix?: (text: string) => void;
  onNavigateToSecret?: (secretName: string) => void;
}) {
  const queryClient = useQueryClient();
  const discardStaging = useDiscardTaskStaging();
  const [discarded, setDiscarded] = useState(false);
  const [openChecks, setOpenChecks] = useState<Set<string>>(new Set());

  if (discarded) {
    return (
      <div className="mt-2 bg-muted border border-border/40 rounded-lg p-2.5 text-[11px] flex items-center gap-2 text-muted-foreground">
        <Ban className="h-3.5 w-3.5 shrink-0" />
        Changes discarded — no files were modified
      </div>
    );
  }

  const gate = report.qualityGate;
  // Only non-skipped failed checks drive the auto-fix prompt and failure count.
  const failedChecks = gate?.checks.filter((c) => !c.skipped && !c.passed) ?? [];
  const skippedChecks = gate?.checks.filter((c) => c.skipped) ?? [];

  function buildAutoFixPrompt(): string {
    const lines: string[] = ["The quality gate found the following issues. Please fix them:"];
    for (const check of failedChecks) {
      lines.push(`\n### ${check.label}`);
      const excerpt = check.output.slice(0, 600).trimEnd();
      if (excerpt) lines.push("```\n" + excerpt + "\n```");
    }
    return lines.join("\n");
  }

  return (
    <div className="mt-2 bg-background border border-rose-500/30 rounded-xl text-[11px] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-2 bg-rose-500/10 border-b border-rose-500/20">
        <XCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
        <span className="font-semibold text-rose-400 flex-1">Quality Gate Failed</span>
        <span className="text-[9px] text-rose-400/60 font-medium">Staged · not applied</span>
      </div>

      {/* Failed checks */}
      <div className="px-2.5 py-2 space-y-2">
        {failedChecks.length === 0 && skippedChecks.length === 0 && (
          <p className="text-muted-foreground italic">No check details available.</p>
        )}
        {/* Skipped checks — shown first as informational, not failures */}
        {skippedChecks.map((check) => (
          <div
            key={check.id}
            className="rounded-md border border-border/40 bg-muted/30 px-2.5 py-1.5 flex items-center gap-2"
          >
            <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/40">
              Skipped
            </span>
            <span className="text-muted-foreground">{check.label}</span>
            {check.skipReason && (
              <span className="text-[9px] text-muted-foreground/60 truncate">
                — {check.skipReason}
              </span>
            )}
          </div>
        ))}
        {failedChecks.map((check) => {
          const isOpen = openChecks.has(check.id);
          return (
            <div
              key={check.id}
              className="rounded-md border border-rose-500/20 bg-rose-500/5 overflow-hidden"
            >
              <button
                type="button"
                onClick={() =>
                  setOpenChecks((prev) => {
                    const next = new Set(prev);
                    if (isOpen) next.delete(check.id);
                    else next.add(check.id);
                    return next;
                  })
                }
                className="w-full flex items-center gap-2 px-2.5 py-2 text-[11px] hover:bg-rose-500/5 transition-colors"
              >
                <XCircle className="h-3 w-3 text-rose-400 shrink-0" />
                <span className="font-medium text-rose-300 flex-1 text-left">{check.label}</span>
                <span className="text-[9px] text-muted-foreground/60">
                  {(check.durationMs / 1000).toFixed(1)} s
                </span>
                {isOpen ? (
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
              {isOpen && check.output && (
                <pre className="px-2.5 pb-2 text-[10px] text-rose-200/80 font-mono whitespace-pre-wrap leading-relaxed overflow-x-auto max-h-48 overflow-y-auto bg-rose-950/30">
                  {check.output.slice(0, 2000)}
                  {check.output.length > 2000 && "\n… (truncated)"}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      {/* Undeclared env vars — shown in the needs_fix card too */}
      {(report.undeclaredEnvVars ?? []).length > 0 && (
        <div className="px-2.5 pb-2">
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2 space-y-1">
            <div className="flex items-center gap-1.5 text-amber-400">
              <KeySquare className="h-3 w-3 shrink-0" />
              <span className="text-[10px] font-semibold">Undeclared environment variables</span>
            </div>
            {report.undeclaredEnvVars!.map((v) => (
              <div key={v.varName} className="flex items-center justify-between gap-1.5 pl-4">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[10px] text-amber-300 truncate">{v.varName}</span>
                  <span className="text-[10px] text-muted-foreground/60 truncate">in {v.file}</span>
                </div>
                {onNavigateToSecret && (
                  <button
                    onClick={() => onNavigateToSecret(v.varName)}
                    className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors border border-amber-500/20"
                  >
                    Add secret
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/40 bg-muted/20">
        <button
          onClick={() => {
            const prompt = buildAutoFixPrompt();
            // onAutoFix is wired to Main Agent so the retry updates the live project path.
            (onAutoFix ?? onSendMessage)?.(prompt);
          }}
          disabled={!onAutoFix && !onSendMessage}
          className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-lg bg-rose-500 text-white text-[11px] font-medium hover:bg-rose-600 transition-colors disabled:opacity-50"
          title="Submit a targeted fix to the AI"
        >
          <Wrench className="h-3 w-3" />
          Auto-fix
        </button>
        <button
          onClick={() => {
            discardStaging.mutate(
              { id: projectId, taskId },
              {
                onSuccess: () => {
                  setDiscarded(true);
                  void queryClient.invalidateQueries({
                    queryKey: getListMessagesQueryKey(projectId),
                  });
                },
              },
            );
          }}
          disabled={discardStaging.isPending}
          className="flex items-center gap-1.5 h-7 px-3 rounded-lg border border-border text-muted-foreground text-[11px] font-medium hover:text-foreground hover:border-primary/30 transition-colors disabled:opacity-50"
        >
          {discardStaging.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          Discard
        </button>
      </div>
    </div>
  );
}

// ── What-to-look-for guidance rules (static, pattern-based) ──────────────────
const REVIEW_RULES: Array<{
  pattern: RegExp;
  tip: string;
}> = [
  {
    pattern: /\bsrc\/routes?\b|\broutes?\//i,
    tip: "A new route was added — verify the path matches what the frontend calls.",
  },
  {
    pattern: /\bschema\b|\bmigrat/i,
    tip: "Schema or migration file changed — confirm the migration runs cleanly and is backwards-compatible.",
  },
  {
    pattern: /\bauth\b|\bsession\b|\bjwt\b|\bpassword/i,
    tip: "Authentication code changed — double-check that login and session handling still work end-to-end.",
  },
  {
    pattern: /\benv\b|\b\.env\b|\bprocess\.env/i,
    tip: "Environment variable usage changed — make sure all referenced vars are declared in your Secrets.",
  },
  {
    pattern: /\bpackage\.json\b|\bpackage-lock\b|\byarn\.lock\b/i,
    tip: "Package dependencies changed — a restart may be required for new packages to load.",
  },
  {
    pattern: /\bapi\//i,
    tip: "API layer changed — verify the response shape matches what the frontend expects.",
  },
  {
    pattern: /\bcomponent\b|\bpages?\//i,
    tip: "UI component changed — check the preview to make sure the layout still looks right.",
  },
  {
    pattern: /\bconfig\b|\bvite\.config\b|\btsconfig\b/i,
    tip: "Config file changed — a full rebuild may be needed for the new settings to take effect.",
  },
];

function getWhatToLookForTips(changedFiles: string[]): string[] {
  const tips = new Set<string>();
  for (const file of changedFiles) {
    for (const rule of REVIEW_RULES) {
      if (rule.pattern.test(file)) tips.add(rule.tip);
    }
  }
  return [...tips].slice(0, 4);
}

// ── Dismissed tips persistence ────────────────────────────────────────────────
const DISMISSED_TIPS_KEY = "mustaflow_dismissed_review_tips";

function useDismissedTips() {
  const [dismissed, setDismissed] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(DISMISSED_TIPS_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch {
      return new Set();
    }
  });

  const dismiss = useCallback((tip: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(tip);
      try {
        localStorage.setItem(DISMISSED_TIPS_KEY, JSON.stringify([...next]));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    setDismissed(new Set());
    try {
      localStorage.removeItem(DISMISSED_TIPS_KEY);
    } catch {
      // ignore storage errors
    }
  }, []);

  return { dismissed, dismiss, reset };
}

// ── Task Review Card ──────────────────────────────────────────────────────────
function TaskReviewCard({
  projectId,
  taskId,
  report,
  onViewFile,
  onNavigateToSecret,
  onSendMessage,
}: {
  projectId: number;
  taskId: number;
  report: TaskReport;
  onViewFile?: (path: string, line?: number) => void;
  onNavigateToSecret?: (secretName: string) => void;
  onSendMessage?: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const applyStaging = useApplyTaskStaging();
  const discardStaging = useDiscardTaskStaging();
  const [applied, setApplied] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(false);
  const [applyFailure, setApplyFailure] = useState<unknown | null>(null);
  const completionKind = report.agentLoop?.completionKind;
  // Apply step index driven by backend narration events (not a timer).
  const [applyStartedAt, setApplyStartedAt] = useState<number | null>(null);
  const { dismissed: dismissedTips, dismiss: dismissTip, reset: resetTips } = useDismissedTips();

  // Security gate block: parsed from the task result JSON when an apply is
  // rejected by the SAST or npm-audit gate. Shown as a "Fix with AI" card.
  // We also watch liveTask.result via an effect so the card appears even when
  // the task query refetches after the mutation error callback fires.
  type SecurityGateBlock =
    | {
        type: "sast_block";
        findings: Array<{
          file: string;
          line?: number | null;
          message: string;
          detail?: string | null;
          severity: string;
        }>;
        message: string;
        fixPrompt: string;
      }
    | {
        type: "npm_audit_block";
        critical: number;
        high: number;
        parsed: boolean;
        packages: Array<{ name: string; severity: string }>;
        message: string;
        fixPrompt: string;
      };
  const [securityGate, setSecurityGate] = useState<SecurityGateBlock | null>(null);

  // Poll task events when apply is in-flight so we can drive the progress steps.
  const { data: applyEvents = [] } = useListTaskEvents(projectId, taskId, {
    query: {
      enabled: applyStaging.isPending,
      refetchInterval: 800,
      queryKey: getListTaskEventsQueryKey(projectId, taskId),
    },
  });

  // Map narration messages from the backend to step indices.
  const APPLY_STEP_PATTERNS = [
    /syncing\s+\d+\s+file/i, // "Syncing N file(s) to your project…"
    /saving files and version/i, // "Saving files and version…"
    /running database migrations/i, // "Running database migrations…"
    /database migrations completed/i, // "Database migrations completed successfully."
  ] as const;

  const APPLY_STEP_LABELS = [
    "Syncing files to your project…",
    "Saving files and version together…",
    "Running database migrations…",
    "Database migrations completed.",
  ];

  // Determine the furthest step that has been announced.
  const recentEvents = (
    applyEvents as Array<{ eventType: string; message: string; createdAt: string }>
  ).filter(
    (e) =>
      e.eventType === "narration" &&
      applyStartedAt !== null &&
      new Date(e.createdAt).getTime() >= applyStartedAt,
  );

  let applyStepIdx = 0;
  for (const event of recentEvents) {
    for (let i = APPLY_STEP_PATTERNS.length - 1; i >= 0; i--) {
      if (APPLY_STEP_PATTERNS[i].test(event.message)) {
        applyStepIdx = Math.max(applyStepIdx, i);
        break;
      }
    }
  }

  const checksBlocking = report.preReviewChecks?.anyFailed === true;

  // Pull the live task to access stagingSnapshot for per-file diffs (Task #531).
  const { data: tasks } = useListTasks(projectId, {
    query: { queryKey: getListTasksQueryKey(projectId) },
  });
  const liveTask = tasks?.find((t: { id: number }) => t.id === taskId) as
    | {
        stagingSnapshot?: Array<{ path: string; content: string; mimeType: string }> | null;
        result?: string | null;
        status?: string | null;
        terminal?: unknown;
      }
    | undefined;
  const staging = liveTask?.stagingSnapshot ?? null;
  const terminal = liveTask ? terminalPresentationFor(liveTask) : null;
  const stagingByPath = new Map<string, string>((staging ?? []).map((f) => [f.path, f.content]));

  // Parse security gate findings from the live task result whenever the task
  // data refreshes — covers the async refetch that races the mutation onError.
  useEffect(() => {
    if (!applyStaging.isError || securityGate) return;
    try {
      const raw = liveTask?.result;
      if (raw) {
        const parsed = JSON.parse(raw) as {
          type?: string;
          findings?: unknown[];
          message?: string;
          fixPrompt?: string;
          critical?: number;
          high?: number;
          parsed?: boolean;
        };
        if ((parsed.type === "sast_block" || parsed.type === "npm_audit_block") && parsed.message) {
          setSecurityGate(parsed as SecurityGateBlock);
        }
      }
    } catch {
      // not a structured block — ignore
    }
  }, [liveTask?.result, applyStaging.isError, securityGate]);

  const allChanged = [
    ...(report.filesCreated ?? []),
    ...(report.filesModified ?? []),
    ...(report.filesDeleted ?? []),
  ];

  if (applied) {
    const outcomeUnavailable = terminal?.tone === "unknown";
    return (
      <div
        className={cn(
          "mt-2 rounded-lg p-2.5 text-[11px] flex items-center gap-2",
          outcomeUnavailable
            ? "bg-amber-500/10 border border-amber-500/20 text-amber-400"
            : "bg-green-500/10 border border-green-500/20 text-green-400",
        )}
      >
        {outcomeUnavailable ? (
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        )}
        {terminal?.message ?? "Changes applied — project updated"}
      </div>
    );
  }
  if (discarded) {
    return (
      <div className="mt-2 bg-muted border border-border/40 rounded-lg p-2.5 text-[11px] flex items-center gap-2 text-muted-foreground">
        <Ban className="h-3.5 w-3.5 shrink-0" />
        Changes discarded — no files were modified
      </div>
    );
  }

  return (
    <div className="mt-2 bg-background border border-amber-500/30 rounded-xl text-[11px] overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-2.5 py-2 bg-amber-500/10 border-b border-amber-500/20">
        <Cpu className="h-3.5 w-3.5 text-amber-400 shrink-0" />
        <span className="font-semibold text-amber-400 flex-1">Review Required</span>
        <span className="text-[9px] text-amber-400/60 font-medium">Staged · not applied</span>
      </div>

      {/* Pre-review checks — pending state while checks are still running */}
      {!report.preReviewChecks && (
        <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border/40 text-[10px] text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin shrink-0" />
          Verifying changes…
        </div>
      )}

      {/* Pre-review checks checklist */}
      {report.preReviewChecks && report.preReviewChecks.checks.length > 0 && (
        <div
          className={cn(
            "px-2.5 py-2 border-b",
            report.preReviewChecks.anyFailed
              ? "border-rose-500/20 bg-rose-500/5"
              : "border-emerald-500/20 bg-emerald-500/5",
          )}
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            <ShieldCheck
              className={cn(
                "h-3 w-3 shrink-0",
                report.preReviewChecks.anyFailed ? "text-rose-400" : "text-emerald-400",
              )}
            />
            <span
              className={cn(
                "text-[10px] font-semibold",
                report.preReviewChecks.anyFailed ? "text-rose-400" : "text-emerald-400",
              )}
            >
              {report.preReviewChecks.anyFailed
                ? "Pre-review checks found issues"
                : "Pre-review checks passed"}
            </span>
            {onSendMessage && report.preReviewChecks.anyFailed && (
              <button
                type="button"
                onClick={() =>
                  onSendMessage(
                    "Fix the issues found in the pre-review checks: " +
                      report
                        .preReviewChecks!.checks.filter((c) => !c.passed && !c.skipped)
                        .flatMap((c) => c.errors)
                        .slice(0, 5)
                        .join("; "),
                  )
                }
                className="ml-auto flex items-center gap-1 text-[9px] font-medium px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400 border border-rose-500/20 hover:bg-rose-500/25 transition-colors shrink-0"
              >
                <Wrench className="h-2.5 w-2.5" />
                Fix with AI
              </button>
            )}
          </div>
          <div className="space-y-0.5 pl-4">
            {report.preReviewChecks.checks.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5">
                {c.skipped ? (
                  <Minus className="h-2.5 w-2.5 text-muted-foreground/50 shrink-0" />
                ) : c.passed ? (
                  <Check className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
                ) : (
                  <X className="h-2.5 w-2.5 text-rose-400 shrink-0" />
                )}
                <span
                  className={cn(
                    "text-[10px]",
                    c.skipped
                      ? "text-muted-foreground/50"
                      : c.passed
                        ? "text-emerald-400/80"
                        : "text-rose-400",
                  )}
                >
                  {c.label}
                </span>
                {!c.passed && !c.skipped && c.errorCount > 0 && (
                  <span className="text-[9px] text-rose-400/70 ml-auto shrink-0">
                    {c.errorCount} {c.errorCount === 1 ? "issue" : "issues"}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All checks passed banner (legacy quality gate) */}
      {report.allChecksPassed && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400">
          <ShieldCheck className="h-3 w-3 shrink-0" />
          <span className="text-[10px] font-semibold">All checks passed</span>
          {(report.qualityGate?.checks ?? []).length > 0 && (
            <span className="text-[9px] text-emerald-400/70 ml-1">
              {report.qualityGate!.checks.map((c) => c.label).join(" · ")}
            </span>
          )}
        </div>
      )}

      {/* Validation warnings — required checks passed, non-required checks failed */}
      {(report.warningChecks ?? []).length > 0 && (
        <div className="px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertTriangle className="h-3 w-3 shrink-0" />
            <span className="text-[10px] font-semibold">
              {terminal?.message ??
                getBuilderWarningCompletionMessage(completionKind, report.previewUpdated)}
            </span>
          </div>
          <div className="mt-1 space-y-0.5">
            {report.warningChecks!.map((c) => (
              <div key={c.id} className="text-[9px] text-amber-400/70 pl-5">
                {c.label} — non-blocking
              </div>
            ))}
          </div>
          <div className="text-[9px] text-amber-400/60 pl-5 mt-0.5">
            Publish requires confirmation override
          </div>
        </div>
      )}

      {/* Repair loop exhausted — completed with TypeScript errors */}
      {report.completedWithErrors && (
        <div className="flex items-center gap-2 px-2.5 py-1.5 bg-amber-500/10 border-b border-amber-500/30 text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="text-[10px] font-semibold">
            {terminal?.message ??
              getBuilderCompletionMessage(
                completionKind,
                "Build complete — TypeScript errors remain",
              )}
          </span>
          {report.repairLoop && (
            <span className="text-[9px] text-amber-400/70 ml-1">
              Repair exhausted after {report.repairLoop.totalAttempts} attempt
              {report.repairLoop.totalAttempts !== 1 ? "s" : ""}
            </span>
          )}
        </div>
      )}

      {/* Undeclared env vars warning */}
      {(report.undeclaredEnvVars ?? []).length > 0 && (
        <div className="px-2.5 py-2 border-b border-border/40">
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-2 space-y-1">
            <div className="flex items-center gap-1.5 text-amber-400">
              <KeySquare className="h-3 w-3 shrink-0" />
              <span className="text-[10px] font-semibold">Undeclared environment variables</span>
            </div>
            {report.undeclaredEnvVars!.map((v) => (
              <div key={v.varName} className="flex items-center justify-between gap-1.5 pl-4">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[10px] text-amber-300 truncate">{v.varName}</span>
                  <span className="text-[10px] text-muted-foreground/60 truncate">in {v.file}</span>
                </div>
                {onNavigateToSecret && (
                  <button
                    onClick={() => onNavigateToSecret(v.varName)}
                    className="shrink-0 text-[9px] font-medium px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors border border-amber-500/20"
                  >
                    Add secret
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Architect review findings — shown in review card when non-trivial */}
      {report.architectReview &&
        !report.architectReview.skipped &&
        (report.architectReview.findings ?? []).length > 0 && (
          <div className="px-2.5 py-2 border-b border-border/40">
            <div className="rounded-md border border-border/50 bg-card/60 overflow-hidden">
              <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border/40 bg-muted/30">
                <Eye className="h-3 w-3 text-muted-foreground shrink-0" />
                <span className="text-[10px] font-semibold text-muted-foreground">
                  Architect findings
                </span>
                <span
                  className={cn(
                    "ml-auto text-[9px] font-medium px-1.5 py-0.5 rounded",
                    report.architectReview.verdict === "fail"
                      ? "bg-rose-500/15 text-rose-400 border border-rose-500/20"
                      : report.architectReview.verdict === "partial"
                        ? "bg-amber-500/15 text-amber-400 border border-amber-500/20"
                        : "bg-emerald-500/15 text-emerald-400 border border-emerald-500/20",
                  )}
                >
                  {report.architectReview.verdict}
                </span>
              </div>
              <div className="divide-y divide-border/30">
                {report.architectReview.findings.map((f, i) => {
                  // Normalize architect severity levels to UI taxonomy: critical | warning | info
                  const uiSeverity =
                    f.severity === "critical" || f.severity === "high"
                      ? "critical"
                      : f.severity === "medium"
                        ? "warning"
                        : "info";
                  const sevClass =
                    uiSeverity === "critical"
                      ? "bg-rose-500/15 text-rose-400 border-rose-500/20"
                      : uiSeverity === "warning"
                        ? "bg-amber-500/15 text-amber-400 border-amber-500/20"
                        : "bg-blue-500/15 text-blue-400 border-blue-500/20";
                  return (
                    <div key={i} className="px-2 py-1.5 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span
                          className={cn(
                            "text-[9px] font-medium px-1 py-0.5 rounded border shrink-0",
                            sevClass,
                          )}
                        >
                          {uiSeverity}
                        </span>
                        <span className="text-[10px] font-medium text-foreground/90 truncate">
                          {f.title}
                        </span>
                      </div>
                      {f.detail && (
                        <p className="text-[10px] text-muted-foreground leading-relaxed pl-1">
                          {f.detail}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

      {/* What to look for panel */}
      {(() => {
        const allTips = getWhatToLookForTips(allChanged);
        const visibleTips = allTips.filter((tip) => !dismissedTips.has(tip));
        const hasDismissed = dismissedTips.size > 0 && allTips.some((t) => dismissedTips.has(t));
        if (allTips.length === 0) return null;
        return (
          <div className="border-t border-border/40">
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground">
              <button
                type="button"
                onClick={() => setTipsOpen((v) => !v)}
                className="flex items-center gap-1.5 flex-1 min-w-0 hover:text-foreground transition-colors"
              >
                {tipsOpen ? (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronRight className="h-3 w-3 shrink-0" />
                )}
                <BookOpen className="h-3 w-3 shrink-0" />
                <span className="font-medium">What to look for</span>
              </button>
              {hasDismissed && (
                <button
                  type="button"
                  onClick={resetTips}
                  className="text-[9px] text-muted-foreground/50 hover:text-primary transition-colors underline underline-offset-2 shrink-0"
                >
                  Reset tips
                </button>
              )}
              <span className="text-[9px] text-muted-foreground/50 shrink-0">
                {visibleTips.length} tip{visibleTips.length !== 1 ? "s" : ""}
              </span>
            </div>
            {tipsOpen && (
              <div className="px-2.5 pb-2 space-y-1">
                {visibleTips.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground/50 italic">
                    All tips dismissed.{" "}
                    <button
                      type="button"
                      onClick={resetTips}
                      className="underline underline-offset-2 hover:text-primary transition-colors"
                    >
                      Reset
                    </button>{" "}
                    to show them again.
                  </p>
                ) : (
                  visibleTips.map((tip) => (
                    <div key={tip} className="flex items-start gap-1.5 group">
                      <Info className="h-2.5 w-2.5 text-primary/60 shrink-0 mt-0.5" />
                      <span className="text-[10px] text-muted-foreground leading-relaxed flex-1">
                        {tip}
                      </span>
                      <button
                        type="button"
                        onClick={() => dismissTip(tip)}
                        title="Dismiss this tip"
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground/40 hover:text-muted-foreground"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* File summary — each file is an expandable per-file diff. */}
      <div className="px-2.5 py-2 space-y-1.5">
        {(report.filesCreated ?? []).length > 0 && (
          <div className="space-y-1">
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Created · {(report.filesCreated ?? []).length}
            </span>
            <div className="space-y-1">
              {(report.filesCreated ?? []).map((f) => (
                <StagingFileDiffRow
                  key={f}
                  projectId={projectId}
                  taskId={taskId}
                  path={f}
                  stagingContent={stagingByPath.get(f) ?? ""}
                  status="created"
                  onViewFile={onViewFile}
                />
              ))}
            </div>
          </div>
        )}
        {(report.filesModified ?? []).length > 0 && (
          <div className="space-y-1">
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Modified · {(report.filesModified ?? []).length}
            </span>
            <div className="space-y-1">
              {(report.filesModified ?? []).map((f) => (
                <StagingFileDiffRow
                  key={f}
                  projectId={projectId}
                  taskId={taskId}
                  path={f}
                  stagingContent={stagingByPath.get(f) ?? null}
                  status="modified"
                  onViewFile={onViewFile}
                />
              ))}
            </div>
          </div>
        )}
        {(report.filesDeleted ?? []).length > 0 && (
          <div className="space-y-1">
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Deleted · {(report.filesDeleted ?? []).length}
            </span>
            <div className="space-y-1">
              {(report.filesDeleted ?? []).map((f) => (
                <StagingFileDiffRow
                  key={f}
                  projectId={projectId}
                  taskId={taskId}
                  path={f}
                  stagingContent={null}
                  status="deleted"
                />
              ))}
            </div>
          </div>
        )}
        {allChanged.length === 0 && (
          <p className="text-muted-foreground">No file changes in staging snapshot.</p>
        )}
      </div>
      {/* Toggle report */}
      {report.summary && (
        <div className="border-t border-border/40">
          <button
            onClick={() => setReportOpen((v) => !v)}
            className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {reportOpen ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            What changed
          </button>
          {reportOpen && (
            <div className="px-2.5 pb-2 text-[11px] text-muted-foreground leading-relaxed">
              {report.summary}
            </div>
          )}
        </div>
      )}
      {/* Apply progress indicator — driven by backend narration events */}
      {applyStaging.isPending && (
        <div className="px-2.5 py-2 border-t border-border/40 bg-muted/10 space-y-1">
          {APPLY_STEP_LABELS.map((step, i) => (
            <div key={i} className="flex items-center gap-1.5">
              {i < applyStepIdx ? (
                <Check className="h-2.5 w-2.5 text-emerald-400 shrink-0" />
              ) : i === applyStepIdx ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin text-primary shrink-0" />
              ) : (
                <Minus className="h-2.5 w-2.5 text-muted-foreground/30 shrink-0" />
              )}
              <span
                className={cn(
                  "text-[10px]",
                  i < applyStepIdx
                    ? "text-emerald-400/70"
                    : i === applyStepIdx
                      ? "text-foreground/80"
                      : "text-muted-foreground/40",
                )}
              >
                {step}
              </span>
            </div>
          ))}
        </div>
      )}
      {applyFailure !== null && !securityGate && <ApplyFailureNotice error={applyFailure} />}
      {/* Actions */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/40 bg-muted/20">
        {/* When checks are blocking, replace Apply with Fix with AI */}
        {checksBlocking && !applyStaging.isPending ? (
          <button
            onClick={() => {
              if (!onSendMessage || !report.preReviewChecks) return;
              const failedErrors = report.preReviewChecks.checks
                .filter((c) => !c.passed && !c.skipped)
                .flatMap((c) => c.errors)
                .slice(0, 5)
                .join("; ");
              onSendMessage("Fix the issues found in the pre-review checks: " + failedErrors);
            }}
            disabled={!onSendMessage}
            className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-lg bg-rose-600 text-white text-[11px] font-medium hover:bg-rose-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Wrench className="h-3 w-3" />
            Fix with AI
          </button>
        ) : (
          <button
            onClick={() => {
              setApplyFailure(null);
              setSecurityGate(null);
              setApplyStartedAt(Date.now());
              applyStaging.mutate(
                { id: projectId, taskId },
                {
                  onSuccess: () => {
                    setApplyFailure(null);
                    setApplied(true);
                    void queryClient.invalidateQueries({
                      queryKey: getListMessagesQueryKey(projectId),
                    });
                    void queryClient.invalidateQueries({
                      queryKey: getGetProjectQueryKey(projectId),
                    });
                    void queryClient.invalidateQueries({
                      queryKey: getListProjectFilesQueryKey(projectId),
                    });
                    void queryClient.invalidateQueries({
                      queryKey: getListVersionsQueryKey(projectId),
                    });
                  },
                  onError: (error) => {
                    setApplyFailure(error);
                    setApplyStartedAt(null);
                    // Refetch the task so we can read the structured result JSON
                    // from the failed SAST / npm-audit gate.
                    void queryClient.invalidateQueries({
                      queryKey: getListTasksQueryKey(projectId),
                    });
                    // Try to parse security gate findings from the updated task result.
                    // The invalidation above is async; read from the current liveTask
                    // which may already have the result if the task update raced ahead.
                    try {
                      const raw = liveTask?.result;
                      if (raw) {
                        const parsed = JSON.parse(raw) as {
                          type?: string;
                          findings?: unknown[];
                          message?: string;
                          fixPrompt?: string;
                          critical?: number;
                          high?: number;
                          parsed?: boolean;
                        };
                        if (
                          (parsed.type === "sast_block" || parsed.type === "npm_audit_block") &&
                          parsed.message
                        ) {
                          setSecurityGate(parsed as Parameters<typeof setSecurityGate>[0]);
                        }
                      }
                    } catch {
                      // not a structured block — ignore
                    }
                  },
                },
              );
            }}
            disabled={applyStaging.isPending || discardStaging.isPending}
            className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {applyStaging.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {applyStaging.isPending ? "Applying…" : "Apply changes"}
          </button>
        )}
        <button
          onClick={() => {
            discardStaging.mutate(
              { id: projectId, taskId },
              {
                onSuccess: () => {
                  setDiscarded(true);
                  void queryClient.invalidateQueries({
                    queryKey: getListMessagesQueryKey(projectId),
                  });
                },
              },
            );
          }}
          disabled={applyStaging.isPending || discardStaging.isPending}
          className="flex items-center gap-1.5 h-7 px-3 rounded-lg border border-border text-muted-foreground text-[11px] font-medium hover:text-foreground hover:border-primary/30 transition-colors disabled:opacity-50"
        >
          {discardStaging.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          Discard
        </button>
      </div>

      {/* Security gate block card — shown when SAST or npm audit rejects the apply */}
      {securityGate && (
        <div className="border-t border-red-900/30 bg-red-950/20 px-2.5 py-2.5 space-y-2">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold text-red-400">
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
            {securityGate.type === "sast_block"
              ? `Security gate blocked apply — ${securityGate.findings.length} critical issue(s) found`
              : `Security gate blocked apply — npm audit: ${securityGate.critical} critical, ${securityGate.high} high`}
          </div>

          {securityGate.type === "sast_block" && securityGate.findings.length > 0 && (
            <ul className="space-y-1 pl-1">
              {securityGate.findings.slice(0, 5).map((f, i) => (
                <li key={i} className="text-[10px] text-red-300/80">
                  <span className="font-mono text-[9px] text-red-400/70">
                    {f.file}
                    {f.line != null ? `:${f.line}` : ""}
                  </span>{" "}
                  — {f.message}
                  {f.detail && (
                    <span className="ml-1 text-[9px] text-muted-foreground">({f.detail})</span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {securityGate.type === "npm_audit_block" && securityGate.packages.length > 0 && (
            <ul className="space-y-1 pl-1">
              {securityGate.packages.slice(0, 5).map((p, i) => (
                <li key={i} className="text-[10px] text-red-300/80">
                  <span className="font-mono text-[9px] text-red-400/70">{p.name}</span> —{" "}
                  {p.severity}
                </li>
              ))}
            </ul>
          )}

          {securityGate.type === "npm_audit_block" && !securityGate.parsed && (
            <p className="text-[10px] text-red-300/70 italic">
              Full vulnerability details unavailable — audit report could not be parsed.
            </p>
          )}

          {onSendMessage && (
            <button
              onClick={() => onSendMessage(securityGate.fixPrompt)}
              className="mt-0.5 flex items-center gap-1.5 h-6 px-2.5 rounded-md bg-rose-600 text-white text-[10px] font-medium hover:bg-rose-500 transition-colors"
            >
              <Wrench className="h-2.5 w-2.5" />
              Fix with AI
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function DateDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="flex-1 h-px bg-border/50" />
      <span className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider shrink-0">
        {label}
      </span>
      <div className="flex-1 h-px bg-border/50" />
    </div>
  );
}

export function ChatHistory({
  messages,
  isLoading,
  projectId,
  onViewFile,
  onOpenCheckpoint,
  onOpenTask,
  onClose,
  onApplyCode,
  onSendMessage,
  onAutoFix,
  onNavigateToSecret,
  onEditAndResend,
}: {
  messages: Message[] | undefined;
  isLoading: boolean;
  projectId: number;
  onViewFile?: (path: string, line?: number) => void;
  onOpenCheckpoint?: (checkpointId: number) => void;
  onOpenTask?: (taskId: number) => void;
  onClose: () => void;
  onApplyCode?: (code: string) => void;
  onSendMessage?: (text: string) => void;
  /** Forwarded to QualityGateFailureCard Auto-fix button with Main Agent identity. */
  onAutoFix?: (text: string) => void;
  onNavigateToSecret?: (secretName: string) => void;
  onEditAndResend?: (text: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [serverHits, setServerHits] = useState<
    { id: number; role: string; content: string; createdAt: string; snippet: string }[] | null
  >(null);
  const [serverSearching, setServerSearching] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followsLatestRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const editableUserMessageId = latestUserMessageId(messages);

  // Debounce search input → server full-text search (Task #546)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250);
    return () => clearTimeout(t);
  }, [searchQuery]);

  useEffect(() => {
    if (!debouncedQuery) {
      setServerHits(null);
      return;
    }
    let cancelled = false;
    setServerSearching(true);
    void (async () => {
      try {
        const r = await authFetch(
          `/api/projects/${projectId}/messages/search?q=${encodeURIComponent(debouncedQuery)}&limit=50`,
        );
        if (!r.ok) {
          if (!cancelled) setServerHits([]);
          return;
        }
        const data = (await r.json()) as {
          results: {
            id: number;
            role: string;
            content: string;
            createdAt: string;
            snippet: string;
          }[];
        };
        if (!cancelled) setServerHits(data.results ?? []);
      } catch {
        if (!cancelled) setServerHits([]);
      } finally {
        if (!cancelled) setServerSearching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, projectId]);

  // When a server search is active, render messages in relevance-rank order
  // (as returned by ts_rank) instead of chronological order, so the most
  // relevant hits appear first. We still use the loaded MessageRow records
  // (keyed by id) to preserve rich rendering of plans, reports, etc.
  const filtered =
    serverHits !== null
      ? (() => {
          const byId = new Map((messages ?? []).map((m) => [m.id, m]));
          return serverHits.map((h) => byId.get(h.id)).filter((m): m is Message => m !== undefined);
        })()
      : (messages ?? []);

  const grouped: { dateKey: string; label: string; msgs: Message[] }[] = [];
  for (const msg of filtered) {
    const key = getDateKey(msg.createdAt);
    const last = grouped[grouped.length - 1];
    if (last && last.dateKey === key) {
      last.msgs.push(msg);
    } else {
      grouped.push({ dateKey: key, label: getDateLabel(msg.createdAt), msgs: [msg] });
    }
  }

  useEffect(() => {
    if (searchQuery || !followsLatestRef.current) return;
    const frame = requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element || !followsLatestRef.current) return;
      scrollChatToLatest(element);
      lastScrollTopRef.current = element.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [messages, searchQuery]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const followsLatest = nextChatFollowState({
      wasFollowing: followsLatestRef.current,
      previousScrollTop: lastScrollTopRef.current,
      metrics: el,
    });
    lastScrollTopRef.current = el.scrollTop;
    followsLatestRef.current = followsLatest;
    setShowJumpToBottom(!followsLatest);
  };

  const jumpToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    scrollChatToLatest(element);
    lastScrollTopRef.current = element.scrollTop;
    followsLatestRef.current = true;
    setShowJumpToBottom(false);
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-border/50 flex items-center gap-2 bg-card/60">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-semibold text-foreground">Chat History</span>
        {messages && messages.length > 0 && (
          <span className="text-[10px] text-muted-foreground">
            {messages.length} message{messages.length !== 1 ? "s" : ""}
          </span>
        )}
        <button
          onClick={() => setFeedbackOpen(true)}
          className="ml-auto flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
          title="Send feedback to the AI builder"
        >
          <MessageSquarePlus className="h-3 w-3" /> Feedback
        </button>
        <button
          onClick={onClose}
          className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
        >
          <X className="h-3 w-3" /> Back to chat
        </button>
      </div>
      {feedbackOpen && (
        <FeedbackModal projectId={projectId} onClose={() => setFeedbackOpen(false)} />
      )}

      {/* Search bar */}
      <div className="shrink-0 px-3 py-2 border-b border-border/40">
        <div className="flex items-center gap-2 bg-muted border border-border rounded-lg px-2.5 py-1.5">
          <Search className="h-3 w-3 text-muted-foreground shrink-0" />
          <input
            type="text"
            placeholder="Search messages…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 focus:outline-none min-w-0"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        {searchQuery && (
          <div className="mt-1 text-[10px] text-muted-foreground px-0.5 flex items-center gap-2">
            {serverSearching ? (
              <>
                <Loader2 className="h-2.5 w-2.5 animate-spin" /> Searching…
              </>
            ) : (
              <span>
                {filtered.length} result{filtered.length !== 1 ? "s" : ""}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0 hide-scrollbar relative"
      >
        {isLoading && (
          <div className="space-y-3 pt-2">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className={cn("flex", i % 2 === 0 ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "h-10 rounded-xl bg-muted animate-pulse",
                    i % 2 === 0 ? "w-2/3" : "w-3/4",
                  )}
                />
              </div>
            ))}
          </div>
        )}

        {!isLoading && (messages ?? []).length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center pt-8">
            <div className="p-3 rounded-full bg-muted">
              <MessageSquare className="h-6 w-6 text-muted-foreground/40" />
            </div>
            <div>
              <div className="text-xs font-medium text-foreground/60">No messages yet</div>
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                Ask a question, request a plan, or describe what you want to build
              </div>
            </div>
          </div>
        )}

        {!isLoading && (messages ?? []).length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center pt-8">
            <Search className="h-6 w-6 text-muted-foreground/30" />
            <div>
              <div className="text-xs font-medium text-foreground/60">No results</div>
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                Try a different keyword
              </div>
            </div>
          </div>
        )}

        {!isLoading &&
          grouped.map((group) => (
            <div key={group.dateKey}>
              <DateDivider label={group.label} />
              <div className="space-y-2.5">
                {group.msgs.map((msg) => (
                  <MessageRow
                    key={msg.id}
                    msg={msg}
                    searchQuery={searchQuery}
                    projectId={projectId}
                    onViewFile={onViewFile}
                    onOpenCheckpoint={onOpenCheckpoint}
                    onOpenTask={onOpenTask}
                    onApply={onApplyCode}
                    onSendMessage={onSendMessage}
                    onAutoFix={onAutoFix}
                    onNavigateToSecret={onNavigateToSecret}
                    canEditAndResend={msg.id === editableUserMessageId}
                    onEditAndResend={onEditAndResend}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Jump to bottom */}
      {showJumpToBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <JumpToLatestButton onJump={jumpToBottom} />
        </div>
      )}
    </div>
  );
}
