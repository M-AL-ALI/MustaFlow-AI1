import { useEffect, useState, useCallback } from "react";
import { Gauge, Cpu, HardDrive, MemoryStick, Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ResourceUsage {
  cpuPercent: number;
  ramMb: number;
  ramLimitMb: number;
  diskMb: number;
  diskLimitMb: number;
  status: "running" | "stopped" | "unknown";
}

function UsageBar({
  label,
  value,
  max,
  unit,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const isHigh = pct > 80;
  const isMed = pct > 50;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <div className="flex items-center gap-1.5 text-foreground/80">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
          {label}
        </div>
        <span
          className={cn(
            "font-mono font-medium",
            isHigh ? "text-red-400" : isMed ? "text-yellow-400" : "text-muted-foreground",
          )}
        >
          {unit === "%"
            ? `${Math.round(pct)}%`
            : `${Math.round(value)} / ${Math.round(max)} ${unit}`}
        </span>
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

  const fetchResources = useCallback(async () => {
    if (containerStatus !== "running") {
      setUsage(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/resources`);
      if (res.ok) {
        const data = (await res.json()) as ResourceUsage;
        setUsage(data);
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
        ) : usage ? (
          <div className="space-y-5">
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
            />

            <div className="pt-2 border-t border-border">
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
