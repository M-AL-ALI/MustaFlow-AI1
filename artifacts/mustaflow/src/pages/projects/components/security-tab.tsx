import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListSecurityFindings,
  useDismissSecurityFinding,
  getListSecurityFindingsQueryKey,
  type SecurityFinding,
} from "@workspace/api-client-react";
import {
  ShieldAlert,
  ShieldCheck,
  KeyRound,
  ScanSearch,
  Globe,
  Code2,
  Eye,
  Search,
  Zap,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Clock,
  FileCode2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type FindingStatus = "open" | "dismissed" | "fixed";

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

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

const CHECK_TYPE_META: Record<string, { label: string; Icon: React.FC<{ className?: string }> }> = {
  "secret-leak": { label: "Secret Leak", Icon: KeyRound },
  sast: { label: "SAST", Icon: ScanSearch },
  "cdn-security": { label: "CDN Security", Icon: Globe },
  "code-quality": { label: "Code Quality", Icon: Code2 },
  accessibility: { label: "Accessibility", Icon: Eye },
  seo: { label: "SEO", Icon: Search },
  performance: { label: "Performance", Icon: Zap },
  security: { label: "Security", Icon: ShieldAlert },
};

function getCheckMeta(checkType: string) {
  return CHECK_TYPE_META[checkType] ?? { label: checkType, Icon: ShieldAlert };
}

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

function FindingRow({
  finding,
  onDismiss,
  isDismissing,
}: {
  finding: SecurityFinding;
  onDismiss: (id: number) => void;
  isDismissing: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const { label, Icon } = getCheckMeta(finding.checkType);
  const isOpen = finding.status === "open";

  return (
    <div
      className={cn(
        "border rounded-md overflow-hidden text-xs transition-colors",
        isOpen ? "border-border" : "border-border/50 opacity-60",
      )}
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left p-2.5 flex items-start gap-2 hover:bg-muted/40 transition-colors"
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <SeverityBadge severity={finding.severity as Severity} />
            <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {label}
            </span>
            {finding.status === "fixed" && (
              <span className="text-[10px] text-green-400 bg-green-500/10 border border-green-500/20 px-1.5 py-0.5 rounded">
                Fixed
              </span>
            )}
            {finding.status === "dismissed" && (
              <span className="text-[10px] text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded">
                Dismissed
              </span>
            )}
          </div>
          <div className="text-foreground leading-snug mt-1 pr-2">{finding.message}</div>
          {finding.file && (
            <div className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground font-mono">
              <FileCode2 className="h-2.5 w-2.5 shrink-0" />
              {finding.file}
              {finding.line ? `:${finding.line}` : ""}
            </div>
          )}
        </div>
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 mt-0.5" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-border bg-muted/20 px-3 py-2.5 space-y-2">
          <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              First seen {relativeTime(finding.firstSeenAt as unknown as string)}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="h-2.5 w-2.5" />
              Last seen {relativeTime(finding.lastSeenAt as unknown as string)}
            </span>
          </div>
          {isOpen && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1.5"
              disabled={isDismissing}
              onClick={(e) => {
                e.stopPropagation();
                onDismiss(finding.id);
              }}
            >
              {isDismissing ? (
                <RefreshCw className="h-3 w-3 animate-spin" />
              ) : (
                <CheckCircle2 className="h-3 w-3" />
              )}
              Dismiss finding
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryBar({ findings }: { findings: SecurityFinding[] }) {
  const counts = SEVERITY_ORDER.reduce(
    (acc, s) => {
      acc[s] = findings.filter((f) => f.status === "open" && f.severity === s).length;
      return acc;
    },
    {} as Record<Severity, number>,
  );

  const hasCriticalOrHigh = counts.critical > 0 || counts.high > 0;

  return (
    <div
      className={cn(
        "flex items-center gap-2 flex-wrap p-3 rounded-lg border",
        hasCriticalOrHigh ? "bg-red-500/5 border-red-500/20" : "bg-green-500/5 border-green-500/20",
      )}
    >
      {hasCriticalOrHigh ? (
        <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
      ) : (
        <ShieldCheck className="h-4 w-4 text-green-400 shrink-0" />
      )}
      {SEVERITY_ORDER.map((sev) => {
        if (counts[sev] === 0) return null;
        const cfg = SEVERITY_CONFIG[sev];
        return (
          <span key={sev} className={cn("text-xs font-semibold", cfg.color)}>
            {cfg.label} {counts[sev]}
          </span>
        );
      })}
      {SEVERITY_ORDER.every((s) => counts[s] === 0) && (
        <span className="text-xs text-green-400 font-medium">No open findings</span>
      )}
    </div>
  );
}

type GroupedFindings = {
  checkType: string;
  findings: SecurityFinding[];
};

function groupByCheckType(findings: SecurityFinding[]): GroupedFindings[] {
  const map = new Map<string, SecurityFinding[]>();
  for (const f of findings) {
    if (!map.has(f.checkType)) map.set(f.checkType, []);
    map.get(f.checkType)!.push(f);
  }
  return Array.from(map.entries()).map(([checkType, findings]) => ({ checkType, findings }));
}

function CheckTypeGroup({
  checkType,
  findings,
  onDismiss,
  dismissingId,
}: {
  checkType: string;
  findings: SecurityFinding[];
  onDismiss: (id: number) => void;
  dismissingId: number | null;
}) {
  const [expanded, setExpanded] = useState(true);
  const { label, Icon } = getCheckMeta(checkType);
  const openCount = findings.filter((f) => f.status === "open").length;
  const hasCritical = findings.some(
    (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
  );

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-2.5 flex items-center gap-2.5 hover:bg-muted/30 transition-colors"
      >
        <Icon
          className={cn("h-4 w-4 shrink-0", hasCritical ? "text-red-400" : "text-muted-foreground")}
        />
        <span className="text-sm font-medium text-foreground flex-1">{label}</span>
        {openCount > 0 && (
          <span
            className={cn(
              "text-[10px] font-bold px-1.5 py-0.5 rounded",
              hasCritical ? "bg-red-500/15 text-red-400" : "bg-muted text-muted-foreground",
            )}
          >
            {openCount} open
          </span>
        )}
        {openCount === 0 && <span className="text-[10px] text-green-400">All resolved</span>}
        {expanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="border-t border-border p-2 space-y-1.5 bg-card/30">
          {findings.map((f) => (
            <FindingRow
              key={f.id}
              finding={f}
              onDismiss={onDismiss}
              isDismissing={dismissingId === f.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SecurityTab({ projectId }: { projectId: number }) {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<FindingStatus>("open");
  const [dismissingId, setDismissingId] = useState<number | null>(null);

  const params = { status: statusFilter };
  const {
    data: findings = [],
    isLoading,
    isError,
  } = useListSecurityFindings(projectId, params, {
    query: {
      enabled: !!projectId,
      queryKey: getListSecurityFindingsQueryKey(projectId, params),
      refetchInterval: 30000,
    },
  });

  const dismissMutation = useDismissSecurityFinding();

  const handleDismiss = (findingId: number) => {
    setDismissingId(findingId);
    dismissMutation.mutate(
      { id: projectId, findingId },
      {
        onSettled: () => {
          setDismissingId(null);
          void queryClient.invalidateQueries({
            queryKey: getListSecurityFindingsQueryKey(projectId, { status: "open" }),
          });
          void queryClient.invalidateQueries({
            queryKey: getListSecurityFindingsQueryKey(projectId, { status: "dismissed" }),
          });
        },
      },
    );
  };

  const handleRefresh = () => {
    void queryClient.invalidateQueries({
      queryKey: getListSecurityFindingsQueryKey(projectId, params),
    });
  };

  const grouped = groupByCheckType(findings);

  // Sort groups: groups with open critical/high first
  grouped.sort((a, b) => {
    const aCrit = a.findings.some(
      (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
    );
    const bCrit = b.findings.some(
      (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
    );
    if (aCrit !== bCrit) return aCrit ? -1 : 1;
    return 0;
  });

  const _dismissedFindings = statusFilter === "dismissed" ? findings : [];

  return (
    <div className="space-y-4 p-1">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground">Security Center</span>
        </div>
        <button
          onClick={handleRefresh}
          className="text-muted-foreground hover:text-foreground transition-colors p-1 rounded"
          title="Refresh findings"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1 bg-muted/40 rounded-lg p-1">
        {(["open", "dismissed", "fixed"] as FindingStatus[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "flex-1 text-xs font-medium py-1 rounded-md transition-colors capitalize",
              statusFilter === s
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="p-6 text-center text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin mx-auto mb-2" />
          Loading findings…
        </div>
      )}

      {isError && (
        <div className="p-4 text-center text-sm text-muted-foreground border border-border rounded-lg">
          Failed to load findings.
        </div>
      )}

      {!isLoading && !isError && statusFilter === "open" && (
        <>
          <SummaryBar findings={findings} />
          {grouped.length === 0 ? (
            <div className="border border-border rounded-lg p-5 text-center space-y-2">
              <ShieldCheck className="h-8 w-8 text-green-400 mx-auto" />
              <p className="text-sm text-foreground font-medium">No open security findings</p>
              <p className="text-xs text-muted-foreground">
                Build or refine your app to run security checks. Findings from all builds are
                tracked here.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {grouped.map((g) => (
                <CheckTypeGroup
                  key={g.checkType}
                  checkType={g.checkType}
                  findings={g.findings}
                  onDismiss={handleDismiss}
                  dismissingId={dismissingId}
                />
              ))}
            </div>
          )}
        </>
      )}

      {!isLoading && !isError && statusFilter === "dismissed" && (
        <>
          {findings.length === 0 ? (
            <div className="border border-border rounded-lg p-5 text-center space-y-1">
              <p className="text-sm text-muted-foreground">No dismissed findings.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {grouped.map((g) => (
                <CheckTypeGroup
                  key={g.checkType}
                  checkType={g.checkType}
                  findings={g.findings}
                  onDismiss={handleDismiss}
                  dismissingId={dismissingId}
                />
              ))}
            </div>
          )}
        </>
      )}

      {!isLoading && !isError && statusFilter === "fixed" && (
        <>
          {findings.length === 0 ? (
            <div className="border border-border rounded-lg p-5 text-center space-y-1">
              <p className="text-sm text-muted-foreground">No fixed findings yet.</p>
              <p className="text-xs text-muted-foreground">
                When a finding from a previous build no longer appears in a new build, it is
                automatically marked fixed.
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {grouped.map((g) => (
                <CheckTypeGroup
                  key={g.checkType}
                  checkType={g.checkType}
                  findings={g.findings}
                  onDismiss={handleDismiss}
                  dismissingId={dismissingId}
                />
              ))}
            </div>
          )}
        </>
      )}

      <div className="text-[10px] text-muted-foreground text-center pt-1">
        Findings are deduplicated and updated after every build · dismissed findings persist
      </div>
    </div>
  );
}

/**
 * Returns the count of open critical+high findings for the tab badge.
 * Used by the parent component to show a badge on the Security tab.
 */
export function useSecurityBadgeCount(findings: SecurityFinding[]): number {
  return findings.filter(
    (f) => f.status === "open" && (f.severity === "critical" || f.severity === "high"),
  ).length;
}
