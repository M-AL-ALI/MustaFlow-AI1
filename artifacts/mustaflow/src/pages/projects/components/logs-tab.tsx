import { useState, useEffect, useCallback } from "react";
import {
  useListTasks,
  useSubmitTaskFeedback,
  getListTasksQueryKey,
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
  };
  projectId: number;
  onTryFix: (text: string) => void;
}) {
  const [expanded, setExpanded] = useState(task.status === "failed");
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
      className={cn(
        "rounded-xl border overflow-hidden transition-colors",
        task.status === "failed"
          ? "border-destructive/30 bg-destructive/5"
          : task.status === "completed"
            ? "border-border bg-card"
            : "border-border bg-card/50",
      )}
    >
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

export function LogsTab({
  projectId,
  kind,
  onTryFix,
}: {
  projectId: number;
  kind?: string;
  onTryFix?: (text: string) => void;
}) {
  const isMobile = kind?.startsWith("mobile-") ?? false;
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

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
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

      {/* Task + mobile build list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
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
          <div className="text-center py-16 text-muted-foreground text-sm">Loading history...</div>
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
          />
        ))}
      </div>
    </div>
  );
}
