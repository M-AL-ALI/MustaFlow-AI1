import { useState, useCallback } from "react";
import {
  useGetAccountSecurityFindings,
  useGetSecurityBadgeCount,
  getGetAccountSecurityFindingsQueryKey,
  getGetSecurityBadgeCountQueryKey,
} from "@workspace/api-client-react";
import type { AccountSecurityFinding } from "@workspace/api-client-react";
import { Link } from "wouter";
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  ShieldCheck,
  RefreshCw,
  ShieldAlert,
  AlertTriangle,
  Globe,
  ExternalLink,
  FileCode2,
  Clock,
  Wrench,
} from "lucide-react";
import { buildFixPrompt } from "./projects/components/security-tab";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type CheckStatus = "pass" | "partial" | "fail" | "setup-required";
type Severity = "critical" | "high" | "medium" | "low" | "info";
type FindingStatus = "open" | "dismissed" | "fixed";

interface LaunchCheck {
  id: string;
  label: string;
  status: CheckStatus;
  message?: string;
  severity?: string;
}

interface LaunchReadiness {
  canPublish: boolean;
  checks: LaunchCheck[];
}

const SEVERITY_CONFIG: Record<
  Severity,
  { label: string; color: string; bg: string; border: string; dot: string }
> = {
  critical: {
    label: "Critical",
    color: "text-red-500",
    bg: "bg-red-500/10",
    border: "border-red-500/30",
    dot: "bg-red-500",
  },
  high: {
    label: "High",
    color: "text-orange-500",
    bg: "bg-orange-500/10",
    border: "border-orange-500/30",
    dot: "bg-orange-500",
  },
  medium: {
    label: "Medium",
    color: "text-yellow-500",
    bg: "bg-yellow-500/10",
    border: "border-yellow-500/30",
    dot: "bg-yellow-500",
  },
  low: {
    label: "Low",
    color: "text-blue-400",
    bg: "bg-blue-400/10",
    border: "border-blue-400/30",
    dot: "bg-blue-400",
  },
  info: {
    label: "Info",
    color: "text-muted-foreground",
    bg: "bg-muted/50",
    border: "border-border",
    dot: "bg-muted-foreground",
  },
};

const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

function SeverityBadge({ severity }: { severity: Severity }) {
  const cfg = SEVERITY_CONFIG[severity] ?? SEVERITY_CONFIG.info;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded border uppercase tracking-wide shrink-0",
        cfg.bg,
        cfg.border,
        cfg.color,
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full shrink-0", cfg.dot)} />
      {cfg.label}
    </span>
  );
}

function StatusIcon({ status }: { status: CheckStatus }) {
  if (status === "pass") return <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />;
  if (status === "partial" || status === "setup-required")
    return <AlertCircle className="h-4 w-4 text-yellow-500 shrink-0" />;
  return <XCircle className="h-4 w-4 text-destructive shrink-0" />;
}

function StatusLabel({ status }: { status: CheckStatus }) {
  const map: Record<CheckStatus, { label: string; className: string }> = {
    pass: { label: "Pass", className: "text-green-500" },
    partial: { label: "Partial", className: "text-yellow-500" },
    fail: { label: "Fail", className: "text-destructive" },
    "setup-required": { label: "Setup required", className: "text-yellow-500" },
  };
  const { label, className } = map[status];
  return <span className={`text-xs font-semibold ${className}`}>{label}</span>;
}

const PLATFORM_CHECKS: LaunchCheck[] = [
  {
    id: "clerk_auth",
    label: "Clerk authentication active",
    status: "pass",
    message: "Your session is secured by Clerk. Cookie-based auth — no tokens exposed.",
  },
  {
    id: "aes_encryption",
    label: "AES-256-GCM encryption active",
    status: "pass",
    message: "All project secrets are encrypted at rest before being stored in the database.",
  },
  {
    id: "secret_masking",
    label: "Secret value masking",
    status: "pass",
    message:
      "Secret values are never returned by the API — only a masked preview (e.g. ••••••••abcd) is shown.",
  },
  {
    id: "rate_limits",
    label: "API rate limiting active",
    status: "pass",
    message: "AI builder: 10 req/min. Publish/export: 5 req/min. Global: 300 req/15 min.",
  },
  {
    id: "sandbox_preview",
    label: "Preview sandbox isolation",
    status: "pass",
    message:
      "Generated app previews run in a sandboxed iframe (allow-scripts allow-forms allow-popups). allow-same-origin is removed.",
  },
  {
    id: "soft_delete",
    label: "Soft-delete data protection",
    status: "pass",
    message:
      "Deleted projects are soft-deleted (deleted_at set). Data is never hard-deleted automatically.",
  },
];

function relativeTime(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function FindingRow({ finding }: { finding: AccountSecurityFinding }) {
  const isOpen = finding.status === "open";
  const fixPrompt = buildFixPrompt(finding);
  const fixHref = `/projects/${finding.projectId}?tab=security&fixPrompt=${encodeURIComponent(
    fixPrompt,
  )}`;
  return (
    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/20 transition-colors">
      <SeverityBadge severity={finding.severity as Severity} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            {finding.checkType}
          </span>
          {finding.status === "fixed" && (
            <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded">
              Fixed
            </span>
          )}
        </div>
        <p className="text-sm text-foreground mt-0.5">{finding.message}</p>
        {finding.file && (
          <p className="text-[10px] text-muted-foreground font-mono mt-0.5 flex items-center gap-1">
            <FileCode2 className="h-2.5 w-2.5 shrink-0" />
            {finding.file}
            {finding.line ? `:${finding.line}` : ""}
          </p>
        )}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          <Link href={`/projects/${finding.projectId}?tab=security`}>
            <span className="text-[10px] text-primary hover:underline cursor-pointer flex items-center gap-0.5">
              {finding.projectName}
              {finding.isPublished && <Globe className="h-2.5 w-2.5 ml-0.5 text-green-400" />}
              <ExternalLink className="h-2.5 w-2.5 ml-0.5" />
            </span>
          </Link>
          <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
            <Clock className="h-2.5 w-2.5" />
            {relativeTime(finding.lastSeenAt as unknown as string)}
          </span>
        </div>
      </div>
      {isOpen && (
        <Link href={fixHref}>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px] gap-1.5 shrink-0"
            title="Open this project's Security tab with a fix prompt pre-filled in the AI builder chat"
          >
            <Wrench className="h-3 w-3" />
            Fix
          </Button>
        </Link>
      )}
    </div>
  );
}

function SummaryBar({
  summary,
}: {
  summary: { critical: number; high: number; medium: number; low: number; info: number };
}) {
  const total = Object.values(summary).reduce((a, b) => a + b, 0);
  const hasCriticalOrHigh = summary.critical > 0 || summary.high > 0;

  if (total === 0) {
    return (
      <div className="flex items-center gap-3 p-4 rounded-xl border border-green-500/20 bg-green-500/5">
        <ShieldCheck className="h-5 w-5 text-green-400 shrink-0" />
        <div>
          <p className="text-sm font-semibold text-green-400">No open security findings</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            All your projects are clean across all security checks.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex items-start gap-4 p-4 rounded-xl border flex-wrap",
        hasCriticalOrHigh
          ? "border-red-500/20 bg-red-500/5"
          : "border-yellow-500/20 bg-yellow-500/5",
      )}
    >
      {hasCriticalOrHigh ? (
        <ShieldAlert className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
      ) : (
        <AlertTriangle className="h-5 w-5 text-yellow-400 shrink-0 mt-0.5" />
      )}
      <div className="flex-1">
        <p className="text-sm font-semibold text-foreground">
          {total} open finding{total !== 1 ? "s" : ""} across all projects
        </p>
        <div className="flex items-center gap-3 mt-1 flex-wrap">
          {SEVERITY_ORDER.map((sev) => {
            const count = summary[sev];
            if (count === 0) return null;
            const cfg = SEVERITY_CONFIG[sev];
            return (
              <span key={sev} className={cn("text-xs font-semibold", cfg.color)}>
                {cfg.label} {count}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function SecurityPage() {
  const queryClient = useQueryClient();
  const [readiness, setReadiness] = useState<LaunchReadiness | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [statusFilter, setStatusFilter] = useState<FindingStatus>("open");

  const params = { status: statusFilter };
  const {
    data: findingsData,
    isLoading: findingsLoading,
    isError: findingsError,
  } = useGetAccountSecurityFindings(params, {
    query: {
      queryKey: getGetAccountSecurityFindingsQueryKey(params),
      refetchInterval: 60000,
    },
  });

  const { data: badgeData } = useGetSecurityBadgeCount({
    query: { queryKey: getGetSecurityBadgeCountQueryKey(), refetchInterval: 60000 },
  });

  const load = useCallback(async () => {
    try {
      const [meRes, readinessRes] = await Promise.all([
        fetch("/api/admin/me"),
        fetch("/api/admin/launch-readiness"),
      ]);
      if (meRes.ok) {
        const me = (await meRes.json()) as { isAdmin: boolean };
        setIsAdmin(me.isAdmin);
      }
      if (readinessRes.ok) {
        setReadiness((await readinessRes.json()) as LaunchReadiness);
      }
    } catch {
      /* non-admin */
    }
  }, []);

  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getGetAccountSecurityFindingsQueryKey(params),
    });
    void load();
  };

  const findings = findingsData?.findings ?? [];
  const summary = findingsData?.summary ?? { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

  const critHighCount = badgeData?.count ?? 0;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold text-foreground">Security Center</h1>
            {critHighCount > 0 && (
              <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">
                {critHighCount} critical/high
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Persistent security findings across all your projects, sorted by exposure.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={handleRefresh} disabled={findingsLoading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${findingsLoading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Summary bar */}
      {!findingsLoading && !findingsError && statusFilter === "open" && (
        <SummaryBar summary={summary} />
      )}

      {/* Cross-project findings */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold text-foreground">Project Findings</h2>
            <span className="text-xs text-muted-foreground">Published projects appear first</span>
          </div>
          <div className="flex items-center gap-1 bg-muted/60 rounded-lg p-0.5">
            {(["open", "dismissed", "fixed"] as FindingStatus[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={cn(
                  "text-xs font-medium px-2.5 py-1 rounded-md transition-colors capitalize",
                  statusFilter === s
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {findingsLoading && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin mx-auto mb-2" />
            Loading findings…
          </div>
        )}

        {findingsError && (
          <div className="p-8 text-center text-sm text-muted-foreground">
            Failed to load findings. Try refreshing.
          </div>
        )}

        {!findingsLoading && !findingsError && findings.length === 0 && (
          <div className="p-8 text-center space-y-2">
            <ShieldCheck className="h-8 w-8 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              {statusFilter === "open"
                ? "No open findings across your projects."
                : statusFilter === "dismissed"
                  ? "No dismissed findings."
                  : "No fixed findings yet."}
            </p>
            {statusFilter === "open" && (
              <p className="text-xs text-muted-foreground">
                Build a project and run security checks to see persistent findings here.
              </p>
            )}
          </div>
        )}

        {!findingsLoading && !findingsError && findings.length > 0 && (
          <div className="divide-y divide-border">
            {findings.map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </div>
        )}
      </div>

      {/* Platform security checks */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">Platform Security</h2>
        </div>
        <div className="divide-y divide-border">
          {PLATFORM_CHECKS.map((check) => (
            <div key={check.id} className="flex items-start gap-3 px-4 py-3">
              <StatusIcon status={check.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-4">
                  <span className="text-sm font-medium text-foreground">{check.label}</span>
                  <StatusLabel status={check.status} />
                </div>
                {check.message && (
                  <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Admin launch-readiness */}
      {isAdmin && readiness && (
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-foreground">Launch Readiness</h2>
            {readiness.canPublish ? (
              <span className="text-xs text-green-500 font-semibold flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" /> Production ready
              </span>
            ) : (
              <span className="text-xs text-destructive font-semibold flex items-center gap-1.5">
                <XCircle className="h-3.5 w-3.5" /> Blocking issues present
              </span>
            )}
          </div>
          <div className="divide-y divide-border">
            {readiness.checks.map((check) => (
              <div key={check.id} className="flex items-start gap-3 px-4 py-3">
                <StatusIcon status={check.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-sm font-medium text-foreground">{check.label}</span>
                    <div className="flex items-center gap-2 shrink-0">
                      {check.severity === "blocking" && (
                        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                          blocking
                        </span>
                      )}
                      <StatusLabel status={check.status} />
                    </div>
                  </div>
                  {check.message && (
                    <p className="text-xs text-muted-foreground mt-0.5">{check.message}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-sm font-semibold text-foreground mb-2">Admin Launch Readiness</h2>
          <p className="text-sm text-muted-foreground">
            Full launch readiness checks (Stripe, Cloudflare, encryption key, admin RBAC, etc.) are
            visible in the Admin dashboard. Contact your platform administrator for access.
          </p>
        </div>
      )}
    </div>
  );
}
