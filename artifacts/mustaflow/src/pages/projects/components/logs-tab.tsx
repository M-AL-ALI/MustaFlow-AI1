import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import {
  useListTasks,
  useSubmitTaskFeedback,
  getListTasksQueryKey,
  createTask,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Terminal,
  CheckCircle2,
  Clock,
  XCircle,
  ThumbsUp,
  ThumbsDown,
  Wrench,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  FileCode2,
  RotateCcw,
  BookOpen,
  ShieldAlert,
  Smartphone,
  PlaySquare,
  ArrowUpRight,
  Activity,
  Bug,
  Box,
  Sparkles,
} from "lucide-react";
import { cn } from "@/lib/utils";

type TaskReport = {
  userRequest?: string;
  filesCreated?: string[];
  filesChanged?: string[];
  filesRemoved?: string[];
  warnings?: string[];
  suggestions?: string[];
  nextRecommendation?: string;
  knowledgeApplied?: Array<{ id: number; title: string; category: string }>;
  nativeFeatures?: string[];
};

type AgentAuditRow = {
  id: number;
  taskId: number | null;
  toolName: string;
  argsSummary: string | null;
  stdoutPreview: string | null;
  exitCode: number | null;
  ok: boolean;
  durationMs: number;
  calledAt: string;
};

type MobileBuildRow = {
  id: number;
  env: string;
  status: string;
  platform: string | null;
  buildId: string | null;
  downloadUrl: string | null;
  testflightUrl: string | null;
  note: string | null;
  createdAt: string;
};

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string; spin?: boolean }> = {
    completed: {
      label: "Completed",
      className: "bg-green-500/10 text-green-400 border-green-500/20",
    },
    failed: {
      label: "Failed",
      className: "bg-destructive/10 text-destructive border-destructive/20",
    },
    building: {
      label: "Building",
      className: "bg-primary/10 text-primary border-primary/20",
      spin: true,
    },
    planning: {
      label: "Planning",
      className: "bg-violet-500/10 text-violet-400 border-violet-500/20",
      spin: true,
    },
    testing: {
      label: "Testing",
      className: "bg-yellow-500/10 text-yellow-400 border-yellow-500/20",
      spin: true,
    },
    queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
    canceled: {
      label: "Canceled",
      className: "bg-muted/60 text-muted-foreground/70 border-border/60",
    },
  };
  const c = cfg[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0",
        c.className,
      )}
    >
      {c.spin && (
        <span className="w-2 h-2 rounded-full border border-current border-t-transparent animate-spin" />
      )}
      {c.label}
    </span>
  );
}

function MobileBuildStatusBadge({ status }: { status: string }) {
  const cfg: Record<string, { label: string; className: string; spin?: boolean }> = {
    queued: { label: "Queued", className: "bg-muted text-muted-foreground border-border" },
    building: {
      label: "Building",
      className: "bg-primary/10 text-primary border-primary/20",
      spin: true,
    },
    submitting: {
      label: "Submitting",
      className: "bg-violet-500/10 text-violet-400 border-violet-500/20",
      spin: true,
    },
    submitted: {
      label: "Submitted",
      className: "bg-green-500/10 text-green-400 border-green-500/20",
    },
    passed: { label: "Passed", className: "bg-green-500/10 text-green-400 border-green-500/20" },
    failed: {
      label: "Failed",
      className: "bg-destructive/10 text-destructive border-destructive/20",
    },
  };
  const c = cfg[status] ?? {
    label: status,
    className: "bg-muted text-muted-foreground border-border",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full border font-medium shrink-0",
        c.className,
      )}
    >
      {c.spin && (
        <span className="w-1.5 h-1.5 rounded-full border border-current border-t-transparent animate-spin" />
      )}
      {c.label}
    </span>
  );
}

function FeedbackButtons({
  projectId,
  taskId,
  current,
}: {
  projectId: number;
  taskId: number;
  current: string | null | undefined;
}) {
  const qc = useQueryClient();
  const submitFeedback = useSubmitTaskFeedback();

  const send = (feedback: "positive" | "negative") => {
    if (current === feedback) return;
    submitFeedback.mutate(
      { id: projectId, taskId, data: { feedback } },
      {
        onSuccess: () => {
          void qc.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
        },
      },
    );
  };

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => send("positive")}
        title="This build was helpful"
        className={cn(
          "p-1 rounded-lg transition-colors",
          current === "positive"
            ? "bg-green-500/20 text-green-400"
            : "text-muted-foreground hover:text-green-400 hover:bg-green-500/10",
        )}
      >
        <ThumbsUp className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={() => send("negative")}
        title="This build was not helpful"
        className={cn(
          "p-1 rounded-lg transition-colors",
          current === "negative"
            ? "bg-destructive/20 text-destructive"
            : "text-muted-foreground hover:text-destructive hover:bg-destructive/10",
        )}
      >
        <ThumbsDown className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TaskRow({
  task,
  projectId,
  onTryFix,
  highlight,
  highlightCmd,
}: {
  task: {
    id: number;
    projectId: number;
    title: string;
    kind: string;
    status: string;
    prompt?: string | null;
    result?: string | null;
    report?: Record<string, unknown> | null;
    userFeedback?: string | null;
    createdAt: string;
    completedAt?: string | null;
    hasBrainstormContext?: boolean | null;
    brainstormTurnCount?: number | null;
  };
  projectId: number;
  onTryFix: (text: string) => void;
  highlight?: boolean;
  highlightCmd?: string;
}) {
  const [expanded, setExpanded] = useState(task.status === "failed" || !!highlight);
  // Task #733 (code-review pass): when deep-linked from the AI Builder
  // chat's "View full log", auto-expand and scroll the matching task into
  // view so the user lands directly on the relevant run.
  const rowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!highlight) return;
    setExpanded(true);
    const t = setTimeout(() => {
      rowRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => clearTimeout(t);
  }, [highlight]);
  // Surface the filter source so the user can see (and dismiss) what
  // brought them here when the deep-link carries a command snippet.
  const showCmdBanner = highlight && !!highlightCmd;
  const report = task.report as TaskReport | null;
  const suggestions = report?.suggestions ?? [];
  const warnings = report?.warnings ?? [];
  const filesCreated = report?.filesCreated ?? [];
  const filesChanged = report?.filesChanged ?? [];

  const durationMs =
    task.completedAt && task.createdAt
      ? new Date(task.completedAt).getTime() - new Date(task.createdAt).getTime()
      : null;
  const durationSec = durationMs != null ? Math.round(durationMs / 1000) : null;

  return (
    <div
      ref={rowRef}
      className={cn(
        "rounded-xl border overflow-hidden transition-colors",
        highlight
          ? "border-primary/50 ring-1 ring-primary/30 bg-primary/5"
          : task.status === "failed"
            ? "border-destructive/30 bg-destructive/5"
            : task.status === "completed"
              ? "border-border bg-card"
              : "border-border bg-card/50",
      )}
    >
      {showCmdBanner && (
        <div className="px-3 py-1.5 text-[10px] font-mono text-primary/80 border-b border-primary/20 bg-primary/5 truncate">
          Filtered to command: {highlightCmd}
        </div>
      )}
      <button
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0">
          {task.status === "completed" && <CheckCircle2 className="h-4 w-4 text-green-500" />}
          {task.status === "failed" && <XCircle className="h-4 w-4 text-destructive" />}
          {["building", "planning", "testing"].includes(task.status) && (
            <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          )}
          {["queued", "canceled"].includes(task.status) && (
            <Clock className="h-4 w-4 text-muted-foreground" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground truncate">{task.title}</span>
            <StatusBadge status={task.status} />
            {task.hasBrainstormContext && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded-full shrink-0"
                title={
                  task.brainstormTurnCount != null
                    ? `Brainstorm-guided — ${task.brainstormTurnCount} conversation turn${task.brainstormTurnCount !== 1 ? "s" : ""} from your brainstorm were included as context for this build`
                    : "Brainstorm-guided — context from your brainstorm session was included for this build"
                }
              >
                <Sparkles className="h-2.5 w-2.5" />
                Brainstorm-guided
                {task.brainstormTurnCount != null && (
                  <span className="text-violet-400/70">· {task.brainstormTurnCount} turns</span>
                )}
              </span>
            )}
            {durationSec != null && (
              <span className="text-[10px] text-muted-foreground shrink-0">{durationSec}s</span>
            )}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {new Date(task.createdAt).toLocaleString()} · {task.kind}
          </div>
          {task.status === "failed" && !expanded && suggestions.length > 0 && (
            <div className="text-[11px] text-destructive/80 mt-1 flex items-center gap-1">
              <Wrench className="h-3 w-3" />
              {suggestions.length} fix suggestion{suggestions.length !== 1 ? "s" : ""} available
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <FeedbackButtons projectId={projectId} taskId={task.id} current={task.userFeedback} />
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2 space-y-3">
          {task.status === "failed" && task.result && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-2.5 text-xs text-destructive/90 font-mono leading-relaxed">
              {task.result}
            </div>
          )}

          {suggestions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Wrench className="h-3 w-3" /> Fix suggestions
              </div>
              {suggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-4 h-4 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px] flex items-center justify-center font-bold shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 flex items-start gap-2 min-w-0">
                    <span className="text-xs text-foreground leading-relaxed flex-1">{s}</span>
                    <button
                      onClick={() => onTryFix(s)}
                      className="shrink-0 text-[10px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Try this
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {warnings.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <AlertTriangle className="h-3 w-3 text-yellow-500" /> Warnings
              </div>
              {warnings.map((w, i) => (
                <div key={i} className="text-[11px] text-yellow-500/80 flex items-start gap-1.5">
                  <span className="shrink-0 mt-0.5">•</span>
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          {(filesCreated.length > 0 || filesChanged.length > 0) && (
            <div className="space-y-0.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 mb-1">
                <FileCode2 className="h-3 w-3" /> Files changed
              </div>
              {filesCreated.slice(0, 6).map((p) => (
                <div key={`c-${p}`} className="font-mono text-[10px] text-green-400 truncate">
                  + {p}
                </div>
              ))}
              {filesChanged.slice(0, 6).map((p) => (
                <div key={`m-${p}`} className="font-mono text-[10px] text-yellow-400 truncate">
                  ~ {p}
                </div>
              ))}
            </div>
          )}

          {/* Native features */}
          {report?.nativeFeatures && report.nativeFeatures.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <ShieldAlert className="h-3 w-3 text-blue-400" /> Native device permissions
              </div>
              <div className="space-y-1">
                {report.nativeFeatures.map((feature, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 bg-blue-500/8 border border-blue-500/20 rounded-lg px-2.5 py-1.5"
                  >
                    <Smartphone className="h-3 w-3 text-blue-400 shrink-0" />
                    <span className="text-[11px] text-blue-300/90 flex-1">{feature}</span>
                    <span className="text-[10px] text-blue-400/50 shrink-0">Device only</span>
                  </div>
                ))}
                <p className="text-[10px] text-muted-foreground px-0.5">
                  These permissions are added to app.json and require a real device to test — they
                  will not work in the web preview.
                </p>
              </div>
            </div>
          )}
          {task.status === "completed" &&
            report?.knowledgeApplied &&
            report.knowledgeApplied.length > 0 && (
              <div className="space-y-1.5">
                <a
                  href={`/knowledge?ids=${report.knowledgeApplied.map((k) => k.id).join(",")}`}
                  className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1 hover:text-primary transition-colors group"
                  title="View these lessons in the Knowledge Vault"
                >
                  <BookOpen className="h-3 w-3 text-primary" />
                  Applied {report.knowledgeApplied.length} prior{" "}
                  {report.knowledgeApplied.length === 1 ? "lesson" : "lessons"}
                </a>
                {report.knowledgeApplied.map((k, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <span className="text-[9px] font-medium text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                      {k.category}
                    </span>
                    <span className="text-[11px] text-foreground truncate">{k.title}</span>
                  </div>
                ))}
              </div>
            )}

          {task.status === "completed" && report?.nextRecommendation && (
            <div className="text-[11px] text-muted-foreground italic border-t border-border pt-2">
              {report.nextRecommendation}
            </div>
          )}

          {task.status === "failed" && task.prompt && (
            <button
              onClick={() => onTryFix(task.prompt!)}
              className="flex items-center gap-1.5 text-xs font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-3 py-1.5 rounded-xl transition-colors"
            >
              <RotateCcw className="h-3 w-3" /> Retry original request
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Mobile cloud build row with expandable live log viewer ────────────────────

function MobileBuildRow({
  build,
  projectId,
  onTryFix,
}: {
  build: MobileBuildRow;
  projectId: number;
  onTryFix: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(build.status === "failed");
  const [logs, setLogs] = useState<string>("");
  const [logsLoading, setLogsLoading] = useState(false);

  const isActive = ["queued", "building", "submitting"].includes(build.status);
  const PlatformIcon = build.platform === "android" ? PlaySquare : Smartphone;

  const fetchLogs = useCallback(async () => {
    if (!expanded || !build.buildId) return;
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/builds/${build.id}/logs`);
      if (res.ok) {
        const data = (await res.json()) as { logs?: string };
        setLogs(data.logs ?? "");
      }
    } catch {
      /* ignore */
    } finally {
      setLogsLoading(false);
    }
  }, [expanded, build.buildId, build.id, projectId]);

  // Initial log fetch when expanded
  useEffect(() => {
    void fetchLogs();
  }, [fetchLogs]);

  // Poll logs every 3 s while build is active and row is expanded
  useEffect(() => {
    if (!expanded || !isActive || !build.buildId) return;
    const timer = setInterval(() => {
      void fetchLogs();
    }, 3000);
    return () => clearInterval(timer);
  }, [expanded, isActive, build.buildId, fetchLogs]);

  return (
    <div
      className={cn(
        "rounded-xl border overflow-hidden transition-colors",
        build.status === "failed"
          ? "border-destructive/30 bg-destructive/5"
          : build.status === "submitted" || build.status === "passed"
            ? "border-green-500/20 bg-card"
            : "border-border bg-card/50",
      )}
    >
      <button
        className="w-full flex items-start gap-3 p-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="mt-0.5 shrink-0">
          <PlatformIcon
            className={cn(
              "h-4 w-4",
              build.platform === "android" ? "text-green-500" : "text-primary",
            )}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-foreground">
              {build.platform === "ios" ? "iOS" : "Android"} cloud build
            </span>
            <MobileBuildStatusBadge status={build.status} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {new Date(build.createdAt).toLocaleString()}
            {build.buildId && (
              <span className="ml-2 font-mono">· EAS: {build.buildId.slice(0, 8)}…</span>
            )}
          </div>
          {build.note && (
            <div className="text-[11px] text-muted-foreground mt-0.5 truncate">{build.note}</div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border px-3 pb-3 pt-2 space-y-3">
          {/* Links */}
          <div className="flex flex-wrap gap-2">
            {build.downloadUrl && (
              <a
                href={build.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2.5 py-1 rounded-lg"
              >
                {build.platform === "ios" ? "Download IPA" : "Download AAB"}
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
            {build.testflightUrl && (
              <a
                href={build.testflightUrl}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 text-[11px] font-medium text-green-500 border border-green-500/30 bg-green-500/5 hover:bg-green-500/10 px-2.5 py-1 rounded-lg"
              >
                {build.platform === "ios" ? "App Store Connect" : "Play Console"}
                <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>

          {/* Error note for failed builds */}
          {build.status === "failed" && build.note && (
            <div className="bg-destructive/10 border border-destructive/20 rounded-lg p-2.5 text-xs text-destructive/90 leading-relaxed">
              {build.note}
            </div>
          )}

          {/* Fix suggestions for failed builds */}
          {build.status === "failed" && (
            <div className="space-y-1.5">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1">
                <Wrench className="h-3 w-3" /> Suggested fixes
              </div>
              {[
                "Check your Apple/Google credentials in the project Secrets tab.",
                "Verify your app.json has a valid bundleIdentifier / package name.",
                "Review EAS build logs below for the root cause.",
              ].map((s, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="w-4 h-4 rounded-full bg-primary/10 border border-primary/20 text-primary text-[9px] flex items-center justify-center font-bold shrink-0 mt-0.5">
                    {i + 1}
                  </div>
                  <div className="flex-1 flex items-start gap-2 min-w-0">
                    <span className="text-xs text-foreground leading-relaxed flex-1">{s}</span>
                    <button
                      onClick={() => onTryFix(s)}
                      className="shrink-0 text-[10px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap"
                    >
                      Try this
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Live log viewer */}
          {build.buildId && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                <span className="flex items-center gap-1">
                  <Terminal className="h-3 w-3" /> EAS Build Logs
                </span>
                {isActive && (
                  <span className="flex items-center gap-1 text-primary normal-case font-normal">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
                    Live
                  </span>
                )}
              </div>
              <div className="bg-black/60 border border-border rounded-lg p-2.5 font-mono text-[10px] leading-relaxed max-h-48 overflow-y-auto text-green-400 whitespace-pre-wrap break-all">
                {logsLoading && !logs ? (
                  <span className="text-muted-foreground">Fetching logs…</span>
                ) : logs ? (
                  logs
                ) : isActive ? (
                  <span className="text-muted-foreground">
                    Build in progress — logs will appear here…
                  </span>
                ) : (
                  <span className="text-muted-foreground">No logs available.</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── Production logs panel (Task #511) ──────────────────────────────────────
type ProdLogRow = {
  id: number;
  ts: string;
  kind: string;
  method: string | null;
  path: string | null;
  status: number | null;
  latencyMs: number | null;
  errorClass: string | null;
  message: string | null;
};
type ProdErrorGroup = {
  id: number;
  signature: string;
  sampleMessage: string;
  count: number;
  lastSeen: string;
  kind: string;
};

function ProdLogsPanel({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<ProdLogRow[]>([]);
  const [groups, setGroups] = useState<ProdErrorGroup[]>([]);
  const [view, setView] = useState<"errors" | "requests" | "server">("errors");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [logsRes, groupsRes] = await Promise.all([
        fetch(`/api/projects/${projectId}/prod-logs?limit=50`),
        fetch(`/api/projects/${projectId}/prod-errors?limit=20`),
      ]);
      if (logsRes.ok) {
        const data = (await logsRes.json()) as { logs: ProdLogRow[] };
        setLogs(data.logs ?? []);
      }
      if (groupsRes.ok) {
        const data = (await groupsRes.json()) as { groups: ProdErrorGroup[] };
        setGroups(data.groups ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => clearInterval(timer);
  }, [open, refresh]);

  const errorCount = groups.reduce((acc, g) => acc + (g.count ?? 0), 0);

  return (
    <div className="shrink-0 border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-2.5 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <Activity className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Production Logs</span>
        {errorCount > 0 && (
          <span className="ml-2 px-2 py-0.5 rounded-full bg-destructive/10 text-destructive text-[10px] font-medium border border-destructive/20">
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">From published deployment</span>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setView("errors")}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors",
                view === "errors"
                  ? "bg-primary/10 text-primary border-primary/20"
                  : "text-muted-foreground border-border hover:bg-muted/30",
              )}
            >
              <Bug className="inline h-3 w-3 mr-1" />
              Errors ({groups.length})
            </button>
            <button
              type="button"
              onClick={() => setView("requests")}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors",
                view === "requests"
                  ? "bg-primary/10 text-primary border-primary/20"
                  : "text-muted-foreground border-border hover:bg-muted/30",
              )}
            >
              Requests ({logs.filter((l) => l.kind === "request").length})
            </button>
            <button
              type="button"
              onClick={() => setView("server")}
              className={cn(
                "px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors",
                view === "server"
                  ? "bg-primary/10 text-primary border-primary/20"
                  : "text-muted-foreground border-border hover:bg-muted/30",
              )}
            >
              Server ({logs.filter((l) => l.kind === "server").length})
            </button>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            >
              {loading ? "Refreshing…" : "Refresh"}
            </button>
          </div>

          {view === "errors" && (
            <div className="space-y-1.5 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/10">
              {groups.length === 0 && (
                <div className="text-[11px] text-muted-foreground text-center py-6">
                  No browser errors recorded.
                </div>
              )}
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="px-3 py-2 border-b border-border/40 last:border-b-0 text-[11px] flex items-start gap-2"
                >
                  <span className="px-1.5 py-0.5 rounded bg-destructive/10 text-destructive font-mono shrink-0">
                    ×{g.count}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-mono text-foreground" title={g.sampleMessage}>
                      {g.sampleMessage}
                    </div>
                    <div className="text-muted-foreground text-[10px] mt-0.5">
                      sig {g.signature} · last {new Date(g.lastSeen).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {view === "server" && (
            <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/10 font-mono text-[11px]">
              {logs.filter((l) => l.kind === "server").length === 0 && (
                <div className="text-[11px] text-muted-foreground text-center py-6 font-sans">
                  No server logs recorded yet. Backend stacks emit container output here.
                </div>
              )}
              {logs
                .filter((l) => l.kind === "server")
                .map((l) => {
                  const isErr = !!l.errorClass;
                  return (
                    <div
                      key={l.id}
                      className="px-3 py-1 border-b border-border/40 last:border-b-0 flex items-start gap-2"
                    >
                      <span
                        className={cn(
                          "w-14 shrink-0 text-[10px] uppercase font-semibold",
                          isErr ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        {isErr ? "stderr" : "stdout"}
                      </span>
                      <span className="flex-1 whitespace-pre-wrap break-all text-foreground">
                        {l.message ?? ""}
                      </span>
                      <span className="shrink-0 text-muted-foreground text-[10px]">
                        {new Date(l.ts).toLocaleTimeString()}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}

          {view === "requests" && (
            <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border border-border bg-muted/10 font-mono text-[11px]">
              {logs.filter((l) => l.kind === "request").length === 0 && (
                <div className="text-[11px] text-muted-foreground text-center py-6 font-sans">
                  No requests recorded yet.
                </div>
              )}
              {logs
                .filter((l) => l.kind === "request")
                .map((l) => {
                  const s = l.status ?? 0;
                  const cls =
                    s >= 500 ? "text-destructive" : s >= 400 ? "text-amber-400" : "text-green-400";
                  return (
                    <div
                      key={l.id}
                      className="px-3 py-1 border-b border-border/40 last:border-b-0 flex items-center gap-2"
                    >
                      <span className={cn("w-10 shrink-0", cls)}>{s || "—"}</span>
                      <span className="w-12 shrink-0 text-muted-foreground">{l.method}</span>
                      <span className="flex-1 truncate text-foreground" title={l.path ?? ""}>
                        {l.path}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{l.latencyMs ?? 0}ms</span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Container logs panel (Task #746) ───────────────────────────────────────
// Live stdout/stderr/system feed from the project's Fly container, streamed
// over SSE. Mounts only for agentic projects (where there's actually a
// container to tail). Auto-scrolls to the bottom on new lines unless the
// user has scrolled up to read history.
type ContainerLogLine = {
  id: number;
  level: "stdout" | "stderr" | "system";
  message: string;
  createdAt: string;
};

function ContainerLogsPanel({ projectId }: { projectId: number }) {
  const [open, setOpen] = useState(false);
  const [lines, setLines] = useState<ContainerLogLine[]>([]);
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stuckToBottomRef = useRef(true);
  const seenIdsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    if (!open) return;
    seenIdsRef.current = new Set();
    setLines([]);
    setConnected(false);
    const es = new EventSource(`/api/projects/${projectId}/container/logs/stream`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data) as ContainerLogLine;
        // The server uses id=0 as a transient hint that wasn't persisted;
        // we keep it but skip de-dupe for those.
        if (payload.id > 0) {
          if (seenIdsRef.current.has(payload.id)) return;
          seenIdsRef.current.add(payload.id);
        }
        setLines((prev) => {
          // Cap to last 500 lines to keep DOM cheap on long-running sessions.
          const next = [...prev, payload];
          return next.length > 500 ? next.slice(next.length - 500) : next;
        });
      } catch {
        /* ignore malformed payloads */
      }
    };
    return () => es.close();
  }, [open, projectId]);

  // Auto-scroll to bottom when new lines arrive, unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stuckToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    stuckToBottomRef.current = nearBottom;
  }, []);

  const sendTestLine = useCallback(() => {
    void fetch(`/api/projects/${projectId}/container/logs/test`, { method: "POST" }).catch(
      () => {},
    );
  }, [projectId]);

  return (
    <div className="shrink-0 border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full px-5 py-2.5 flex items-center gap-2 text-left hover:bg-muted/30 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        )}
        <Box className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Container Logs</span>
        {open && (
          <span
            className={cn(
              "ml-2 inline-flex items-center gap-1 text-[10px]",
              connected ? "text-green-400" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "w-1.5 h-1.5 rounded-full",
                connected ? "bg-green-400 animate-pulse" : "bg-muted-foreground/40",
              )}
            />
            {connected ? "Live" : "Connecting…"}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          Live stdout/stderr from your container
        </span>
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setLines([]);
                seenIdsRef.current = new Set();
              }}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Clear view
            </button>
            <button
              type="button"
              onClick={sendTestLine}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Send test line
            </button>
            <span className="ml-auto text-[10px] text-muted-foreground">
              {lines.length} {lines.length === 1 ? "line" : "lines"}
            </span>
          </div>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="bg-black/70 border border-border rounded-lg p-2.5 font-mono text-[11px] leading-relaxed max-h-72 overflow-y-auto whitespace-pre-wrap break-all"
          >
            {lines.length === 0 ? (
              <span className="text-muted-foreground">
                Waiting for output… Logs appear here when the container produces stdout/stderr.
              </span>
            ) : (
              lines.map((l, idx) => {
                const colour =
                  l.level === "stderr"
                    ? "text-red-400"
                    : l.level === "system"
                      ? "text-amber-400"
                      : "text-green-300";
                const label = l.level === "stderr" ? "ERR" : l.level === "system" ? "SYS" : "OUT";
                return (
                  <div key={`${l.id}-${idx}`} className="flex items-start gap-2 py-0.5">
                    <span className={cn("shrink-0 text-[10px] font-semibold", colour)}>
                      {label}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/70">
                      {new Date(l.createdAt).toLocaleTimeString()}
                    </span>
                    <span className={cn("flex-1", colour)}>{l.message}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Failed Jobs Section ────────────────────────────────────────────────────────
// Collapsible section surfaced at the top of Build History when there are
// ── Agent Audit Row ──────────────────────────────────────────────────────────
// Displays a single tool-call record from the agent_tool_calls audit table.
function AgentAuditRowItem({ row }: { row: AgentAuditRow }) {
  const [expanded, setExpanded] = useState(false);

  const toolBadgeColor = (() => {
    if (!row.ok) return "text-destructive border-destructive/30 bg-destructive/5";
    if (row.toolName.startsWith("run_command") || row.toolName === "pkg_install")
      return "text-yellow-400 border-yellow-400/30 bg-yellow-400/5";
    if (
      row.toolName === "write_file" ||
      row.toolName === "apply_patch" ||
      row.toolName === "delete_file"
    )
      return "text-blue-400 border-blue-400/30 bg-blue-400/5";
    return "text-muted-foreground border-border bg-muted/30";
  })();

  return (
    <div className="rounded border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
        )}
        <span
          className={cn(
            "text-[10px] font-mono px-1.5 py-0.5 rounded border shrink-0",
            toolBadgeColor,
          )}
        >
          {row.toolName}
        </span>
        {row.exitCode !== null && (
          <span
            className={cn(
              "text-[10px] font-mono shrink-0",
              row.exitCode === 0 ? "text-green-400" : "text-destructive",
            )}
          >
            exit {row.exitCode}
          </span>
        )}
        <span className="text-[10px] text-muted-foreground truncate flex-1">
          {row.argsSummary ? row.argsSummary.slice(0, 80) : "—"}
        </span>
        <span className="text-[10px] text-muted-foreground shrink-0 ml-auto">
          {row.durationMs < 1000 ? `${row.durationMs}ms` : `${(row.durationMs / 1000).toFixed(1)}s`}
        </span>
        <span className="text-[10px] text-muted-foreground/60 shrink-0">
          {new Date(row.calledAt).toLocaleTimeString()}
        </span>
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2 space-y-1.5 bg-muted/10">
          {row.taskId && (
            <div className="text-[10px] text-muted-foreground">
              Task <span className="font-mono text-foreground/70">#{row.taskId}</span>
            </div>
          )}
          {row.argsSummary && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground mb-0.5">Args</div>
              <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap break-all bg-muted/20 rounded px-2 py-1">
                {row.argsSummary}
              </pre>
            </div>
          )}
          {row.stdoutPreview && (
            <div>
              <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
                Output preview
              </div>
              <pre className="text-[10px] font-mono text-foreground/80 whitespace-pre-wrap break-all bg-muted/20 rounded px-2 py-1">
                {row.stdoutPreview}
              </pre>
            </div>
          )}
          <div className="text-[10px] text-muted-foreground/60">
            {new Date(row.calledAt).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Failed Jobs section ───────────────────────────────────────────────────────
// recently failed tasks. Shows task title, termination reason, step count,
// timestamp, and a Retry button that pre-fills the AI chat with the original
// prompt.
function FailedJobsSection({
  tasks,
  projectId,
  onTryFix,
}: {
  tasks: Array<{
    id: number;
    title?: string | null;
    status: string;
    prompt?: string | null;
    result?: string | null;
    createdAt?: Date | string | null;
    elapsedSeconds?: number | null;
    agentMode?: string | null;
  }>;
  projectId: number;
  onTryFix: (text: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const queryClient = useQueryClient();

  const handleRetry = useCallback(
    async (task: (typeof tasks)[number]) => {
      if (!task.prompt || retryingId !== null) return;
      setRetryingId(task.id);
      try {
        await createTask(projectId, {
          title: task.title ?? "Retry",
          kind: "main" as const,
          prompt: task.prompt ?? undefined,
        });
        void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
      } catch {
        onTryFix(task.prompt);
      } finally {
        setRetryingId(null);
      }
    },
    [projectId, retryingId, queryClient, onTryFix],
  );

  return (
    <div className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-destructive/10 transition-colors"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 text-destructive shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-destructive shrink-0" />
        )}
        <XCircle className="h-3.5 w-3.5 text-destructive shrink-0" />
        <span className="text-[11px] font-semibold text-destructive">
          Failed Jobs ({tasks.length})
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          Most recent failures — click Retry to re-run
        </span>
      </button>
      {open && (
        <div className="divide-y divide-border/50">
          {tasks.map((task) => (
            <div key={task.id} className="px-4 py-2.5 flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-foreground truncate">
                  {task.title ?? task.prompt?.slice(0, 80) ?? `Task #${task.id}`}
                </p>
                {task.result && (
                  <p className="text-[11px] text-destructive/80 mt-0.5 leading-snug line-clamp-2">
                    {task.result}
                  </p>
                )}
                <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-2">
                  {task.createdAt && <span>{new Date(task.createdAt).toLocaleString()}</span>}
                  {task.elapsedSeconds != null && task.elapsedSeconds > 0 && (
                    <span className="text-muted-foreground/70">
                      {task.elapsedSeconds < 60
                        ? `${task.elapsedSeconds}s`
                        : `${Math.round(task.elapsedSeconds / 60)}m`}
                    </span>
                  )}
                </p>
              </div>
              {task.prompt && (
                <button
                  type="button"
                  onClick={() => void handleRetry(task)}
                  disabled={retryingId !== null}
                  className="shrink-0 flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-border bg-background hover:bg-muted text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  title="Re-enqueue this task immediately"
                >
                  <RotateCcw
                    className={cn("h-2.5 w-2.5", retryingId === task.id && "animate-spin")}
                  />
                  {retryingId === task.id ? "Queuing\u2026" : "Retry"}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function LogsTab({
  projectId,
  kind,
  builderMode,
  onTryFix,
}: {
  projectId: number;
  kind?: string;
  builderMode?: string;
  onTryFix?: (text: string) => void;
}) {
  const isMobile = kind?.startsWith("mobile-") ?? false;
  // Task #733 (code-review pass): the AI Builder chat's "View full log"
  // deep-link carries ?logsTaskId / ?runId / ?cmd so we can auto-expand and
  // scroll to the originating task. We parse once on mount (the bubble
  // generates a fresh URL per command so we don't need to react to in-flight
  // search-string changes).
  const filter = useMemo(() => {
    if (typeof window === "undefined") return { taskId: null as number | null, cmd: "" };
    try {
      const p = new URLSearchParams(window.location.search);
      const tid = p.get("logsTaskId");
      const parsedId = tid ? parseInt(tid, 10) : NaN;
      return {
        taskId: Number.isFinite(parsedId) ? parsedId : null,
        cmd: p.get("cmd") ?? "",
      };
    } catch {
      return { taskId: null as number | null, cmd: "" };
    }
  }, []);
  const { data: tasks, isLoading } = useListTasks(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: 5000,
    },
  });

  const [mobileBuilds, setMobileBuilds] = useState<MobileBuildRow[]>([]);

  const fetchMobileBuilds = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await fetch(`/api/projects/${projectId}/builds`);
      if (res.ok) {
        const data = (await res.json()) as { builds: MobileBuildRow[] };
        setMobileBuilds(data.builds ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [projectId, isMobile]);

  // Initial fetch
  useEffect(() => {
    void fetchMobileBuilds();
  }, [fetchMobileBuilds]);

  // Poll every 5 s while any mobile build is in progress
  useEffect(() => {
    const inProgress = mobileBuilds.some((b) =>
      ["queued", "building", "submitting"].includes(b.status),
    );
    if (!inProgress) return;
    const timer = setInterval(() => void fetchMobileBuilds(), 5000);
    return () => clearInterval(timer);
  }, [mobileBuilds, fetchMobileBuilds]);

  const failed = (tasks ?? []).filter((t) => t.status === "failed").length;
  const completed = (tasks ?? []).filter((t) => t.status === "completed").length;
  const activeBuilds = mobileBuilds.filter((b) =>
    ["queued", "building", "submitting"].includes(b.status),
  ).length;

  const isAgentic = builderMode === "agentic";

  // ── Agent Audit sub-tab ──────────────────────────────────────────────────
  const [logsView, setLogsView] = useState<"history" | "agent-audit">("history");
  const [auditRows, setAuditRows] = useState<AgentAuditRow[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  const fetchAuditLog = useCallback(async () => {
    if (!isAgentic) return;
    setAuditLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/agent-audit?limit=100`);
      if (res.ok) {
        const data = (await res.json()) as { rows: AgentAuditRow[] };
        setAuditRows(data.rows ?? []);
      }
    } catch {
      /* ignore */
    } finally {
      setAuditLoading(false);
    }
  }, [projectId, isAgentic]);

  useEffect(() => {
    if (logsView === "agent-audit") {
      void fetchAuditLog();
    }
  }, [logsView, fetchAuditLog]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {isAgentic && <ContainerLogsPanel projectId={projectId} />}
      <ProdLogsPanel projectId={projectId} />
      {/* Header */}
      <div className="shrink-0 border-b border-border px-5 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Terminal className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Build History</span>
        </div>
        <div className="flex items-center gap-3 ml-auto text-[11px]">
          {activeBuilds > 0 && (
            <span className="flex items-center gap-1 text-primary">
              <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              {activeBuilds} EAS build{activeBuilds !== 1 ? "s" : ""} running
            </span>
          )}
          {completed > 0 && (
            <span className="flex items-center gap-1 text-green-400">
              <CheckCircle2 className="h-3 w-3" /> {completed} succeeded
            </span>
          )}
          {failed > 0 && (
            <span className="flex items-center gap-1 text-destructive">
              <XCircle className="h-3 w-3" /> {failed} failed
            </span>
          )}
        </div>
      </div>

      {/* Sub-tab selector — shown for agentic projects */}
      {isAgentic && (
        <div className="shrink-0 flex border-b border-border">
          <button
            type="button"
            onClick={() => setLogsView("history")}
            className={cn(
              "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2",
              logsView === "history"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            Build History
          </button>
          <button
            type="button"
            onClick={() => setLogsView("agent-audit")}
            className={cn(
              "flex-1 py-1.5 text-[11px] font-medium transition-colors border-b-2 flex items-center justify-center gap-1",
              logsView === "agent-audit"
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <ShieldAlert className="h-3 w-3" />
            Agent Audit
          </button>
        </div>
      )}

      {/* Agent Audit view */}
      {isAgentic && logsView === "agent-audit" && (
        <div className="flex-1 overflow-y-auto">
          <div className="flex items-center justify-between px-4 pt-3 pb-2">
            <span className="text-[11px] text-muted-foreground">
              Recent tool calls by the agent loop (last 100)
            </span>
            <button
              type="button"
              onClick={() => void fetchAuditLog()}
              disabled={auditLoading}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <RotateCcw className={cn("h-3 w-3", auditLoading && "animate-spin")} />
              Refresh
            </button>
          </div>
          {auditLoading && auditRows.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              Loading audit log…
            </div>
          )}
          {!auditLoading && auditRows.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              No tool calls recorded yet. Run the agent to see audit entries.
            </div>
          )}
          <div className="px-3 pb-4 space-y-1">
            {auditRows.map((row) => (
              <AgentAuditRowItem key={row.id} row={row} />
            ))}
          </div>
        </div>
      )}

      {/* Task + mobile build list */}
      {(!isAgentic || logsView === "history") && (
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {/* ── Failed Jobs section ───────────────────────────────────────────── */}
          {(() => {
            const failedTasks = (tasks ?? []).filter((t) => t.status === "failed").slice(0, 10);
            if (failedTasks.length === 0) return null;
            return (
              <FailedJobsSection
                tasks={failedTasks}
                projectId={projectId}
                onTryFix={onTryFix ?? (() => {})}
              />
            );
          })()}

          {/* Mobile cloud builds section */}
          {isMobile && mobileBuilds.length > 0 && (
            <div className="space-y-2 mb-4">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 flex items-center gap-1.5">
                <Smartphone className="h-3 w-3" /> Cloud Builds
              </div>
              {mobileBuilds.map((b) => (
                <MobileBuildRow
                  key={b.id}
                  build={b}
                  projectId={projectId}
                  onTryFix={onTryFix ?? (() => {})}
                />
              ))}
              {(tasks ?? []).length > 0 && (
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 pt-2 flex items-center gap-1.5">
                  <Terminal className="h-3 w-3" /> AI Builder Tasks
                </div>
              )}
            </div>
          )}

          {isLoading && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              Loading history...
            </div>
          )}
          {!isLoading && (!tasks || tasks.length === 0) && mobileBuilds.length === 0 && (
            <div className="text-center py-16 text-muted-foreground text-sm">
              No builds yet. Send a message to the AI Builder to get started.
            </div>
          )}
          {(tasks ?? []).map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projectId={projectId}
              onTryFix={onTryFix ?? (() => {})}
              highlight={filter.taskId === task.id}
              highlightCmd={filter.taskId === task.id ? filter.cmd : undefined}
            />
          ))}
        </div>
      )}
    </div>
  );
}
