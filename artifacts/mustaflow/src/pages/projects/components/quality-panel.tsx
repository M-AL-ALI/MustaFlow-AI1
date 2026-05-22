import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectAudit,
  getGetProjectAuditQueryKey,
  useGetCheckRuns,
  getGetCheckRunsQueryKey,
  useTriggerCheckRuns,
  type CheckRun,
  type CheckRunFinding,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  ShieldCheck,
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
  Wrench,
  ChevronDown,
  ChevronUp,
  Code2,
  KeyRound,
  ScanSearch,
  Globe,
  SkipForward,
  BadgeCheck,
} from "lucide-react";

type AuditCategory = "accessibility" | "seo" | "performance" | "security";
type AuditSeverity = "error" | "warning" | "info";

interface AuditFinding {
  category: AuditCategory;
  severity: AuditSeverity;
  file: string;
  message: string;
  suggestion: string;
}

interface AuditScore {
  category: AuditCategory;
  label: string;
  pass: number;
  warnings: number;
  failures: number;
  score: number;
}

interface AuditReport {
  findings: AuditFinding[];
  scores: AuditScore[];
  auditedAt: string;
  fileCount: number;
}

const CATEGORY_ICONS: Record<AuditCategory, React.FC<{ className?: string }>> = {
  accessibility: Eye,
  seo: Search,
  performance: Zap,
  security: Lock,
};

const CATEGORY_LABELS: Record<AuditCategory, string> = {
  accessibility: "Accessibility",
  seo: "SEO",
  performance: "Performance",
  security: "Security",
};

const CATEGORY_FIX_PROMPTS: Record<AuditCategory, (findings: AuditFinding[]) => string> = {
  accessibility: (findings) => {
    const issues = findings
      .map((f) => f.suggestion)
      .slice(0, 5)
      .join("; ");
    return `Fix all accessibility issues in the generated app. ${issues}. Ensure all images have alt attributes, all form inputs have associated labels, all buttons have accessible text, and the html element has a lang attribute.`;
  },
  seo: (findings) => {
    const issues = findings
      .map((f) => f.suggestion)
      .slice(0, 5)
      .join("; ");
    return `Fix all SEO issues in the generated app. ${issues}. Add or improve meta description, Open Graph tags (og:title, og:description, og:image), and ensure the page title is descriptive.`;
  },
  performance: (findings) => {
    const issues = findings
      .map((f) => f.suggestion)
      .slice(0, 5)
      .join("; ");
    return `Fix all performance issues in the generated app. ${issues}. Add defer or async to scripts in the head, add explicit width and height to images, and add loading="lazy" to below-fold images.`;
  },
  security: (findings) => {
    const pkgs = [...new Set(findings.map((f) => f.message.split(":")[0]))].join(", ");
    return `Update outdated or vulnerable CDN packages in the generated app. The following packages need updating: ${pkgs}. Replace their CDN URLs with the latest stable versions.`;
  },
};

const CHECK_META: Record<
  string,
  { label: string; Icon: React.FC<{ className?: string }>; fixable: boolean }
> = {
  "secret-leak": { label: "Secret Leak", Icon: KeyRound, fixable: false },
  "code-quality": { label: "Code Quality", Icon: Code2, fixable: false },
  sast: { label: "SAST", Icon: ScanSearch, fixable: false },
  accessibility: { label: "Accessibility", Icon: Eye, fixable: true },
  seo: { label: "SEO", Icon: Search, fixable: true },
  performance: { label: "Performance", Icon: Zap, fixable: true },
  "cdn-security": { label: "CDN Security", Icon: Globe, fixable: true },
};

function scoreColor(score: number): string {
  if (score >= 80) return "text-green-500";
  if (score >= 60) return "text-yellow-500";
  return "text-red-500";
}

function scoreBg(score: number): string {
  if (score >= 80) return "bg-green-500/10 border-green-500/30";
  if (score >= 60) return "bg-yellow-500/10 border-yellow-500/30";
  return "bg-red-500/10 border-red-500/30";
}

function SeverityIcon({ severity }: { severity: AuditSeverity | "error" | "warning" | "info" }) {
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

function CheckRunCard({ run }: { run: CheckRun }) {
  const [expanded, setExpanded] = useState(false);
  const meta = CHECK_META[run.checkName] ?? {
    label: run.checkName,
    Icon: ShieldCheck,
    fixable: false,
  };
  const Icon = meta.Icon;
  const findings = (run.findings ?? []) as CheckRunFinding[];

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
        <CheckStatusBadge status={run.status} />
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
        <div className="border-t border-border bg-card/50 p-3 space-y-2">
          {run.aiReason && (
            <p className="text-[11px] text-muted-foreground italic leading-relaxed">
              {run.aiReason}
            </p>
          )}
          {findings.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-green-400 py-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> No issues found.
            </div>
          ) : (
            <div className="space-y-1.5">
              {findings.slice(0, 10).map((f, i) => (
                <div key={i} className="border border-border rounded-md p-2.5 text-xs space-y-0.5">
                  <div className="flex items-start gap-2">
                    <SeverityIcon severity={f.severity} />
                    <div className="flex-1 min-w-0">
                      <div className="text-foreground leading-snug">{f.message}</div>
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                        {f.file}
                        {f.line ? `:${f.line}` : ""}
                      </div>
                    </div>
                  </div>
                  {f.detail && (
                    <div className="pl-5 text-[10px] text-muted-foreground leading-relaxed">
                      {f.detail}
                    </div>
                  )}
                </div>
              ))}
              {findings.length > 10 && (
                <div className="text-[10px] text-muted-foreground text-center">
                  +{findings.length - 10} more findings
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ finding }: { finding: AuditFinding }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-muted/50 transition-colors"
      >
        <SeverityIcon severity={finding.severity} />
        <div className="flex-1 min-w-0">
          <div className="text-foreground leading-snug">{finding.message}</div>
          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{finding.file}</div>
        </div>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>
      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border bg-muted/30">
          <div className="flex items-start gap-1.5 pt-2">
            <Wrench className="h-3 w-3 text-primary shrink-0 mt-0.5" />
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {finding.suggestion}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CategorySection({
  category,
  score,
  findings,
  onFix,
}: {
  category: AuditCategory;
  score: AuditScore | undefined;
  findings: AuditFinding[];
  onFix: (prompt: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const Icon = CATEGORY_ICONS[category];
  const label = CATEGORY_LABELS[category];
  const s = score?.score ?? 100;
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
      >
        <div className={`p-1.5 rounded-md border ${scoreBg(s)}`}>
          <Icon className={`h-3.5 w-3.5 ${scoreColor(s)}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className={`text-xs font-bold ${scoreColor(s)}`}>{s}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            {errors > 0 && (
              <span className="text-[10px] text-red-400">
                {errors} error{errors !== 1 ? "s" : ""}
              </span>
            )}
            {warnings > 0 && (
              <span className="text-[10px] text-yellow-400">
                {warnings} warning{warnings !== 1 ? "s" : ""}
              </span>
            )}
            {findings.length === 0 && (
              <span className="text-[10px] text-green-400 flex items-center gap-1">
                <CheckCircle2 className="h-2.5 w-2.5" /> All checks passed
              </span>
            )}
          </div>
        </div>
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border p-3 space-y-2 bg-card/50">
          {findings.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-green-400 py-1">
              <CheckCircle2 className="h-4 w-4" />
              No issues found in this category.
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {findings.map((f, i) => (
                  <FindingRow key={i} finding={f} />
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-2 text-xs h-8 gap-1.5"
                onClick={() => onFix(CATEGORY_FIX_PROMPTS[category](findings))}
              >
                <Wrench className="h-3.5 w-3.5" />
                Fix all {label.toLowerCase()} issues
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ChecksSection({
  projectId,
  onSecurityReview,
}: {
  projectId: number;
  onSecurityReview: () => void;
}) {
  const queryClient = useQueryClient();
  const { data: runs, isLoading } = useGetCheckRuns(projectId, undefined, {
    query: {
      enabled: !!projectId,
      queryKey: getGetCheckRunsQueryKey(projectId),
      retry: false,
      staleTime: 30_000,
    },
  });

  const { mutate: triggerChecks, isPending: isTriggering } = useTriggerCheckRuns({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetCheckRunsQueryKey(projectId) });
      },
    },
  });

  const handleSecurityReview = () => {
    triggerChecks({ id: projectId, data: { onDemand: true } });
    onSecurityReview();
  };

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetCheckRunsQueryKey(projectId) });
  };

  const latestRuns = runs ?? [];

  const passed = latestRuns.filter((r) => r.status === "pass").length;
  const warnings = latestRuns.filter((r) => r.status === "warning").length;
  const failed = latestRuns.filter((r) => r.status === "fail").length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanSearch className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Checks</span>
          {latestRuns.length > 0 && (
            <div className="flex items-center gap-1.5 text-[10px]">
              {passed > 0 && <span className="text-green-400">{passed} passed</span>}
              {warnings > 0 && <span className="text-yellow-400">{warnings} warnings</span>}
              {failed > 0 && <span className="text-red-400">{failed} failed</span>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleRefresh}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            title="Refresh checks"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
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
        <div className="text-center text-xs text-muted-foreground py-2">
          <RefreshCw className="h-3.5 w-3.5 animate-spin mx-auto mb-1" />
          Loading checks…
        </div>
      )}

      {!isLoading && latestRuns.length === 0 && (
        <div className="border border-border rounded-lg p-4 text-center space-y-1.5">
          <ScanSearch className="h-6 w-6 text-muted-foreground mx-auto" />
          <p className="text-xs text-muted-foreground">No check runs yet.</p>
          <p className="text-[10px] text-muted-foreground">
            Checks run automatically after each build. Click "Run security review" for an on-demand
            scan.
          </p>
        </div>
      )}

      {latestRuns.length > 0 && (
        <div className="space-y-1.5">
          {latestRuns.map((run) => (
            <CheckRunCard key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

export function QualityPanel({
  projectId,
  onSendMessage,
}: {
  projectId: number;
  onSendMessage?: (text: string) => void;
}) {
  const queryClient = useQueryClient();

  const {
    data: audit,
    isLoading,
    isError,
  } = useGetProjectAudit(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectAuditQueryKey(projectId),
      retry: false,
    },
  });

  const handleRefresh = () => {
    void queryClient.invalidateQueries({ queryKey: getGetProjectAuditQueryKey(projectId) });
  };

  const handleFix = (prompt: string) => {
    onSendMessage?.(prompt);
  };

  const noAuditYet = isError || !audit || !("findings" in (audit as object));

  return (
    <div className="space-y-6 p-1">
      <ChecksSection
        projectId={projectId}
        onSecurityReview={() => {
          void queryClient.invalidateQueries({ queryKey: getGetCheckRunsQueryKey(projectId) });
        }}
      />

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium text-foreground">Quality Audit</span>
          </div>
          <button
            onClick={handleRefresh}
            className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
            title="Refresh audit"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>

        {isLoading && (
          <div className="p-4 text-center text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin mx-auto mb-2" />
            Loading audit report…
          </div>
        )}

        {!isLoading && noAuditYet && (
          <div className="border border-border rounded-lg p-4 text-center space-y-2">
            <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">No audit report yet.</p>
            <p className="text-xs text-muted-foreground">
              Build or refine your app to generate a quality audit covering accessibility, SEO,
              performance, and security.
            </p>
          </div>
        )}

        {!isLoading &&
          !noAuditYet &&
          (() => {
            const report = audit as AuditReport;
            const categories: AuditCategory[] = ["accessibility", "seo", "performance", "security"];
            const totalIssues = report.findings.length;
            const totalErrors = report.findings.filter((f) => f.severity === "error").length;
            const overallScore = Math.round(
              report.scores.reduce((sum, s) => sum + s.score, 0) /
                Math.max(report.scores.length, 1),
            );
            const relativeDate = new Date(report.auditedAt).toLocaleString();

            return (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className={`border rounded-lg p-3 text-center ${scoreBg(overallScore)}`}>
                    <div className={`text-2xl font-bold ${scoreColor(overallScore)}`}>
                      {overallScore}
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">Overall Score</div>
                  </div>
                  <div className="border border-border rounded-lg p-3 text-center bg-card">
                    <div className="text-2xl font-bold text-foreground">{totalIssues}</div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {totalErrors > 0 ? (
                        <span className="text-red-400">
                          {totalErrors} error{totalErrors !== 1 ? "s" : ""}
                        </span>
                      ) : (
                        "Total issues"
                      )}
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-1.5">
                  {report.scores.map((s) => {
                    const Icon = CATEGORY_ICONS[s.category];
                    return (
                      <div
                        key={s.category}
                        className={`border rounded-md p-2 text-center ${scoreBg(s.score)}`}
                      >
                        <Icon className={`h-3.5 w-3.5 mx-auto mb-1 ${scoreColor(s.score)}`} />
                        <div className={`text-xs font-bold ${scoreColor(s.score)}`}>{s.score}</div>
                        <div className="text-[9px] text-muted-foreground mt-0.5 leading-tight">
                          {s.label}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-2">
                  {categories.map((cat) => (
                    <CategorySection
                      key={cat}
                      category={cat}
                      score={report.scores.find((s) => s.category === cat)}
                      findings={report.findings.filter((f) => f.category === cat)}
                      onFix={handleFix}
                    />
                  ))}
                </div>

                <div className="text-[10px] text-muted-foreground text-center pt-1">
                  Audited {report.fileCount} HTML file{report.fileCount !== 1 ? "s" : ""} ·{" "}
                  {relativeDate}
                </div>
              </>
            );
          })()}
      </div>
    </div>
  );
}
