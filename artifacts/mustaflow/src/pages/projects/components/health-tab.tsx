import { useState } from "react";
import {
  Activity,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Clock,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useGetProjectHealth, type ProjectHealthWindow } from "@workspace/api-client-react";

type Window = "24h" | "7d" | "30d";

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function LatencyRow({ label, value }: { label: string; value: number | null | undefined }) {
  const ok = value != null && value < 5000;
  return (
    <div className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "text-xs font-mono font-medium",
          ok ? "text-green-400" : value != null ? "text-yellow-400" : "text-muted-foreground",
        )}
      >
        {formatMs(value)}
      </span>
    </div>
  );
}

function MetricCard({
  label,
  value,
  subvalue,
  accent,
}: {
  label: string;
  value: string;
  subvalue?: string;
  accent?: "green" | "yellow" | "red";
}) {
  const color = {
    green: "text-green-400",
    yellow: "text-yellow-400",
    red: "text-red-400",
  }[accent ?? "green"];

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={cn("text-xl font-bold font-mono", color)}>{value}</p>
      {subvalue && <p className="text-xs text-muted-foreground mt-0.5">{subvalue}</p>}
    </div>
  );
}

export function HealthTab({ projectId }: { projectId: number }) {
  const { data, isLoading, error, refetch } = useGetProjectHealth(projectId);
  const [window, setWindow] = useState<Window>("24h");

  const wm: ProjectHealthWindow | undefined = data?.windows.find((w) => w.window === window);

  const successAccent = !wm
    ? "green"
    : wm.tasks.successRate >= 95
      ? "green"
      : wm.tasks.successRate >= 80
        ? "yellow"
        : "red";

  const WINDOWS: Window[] = ["24h", "7d", "30d"];

  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : "Failed to load health data"
    : null;

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-medium text-foreground">Project Health</h2>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-md border border-border overflow-hidden">
            {WINDOWS.map((w) => (
              <button
                key={w}
                onClick={() => setWindow(w)}
                className={cn(
                  "px-3 py-1 text-xs font-medium transition-colors",
                  window === w
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted",
                )}
              >
                {w}
              </button>
            ))}
          </div>
          <button
            onClick={() => void refetch()}
            disabled={isLoading}
            className="p-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
          </button>
        </div>
      </div>

      {errorMessage && (
        <div className="p-3 rounded-lg border bg-red-500/10 border-red-500/20 text-red-400 text-xs">
          {errorMessage}
        </div>
      )}

      {isLoading && !data && (
        <div className="flex items-center justify-center py-16">
          <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
        </div>
      )}

      {wm && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <MetricCard
              label="Total builds"
              value={String(wm.tasks.total)}
              subvalue={wm.windowLabel}
            />
            <MetricCard
              label="Success rate"
              value={`${wm.tasks.successRate}%`}
              subvalue={`${wm.tasks.succeeded} succeeded`}
              accent={successAccent}
            />
            <MetricCard
              label="Failed builds"
              value={String(wm.tasks.failed)}
              accent={wm.tasks.failed > 0 ? "red" : "green"}
            />
            <MetricCard
              label="Deploys"
              value={String(wm.deployments.published)}
              subvalue={`${wm.deployments.unpublished} unpublished`}
            />
          </div>

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Clock className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-medium text-foreground">Build Latency</h3>
            </div>
            <LatencyRow label="Average" value={wm.tasks.avgDurationMs} />
            <LatencyRow label="p50 (median)" value={wm.tasks.p50DurationMs} />
            <LatencyRow label="p95" value={wm.tasks.p95DurationMs} />
            <LatencyRow label="p99" value={wm.tasks.p99DurationMs} />
          </div>

          {data && data.recentIncidents.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-4">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="h-3.5 w-3.5 text-yellow-400" />
                <h3 className="text-xs font-medium text-foreground">Recent Incidents</h3>
              </div>
              <div className="space-y-2">
                {data.recentIncidents.slice(0, 10).map((inc, i) => (
                  <div key={i} className="flex items-start gap-2.5">
                    <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <p className="text-xs text-foreground truncate">{inc.message}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {new Date(inc.at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data && data.recentIncidents.length === 0 && (
            <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4 flex items-center gap-3">
              <CheckCircle2 className="h-4 w-4 text-green-400 shrink-0" />
              <p className="text-sm text-green-300">No recent incidents — all builds succeeded.</p>
            </div>
          )}

          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center gap-2 mb-3">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              <h3 className="text-xs font-medium text-foreground">SLO Targets</h3>
            </div>
            <div className="space-y-2">
              {[
                { label: "Availability", target: "≥ 99.5%", ok: wm.tasks.successRate >= 99.5 },
                {
                  label: "AI job failure rate",
                  target: "< 1%",
                  ok: wm.tasks.failed / Math.max(wm.tasks.total, 1) < 0.01,
                },
                {
                  label: "p95 build latency",
                  target: "< 5s",
                  ok: (wm.tasks.p95DurationMs ?? 0) < 5000,
                },
              ].map((slo) => (
                <div
                  key={slo.label}
                  className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0"
                >
                  <span className="text-xs text-muted-foreground">{slo.label}</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground">{slo.target}</span>
                    {slo.ok ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-green-400" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-400" />
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <p className="text-xs text-muted-foreground text-center">
            Generated {new Date(data?.generatedAt ?? "").toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}
