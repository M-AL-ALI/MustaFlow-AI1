import { useEffect, useState, useCallback } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  RefreshCw,
  Activity,
  Shield,
  Server,
  Cpu,
  Boxes,
  CreditCard,
  Database,
  Eye,
  Rocket,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";

interface ComponentHealth {
  name: string;
  status: ComponentStatus;
  latencyMs?: number;
  message?: string;
}

interface StatusData {
  status: "operational" | "degraded" | "outage";
  checkedAt: string;
  components: ComponentHealth[];
  slos: {
    availability: { target: number; description: string };
    aiJobFailureRate: { target: number; description: string };
    p95ChatResponse: { targetMs: number; description: string };
  };
}

const STATUS_ICONS: Record<ComponentStatus, React.ElementType> = {
  operational: CheckCircle2,
  degraded: AlertTriangle,
  outage: XCircle,
  unknown: AlertTriangle,
};

const STATUS_COLORS: Record<ComponentStatus, string> = {
  operational: "text-green-400",
  degraded: "text-yellow-400",
  outage: "text-red-400",
  unknown: "text-muted-foreground",
};

const COMPONENT_ICONS: Record<string, React.ElementType> = {
  API: Server,
  Database: Database,
  "AI Builder": Cpu,
  Containers: Boxes,
  Payments: CreditCard,
  Queue: Activity,
  Auth: Shield,
  Preview: Eye,
  Publishing: Rocket,
};

const OVERALL_BANNER: Record<
  string,
  { bg: string; text: string; icon: React.ElementType; label: string }
> = {
  operational: {
    bg: "bg-green-500/10 border-green-500/30",
    text: "text-green-300",
    icon: CheckCircle2,
    label: "All systems operational",
  },
  degraded: {
    bg: "bg-yellow-500/10 border-yellow-500/30",
    text: "text-yellow-300",
    icon: AlertTriangle,
    label: "Partial outage — some systems degraded",
  },
  outage: {
    bg: "bg-red-500/10 border-red-500/30",
    text: "text-red-300",
    icon: XCircle,
    label: "Service disruption detected",
  },
};

const STATUS_LABELS: Record<ComponentStatus, string> = {
  operational: "Operational",
  degraded: "Degraded",
  outage: "Outage",
  unknown: "Unknown",
};

export default function StatusPage() {
  const [data, setData] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());

  const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${basePath}/api/status`);
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = (await res.json()) as StatusData;
      setData(json);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load status");
    } finally {
      setLoading(false);
    }
  }, [basePath]);

  useEffect(() => {
    void fetchStatus();
    const interval = setInterval(() => void fetchStatus(), 60_000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const overall = data?.status ?? "unknown";
  const banner = OVERALL_BANNER[overall] ?? OVERALL_BANNER.outage;
  const BannerIcon = banner.icon;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-2xl mx-auto px-4 py-12">
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-foreground">MustaFlow Status</h1>
            <p className="text-sm text-muted-foreground mt-1">Real-time system health</p>
          </div>
          <button
            onClick={() => void fetchStatus()}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5 rounded-md border border-border hover:border-border/70"
          >
            <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            Refresh
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-lg border bg-red-500/10 border-red-500/20 text-red-400 text-sm">
            {error}
          </div>
        )}

        {data && (
          <>
            <div className={cn("mb-8 p-4 rounded-lg border flex items-center gap-3", banner.bg)}>
              <BannerIcon className={cn("h-5 w-5 shrink-0", banner.text)} />
              <div>
                <p className={cn("font-medium text-sm", banner.text)}>{banner.label}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Last checked {new Date(data.checkedAt).toLocaleTimeString()}
                </p>
              </div>
            </div>

            <div className="mb-8">
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Components
              </h2>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                {data.components.map((comp) => {
                  const Icon = COMPONENT_ICONS[comp.name] ?? Server;
                  const StatusIcon = STATUS_ICONS[comp.status] ?? AlertTriangle;
                  return (
                    <div
                      key={comp.name}
                      className="flex items-center justify-between px-4 py-3 bg-card"
                    >
                      <div className="flex items-center gap-3">
                        <Icon className="h-4 w-4 text-muted-foreground" />
                        <div>
                          <p className="text-sm font-medium text-foreground">{comp.name}</p>
                          {comp.message && (
                            <p className="text-xs text-muted-foreground">{comp.message}</p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {comp.latencyMs !== undefined && (
                          <span className="text-xs text-muted-foreground">{comp.latencyMs}ms</span>
                        )}
                        <div className="flex items-center gap-1.5">
                          <StatusIcon className={cn("h-4 w-4", STATUS_COLORS[comp.status])} />
                          <span className={cn("text-xs font-medium", STATUS_COLORS[comp.status])}>
                            {STATUS_LABELS[comp.status]}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                SLO Targets
              </h2>
              <div className="rounded-lg border border-border overflow-hidden divide-y divide-border">
                <div className="flex items-center justify-between px-4 py-3 bg-card">
                  <div>
                    <p className="text-sm font-medium text-foreground">Availability</p>
                    <p className="text-xs text-muted-foreground">
                      {data.slos.availability.description}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-green-400">
                    {data.slos.availability.target}%
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-card">
                  <div>
                    <p className="text-sm font-medium text-foreground">AI Job Failure Rate</p>
                    <p className="text-xs text-muted-foreground">
                      {data.slos.aiJobFailureRate.description}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-green-400">
                    &lt; {data.slos.aiJobFailureRate.target}%
                  </span>
                </div>
                <div className="flex items-center justify-between px-4 py-3 bg-card">
                  <div>
                    <p className="text-sm font-medium text-foreground">p95 Build Latency</p>
                    <p className="text-xs text-muted-foreground">
                      {data.slos.p95ChatResponse.description}
                    </p>
                  </div>
                  <span className="text-sm font-semibold text-green-400">
                    &lt; {data.slos.p95ChatResponse.targetMs / 1000}s
                  </span>
                </div>
              </div>
            </div>

            <p className="text-xs text-muted-foreground text-center mt-8">
              Auto-refreshes every 60 seconds &middot; Last updated{" "}
              {lastRefresh.toLocaleTimeString()}
            </p>
          </>
        )}

        {loading && !data && (
          <div className="flex items-center justify-center py-24">
            <RefreshCw className="h-6 w-6 text-muted-foreground animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
