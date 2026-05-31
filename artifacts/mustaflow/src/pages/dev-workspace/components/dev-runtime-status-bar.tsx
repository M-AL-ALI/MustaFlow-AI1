import { CheckCircle, AlertCircle, Loader2, Server } from "lucide-react";
import { cn } from "@/lib/utils";

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

interface DevRuntimeStatusBarProps {
  containerStatus: ContainerStatus | string;
  provisioningStatus?: string | null;
  hasContainer: boolean;
}

export function DevRuntimeStatusBar({
  containerStatus,
  provisioningStatus,
  hasContainer,
}: DevRuntimeStatusBarProps) {
  if (!hasContainer) return null;

  const isProvisioning =
    provisioningStatus != null &&
    provisioningStatus !== "idle" &&
    provisioningStatus !== "ready";

  if (!isProvisioning && containerStatus === "stopped") return null;
  if (!isProvisioning && containerStatus === "hibernated") return null;

  return (
    <div className="shrink-0 flex items-center gap-2 px-3 py-1 border-b border-border bg-zinc-900/60 overflow-x-auto text-[10px]">
      <Server size={10} className="text-muted-foreground shrink-0" />

      {isProvisioning && (
        <span className="flex items-center gap-1 text-yellow-400">
          <Loader2 size={10} className="animate-spin" />
          Setting up workspace
          {provisioningStatus && <span className="opacity-60">· {provisioningStatus}</span>}
        </span>
      )}

      {!isProvisioning && containerStatus === "starting" && (
        <span className="flex items-center gap-1 text-yellow-400">
          <Loader2 size={10} className="animate-spin" />
          Container starting…
        </span>
      )}

      {!isProvisioning && containerStatus === "running" && (
        <span
          className={cn(
            "flex items-center gap-1",
            "text-green-400",
          )}
        >
          <CheckCircle size={10} />
          Container running
        </span>
      )}

      {!isProvisioning && containerStatus === "error" && (
        <span className="flex items-center gap-1 text-red-400">
          <AlertCircle size={10} />
          Container error — check logs
        </span>
      )}
    </div>
  );
}
