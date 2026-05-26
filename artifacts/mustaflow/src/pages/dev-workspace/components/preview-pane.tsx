import { useState, useRef, useEffect, useCallback } from "react";
import {
  Monitor,
  Tablet,
  Smartphone,
  RefreshCw,
  ExternalLink,
  Globe,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type DeviceFrame = "desktop" | "tablet" | "mobile";

const DEVICE_WIDTHS: Record<DeviceFrame, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

const DEVICE_ICONS: Record<DeviceFrame, React.ComponentType<{ className?: string }>> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

interface PreviewPaneProps {
  projectId: number;
  containerUrl: string | null;
  containerStatus: string;
  /** True when the project has a provisioned container (Fly.io). False for static/SPA projects. */
  hasContainer: boolean;
  previewUrl?: string | null;
  refreshTrigger?: number;
}

export function PreviewPane({
  projectId,
  containerUrl,
  containerStatus,
  hasContainer,
  previewUrl,
  refreshTrigger,
}: PreviewPaneProps) {
  const [device, setDevice] = useState<DeviceFrame>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [urlInput, setUrlInput] = useState("/");
  const [currentPath, setCurrentPath] = useState("/");
  const [pathHistory, setPathHistory] = useState<string[]>(["/"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const prevRefreshTrigger = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (refreshTrigger === undefined) return;
    if (prevRefreshTrigger.current === undefined) {
      prevRefreshTrigger.current = refreshTrigger;
      return;
    }
    if (refreshTrigger !== prevRefreshTrigger.current) {
      prevRefreshTrigger.current = refreshTrigger;
      setIframeKey((k) => k + 1);
    }
  }, [refreshTrigger]);

  const navigateTo = useCallback(
    (path: string) => {
      let p = path.trim() || "/";
      if (!p.startsWith("/")) p = `/${p}`;
      setCurrentPath(p);
      setUrlInput(p);
      setPathHistory((prev) => [...prev.slice(0, historyIndex + 1), p]);
      setHistoryIndex((i) => i + 1);
      setIframeKey((k) => k + 1);
    },
    [historyIndex],
  );

  const goBack = () => {
    if (historyIndex <= 0) return;
    const newIdx = historyIndex - 1;
    const path = pathHistory[newIdx] ?? "/";
    setHistoryIndex(newIdx);
    setCurrentPath(path);
    setUrlInput(path);
    setIframeKey((k) => k + 1);
  };

  const goForward = () => {
    if (historyIndex >= pathHistory.length - 1) return;
    const newIdx = historyIndex + 1;
    const path = pathHistory[newIdx] ?? "/";
    setHistoryIndex(newIdx);
    setCurrentPath(path);
    setUrlInput(path);
    setIframeKey((k) => k + 1);
  };

  const iframeSrc = (() => {
    if (containerUrl) {
      return currentPath === "/" ? containerUrl : `${containerUrl}${currentPath}`;
    }
    if (previewUrl) {
      return currentPath === "/" ? previewUrl : `${previewUrl}${currentPath}`;
    }
    return `/api/projects/${projectId}/preview${currentPath}`;
  })();

  return (
    <div className="flex flex-col h-full min-h-0 bg-zinc-900">
      {/* Simulated browser bar */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-border bg-zinc-950 shrink-0">
        {/* Device selector */}
        <div className="flex items-center gap-0.5 mr-1">
          {(["desktop", "tablet", "mobile"] as DeviceFrame[]).map((d) => {
            const Icon = DEVICE_ICONS[d];
            return (
              <Tooltip key={d}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setDevice(d)}
                    className={cn(
                      "flex items-center justify-center h-6 w-6 rounded transition-colors",
                      device === d
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {d.charAt(0).toUpperCase() + d.slice(1)} ({DEVICE_WIDTHS[d]})
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <div className="w-px h-4 bg-border mx-0.5 shrink-0" />

        {/* Nav buttons */}
        <button
          onClick={goBack}
          disabled={historyIndex <= 0}
          className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={goForward}
          disabled={historyIndex >= pathHistory.length - 1}
          className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 transition-colors"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </button>

        {/* URL bar */}
        <div className="flex-1 flex items-center gap-1.5 bg-muted/40 border border-border/50 rounded px-2 py-0.5 min-w-0">
          <Globe className="h-3 w-3 text-muted-foreground/50 shrink-0" />
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigateTo(urlInput);
            }}
            className="flex-1 min-w-0 bg-transparent text-[11px] text-foreground outline-none font-mono"
            spellCheck={false}
          />
        </div>

        <button
          onClick={() => setIframeKey((k) => k + 1)}
          className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Refresh"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>

        <a
          href={iframeSrc}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center h-6 w-6 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Open in new tab"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      </div>

      {/* Preview area */}
      <div className="flex-1 min-h-0 overflow-auto bg-zinc-800 flex items-start justify-center pt-0">
        {hasContainer && (containerStatus === "stopped" || containerStatus === "hibernated") ? (
          <div className="flex flex-col items-center justify-center h-full w-full gap-3 text-center p-6">
            <div className="w-12 h-12 rounded-xl bg-muted border border-border flex items-center justify-center">
              <Globe className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground mb-1">Container not running</div>
              <div className="text-xs text-muted-foreground">
                Start the container to see a live preview
              </div>
            </div>
          </div>
        ) : (
          <div
            style={{
              width: device === "desktop" ? "100%" : DEVICE_WIDTHS[device],
              height: "100%",
              minHeight: "100%",
              transition: "width 0.2s ease",
              flexShrink: 0,
            }}
          >
            <iframe
              key={iframeKey}
              src={iframeSrc}
              className="w-full h-full border-0"
              sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
              title="Live Preview"
            />
          </div>
        )}
      </div>
    </div>
  );
}
