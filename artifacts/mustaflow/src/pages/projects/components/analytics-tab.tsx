import { useEffect, useState, useCallback } from "react";
import {
  BarChart3,
  Globe,
  Calendar,
  RefreshCw,
  Users,
  TrendingUp,
  ExternalLink,
} from "lucide-react";
import type { Project } from "@workspace/api-client-react";

type Deployment = {
  id: number;
  env: string;
  status: string;
  publicUrl: string | null;
  filesCount: number | null;
  createdAt: string;
};

type AnalyticsSummary = {
  totalViews: number;
  uniqueVisitors: number;
  topReferrers: Array<{ referrer: string | null; count: number }>;
  dailyTrend: Array<{ day: string; count: number }>;
  windowDays: number;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDay(day: string) {
  return new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function MiniBarChart({ data }: { data: Array<{ day: string; count: number }> }) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.count), 1);
  const last14 = data.slice(-14);
  return (
    <div className="flex items-end gap-px h-12">
      {last14.map((d) => {
        const pct = Math.max((d.count / max) * 100, 2);
        return (
          <div
            key={d.day}
            title={`${formatDay(d.day)}: ${d.count} view${d.count !== 1 ? "s" : ""}`}
            className="flex-1 bg-primary/60 rounded-sm hover:bg-primary transition-colors cursor-default"
            style={{ height: `${pct}%` }}
          />
        );
      })}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2 text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span className="text-xs font-medium">{label}</span>
      </div>
      <div className="text-2xl font-bold">{value}</div>
      {sub && <div className="text-[11px] text-muted-foreground/60 mt-1">{sub}</div>}
    </div>
  );
}

export function AnalyticsTab({ project }: { project: Project }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isPublished = project.status === "published";

  const load = useCallback(async () => {
    if (!isPublished) return;
    setLoading(true);
    setError(null);
    try {
      const [deployRes, analyticsRes] = await Promise.all([
        fetch(`/api/projects/${project.id}/deployments`),
        fetch(`/api/projects/${project.id}/analytics/summary`),
      ]);
      if (deployRes.ok) {
        const data = (await deployRes.json()) as { deployments: Deployment[] };
        setDeployments(data.deployments);
      }
      if (analyticsRes.ok) {
        const data = (await analyticsRes.json()) as AnalyticsSummary;
        setAnalytics(data);
      }
    } catch {
      setError("Could not load analytics data.");
    } finally {
      setLoading(false);
    }
  }, [project.id, isPublished]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!isPublished) {
    return (
      <div className="p-6 h-full overflow-y-auto flex items-center justify-center">
        <div className="text-center space-y-3 max-w-sm">
          <BarChart3 className="h-10 w-10 mx-auto text-muted-foreground/30" />
          <div>
            <p className="text-sm font-medium text-foreground">No analytics yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Publish your app to start tracking page views and visitors. Analytics data updates
              automatically as users visit your published app.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const publishCount = deployments.filter((d) => d.status === "passed").length;
  const lastPublish = deployments.find((d) => d.status === "passed");
  const trendTotal = analytics?.dailyTrend.reduce((s, d) => s + d.count, 0) ?? 0;

  return (
    <div className="p-6 h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold mb-1">Analytics</h2>
            <p className="text-sm text-muted-foreground">
              Last 30 days · Page views tracked automatically on your published app.
            </p>
          </div>
          <button
            onClick={() => void load()}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="text-xs text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <StatCard
            icon={BarChart3}
            label="Page Views"
            value={analytics?.totalViews ?? 0}
            sub="Last 30 days"
          />
          <StatCard
            icon={Users}
            label="Unique Visitors"
            value={analytics?.uniqueVisitors ?? 0}
            sub="Sessions (30d)"
          />
          <StatCard
            icon={Globe}
            label="Total Publishes"
            value={publishCount}
            sub="Times published"
          />
          <StatCard
            icon={Calendar}
            label="Last Published"
            value={
              lastPublish
                ? new Date(lastPublish.createdAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })
                : "—"
            }
            sub={lastPublish ? formatDate(lastPublish.createdAt) : "No publish yet"}
          />
        </div>

        {/* Daily trend chart */}
        {analytics && analytics.dailyTrend.length > 0 && (
          <div className="bg-card border border-border rounded-xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 text-muted-foreground">
                <TrendingUp className="h-4 w-4" />
                <span className="text-xs font-medium">Daily Views (last 14 days)</span>
              </div>
              <span className="text-xs text-muted-foreground">{trendTotal} total</span>
            </div>
            <MiniBarChart data={analytics.dailyTrend} />
            <div className="flex justify-between mt-1 text-[10px] text-muted-foreground/50">
              {analytics.dailyTrend.length > 0 && (
                <>
                  <span>{formatDay(analytics.dailyTrend[0]?.day ?? "")}</span>
                  <span>
                    {formatDay(analytics.dailyTrend[analytics.dailyTrend.length - 1]?.day ?? "")}
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        {/* Top referrers */}
        {analytics && analytics.topReferrers.length > 0 && (
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center gap-2">
              <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-semibold">Top Referrers</span>
            </div>
            <div className="divide-y divide-border">
              {analytics.topReferrers.map((r, i) => {
                const maxCount = analytics.topReferrers[0]?.count ?? 1;
                const pct = Math.round((r.count / maxCount) * 100);
                return (
                  <div key={i} className="px-4 py-2.5 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-mono truncate text-foreground">
                        {r.referrer ?? "(direct)"}
                      </div>
                      <div className="mt-1 h-1 bg-muted rounded-full overflow-hidden">
                        <div
                          className="h-full bg-primary/50 rounded-full"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0 font-medium">
                      {r.count}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Deployment history */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-muted/50 flex items-center justify-between">
            <span className="text-xs font-semibold">Deployment History</span>
            <span className="text-xs text-muted-foreground">{deployments.length} events</span>
          </div>
          {loading && deployments.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground animate-pulse">
              Loading…
            </div>
          ) : deployments.length === 0 ? (
            <div className="p-6 text-center text-xs text-muted-foreground">
              No deployment events yet.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {deployments.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center gap-3">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 ${
                      d.status === "passed"
                        ? "bg-green-500/10 text-green-400"
                        : d.status === "unpublished"
                          ? "bg-muted text-muted-foreground"
                          : "bg-blue-500/10 text-blue-400"
                    }`}
                  >
                    {d.status}
                  </span>
                  <span className="text-xs text-muted-foreground capitalize shrink-0">{d.env}</span>
                  {d.publicUrl && (
                    <a
                      href={d.publicUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] font-mono text-primary/80 hover:text-primary truncate"
                    >
                      {d.publicUrl}
                    </a>
                  )}
                  <span className="ml-auto text-[11px] text-muted-foreground/60 whitespace-nowrap shrink-0">
                    {formatDate(d.createdAt)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-[11px] text-muted-foreground/50 text-center">
          Page view tracking is automatically injected into your published app. No extra setup
          needed.
        </p>
      </div>
    </div>
  );
}
