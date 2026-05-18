import {
  Monitor,
  Smartphone,
  Tablet,
  RefreshCw,
  ExternalLink,
  Globe,
  LayoutTemplate,
  Clock,
  Zap,
  BrainCircuit,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Terminal,
  X,
  ShieldAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useListProjectFiles, getListProjectFilesQueryKey } from "@workspace/api-client-react";

type Platform = "web" | "ios" | "android";
type DeviceFrame = "desktop" | "tablet" | "mobile";

const DEVICE_ICONS: Record<DeviceFrame, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

const DEVICE_SIZES: Record<Platform, Record<DeviceFrame, { w: number | string; h: number | string }>> = {
  web: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 768, h: 1024 },
    mobile: { w: 390, h: 844 },
  },
  ios: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 820, h: 1180 },
    mobile: { w: 390, h: 844 },
  },
  android: {
    desktop: { w: "100%", h: "100%" },
    tablet: { w: 800, h: 1280 },
    mobile: { w: 360, h: 800 },
  },
};

type Project = {
  id: number;
  status: string;
  updatedAt: string;
  name?: string;
};

// ─── Security note ────────────────────────────────────────────────────────────
// The preview iframe uses sandbox="allow-scripts allow-forms allow-popups".
// allow-same-origin is intentionally OMITTED so the iframe receives a null origin
// and cannot read parent window data, cookies, localStorage, or secrets.
//
// Consequence: contentWindow access is cross-origin and will throw SecurityError.
// Console capture and health-check DOM inspection are therefore not available.
//
// TODO (multi-user launch): serve previews from a separate subdomain with
// short-lived signed URLs, or use a container-based preview system.
// This will restore full isolation AND allow opt-in postMessage console bridging.
// ─────────────────────────────────────────────────────────────────────────────

export function PreviewTab({ project }: { project: Project }) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [device, setDevice] = useState<DeviceFrame>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevStatusRef = useRef<string>(project.status);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: files, isLoading: filesLoading } = useListProjectFiles(project.id, {
    query: {
      enabled: !!project.id,
      queryKey: getListProjectFilesQueryKey(project.id),
    },
  });

  const hasFiles = (files?.length ?? 0) > 0;
  const isLoading = filesLoading && files === undefined;
  const previewSrc = `/api/projects/${project.id}/preview/?t=${iframeKey}`;

  const sizes = DEVICE_SIZES[platform][device];
  const isFullWidth = sizes.w === "100%";

  const lastUpdated = project.updatedAt
    ? new Date(project.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  // Hard refresh: force iframe remount (key change)
  const forceRefresh = useCallback(() => {
    setHealthWarning(null);
    setIframeKey((k) => k + 1);
  }, []);

  // Smooth reload: try contentWindow.location.reload() first.
  // Without allow-same-origin this will throw — falls through to key change.
  const smoothRefresh = useCallback(() => {
    setHealthWarning(null);
    try {
      const cw = iframeRef.current?.contentWindow;
      if (cw) {
        cw.location.reload();
        return;
      }
    } catch {
      // cross-origin (no allow-same-origin) — fall through to hard refresh
    }
    setIframeKey((k) => k + 1);
  }, []);

  // Auto-refresh when project transitions out of "building"
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = project.status;
    if (prev === "building" && project.status !== "building" && hasFiles) {
      setHealthWarning(null);
      setIframeKey((k) => k + 1);
    }
  }, [project.status, hasFiles]);

  const handleIframeLoad = useCallback(() => {
    setHealthWarning(null);
    if (healthTimerRef.current) clearTimeout(healthTimerRef.current);

    // Health check: without allow-same-origin, contentDocument is null.
    // We set a timer and check the iframe's load state via a secondary mechanism.
    // If the iframe src is not a 200, the browser will typically still fire onLoad,
    // so we skip the empty-body check (it would throw cross-origin anyway).
    // TODO: implement postMessage health ping from preview route once isolated domain is set up.
    healthTimerRef.current = setTimeout(() => {
      // Cross-origin check is not available without allow-same-origin.
      // Health monitoring via postMessage bridge is planned for the isolated preview domain.
    }, 3000);
  }, []);

  // Cleanup health timer on unmount
  useEffect(() => () => {
    if (healthTimerRef.current) clearTimeout(healthTimerRef.current);
  }, []);

  return (
    <div className="flex flex-col h-full bg-background">

      {/* Preview toolbar */}
      <div className="shrink-0 flex items-center gap-3 px-3 py-1.5 border-b border-border bg-card">

        {/* Platform selector */}
        <div className="flex bg-muted rounded-lg p-0.5 shrink-0">
          {(["web", "ios", "android"] as Platform[]).map((p) => (
            <button
              key={p}
              onClick={() => setPlatform(p)}
              className={cn(
                "px-3 py-1 text-[11px] font-semibold rounded-md transition-colors uppercase tracking-wide",
                platform === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Device selector */}
        <div className="flex items-center gap-0.5 bg-muted rounded-lg p-0.5 shrink-0">
          {(["desktop", "tablet", "mobile"] as DeviceFrame[]).map((d) => {
            const Icon = DEVICE_ICONS[d];
            return (
              <button
                key={d}
                onClick={() => setDevice(d)}
                title={d}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  device === d
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            );
          })}
        </div>

        <div className="w-px h-4 bg-border" />

        {/* Status badge */}
        <div className={cn(
          "flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium shrink-0",
          project.status === "building"
            ? "bg-primary/15 text-primary"
            : project.status === "published"
            ? "bg-green-500/15 text-green-500"
            : project.status === "testing"
            ? "bg-yellow-500/15 text-yellow-500"
            : project.status === "failed"
            ? "bg-destructive/15 text-destructive"
            : "bg-muted text-muted-foreground",
        )}>
          <span className={cn(
            "w-1.5 h-1.5 rounded-full",
            project.status === "building" ? "bg-primary animate-pulse" :
            project.status === "published" ? "bg-green-500" :
            project.status === "testing" ? "bg-yellow-500" :
            project.status === "failed" ? "bg-destructive" : "bg-muted-foreground",
          )} />
          {project.status}
        </div>

        {lastUpdated && (
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground shrink-0">
            <Clock className="h-3 w-3" />
            {lastUpdated}
          </div>
        )}

        <div className="flex-1" />

        {/* Sandbox notice button */}
        {hasFiles && (
          <button
            onClick={() => setConsoleOpen((o) => !o)}
            aria-label={consoleOpen ? "Close sandbox info" : "Open console panel"}
            aria-pressed={consoleOpen}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0",
              consoleOpen
                ? "bg-zinc-800 text-zinc-100"
                : "bg-muted text-muted-foreground hover:text-foreground",
            )}
            title="Console info"
          >
            <Terminal className="h-3 w-3" />
            Console
          </button>
        )}

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={smoothRefresh}
            title="Reload preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={forceRefresh}
            title="Hard refresh (full reload)"
          >
            <RefreshCw className="h-3.5 w-3.5 opacity-50" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            asChild
            title="Open preview in new tab"
          >
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </div>

      {/* Health warning banner */}
      {healthWarning && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-600 dark:text-yellow-400 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{healthWarning}</span>
          <button onClick={() => setHealthWarning(null)} className="shrink-0 hover:opacity-70 transition-opacity">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Preview area */}
      <div className="flex-1 min-h-0 bg-muted/20 overflow-auto flex items-start justify-center p-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            <span className="text-sm">Loading preview…</span>
          </div>
        ) : hasFiles ? (
          <div
            className={cn(
              "border border-border rounded-lg shadow-xl overflow-hidden bg-white flex flex-col",
              isFullWidth ? "w-full h-full" : "",
            )}
            style={!isFullWidth ? { width: sizes.w, minHeight: sizes.h, maxWidth: "100%" } : undefined}
          >
            {/* Browser / device chrome */}
            <div className="h-8 bg-zinc-100 border-b border-zinc-200/80 flex items-center px-3 gap-1.5 shrink-0">
              <span className="w-2.5 h-2.5 rounded-full bg-red-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-yellow-400" />
              <span className="w-2.5 h-2.5 rounded-full bg-green-400" />
              <div className="flex-1 mx-2 max-w-xs">
                <div className="bg-white border border-zinc-200 rounded px-2 py-0.5 text-[10px] text-zinc-500 font-mono text-center truncate">
                  {platform === "web" ? `preview/${project.id}/` : `${platform} preview/${project.id}/`}
                </div>
              </div>
              <Globe className="h-3 w-3 text-zinc-400" />
            </div>
            {/*
              SECURITY: sandbox does NOT include allow-same-origin.
              The iframe gets a null origin — it cannot read parent cookies,
              localStorage, or any app data. Cross-origin restrictions apply.
              TODO: move preview to an isolated subdomain + postMessage bridge.
            */}
            <iframe
              key={iframeKey}
              ref={iframeRef}
              src={previewSrc}
              title="App preview"
              aria-label="App preview"
              className="flex-1 w-full border-0"
              style={{ minHeight: isFullWidth ? "100%" : sizes.h }}
              sandbox="allow-scripts allow-forms allow-popups"
              onLoad={handleIframeLoad}
            />
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full max-w-md text-center gap-6 py-16">
            <div className="relative">
              <div className="w-20 h-20 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
                <LayoutTemplate className="h-10 w-10 text-primary/60" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-muted border border-border flex items-center justify-center">
                <Zap className="h-4 w-4 text-muted-foreground" />
              </div>
            </div>
            <div>
              <h3 className="text-lg font-semibold text-foreground mb-2">No preview yet</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Use the AI Builder below to describe what you want to build. MustaFlow will generate your app and show a live preview here.
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <BrainCircuit className="h-5 w-5 text-secondary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Plan Mode</div>
                  <div className="text-muted-foreground text-[11px]">Generate a detailed plan before building</div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <Zap className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Build First Draft</div>
                  <div className="text-muted-foreground text-[11px]">Generate your app immediately from a prompt</div>
                </div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground/60">
              Type your idea in the AI Builder below and press Enter or click Send
            </p>
          </div>
        )}
      </div>

      {/* Console / sandbox info panel */}
      {hasFiles && consoleOpen && (
        <div className="shrink-0 border-t border-border bg-zinc-950 flex flex-col" style={{ maxHeight: 200 }}>
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0">
            <ShieldAlert className="h-3.5 w-3.5 text-yellow-400" />
            <span className="text-[11px] font-medium text-zinc-300">Sandbox Security Info</span>
            <div className="flex-1" />
            <button onClick={() => setConsoleOpen(false)} className="text-zinc-500 hover:text-zinc-300 transition-colors">
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="p-3 text-[11px] text-zinc-400 space-y-2 overflow-y-auto">
            <div className="flex items-start gap-2">
              <span className="text-green-400 font-bold shrink-0">SECURE</span>
              <span>Preview runs in a sandboxed iframe without <code className="text-zinc-300">allow-same-origin</code>. The generated app cannot read parent cookies, localStorage, or any MustaFlow data.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-yellow-400 font-bold shrink-0">INFO</span>
              <span>Console log capture is not available in the current sandbox configuration. Open the preview in a new tab to use browser DevTools directly.</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-zinc-500 font-bold shrink-0">TODO</span>
              <span>Isolated preview domain + postMessage console bridge planned for multi-user launch (replaces allow-same-origin entirely).</span>
            </div>
          </div>
        </div>
      )}

      {/* Collapsed console indicator */}
      {hasFiles && !consoleOpen && (
        <div className="shrink-0 border-t border-border bg-zinc-950/60">
          <button
            onClick={() => setConsoleOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <ShieldAlert className="h-3 w-3 text-green-500" />
            <span>Sandbox active — previews are isolated from app data</span>
            <div className="flex-1" />
            <ChevronUp className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
