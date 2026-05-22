import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetProjectAudit,
  getGetProjectAuditQueryKey,
  useGetCheckRuns,
  getGetCheckRunsQueryKey,
  useTriggerCheckRuns,
  useGetProject,
  getGetProjectQueryKey,
  useUpdateProject,
  useListCveFindings,
  getListCveFindingsQueryKey,
  useDismissCveFinding,
  useApplyCvePatch,
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
  FileCode,
  KeyRound,
  ScanSearch,
  Globe,
  SkipForward,
  BadgeCheck,
  Bolt,
  Cookie,
  Shield,
  PackageCheck,
  PackageX,
  Loader2,
  Sparkles,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

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

interface CvePatchFinding {
  id: number;
  packageName: string;
  cveId: string | null;
  title: string | null;
  severity: string;
  currentVersion: string | null;
  patchedVersion: string | null;
  patchStatus: string | null;
  patchTypecheckPassed: boolean | null;
  patchContent: string | null;
  advisoryUrl: string | null;
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
  { label: string; Icon: React.FC<{ className?: string }>; fixPrompt?: string }
> = {
  "secret-leak": {
    label: "Secret Leak",
    Icon: KeyRound,
    fixPrompt:
      "Remove all hardcoded API keys, tokens, and secrets from the generated code. Do NOT delete the surrounding functionality — instead replace each hardcoded value with a placeholder comment like /* TODO: Load from environment */ or a descriptive constant like YOUR_API_KEY_HERE. If the secret is used to call an API, keep the call intact but remove only the literal credential value.",
  },
  "code-quality": {
    label: "Code Quality",
    Icon: Code2,
    fixPrompt:
      "Fix all code quality issues in the generated app: replace eval() calls with safer alternatives, replace document.write() with proper DOM manipulation, fix innerHTML string concatenation with safe DOM methods, remove console.log statements, and add missing semicolons.",
  },
  sast: {
    label: "SAST",
    Icon: ScanSearch,
    fixPrompt:
      "Fix all SAST security issues in the generated app: sanitise innerHTML assignments that use user-controlled data to prevent XSS, remove prototype pollution patterns, move sensitive values out of localStorage/sessionStorage, and replace hardcoded internal endpoint URLs with configurable values.",
  },
  accessibility: {
    label: "Accessibility",
    Icon: Eye,
    fixPrompt:
      "Fix all accessibility issues in the generated app: add the lang attribute to the <html> element, add descriptive alt attributes to all images, add associated <label> elements to all form inputs, add accessible text to all buttons (visible text or aria-label), and add a skip-navigation link at the top of the page.",
  },
  seo: {
    label: "SEO",
    Icon: Search,
    fixPrompt:
      "Fix all SEO issues in the generated app: add or improve the <title> tag, add a meta description, add Open Graph tags (og:title, og:description, og:image), add a canonical link tag, and add basic structured data (JSON-LD) for the page.",
  },
  performance: {
    label: "Performance",
    Icon: Zap,
    fixPrompt:
      'Fix all performance issues in the generated app: add defer or async attributes to render-blocking <script> tags in the <head>, add explicit width and height attributes to all images to prevent layout shifts, and add loading="lazy" to below-the-fold images.',
  },
  "cdn-security": {
    label: "CDN Security",
    Icon: Globe,
    fixPrompt:
      "Update all CDN script and stylesheet URLs to the latest stable secure versions. Replace any vulnerable or outdated library URLs in <script src> and <link href> tags with their current versions from cdnjs.cloudflare.com or jsdelivr.com.",
  },
  eslint: {
    label: "ESLint",
    Icon: Code2,
    fixPrompt:
      "Fix all ESLint issues in the generated code: remove or use unused variables, define any undeclared variables, replace == with ===, remove console.log statements left in production code, and address other code quality warnings.",
  },
  typescript: {
    label: "TypeScript",
    Icon: FileCode,
    fixPrompt:
      "Fix all TypeScript type errors in the generated Expo/React Native code: correct wrong types, add missing imports, fix incompatible prop types, add required type annotations, and resolve module resolution errors.",
  },
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

function severityBadgeClass(severity: string): string {
  if (severity === "critical") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (severity === "high") return "bg-orange-500/15 text-orange-400 border-orange-500/30";
  return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
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

function CheckRunCard({
  run,
  onSendMessage,
  onNavigateToFile,
}: {
  run: CheckRun;
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const meta = CHECK_META[run.checkName] ?? {
    label: run.checkName,
    Icon: ShieldCheck,
    fixPrompt: undefined,
  };
  const Icon = meta.Icon;
  const findings = (run.findings ?? []) as CheckRunFinding[];
  const canFix =
    (run.status === "fail" || run.status === "warning") && !!meta.fixPrompt && !!onSendMessage;

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
              {findings.slice(0, 10).map((f, i) => {
                const canJump = !!onNavigateToFile && !!f.file;
                return (
                  <div
                    key={i}
                    className="border border-border rounded-md p-2.5 text-xs space-y-0.5"
                  >
                    <div className="flex items-start gap-2">
                      <SeverityIcon severity={f.severity} />
                      <div className="flex-1 min-w-0">
                        <div className="text-foreground leading-snug">{f.message}</div>
                        {canJump ? (
                          <button
                            type="button"
                            onClick={() => onNavigateToFile!(f.file!, f.line ?? null)}
                            className="text-[10px] text-muted-foreground hover:text-primary font-mono mt-0.5 underline-offset-2 hover:underline transition-colors text-left"
                            title="Open in code editor"
                          >
                            {f.file}
                            {f.line ? `:${f.line}` : ""}
                          </button>
                        ) : (
                          <div className="text-[10px] text-muted-foreground font-mono mt-0.5">
                            {f.file}
                            {f.line ? `:${f.line}` : ""}
                          </div>
                        )}
                      </div>
                    </div>
                    {f.detail && (
                      <div className="pl-5 text-[10px] text-muted-foreground leading-relaxed">
                        {f.detail}
                      </div>
                    )}
                  </div>
                );
              })}
              {findings.length > 10 && (
                <div className="text-[10px] text-muted-foreground text-center">
                  +{findings.length - 10} more findings
                </div>
              )}
            </div>
          )}
          {canFix && (
            <Button
              size="sm"
              variant="outline"
              className="w-full mt-1 text-xs h-8 gap-1.5"
              onClick={() => onSendMessage!(meta.fixPrompt!)}
            >
              <Wrench className="h-3.5 w-3.5" />
              Fix with AI
            </Button>
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

function CvePatchCard({
  finding,
  onApplied,
  onDismissed,
}: {
  finding: CvePatchFinding;
  onApplied: () => void;
  onDismissed: () => void;
}) {
  const [showDiff, setShowDiff] = useState(false);
  const applyMutation = useApplyCvePatch();
  const dismissMutation = useDismissCveFinding();

  const isPreparing = finding.patchStatus === "preparing";
  const isReady = finding.patchStatus === "ready";
  const isFailed = finding.patchStatus === "failed";

  const typecheckBadge =
    finding.patchTypecheckPassed === true ? (
      <span className="inline-flex items-center gap-1 text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 rounded px-1.5 py-0.5">
        <CheckCircle2 className="h-2.5 w-2.5" /> Typecheck passed
      </span>
    ) : finding.patchTypecheckPassed === false ? (
      <span className="inline-flex items-center gap-1 text-[10px] text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded px-1.5 py-0.5">
        <AlertTriangle className="h-2.5 w-2.5" /> Typecheck failed
      </span>
    ) : null;

  let patchSummary: string | null = null;
  let patchFiles: Array<{ path: string; content: string }> = [];
  if (finding.patchContent) {
    try {
      const parsed = JSON.parse(finding.patchContent) as {
        files?: Array<{ path: string; content: string }>;
        summary?: string;
        error?: string;
      };
      patchSummary = parsed.summary ?? parsed.error ?? null;
      patchFiles = parsed.files ?? [];
    } catch {
      patchSummary = null;
    }
  }

  return (
    <div className="border border-border rounded-lg overflow-hidden text-xs">
      <div className="p-3 flex items-start gap-2.5">
        <div className="p-1.5 rounded-md bg-blue-500/10 border border-blue-500/20 shrink-0 mt-0.5">
          {isPreparing ? (
            <Loader2 className="h-3.5 w-3.5 text-blue-400 animate-spin" />
          ) : isReady ? (
            <PackageCheck className="h-3.5 w-3.5 text-blue-400" />
          ) : isFailed ? (
            <PackageX className="h-3.5 w-3.5 text-red-400" />
          ) : (
            <Shield className="h-3.5 w-3.5 text-blue-400" />
          )}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-foreground">
              {isReady
                ? "CVE patch ready"
                : isFailed
                  ? "Patch needs manual review"
                  : isPreparing
                    ? "Preparing patch…"
                    : "CVE auto-protect"}
            </span>
            <span
              className={`text-[10px] border rounded px-1.5 py-0.5 uppercase font-medium ${severityBadgeClass(finding.severity)}`}
            >
              {finding.severity}
            </span>
          </div>

          <div className="text-muted-foreground mt-1 leading-relaxed">
            {finding.cveId && (
              <span className="font-mono text-[10px] text-muted-foreground mr-1">
                {finding.cveId}
              </span>
            )}
            <span className="font-medium text-foreground">{finding.packageName}</span>
            {finding.currentVersion && finding.patchedVersion && (
              <span className="text-muted-foreground ml-1">
                {finding.currentVersion} → {finding.patchedVersion}
              </span>
            )}
          </div>

          {finding.title && (
            <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
              {finding.title}
            </div>
          )}

          {patchSummary && (
            <div className="text-[10px] text-muted-foreground mt-1 italic">{patchSummary}</div>
          )}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {typecheckBadge}
            {finding.advisoryUrl && (
              <a
                href={finding.advisoryUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-primary underline underline-offset-2"
              >
                Advisory
              </a>
            )}
          </div>

          {isReady && patchFiles.length > 0 && (
            <button
              onClick={() => setShowDiff((v) => !v)}
              className="text-[10px] text-muted-foreground hover:text-foreground mt-1.5 flex items-center gap-1 transition-colors"
            >
              {showDiff ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              {showDiff ? "Hide" : "Show"} patch diff
            </button>
          )}

          {showDiff && patchFiles.length > 0 && (
            <div className="mt-2 space-y-1.5">
              {patchFiles.map((f) => (
                <div key={f.path} className="rounded border border-border overflow-hidden">
                  <div className="bg-muted/50 px-2 py-1 text-[10px] font-mono text-muted-foreground border-b border-border">
                    {f.path}
                  </div>
                  <pre className="p-2 text-[10px] font-mono text-foreground overflow-x-auto whitespace-pre-wrap max-h-40">
                    {f.content}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {isReady && (
            <div className="flex items-center gap-2 mt-3">
              <Button
                size="sm"
                variant="default"
                className="h-7 text-[11px] gap-1.5 px-3"
                disabled={applyMutation.isPending}
                onClick={() => {
                  applyMutation.mutate({ id: finding.id }, { onSuccess: onApplied });
                }}
              >
                {applyMutation.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <PackageCheck className="h-3 w-3" />
                )}
                Apply patch
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] text-muted-foreground gap-1.5 px-3"
                disabled={dismissMutation.isPending}
                onClick={() => {
                  dismissMutation.mutate({ id: finding.id }, { onSuccess: onDismissed });
                }}
              >
                Dismiss
              </Button>
            </div>
          )}

          {isFailed && (
            <div className="flex items-center gap-2 mt-3">
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-[11px] text-muted-foreground gap-1.5 px-3"
                disabled={dismissMutation.isPending}
                onClick={() => {
                  dismissMutation.mutate({ id: finding.id }, { onSuccess: onDismissed });
                }}
              >
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CvePatchSection({ projectId: _projectId }: { projectId: number }) {
  const queryClient = useQueryClient();

  const { data: allFindings, isLoading } = useListCveFindings(
    { status: "open" },
    {
      query: {
        queryKey: getListCveFindingsQueryKey({ status: "open" }),
        refetchInterval: 15_000,
      },
    },
  );

  const patchFindings = (allFindings ?? []).filter(
    (f) =>
      (f.patchStatus === "ready" || f.patchStatus === "preparing" || f.patchStatus === "failed") &&
      (f.severity === "critical" || f.severity === "high"),
  ) as CvePatchFinding[];

  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey: getListCveFindingsQueryKey({ status: "open" }),
    });
  };

  if (isLoading) return null;
  if (patchFindings.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Shield className="h-3.5 w-3.5 text-blue-400" />
        <span className="text-xs font-medium text-foreground">CVE Auto-Protect</span>
        <span className="text-[10px] text-muted-foreground">
          {patchFindings.length} patch{patchFindings.length !== 1 ? "es" : ""} available
        </span>
      </div>
      <div className="space-y-2">
        {patchFindings.map((f) => (
          <CvePatchCard key={f.id} finding={f} onApplied={invalidate} onDismissed={invalidate} />
        ))}
      </div>
    </div>
  );
}

function ChecksSection({
  projectId,
  isMobile,
  onSecurityReview,
  onSendMessage,
  onNavigateToFile,
}: {
  projectId: number;
  isMobile?: boolean;
  onSecurityReview: () => void;
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
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

  const { data: project } = useGetProject(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetProjectQueryKey(projectId),
      staleTime: 60_000,
    },
  });

  const { mutate: updateProject, isPending: isUpdatingProject } = useUpdateProject({
    mutation: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      },
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

  const handleAutoFixToggle = () => {
    updateProject({
      id: projectId,
      data: { autoFixOnCheckFailure: !project?.autoFixOnCheckFailure },
    });
  };

  const allRuns = runs ?? [];

  // Platform-aware filtering: ESLint runs for both web and mobile; TypeScript only for mobile.
  const latestRuns = allRuns.filter((run) => {
    if (run.checkName === "typescript" && !isMobile) return false;
    return true;
  });

  const autoFixEnabled = project?.autoFixOnCheckFailure ?? false;

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

      <button
        onClick={handleAutoFixToggle}
        disabled={isUpdatingProject}
        className={`w-full flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left transition-colors ${
          autoFixEnabled
            ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
            : "border-border bg-card hover:bg-muted/30"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Bolt
            className={`h-3.5 w-3.5 shrink-0 ${autoFixEnabled ? "text-primary" : "text-muted-foreground"}`}
          />
          <div className="min-w-0">
            <div className="text-xs font-medium text-foreground leading-tight">
              Auto-fix on failure
            </div>
            <div className="text-[10px] text-muted-foreground leading-tight mt-0.5">
              {autoFixEnabled
                ? "Automatically fixes failing checks after each build"
                : "Enable to auto-fix failing checks after each build"}
            </div>
          </div>
        </div>
        <div
          className={`relative shrink-0 h-4 w-7 rounded-full transition-colors ${
            autoFixEnabled ? "bg-primary" : "bg-muted"
          }`}
        >
          <div
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform ${
              autoFixEnabled ? "translate-x-3.5" : "translate-x-0.5"
            }`}
          />
        </div>
      </button>

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
            <CheckRunCard
              key={run.id}
              run={run}
              onSendMessage={onSendMessage}
              onNavigateToFile={onNavigateToFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

const PRIVACY_CHECK_PARAMS = { limit: 5 };

function PrivacySection({
  projectId,
  onFix,
}: {
  projectId: number;
  onFix: (prompt: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const { data: privacyRuns } = useGetCheckRuns(projectId, PRIVACY_CHECK_PARAMS, {
    query: {
      enabled: !!projectId,
      queryKey: getGetCheckRunsQueryKey(projectId, PRIVACY_CHECK_PARAMS),
      retry: false,
    },
  });

  const privacyRun = Array.isArray(privacyRuns)
    ? privacyRuns.find((r) => r.checkName === "privacy")
    : undefined;

  const findings = (privacyRun?.findings as CheckRunFinding[] | undefined) ?? [];
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warning").length;

  const s = findings.length === 0 ? 100 : errors > 0 ? 40 : warnings > 0 ? 65 : 100;

  const buildFixPrompt = (): string => {
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
    return parts.length > 0
      ? `Fix all privacy and compliance issues in the generated app: ${parts.join("; ")}.`
      : "Review the generated app for privacy and compliance best practices.";
  };

  if (!privacyRun) return null;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
      >
        <div className={`p-1.5 rounded-md border ${scoreBg(s)}`}>
          <Cookie className={`h-3.5 w-3.5 ${scoreColor(s)}`} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">Privacy</span>
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
              No privacy issues found.
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {findings.map((f, i) => (
                  <PrivacyFindingRow key={i} finding={f} />
                ))}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full mt-2 text-xs h-8 gap-1.5"
                onClick={() => onFix(buildFixPrompt())}
              >
                <Wrench className="h-3.5 w-3.5" />
                Fix privacy issues
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PrivacyFindingRow({ finding }: { finding: CheckRunFinding }) {
  const [expanded, setExpanded] = useState(false);
  const isTracker = finding.message.startsWith("Tracker loaded without consent");
  return (
    <div className="border border-border rounded-md overflow-hidden text-xs">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-muted/50 transition-colors"
      >
        <SeverityIcon severity={(finding.severity as "error" | "warning" | "info") ?? "info"} />
        <div className="flex-1 min-w-0">
          <div className="text-foreground leading-snug">{finding.message}</div>
          {finding.file && (
            <div className="text-[10px] text-muted-foreground font-mono mt-0.5">{finding.file}</div>
          )}
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
            {isTracker ? (
              <ShieldAlert className="h-3 w-3 text-yellow-500 shrink-0 mt-0.5" />
            ) : (
              <Wrench className="h-3 w-3 text-primary shrink-0 mt-0.5" />
            )}
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              {finding.detail ?? "Review this finding and address it before publishing."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

type FixAllResult = {
  filesScanned: number;
  filesFixed: number;
  fixedCount: number;
  remainingCount: number;
  snapshotVersionId: number | null;
  results: Array<{
    fileId: number;
    path: string;
    supported: boolean;
    changed: boolean;
    fixedCount: number;
    remainingCount: number;
    errorCount: number;
  }>;
};

function ProjectAutoFixSection({
  projectId,
  onNavigateToFile,
}: {
  projectId: number;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isFixing, setIsFixing] = useState(false);
  const [lastResult, setLastResult] = useState<FixAllResult | null>(null);

  const handleFixAll = async () => {
    if (isFixing) return;
    setIsFixing(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/eslint-fix-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!res.ok) {
        toast({
          title: "Auto-fix failed",
          description: "Could not run project-wide ESLint auto-fix. Try again later.",
          variant: "destructive",
        });
        return;
      }
      const data = (await res.json()) as FixAllResult;
      setLastResult(data);

      // Refresh any open file content + version history.
      void queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "files"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/projects", projectId, "versions"] });

      if (data.filesFixed === 0) {
        toast({
          title: "Nothing to fix",
          description: `Scanned ${data.filesScanned} file${data.filesScanned === 1 ? "" : "s"} — no auto-fixable issues found.`,
        });
      } else {
        toast({
          title: "Auto-fixes applied",
          description: `Fixed ${data.fixedCount} issue${data.fixedCount === 1 ? "" : "s"} across ${data.filesFixed} file${data.filesFixed === 1 ? "" : "s"}. ${data.remainingCount} remain.`,
        });
      }
    } catch {
      toast({
        title: "Auto-fix failed",
        description: "Network error while running auto-fix.",
        variant: "destructive",
      });
    } finally {
      setIsFixing(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Project auto-fix</span>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={handleFixAll}
          disabled={isFixing}
          title="Run ESLint auto-fix across every file. Saves a version snapshot first so you can roll back."
        >
          {isFixing ? (
            <>
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              Fixing…
            </>
          ) : (
            <>
              <Wrench className="h-3.5 w-3.5 mr-1.5" />
              Auto-fix everything
            </>
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Applies every safe ESLint fix across all JavaScript and TypeScript files at once. A version
        snapshot is saved first so you can roll back from History if needed.
      </p>

      {lastResult && lastResult.results.length > 0 && (
        <div className="border border-border rounded-lg bg-card">
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <span className="text-xs font-medium text-foreground">
              Fixed {lastResult.fixedCount} issue{lastResult.fixedCount === 1 ? "" : "s"} in{" "}
              {lastResult.filesFixed} of {lastResult.filesScanned} file
              {lastResult.filesScanned === 1 ? "" : "s"}
            </span>
            {lastResult.snapshotVersionId !== null && (
              <span className="text-[10px] text-muted-foreground">
                Snapshot v{lastResult.snapshotVersionId}
              </span>
            )}
          </div>
          <div className="max-h-48 overflow-y-auto divide-y divide-border">
            {lastResult.results.map((r) => (
              <button
                key={r.fileId}
                onClick={() => onNavigateToFile?.(r.path)}
                className="w-full px-3 py-1.5 flex items-center justify-between gap-2 text-left hover:bg-muted/40 transition-colors"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FileCode className="h-3 w-3 text-muted-foreground flex-shrink-0" />
                  <span className="text-xs text-foreground truncate font-mono">{r.path}</span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 text-[10px]">
                  {r.fixedCount > 0 && (
                    <span className="text-emerald-400">+{r.fixedCount} fixed</span>
                  )}
                  {r.remainingCount > 0 && (
                    <span className="text-amber-400">{r.remainingCount} left</span>
                  )}
                  {r.fixedCount === 0 && r.remainingCount === 0 && (
                    <span className="text-muted-foreground">clean</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function QualityPanel({
  projectId,
  projectKind,
  onSendMessage,
  onNavigateToFile,
}: {
  projectId: number;
  projectKind?: string;
  onSendMessage?: (text: string) => void;
  onNavigateToFile?: (filePath: string, line?: number | null) => void;
}) {
  const queryClient = useQueryClient();
  const isMobile =
    projectKind === "mobile-cross" ||
    projectKind === "mobile-ios" ||
    projectKind === "mobile-android";

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
    void queryClient.invalidateQueries({
      queryKey: getGetCheckRunsQueryKey(projectId),
    });
  };

  const handleFix = (prompt: string) => {
    onSendMessage?.(prompt);
  };

  const noAuditYet = isError || !audit || !("findings" in (audit as object));

  return (
    <div className="space-y-6 p-1">
      <ProjectAutoFixSection projectId={projectId} onNavigateToFile={onNavigateToFile} />

      <ChecksSection
        projectId={projectId}
        isMobile={isMobile}
        onSecurityReview={() => {
          void queryClient.invalidateQueries({ queryKey: getGetCheckRunsQueryKey(projectId) });
        }}
        onSendMessage={onSendMessage}
        onNavigateToFile={onNavigateToFile}
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

        <CvePatchSection projectId={projectId} />

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
                  <PrivacySection projectId={projectId} onFix={handleFix} />
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
