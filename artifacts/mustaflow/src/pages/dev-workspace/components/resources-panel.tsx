import { authFetch } from "@/lib/api-fetch";
import { useEffect, useState, useCallback, useRef } from "react";
import { Gauge, Cpu, HardDrive, MemoryStick, Loader2, RefreshCw, TrendingUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface AvailableResourceUsage {
  metricsAvailable: true;
  cpuPercent: number;
  ramMb: number;
  ramLimitMb: number;
  diskMb: number;
  diskLimitMb: number;
  status: "running" | "stopped" | "unknown";
}

interface UnavailableResourceUsage {
  metricsAvailable: false;
  reason: "runtime_not_running" | "provider_metrics_unavailable";
  cpuPercent: null;
  ramMb: null;
  ramLimitMb: null;
  diskMb: null;
  diskLimitMb: null;
  status: "running" | "stopped" | "unknown";
}

type ResourceUsage = AvailableResourceUsage | UnavailableResourceUsage;

const SPARKLINE_MAX = 30;

function Sparkline({ data, color, max }: { data: number[]; color: string; max: number }) {
  if (data.length < 2) return null;
  const width = 80;
  const height = 24;
  const pts = data.slice(-SPARKLINE_MAX);
  const step = width / (SPARKLINE_MAX - 1);
  const points = pts
    .map((v, i) => {
      const x = i * step;
      const y = height - (max > 0 ? Math.min(1, v / max) : 0) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} className="shrink-0">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity={0.7}
      />
    </svg>
  );
}

function UsageBar({
  label,
  value,
  max,
  unit,
  icon: Icon,
  color,
  sparklineData,
  sparklineColor,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  sparklineData: number[];
  sparklineColor: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isHigh = pct > 80;
  const isMed = pct > 50;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-[11px] text-foreground/80 min-w-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{label}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Sparkline data={sparklineData} color={sparklineColor} max={unit === "%" ? 100 : max} />
          <span
            className={cn(
              "font-mono text-[11px] font-medium w-20 text-right",
              isHigh ? "text-red-400" : isMed ? "text-yellow-400" : "text-muted-foreground",
            )}
          >
            {unit === "%" ? `${Math.round(pct)}%` : `${Math.round(value)} / ${Math.round(max)} MB`}
          </span>
        </div>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-500", color)}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

interface ResourcesPanelProps {
  projectId: number;
  containerStatus: string;
}

export function ResourcesPanel({ projectId, containerStatus }: ResourcesPanelProps) {
  const [usage, setUsage] = useState<ResourceUsage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Sparkline history — last SPARKLINE_MAX data points
  const cpuHistory = useRef<number[]>([]);
  const ramHistory = useRef<number[]>([]);
  const diskHistory = useRef<number[]>([]);
  const [, forceRender] = useState(0);

  const fetchResources = useCallback(async () => {
    if (containerStatus !== "running") {
      setUsage(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`/api/projects/${projectId}/resources`, {
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as ResourceUsage;
        setUsage(data);
        if (data.metricsAvailable) {
          cpuHistory.current = [...cpuHistory.current, data.cpuPercent].slice(-SPARKLINE_MAX);
          ramHistory.current = [...ramHistory.current, data.ramMb].slice(-SPARKLINE_MAX);
          diskHistory.current = [...diskHistory.current, data.diskMb].slice(-SPARKLINE_MAX);
          forceRender((n) => n + 1);
        }
      } else {
        setError("Failed to load resource data");
      }
    } catch {
      setError("Could not reach resource endpoint");
    } finally {
      setLoading(false);
    }
  }, [projectId, containerStatus]);

  useEffect(() => {
    void fetchResources();
    if (containerStatus !== "running") return;
    const interval = setInterval(() => void fetchResources(), 5000);
    return () => clearInterval(interval);
  }, [fetchResources, containerStatus]);

  // Reset history when container stops
  useEffect(() => {
    if (containerStatus !== "running") {
      cpuHistory.current = [];
      ramHistory.current = [];
      diskHistory.current = [];
    }
  }, [containerStatus]);

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Resources
        </span>
        <button
          onClick={() => void fetchResources()}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3 w-3" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 p-3">
        {containerStatus !== "running" ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Gauge className="h-8 w-8 text-muted-foreground/20" />
            <div className="text-[11px] text-muted-foreground">
              Start the container to see resource usage
            </div>
          </div>
        ) : loading && !usage ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="text-[11px] text-red-400 text-center py-4">{error}</div>
        ) : usage && !usage.metricsAvailable ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
            <Gauge className="h-8 w-8 text-muted-foreground/20" />
            <div className="text-[11px] text-muted-foreground">
              Live CPU, memory, and disk measurements aren&apos;t available for this runtime yet.
            </div>
          </div>
        ) : usage && usage.metricsAvailable ? (
          <div className="space-y-6">
            <UsageBar
              label="CPU"
              value={usage.cpuPercent}
              max={100}
              unit="%"
              icon={Cpu}
              color={
                usage.cpuPercent > 80
                  ? "bg-red-500"
                  : usage.cpuPercent > 50
                    ? "bg-yellow-500"
                    : "bg-primary"
              }
              sparklineData={cpuHistory.current}
              sparklineColor={
                usage.cpuPercent > 80 ? "#ef4444" : usage.cpuPercent > 50 ? "#eab308" : "#6366f1"
              }
            />
            <UsageBar
              label="Memory"
              value={usage.ramMb}
              max={usage.ramLimitMb}
              unit="MB"
              icon={MemoryStick}
              color={
                usage.ramMb / usage.ramLimitMb > 0.8
                  ? "bg-red-500"
                  : usage.ramMb / usage.ramLimitMb > 0.5
                    ? "bg-yellow-500"
                    : "bg-blue-500"
              }
              sparklineData={ramHistory.current}
              sparklineColor={
                usage.ramMb / usage.ramLimitMb > 0.8
                  ? "#ef4444"
                  : usage.ramMb / usage.ramLimitMb > 0.5
                    ? "#eab308"
                    : "#3b82f6"
              }
            />
            <UsageBar
              label="Disk"
              value={usage.diskMb}
              max={usage.diskLimitMb}
              unit="MB"
              icon={HardDrive}
              color={
                usage.diskMb / usage.diskLimitMb > 0.8
                  ? "bg-red-500"
                  : usage.diskMb / usage.diskLimitMb > 0.5
                    ? "bg-yellow-500"
                    : "bg-green-500"
              }
              sparklineData={diskHistory.current}
              sparklineColor={
                usage.diskMb / usage.diskLimitMb > 0.8
                  ? "#ef4444"
                  : usage.diskMb / usage.diskLimitMb > 0.5
                    ? "#eab308"
                    : "#22c55e"
              }
            />

            <div className="pt-2 border-t border-border space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                <TrendingUp className="h-3 w-3" />
                Sparklines show the last {SPARKLINE_MAX} samples (5 s each)
              </div>
              <div className="text-[10px] text-muted-foreground">
                Live — updates every 5 seconds
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
