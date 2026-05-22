import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCheckRuns,
  getGetCheckRunsQueryKey,
  useTriggerCheckRuns,
  useGetProjectFile,
  getGetProjectFileQueryKey,
  useListCveFindings,
  getListCveFindingsQueryKey,
  useRunCveScan,
  useDismissCveFinding,
  useGetCveScanStatus,
  getGetCveScanStatusQueryKey,
  type CheckRun,
  type CheckRunFinding,
  type ProjectFileSummary,
  type CveFinding,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  ShieldAlert,
  Eye,
  Search,
  Zap,
  Lock,
  AlertTriangle,
  XCircle,
  Info,
  CheckCircle2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Code2,
  KeyRound,
  ScanSearch,
  Globe,
  SkipForward,
  BadgeCheck,
  ShieldCheck,
  MessageSquarePlus,
  FileCode2,
  Package,
  ExternalLink,
  Ban,
  Download,
} from "lucide-react";
import { cn } from "@/lib/utils";

type FixPromptFn = (findings: CheckRunFinding[]) => string;

const CHECK_META: Record<
  string,
  {
    label: string;
    Icon: React.FC<{ className?: string }>;
    fixPrompt: FixPromptFn;
  }
> = {
  "secret-leak": {
    label: "Secret Leak",
    Icon: KeyRound,
    fixPrompt: (findings) => {
      const files = [...new Set(findings.map((f) => f.file))].slice(0, 5).join(", ");
      return `Remove all hardcoded secrets, API keys, and tokens from the app code. Found potential secrets in: ${files}. Move any necessary configuration values to environment variables or prompt the user to enter them at runtime via a settings form.`;
    },
  },
  "code-quality": {
    label: "Code Quality",
    Icon: Code2,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix the following code quality issues in the generated app: ${issues}. Address each finding by refactoring the relevant code to follow best practices.`;
    },
  },
  sast: {
    label: "SAST",
    Icon: ScanSearch,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => `${f.message} (${f.file}${f.line ? `:${f.line}` : ""})`)
        .slice(0, 5)
        .join("; ");
      return `Fix the following security vulnerabilities found by static analysis: ${issues}. Sanitize all user inputs, avoid eval() and innerHTML with untrusted data, and follow OWASP secure coding guidelines.`;
    },
  },
  "semgrep-sast": {
    label: "Semgrep SAST",
    Icon: ShieldCheck,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => `${f.message} at ${f.file}${f.line ? `:${f.line}` : ""}`)
        .slice(0, 5)
        .join("; ");
      return `Fix the following security vulnerabilities detected by Semgrep AST-aware analysis: ${issues}. Address each finding at the exact file and line indicated — sanitize user inputs before DOM operations, avoid eval() and dynamic Function() calls, prevent prototype pollution by validating object keys, and follow OWASP secure coding guidelines.`;
    },
  },
  accessibility: {
    label: "Accessibility",
    Icon: Eye,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix all accessibility issues in the generated app. ${issues}. Ensure all images have alt attributes, all form inputs have associated labels, all buttons have accessible text, and the html element has a lang attribute.`;
    },
  },
  seo: {
    label: "SEO",
    Icon: Search,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix all SEO issues in the generated app. ${issues}. Add or improve meta description, Open Graph tags (og:title, og:description, og:image), and ensure the page title is descriptive.`;
    },
  },
  performance: {
    label: "Performance",
    Icon: Zap,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix all performance issues in the generated app. ${issues}. Add defer or async to scripts in the head, add explicit width and height to images, and add loading="lazy" to below-fold images.`;
    },
  },
  "cdn-security": {
    label: "CDN Security",
    Icon: Globe,
    fixPrompt: (findings) => {
      const pkgs = [...new Set(findings.map((f) => f.message.split(":")[0]))].join(", ");
      return `Update outdated or vulnerable CDN packages in the generated app. The following packages need updating: ${pkgs}. Replace their CDN URLs with the latest stable versions.`;
    },
  },
  security: {
    label: "Security",
    Icon: Lock,
    fixPrompt: (findings) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix the following security issues in the generated app: ${issues}. Review and fix any insecure patterns, missing Content Security Policy headers, or vulnerable dependencies.`;
    },
  },
  privacy: {
    label: "Privacy",
    Icon: ShieldAlert,
    fixPrompt: (findings) => {
      const trackerFindings = findings.filter((f) =>
        f.message.startsWith("Tracker loaded without consent"),
      );
      const noPrivacyLink = findings.some((f) => f.message === "No privacy policy link found");
      const parts: string[] = [];
      if (trackerFindings.length > 0) {
        const trackers = trackerFindings
          .map((f) => f.message.replace("Tracker loaded without consent mechanism: ", ""))
          .join(", ");
        parts.push(
          `add a cookie consent banner that defers loading these trackers until the user accepts: ${trackers}`,
        );
      }
      if (noPrivacyLink) {
        parts.push("add a privacy policy link in the app footer");
      }
      const otherIssues = findings
        .filter(
          (f) =>
            !f.message.startsWith("Tracker loaded without consent") &&
            f.message !== "No privacy policy link found",
        )
        .map((f) => f.message)
        .slice(0, 3)
        .join("; ");
      if (otherIssues) parts.push(otherIssues);
      return `Fix all privacy and compliance issues in the generated app: ${parts.join("; ")}.`;
    },
  },
};

const ALL_CHECK_NAMES = Object.keys(CHECK_META);
const PARAMS = { limit: 100 };

function statusColor(status: CheckRun["status"]): string {
  if (status === "pass") return "bg-green-500";
  if (status === "warning") return "bg-yellow-500";
  if (status === "fail") return "bg-red-500";
  if (status === "skipped") return "bg-muted-foreground/40";
  return "bg-red-500";
}

function statusRing(status: CheckRun["status"]): string {
  if (status === "pass") return "ring-green-500/40";
  if (status === "warning") return "ring-yellow-500/40";
  if (status === "fail") return "ring-red-500/40";
  return "ring-muted-foreground/20";
}

function StatusDot({
  status,
  ranAt,
  size = "sm",
}: {
  status: CheckRun["status"];
  ranAt: string;
  size?: "sm" | "xs";
}) {
  return (
    <span
      title={`${status} · ${new Date(ranAt).toLocaleString()}`}
      className={cn(
        "rounded-full ring-2 shrink-0 transition-transform hover:scale-125",
        statusColor(status),
        statusRing(status),
        size === "sm" ? "h-2.5 w-2.5" : "h-2 w-2",
      )}
    />
  );
}

function SeverityIcon({ severity }: { severity: string }) {
  if (severity === "error") return <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />;
  if (severity === "warning")
    return <AlertTriangle className="h-3.5 w-3.5 text-yellow-500 shrink-0" />;
  return <Info className="h-3.5 w-3.5 text-blue-400 shrink-0" />;
}

function CheckStatusBadge({ status }: { status: CheckRun["status"] }) {
  if (status === "pass")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">
        <BadgeCheck className="h-2.5 w-2.5" /> pass
      </span>
    );
  if (status === "warning")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-1.5 py-0.5">
        <AlertTriangle className="h-2.5 w-2.5" /> warnings
      </span>
    );
  if (status === "fail")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
        <XCircle className="h-2.5 w-2.5" /> failed
      </span>
    );
  if (status === "skipped")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground bg-muted border border-border rounded px-1.5 py-0.5">
        <SkipForward className="h-2.5 w-2.5" /> skipped
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">
      <XCircle className="h-2.5 w-2.5" /> error
    </span>
  );
}

function FileContextSnippet({
  projectId,
  fileId,
  filePath,
  line,
}: {
  projectId: number;
  fileId: number;
  filePath: string;
  line?: number;
}) {
  const [showFull, setShowFull] = useState(false);
  const { data: file, isLoading } = useGetProjectFile(projectId, fileId, {
    query: {
      enabled: !!fileId,
      queryKey: getGetProjectFileQueryKey(projectId, fileId),
      staleTime: 60_000,
    },
  });

  if (isLoading)
    return (
      <div className="mt-1.5 rounded-md border border-border p-2 text-[10px] text-muted-foreground flex items-center gap-1.5">
        <RefreshCw className="h-3 w-3 animate-spin" /> Loading file…
      </div>
    );
  if (!file?.content) return null;

  const allLines = file.content.split("\n");
  const CONTEXT = 4;
  const targetLine = (line ?? 1) - 1;
  const start = Math.max(0, targetLine - CONTEXT);
  const end = Math.min(allLines.length - 1, targetLine + CONTEXT);
  const snippet = allLines.slice(start, end + 1);
  const displayLines = showFull ? allLines : snippet;
  const offset = showFull ? 0 : start;

  return (
    <div className="mt-1.5 rounded-md border border-border overflow-hidden">
      <div className="flex items-center justify-between px-2 py-1 bg-muted/50 border-b border-border">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-mono">
          <FileCode2 className="h-3 w-3 shrink-0" />
          <span className="truncate max-w-[200px]">{filePath}</span>
          {line ? `:${line}` : ""}
        </div>
        {allLines.length > snippet.length && (
          <button
            onClick={() => setShowFull((v) => !v)}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {showFull ? "show snippet" : "show more"}
          </button>
        )}
      </div>
      <pre className="overflow-x-auto text-[10px] leading-relaxed bg-card/50 p-2 font-mono max-h-48">
        {displayLines.map((l, i) => {
          const lineNum = offset + i + 1;
          const isHighlighted = line !== undefined && lineNum === line;
          return (
            <div
              key={i}
              className={cn("flex gap-2", isHighlighted && "bg-yellow-500/10 -mx-2 px-2 rounded")}
            >
              <span className="select-none text-muted-foreground/40 w-6 text-right shrink-0">
                {lineNum}
              </span>
              <span className={isHighlighted ? "text-foreground" : "text-muted-foreground"}>
                {l}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}

function FindingItem({
  projectId,
  checkName,
  finding,
  fileSummaries,
  onNavigateToFile,
}: {
  projectId: number;
  checkName: string;
  finding: CheckRunFinding;
  fileSummaries: ProjectFileSummary[];
  onNavigateToFile?: (filePath: string, line?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const matchedFile = fileSummaries.find(
    (f) => f.path === finding.file || f.path.endsWith("/" + finding.file),
  );

  const handleOpenInEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    onNavigateToFile?.(finding.file, finding.line ?? undefined);
  };

  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-muted/30 transition-colors"
      >
        <SeverityIcon severity={finding.severity} />
        <div className="flex-1 min-w-0">
          <div className="text-foreground leading-snug">{finding.message}</div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-muted-foreground font-mono">
              {finding.file}
              {finding.line ? `:${finding.line}` : ""}
            </span>
            {onNavigateToFile && matchedFile && (
              <button
                onClick={handleOpenInEditor}
                className="text-[10px] text-primary/70 hover:text-primary transition-colors flex items-center gap-0.5 shrink-0"
                title="Open in code editor"
              >
                <FileCode2 className="h-2.5 w-2.5" />
                open
              </button>
            )}
          </div>
        </div>
        {(matchedFile || finding.detail) && (
          <>
            {expanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
            )}
          </>
        )}
      </button>
      {expanded && (
        <div className="px-2.5 pb-2.5 pt-0 space-y-1.5 bg-card/30 border-t border-border">
          {finding.detail &&
            (() => {
              const RULE_PREFIX = "Rule: ";
              if (checkName === "semgrep-sast" && finding.detail.startsWith(RULE_PREFIX)) {
                const ruleId = finding.detail.slice(RULE_PREFIX.length).trim();
                return (
                  <p className="text-[10px] text-muted-foreground leading-relaxed pt-2">
                    Rule:{" "}
                    <a
                      href={`https://semgrep.dev/r/${ruleId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline inline-flex items-center gap-0.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {ruleId}
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </a>
                  </p>
                );
              }
              return (
                <p className="text-[10px] text-muted-foreground leading-relaxed pt-2">
                  {finding.detail}
                </p>
              );
            })()}
          {matchedFile && (
            <FileContextSnippet
              projectId={projectId}
              fileId={matchedFile.id}
              filePath={matchedFile.path}
              line={finding.line}
            />
          )}
        </div>
      )}
    </div>
  );
}

function CheckDetailCard({
  checkName,
  history,
  projectId,
  fileSummaries,
  onFix,
  onNavigateToFile,
}: {
  checkName: string;
  history: CheckRun[];
  projectId: number;
  fileSummaries: ProjectFileSummary[];
  onFix?: (prompt: string) => void;
  onNavigateToFile?: (filePath: string, line?: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = CHECK_META[checkName] ?? {
    label: checkName,
    Icon: ShieldCheck,
    fixPrompt: (findings: CheckRunFinding[]) => {
      const issues = findings
        .map((f) => f.message)
        .slice(0, 5)
        .join("; ");
      return `Fix the following issues found in the ${checkName} check: ${issues}.`;
    },
  };
  const Icon = meta.Icon;
  const latest = history[0];
  const findings = latest ? ((latest.findings ?? []) as CheckRunFinding[]) : [];
  const historySlice = history.slice(0, 12);

  const handleFix = () => {
    onFix?.(meta.fixPrompt(findings));
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 flex items-center gap-2.5 hover:bg-muted/30 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium text-foreground flex-1 min-w-0 text-left">
          {meta.label}
        </span>

        {history.length > 0 && (
          <div className="flex items-center gap-1 mr-2" title="Run history (newest first)">
            {historySlice.map((run) => (
              <StatusDot
                key={run.id}
                status={run.status}
                ranAt={run.ranAt as unknown as string}
                size="xs"
              />
            ))}
          </div>
        )}

        {latest && <CheckStatusBadge status={latest.status} />}
        {findings.length > 0 && (
          <span className="text-[10px] text-muted-foreground ml-1">
            {findings.length} finding{findings.length !== 1 ? "s" : ""}
          </span>
        )}
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border bg-card/50 p-3 space-y-3">
          {history.length > 1 && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                Run history
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {historySlice.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                  >
                    <StatusDot status={run.status} ranAt={run.ranAt as unknown as string} />
                    <span className="tabular-nums">
                      {new Date(run.ranAt as unknown as string).toLocaleDateString(undefined, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {latest?.aiReason && (
            <p className="text-[11px] text-muted-foreground italic leading-relaxed border-l-2 border-border pl-2.5">
              {latest.aiReason}
            </p>
          )}

          {!latest && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <ScanSearch className="h-3.5 w-3.5" /> No runs yet for this check.
            </div>
          )}

          {latest && findings.length === 0 && (
            <div className="flex items-center gap-2 text-xs text-green-400 py-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> No issues found.
            </div>
          )}

          {findings.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                Findings
              </div>
              {findings.slice(0, 20).map((f, i) => (
                <FindingItem
                  key={i}
                  projectId={projectId}
                  checkName={checkName}
                  finding={f}
                  fileSummaries={fileSummaries}
                  onNavigateToFile={onNavigateToFile}
                />
              ))}
              {findings.length > 20 && (
                <div className="text-[10px] text-muted-foreground text-center">
                  +{findings.length - 20} more findings
                </div>
              )}
            </div>
          )}

          {latest && (findings.length > 0 || latest.status !== "pass") && onFix && (
            <Button
              size="sm"
              variant="outline"
              className="w-full gap-1.5 text-xs h-8 mt-1"
              onClick={handleFix}
            >
              <MessageSquarePlus className="h-3.5 w-3.5" />
              Fix with AI
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

const CVE_SEVERITY_ORDER: CveFinding["severity"][] = [
  "critical",
  "high",
  "moderate",
  "low",
  "info",
];

function cveSeverityColor(severity: CveFinding["severity"]): string {
  if (severity === "critical") return "text-red-500";
  if (severity === "high") return "text-orange-500";
  if (severity === "moderate") return "text-yellow-500";
  if (severity === "low") return "text-blue-400";
  return "text-muted-foreground";
}

function cveSeverityBg(severity: CveFinding["severity"]): string {
  if (severity === "critical") return "bg-red-500/10 border-red-500/30";
  if (severity === "high") return "bg-orange-500/10 border-orange-500/30";
  if (severity === "moderate") return "bg-yellow-500/10 border-yellow-500/30";
  if (severity === "low") return "bg-blue-500/10 border-blue-500/30";
  return "bg-muted border-border";
}

function CveRow({
  finding,
  onDismiss,
  isDismissing,
}: {
  finding: CveFinding;
  onDismiss: (id: number) => void;
  isDismissing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const dismissed = finding.status === "dismissed";

  return (
    <div
      className={cn(
        "border rounded-md overflow-hidden text-xs",
        dismissed ? "opacity-50 border-border" : "border-border",
      )}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-muted/30 transition-colors"
      >
        <span
          className={cn(
            "shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border",
            cveSeverityBg(finding.severity),
            cveSeverityColor(finding.severity),
          )}
        >
          {finding.severity}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-foreground leading-snug font-medium">{finding.packageName}</div>
          <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
            {finding.title ?? `Vulnerability in ${finding.packageName}`}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>

      {expanded && (
        <div className="px-2.5 pb-2.5 pt-0 border-t border-border bg-card/30 space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 pt-2 text-[10px] text-muted-foreground">
            {finding.currentVersion && (
              <span>
                Current: <span className="font-mono text-foreground">{finding.currentVersion}</span>
              </span>
            )}
            {finding.patchedVersion && (
              <span>
                Patched: <span className="font-mono text-green-400">{finding.patchedVersion}</span>
              </span>
            )}
            {finding.cveId && (
              <span>
                CVE ID: <span className="font-mono text-foreground">{finding.cveId}</span>
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {finding.advisoryUrl && (
              <a
                href={finding.advisoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                <ExternalLink className="h-2.5 w-2.5" />
                Advisory
              </a>
            )}
            {!dismissed && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDismiss(finding.id);
                }}
                disabled={isDismissing}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                <Ban className="h-2.5 w-2.5" />
                Dismiss
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CvePanel() {
  const queryClient = useQueryClient();
  const cveParams = { status: "open" as const };

  const { data: findings, isLoading: isCveLoading } = useListCveFindings(cveParams, {
    query: {
      queryKey: getListCveFindingsQueryKey(cveParams),
      staleTime: 60_000,
      retry: false,
    },
  });

  const { data: scanStatus } = useGetCveScanStatus({
    query: {
      queryKey: getGetCveScanStatusQueryKey(),
      staleTime: 60_000,
      retry: false,
      refetchInterval: 5 * 60_000,
    },
  });

  const { mutate: runScan, isPending: isScanning } = useRunCveScan({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListCveFindingsQueryKey(cveParams) });
        void queryClient.invalidateQueries({ queryKey: getListCveFindingsQueryKey() });
        void queryClient.invalidateQueries({ queryKey: getGetCveScanStatusQueryKey() });
      },
    },
  });

  const { mutate: dismiss, isPending: isDismissing } = useDismissCveFinding({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getListCveFindingsQueryKey(cveParams) });
        void queryClient.invalidateQueries({ queryKey: getListCveFindingsQueryKey() });
      },
    },
  });

  const openFindings = (findings ?? []).filter((f) => f.status === "open");
  const critical = openFindings.filter((f) => f.severity === "critical").length;
  const high = openFindings.filter((f) => f.severity === "high").length;

  const sorted = [...openFindings].sort(
    (a, b) => CVE_SEVERITY_ORDER.indexOf(a.severity) - CVE_SEVERITY_ORDER.indexOf(b.severity),
  );

  const lastScannedAt = scanStatus?.lastScannedAt
    ? new Date(scanStatus.lastScannedAt)
    : null;

  const formattedLastScan = lastScannedAt
    ? lastScannedAt.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  const handleDownloadSbom = () => {
    const a = document.createElement("a");
    a.href = "/api/security/sbom";
    a.download = `mustaflow-sbom-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-xs font-semibold text-foreground shrink-0">Dependency CVEs</span>
          {(critical > 0 || high > 0) && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-red-500/15 border border-red-500/30 text-[9px] font-bold text-red-400 shrink-0">
              {critical + high} critical/high
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground shrink-0"
            onClick={handleDownloadSbom}
            title="Download SBOM (CycloneDX JSON) for compliance audits"
          >
            <Download className="h-3 w-3" />
            Download SBOM
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[10px] gap-1 text-muted-foreground hover:text-foreground shrink-0"
            onClick={() => runScan()}
            disabled={isScanning}
          >
            {isScanning ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Re-scan
          </Button>
        </div>
      </div>

      {formattedLastScan && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <RefreshCw className="h-2.5 w-2.5 shrink-0" />
          <span>Last scanned {formattedLastScan} · updates daily</span>
        </div>
      )}

      {!formattedLastScan && !isCveLoading && (
        <div className="text-[10px] text-muted-foreground">
          No scan has run yet. Click Re-scan or wait for the daily automatic scan.
        </div>
      )}

      {isCveLoading && (
        <div className="text-center text-[11px] text-muted-foreground py-3">
          <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto mb-1" />
          Loading CVE data…
        </div>
      )}

      {!isCveLoading && sorted.length === 0 && (
        <div className="border border-border rounded-lg p-3 text-center space-y-1">
          <CheckCircle2 className="h-5 w-5 text-green-400 mx-auto" />
          <p className="text-[11px] text-muted-foreground">No open CVEs found.</p>
          <p className="text-[10px] text-muted-foreground">
            Click Re-scan to check for new vulnerabilities.
          </p>
        </div>
      )}

      {!isCveLoading && sorted.length > 0 && (
        <div className="space-y-1.5">
          {sorted.map((f) => (
            <CveRow
              key={f.id}
              finding={f}
              onDismiss={(id) => dismiss({ id })}
              isDismissing={isDismissing}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function ChecksTab({
  projectId,
  files = [],
  onSendMessage,
  onNavigateToFile,
}: {
  projectId: number;
  files?: ProjectFileSummary[];
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number) => void;
}) {
  const queryClient = useQueryClient();

  const { data: runs, isLoading } = useGetCheckRuns(projectId, PARAMS, {
    query: {
      enabled: !!projectId,
      queryKey: getGetCheckRunsQueryKey(projectId, PARAMS),
      retry: false,
      staleTime: 30_000,
    },
  });

  const { mutate: triggerChecks, isPending: isTriggering } = useTriggerCheckRuns({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: getGetCheckRunsQueryKey(projectId, PARAMS),
        });
      },
    },
  });

  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getGetCheckRunsQueryKey(projectId, PARAMS),
    });
  };

  const handleSecurityReview = () => {
    triggerChecks({ id: projectId, data: { onDemand: true } });
  };

  const handleFix = (prompt: string) => {
    onSendMessage?.(prompt);
  };

  const allRuns = runs ?? [];

  const runsByCheckName = new Map<string, CheckRun[]>();
  for (const run of allRuns) {
    const existing = runsByCheckName.get(run.checkName) ?? [];
    existing.push(run);
    runsByCheckName.set(run.checkName, existing);
  }

  const checksWithRuns = ALL_CHECK_NAMES.filter((name) => runsByCheckName.has(name));
  const extraChecks = [...runsByCheckName.keys()].filter((name) => !ALL_CHECK_NAMES.includes(name));
  const checksWithoutRuns = ALL_CHECK_NAMES.filter((name) => !runsByCheckName.has(name));
  const allActiveChecks = [...checksWithRuns, ...extraChecks];

  const passed = allActiveChecks.filter(
    (name) => runsByCheckName.get(name)?.[0]?.status === "pass",
  ).length;
  const warnings = allActiveChecks.filter(
    (name) => runsByCheckName.get(name)?.[0]?.status === "warning",
  ).length;
  const failed = allActiveChecks.filter(
    (name) => runsByCheckName.get(name)?.[0]?.status === "fail",
  ).length;
  const latestRunAt = allRuns[0]?.ranAt as unknown as string | undefined;

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <ScanSearch className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">
                Security &amp; Quality Checks
              </span>
            </div>
            {allActiveChecks.length > 0 && (
              <div className="flex items-center gap-2 pl-6 text-[11px]">
                {passed > 0 && <span className="text-green-400">{passed} passed</span>}
                {warnings > 0 && <span className="text-yellow-400">{warnings} warnings</span>}
                {failed > 0 && <span className="text-red-400">{failed} failed</span>}
                {latestRunAt && (
                  <span className="text-muted-foreground">
                    · last run {new Date(latestRunAt).toLocaleString()}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={handleRefresh}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            title="Refresh checks"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        <Button
          size="sm"
          variant="outline"
          className="w-full gap-1.5 text-xs h-8"
          onClick={handleSecurityReview}
          disabled={isTriggering}
        >
          {isTriggering ? (
            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldAlert className="h-3.5 w-3.5" />
          )}
          Run security review
        </Button>

        {isLoading && (
          <div className="text-center text-xs text-muted-foreground py-4">
            <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto mb-1" />
            Loading checks…
          </div>
        )}

        {!isLoading && allRuns.length === 0 && (
          <div className="border border-border rounded-lg p-6 text-center space-y-2">
            <ScanSearch className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No check runs yet.</p>
            <p className="text-xs text-muted-foreground leading-relaxed max-w-xs mx-auto">
              Checks run automatically after each build. Click &quot;Run security review&quot; for
              an on-demand scan.
            </p>
          </div>
        )}

        {!isLoading && allActiveChecks.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider px-0.5">
              Checks ({allActiveChecks.length})
            </div>
            <div className="space-y-1.5">
              {allActiveChecks.map((name) => (
                <CheckDetailCard
                  key={name}
                  checkName={name}
                  history={runsByCheckName.get(name) ?? []}
                  projectId={projectId}
                  fileSummaries={files}
                  onFix={handleFix}
                  onNavigateToFile={onNavigateToFile}
                />
              ))}
            </div>
          </div>
        )}

        {!isLoading && checksWithoutRuns.length > 0 && allActiveChecks.length > 0 && (
          <div className="space-y-2">
            <div className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider px-0.5">
              Not yet run
            </div>
            <div className="space-y-1.5">
              {checksWithoutRuns.map((name) => (
                <CheckDetailCard
                  key={name}
                  checkName={name}
                  history={[]}
                  projectId={projectId}
                  fileSummaries={files}
                  onFix={handleFix}
                  onNavigateToFile={onNavigateToFile}
                />
              ))}
            </div>
          </div>
        )}

        <div className="border-t border-border pt-4">
          <CvePanel />
        </div>
      </div>
    </div>
  );
}

/**
 * Exported helper so the workspace layout can show a badge count
 * on the Checks tab without rendering the full panel.
 */
export function useCveCriticalHighCount(): number {
  const params = { status: "open" as const };
  const { data } = useListCveFindings(params, {
    query: {
      queryKey: getListCveFindingsQueryKey(params),
      staleTime: 120_000,
      retry: false,
    },
  });
  if (!data) return 0;
  return data.filter((f) => f.severity === "critical" || f.severity === "high").length;
}
