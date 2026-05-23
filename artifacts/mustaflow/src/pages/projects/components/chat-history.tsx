import { useEffect, useRef, useState, isValidElement } from "react";
import {
  Search,
  X,
  MessageSquare,
  CheckCircle2,
  AlertTriangle,
  KeyRound,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  ArrowDown,
  ExternalLink,
  Lightbulb,
  ShieldAlert,
  ShieldCheck,
  Check,
  Ban,
  RotateCcw,
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
} from "lucide-react";
import { format, isToday, isYesterday } from "date-fns";
import { cn } from "@/lib/utils";
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
  useListTestRuns,
  getListTestRunsQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

type TaskReport = {
  userRequest: string;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  /** Alias used by Task Agent staging gate */
  filesModified?: string[];
  /** Alias used by Task Agent staging gate */
  filesDeleted?: string[];
  /** Summary of what changed (Task Agent staging gate) */
  summary?: string;
  filesUnchanged?: string[];
  previewUpdated: boolean;
  warnings: string[];
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
    creditsCharged: number;
    reviewedAt: string;
    model: string;
    skipped?: boolean;
    skipReason?: string;
    isReReview?: boolean;
    completedWithWarnings?: boolean;
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
    }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | { kind: "converse"; taskId?: number }
  | { kind: "clarifying"; question: string; options: string[]; taskId?: number }
  | Record<string, unknown>;

type ChatAttachment = {
  kind: "image";
  url: string;
  alt?: string;
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
};

function AttachmentGallery({ attachments }: { attachments: ChatAttachment[] }) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {attachments.map((att, i) => {
        if (att.kind !== "image" || !att.url) return null;
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

export function MarkdownMessage({
  content,
  onApply,
}: {
  content: string;
  onApply?: (code: string) => void;
}) {
  return (
    <div
      className={cn(
        "prose prose-invert max-w-none",
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
        components={
          onApply
            ? {
                pre({ children, ...props }) {
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
            : undefined
        }
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
      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-primary/25 to-primary/10 border border-primary/25 flex items-center justify-center shrink-0">
        <BrainCircuit className="w-3 h-3 text-primary/80" />
      </div>
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
}: {
  content: string;
  messageId: number;
  animate?: boolean;
  onApply?: (code: string) => void;
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
    return <MarkdownMessage content={content} onApply={onApply} />;
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
  return (
    <span
      className={cn(
        "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border shrink-0",
        mode === "pro"
          ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
          : mode === "power"
            ? "bg-primary/10 text-primary border-primary/20"
            : mode === "eco"
              ? "bg-green-500/10 text-green-400 border-green-500/20"
              : "bg-muted text-muted-foreground border-border",
      )}
    >
      {mode}
    </span>
  );
}

const TESTS_PENDING_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

// ─────────────────────────────────────────────────────────────────────────────
// Architect review card (Task #507) — verdict badge + collapsible findings.
// ─────────────────────────────────────────────────────────────────────────────
function ArchitectReviewCard({ review }: { review: NonNullable<TaskReport["architectReview"]> }) {
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

  return (
    <div className="pt-1.5 border-t border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 text-[11px] hover:opacity-80 transition-opacity"
        data-testid="architect-review-toggle"
      >
        <BrainCircuit className="h-3.5 w-3.5 shrink-0 text-violet-400" />
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
            {review.creditsCharged > 0
              ? `${review.creditsCharged} credit${review.creditsCharged === 1 ? "" : "s"} charged`
              : "No credits charged"}
            {review.model ? ` · ${review.model}` : ""}
          </p>
        </div>
      )}
    </div>
  );
}

function InlineReportCard({
  report,
  onViewFile,
  onSendMessage,
  taskId,
  projectId,
  taskCreatedAt,
}: {
  report: TaskReport;
  onViewFile?: (path: string) => void;
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
  const rerunTests = useRerunTaskTests();
  const queryClient = useQueryClient();

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
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        Builder report
      </div>
      <div
        className={`grid gap-1.5 ${(report.filesUnchanged?.length ?? 0) > 0 ? "grid-cols-4" : "grid-cols-3"}`}
      >
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Created</div>
          <div className="font-semibold text-foreground">{report.filesCreated.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Changed</div>
          <div className="font-semibold text-foreground">{report.filesChanged.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Removed</div>
          <div className="font-semibold text-foreground">{report.filesRemoved.length}</div>
        </div>
        {(report.filesUnchanged?.length ?? 0) > 0 && (
          <div className="bg-muted rounded p-1.5">
            <div className="text-muted-foreground text-[10px] uppercase">Unchanged</div>
            <div className="font-semibold text-foreground">{report.filesUnchanged!.length}</div>
          </div>
        )}
      </div>
      {(report.filesCreated.length > 0 ||
        report.filesChanged.length > 0 ||
        report.filesRemoved.length > 0) && (
        <div className="space-y-0.5 pt-0.5 border-t border-border/50">
          {report.filesCreated.slice(0, 5).map((p) => (
            <button
              key={`c-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-green-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-green-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">+</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesChanged.slice(0, 5).map((p) => (
            <button
              key={`m-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-yellow-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-yellow-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">~</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesRemoved.slice(0, 3).map((p) => (
            <div
              key={`r-${p}`}
              className="font-mono text-[10px] text-red-400/70 truncate flex items-center gap-1"
            >
              <span className="shrink-0">-</span>
              <span className="truncate">{p}</span>
            </div>
          ))}
        </div>
      )}
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
        <ArchitectReviewCard review={report.architectReview} />
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
      {report.warnings.length > 0 && (
        <div className="pt-1.5 border-t border-border">
          <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
            <AlertTriangle className="h-3 w-3" /> {report.warnings.length} warning(s)
          </div>
        </div>
      )}
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
      {report.checkRunsSummary && (
        <div className="pt-1.5 border-t border-border">
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
            <ShieldCheck className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="font-semibold text-foreground/80">Checks</span>
            {report.checkRunsSummary.passed > 0 && (
              <span className="text-green-400">{report.checkRunsSummary.passed} passed</span>
            )}
            {report.checkRunsSummary.warnings > 0 && (
              <span className="text-yellow-400">{report.checkRunsSummary.warnings} warnings</span>
            )}
            {report.checkRunsSummary.failed > 0 && (
              <span className="text-red-400">{report.checkRunsSummary.failed} failed</span>
            )}
            {report.checkRunsSummary.skipped > 0 && (
              <span className="text-muted-foreground/60">
                {report.checkRunsSummary.skipped} skipped
              </span>
            )}
            {(report.checkRunsSummary.failed > 0 || report.checkRunsSummary.warnings > 0) &&
              onSendMessage && (
                <button
                  onClick={() => {
                    const allBad = [
                      ...(report.checkRunsSummary?.failedChecks ?? []),
                      ...(report.checkRunsSummary?.warnChecks ?? []),
                    ];
                    const nameList = allBad.length > 0 ? ` (${allBad.join(", ")})` : "";
                    onSendMessage(
                      `Fix all failing check issues in the generated app${nameList} — address any security vulnerabilities, code quality problems, and other flagged issues shown in the Quality panel.`,
                    );
                  }}
                  className="ml-auto flex items-center gap-1 text-[10px] font-medium text-primary hover:text-primary/80 transition-colors"
                >
                  <Wrench className="h-2.5 w-2.5" />
                  Fix issues
                </button>
              )}
          </div>
          {((report.checkRunsSummary.failedChecks?.length ?? 0) > 0 ||
            (report.checkRunsSummary.warnChecks?.length ?? 0) > 0) && (
            <div className="flex flex-wrap gap-1 mt-1 pl-5">
              {report.checkRunsSummary.failedChecks?.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-red-950/40 text-red-400 border border-red-900/40"
                >
                  {name}
                </span>
              ))}
              {report.checkRunsSummary.warnChecks?.map((name) => (
                <span
                  key={name}
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-medium bg-yellow-950/40 text-yellow-400 border border-yellow-900/40"
                >
                  {name}
                </span>
              ))}
            </div>
          )}
          {report.checkSummary && (
            <p className="text-[10px] text-muted-foreground mt-0.5 pl-5 leading-relaxed">
              {report.checkSummary}
            </p>
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
      {report.nextRecommendation && (
        <div className="pt-1.5 border-t border-border text-muted-foreground italic text-[10px]">
          {report.nextRecommendation}
        </div>
      )}
      {report.versionId && (
        <div className="pt-1.5 border-t border-border">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
            <RotateCcw className="h-3 w-3 shrink-0" />
            <span>Checkpoint saved — roll back any time</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
              #{report.versionId}
            </span>
          </div>
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
        <BrainCircuit className="h-3.5 w-3.5 text-secondary" />
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

function MessageRow({
  msg,
  searchQuery,
  projectId,
  onViewFile,
  onApply,
  onSendMessage,
}: {
  msg: Message;
  searchQuery: string;
  projectId: number;
  onViewFile?: (path: string) => void;
  onApply?: (code: string) => void;
  onSendMessage?: (text: string) => void;
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
          {isUser ? "You" : "AI"}
        </span>
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
      </div>

      {/* Bubble */}
      <div
        className={cn(
          "max-w-[92%] px-3 py-2 rounded-xl text-xs leading-relaxed",
          isUser
            ? "bg-primary/15 text-foreground border border-primary/20 rounded-br-sm"
            : isError
              ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
              : "bg-muted border border-border text-foreground rounded-bl-sm",
        )}
      >
        {isConverse || isClarifying ? (
          <StreamingText content={msg.content} messageId={msg.id} onApply={onApply} />
        ) : msg.role === "assistant" && !isReport && !isError && !isPlanCard && !isTaskQueued ? (
          <MarkdownMessage content={msg.content} onApply={onApply} />
        ) : (
          <div className="whitespace-pre-wrap leading-relaxed">
            {highlightText(msg.content, searchQuery)}
          </div>
        )}

        {Array.isArray(msg.attachments) && msg.attachments.length > 0 && (
          <AttachmentGallery attachments={msg.attachments} />
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

        {/* Expandable report chip */}
        {isReport && (
          <div className="mt-2">
            {(planPayload as { needsReview?: boolean }).needsReview ? (
              <TaskReviewCard
                projectId={projectId}
                taskId={(planPayload as { taskId?: number }).taskId ?? 0}
                report={(planPayload as { report: TaskReport }).report}
                onViewFile={onViewFile}
              />
            ) : (
              <>
                <button
                  onClick={() => setReportExpanded((v) => !v)}
                  className="flex items-center gap-1.5 text-[10px] font-medium px-2 py-1 rounded-md bg-green-500/10 border border-green-500/20 text-green-400 hover:bg-green-500/15 transition-colors"
                >
                  <CheckCircle2 className="h-3 w-3" />
                  View build report
                  {reportExpanded ? (
                    <ChevronDown className="h-3 w-3 ml-0.5" />
                  ) : (
                    <ChevronRight className="h-3 w-3 ml-0.5" />
                  )}
                </button>
                {reportExpanded && (
                  <InlineReportCard
                    report={(planPayload as { kind: "report"; report: TaskReport }).report}
                    onViewFile={onViewFile}
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
              <BrainCircuit className="h-3 w-3" />
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

function TaskReviewCard({
  projectId,
  taskId,
  report,
  onViewFile,
}: {
  projectId: number;
  taskId: number;
  report: TaskReport;
  onViewFile?: (path: string) => void;
}) {
  const queryClient = useQueryClient();
  const applyStaging = useApplyTaskStaging();
  const discardStaging = useDiscardTaskStaging();
  const [applied, setApplied] = useState(false);
  const [discarded, setDiscarded] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  const allChanged = [
    ...(report.filesCreated ?? []),
    ...(report.filesModified ?? []),
    ...(report.filesDeleted ?? []),
  ];

  if (applied) {
    return (
      <div className="mt-2 bg-green-500/10 border border-green-500/20 rounded-lg p-2.5 text-[11px] flex items-center gap-2 text-green-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        Changes applied — project updated
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
        <span className="font-semibold text-amber-400 flex-1">Task Agent — Review Required</span>
        <span className="text-[9px] text-amber-400/60 font-medium">Staged · not applied</span>
      </div>
      {/* File summary */}
      <div className="px-2.5 py-2 space-y-1">
        {(report.filesCreated ?? []).length > 0 && (
          <div>
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Created
            </span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {(report.filesCreated ?? []).map((f) => (
                <button
                  key={f}
                  onClick={() => onViewFile?.(f)}
                  className="text-[9px] px-1.5 py-0.5 bg-green-500/10 border border-green-500/20 rounded font-mono text-green-400 hover:bg-green-500/20 transition-colors"
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}
        {(report.filesModified ?? []).length > 0 && (
          <div>
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Modified
            </span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {(report.filesModified ?? []).map((f) => (
                <button
                  key={f}
                  onClick={() => onViewFile?.(f)}
                  className="text-[9px] px-1.5 py-0.5 bg-yellow-500/10 border border-yellow-500/20 rounded font-mono text-yellow-400 hover:bg-yellow-500/20 transition-colors"
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
        )}
        {(report.filesDeleted ?? []).length > 0 && (
          <div>
            <span className="text-[9px] font-semibold text-muted-foreground/60 uppercase tracking-wide">
              Deleted
            </span>
            <div className="flex flex-wrap gap-1 mt-0.5">
              {(report.filesDeleted ?? []).map((f) => (
                <span
                  key={f}
                  className="text-[9px] px-1.5 py-0.5 bg-red-500/10 border border-red-500/20 rounded font-mono text-red-400 line-through"
                >
                  {f}
                </span>
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
      {/* Actions */}
      <div className="flex items-center gap-2 px-2.5 py-2 border-t border-border/40 bg-muted/20">
        <button
          onClick={() => {
            applyStaging.mutate(
              { id: projectId, taskId },
              {
                onSuccess: () => {
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
              },
            );
          }}
          disabled={applyStaging.isPending || discardStaging.isPending}
          className="flex-1 flex items-center justify-center gap-1.5 h-7 rounded-lg bg-primary text-primary-foreground text-[11px] font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {applyStaging.isPending ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          Apply changes
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
  onClose,
  onApplyCode,
  onSendMessage,
}: {
  messages: Message[] | undefined;
  isLoading: boolean;
  projectId: number;
  onViewFile?: (path: string) => void;
  onClose: () => void;
  onApplyCode?: (code: string) => void;
  onSendMessage?: (text: string) => void;
}) {
  const [searchQuery, setSearchQuery] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const filtered = (messages ?? []).filter((m) =>
    searchQuery.trim() ? m.content.toLowerCase().includes(searchQuery.toLowerCase()) : true,
  );

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
    if (!searchQuery && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, searchQuery]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJumpToBottom(distFromBottom > 120);
  };

  const jumpToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
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
          onClick={onClose}
          className="ml-auto flex items-center gap-1 text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md hover:bg-muted"
        >
          <X className="h-3 w-3" /> Back to chat
        </button>
      </div>

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
          <div className="mt-1 text-[10px] text-muted-foreground px-0.5">
            {filtered.length} result{filtered.length !== 1 ? "s" : ""}
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
                    onApply={onApplyCode}
                    onSendMessage={onSendMessage}
                  />
                ))}
              </div>
            </div>
          ))}
      </div>

      {/* Jump to bottom */}
      {showJumpToBottom && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10">
          <button
            onClick={jumpToBottom}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-border text-xs font-medium text-foreground shadow-md hover:bg-muted transition-colors"
          >
            <ArrowDown className="h-3 w-3" />
            Jump to latest
          </button>
        </div>
      )}
    </div>
  );
}
