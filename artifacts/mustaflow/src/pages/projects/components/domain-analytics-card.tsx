/**
 * DomainAnalyticsCard — shows Cloudflare + Postgres traffic metrics for a domain.
 * Used inside the Publishing tab Domains section.
 */
import { authFetch } from "@/lib/api-fetch";
import { useState, useCallback, useEffect } from "react";
import {
  BarChart2,
  Globe,
  Activity,
  TrendingUp,
  RefreshCw,
  Clock,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type Window = "24h" | "7d" | "30d";

interface AnalyticsData {
  domain: { hostname: string };
  window: Window;
  pg: {
    serveRequests: number | string;
    uniqueDates: number | string;
  };
  cf: null | {
    totalRequests: number;
    totalBytes: number;
    errorRate: number;
    topCountries: { code: string; requests: number }[];
    cachedRequests: number;
  };
}

function MetricCard({
  label,
  value,
  icon: Icon,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ElementType;
  sub?: string;
}) {
  return (
    <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-1">
      <div className="flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">{label}</span>
      </div>
      <div className="text-lg font-semibold text-foreground">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatNum(n: number | string): string {
  const num = typeof n === "string" ? parseInt(n, 10) : n;
  if (isNaN(num)) return "0";
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}K`;
  return String(num);
}

export function DomainAnalyticsCard({
  projectId,
  domainId,
  hostname,
}: {
  projectId: number;
  domainId: number;
  hostname: string;
}) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [window, setWindow] = useState<Window>("24h");
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await authFetch(
        `/api/projects/${projectId}/domains/${domainId}/analytics?window=${window}`,
      );
      if (!r.ok) {
        const d = (await r.json()) as { error?: string };
        setError(d.error ?? "Failed to load analytics");
        return;
      }
      const d = (await r.json()) as AnalyticsData;
      setData(d);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }, [projectId, domainId, window]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center gap-2 px-3 py-2.5 bg-muted/10 hover:bg-muted/20 transition-colors text-left"
      >
        <Activity className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Traffic analytics</span>
        <span className="text-[11px] text-muted-foreground">{hostname}</span>
        <span className="ml-auto text-[11px] text-muted-foreground">{open ? "Hide" : "Show"}</span>
      </button>

      {open && (
        <div className="p-3 space-y-3 bg-background">
          {/* Window selector */}
          <div className="flex items-center gap-1">
            {(["24h", "7d", "30d"] as Window[]).map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => {
                  setWindow(w);
                }}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded border transition-colors",
                  window === w
                    ? "bg-primary/10 border-primary/40 text-primary"
                    : "bg-muted/30 border-border text-muted-foreground hover:bg-muted/50",
                )}
              >
                {w === "24h" ? "Last 24h" : w === "7d" ? "Last 7 days" : "Last 30 days"}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void load()}
              disabled={loading}
              className="ml-auto p-1 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            </button>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-xs text-destructive bg-destructive/10 rounded-lg px-3 py-2">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {loading && !data && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4 justify-center">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Loading analytics…
            </div>
          )}

          {data && (
            <>
              {/* Postgres metrics (always available) */}
              <div>
                <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider">
                  Platform metrics
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <MetricCard
                    label="Serve requests"
                    value={formatNum(data.pg.serveRequests)}
                    icon={Globe}
                    sub="via custom domain"
                  />
                  <MetricCard
                    label="Active days"
                    value={String(data.pg.uniqueDates)}
                    icon={Clock}
                    sub={`in last ${window}`}
                  />
                </div>
              </div>

              {/* Cloudflare metrics */}
              {data.cf ? (
                <div>
                  <p className="text-[10px] text-muted-foreground mb-2 uppercase tracking-wider">
                    Cloudflare metrics
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <MetricCard
                      label="Total requests"
                      value={formatNum(data.cf.totalRequests)}
                      icon={BarChart2}
                    />
                    <MetricCard
                      label="Bandwidth"
                      value={formatBytes(data.cf.totalBytes)}
                      icon={TrendingUp}
                    />
                    <MetricCard
                      label="Error rate"
                      value={`${(data.cf.errorRate * 100).toFixed(1)}%`}
                      icon={AlertTriangle}
                    />
                    <MetricCard
                      label="Cache rate"
                      value={
                        data.cf.totalRequests > 0
                          ? `${((data.cf.cachedRequests / data.cf.totalRequests) * 100).toFixed(0)}%`
                          : "—"
                      }
                      icon={Activity}
                    />
                  </div>
                  {data.cf.topCountries.length > 0 && (
                    <div className="mt-2 rounded-lg border border-border overflow-hidden text-xs">
                      <div className="px-3 py-1.5 bg-muted/30 text-[10px] text-muted-foreground uppercase tracking-wider">
                        Top countries
                      </div>
                      {data.cf.topCountries.slice(0, 5).map((c) => (
                        <div
                          key={c.code}
                          className="flex items-center gap-3 px-3 py-1.5 border-t border-border/50"
                        >
                          <span className="font-mono text-foreground w-8">{c.code}</span>
                          <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
                            <div
                              className="h-full bg-primary rounded-full"
                              style={{
                                width: `${Math.round((c.requests / (data.cf?.topCountries[0]?.requests ?? 1)) * 100)}%`,
                              }}
                            />
                          </div>
                          <span className="text-muted-foreground text-[11px] w-12 text-right">
                            {formatNum(c.requests)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-[11px] text-muted-foreground bg-muted/20 rounded-lg px-3 py-2">
                  Cloudflare analytics require CF_ZONE_ID and CF_API_TOKEN to be configured
                  server-side.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
