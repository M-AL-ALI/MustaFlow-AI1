import {
  Monitor,
  Smartphone,
  Tablet,
  RefreshCw,
  ExternalLink,
  Globe,
  LayoutTemplate,
  Zap,
  BrainCircuit,
  Loader2,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
  Terminal,
  X,
  Maximize2,
  Minimize2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useRef, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useListProjectFiles, getListProjectFilesQueryKey } from "@workspace/api-client-react";

type DeviceFrame = "desktop" | "tablet" | "mobile";

const DEVICE_LABELS: Record<DeviceFrame, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
};

const DEVICE_ICONS: Record<DeviceFrame, React.ElementType> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
};

type ConsoleEntry = {
  id: number;
  level: "log" | "warn" | "error" | "info";
  args: string[];
  ts: number;
};

type Project = {
  id: number;
  status: string;
  updatedAt: string;
  name?: string;
};


export function PreviewTab({
  project,
  focusMode,
  onToggleFocusMode,
}: {
  project: Project;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
}) {
  const [device, setDevice] = useState<DeviceFrame>("desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevStatusRef = useRef<string>(project.status);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryIdRef = useRef(0);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const { data: files, isLoading: filesLoading } = useListProjectFiles(project.id, {
    query: {
      enabled: !!project.id,
      queryKey: getListProjectFilesQueryKey(project.id),
    },
  });

  const hasFiles = (files?.length ?? 0) > 0;
  const isLoading = filesLoading && files === undefined;
  const previewSrc = `/api/projects/${project.id}/preview/?t=${iframeKey}`;

  // postMessage listener — only accept messages from our preview iframe.
  // Requires both a mounted iframe ref AND a matching source window.
  // When iframeRef is null (no iframe mounted) all messages are rejected.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !data.__mustaflow) return;
      const VALID_LEVELS = ["log", "warn", "error", "info"] as const;
      type ValidLevel = typeof VALID_LEVELS[number];
      const rawLevel = data.level as string;
      const level: ValidLevel = (VALID_LEVELS as readonly string[]).includes(rawLevel)
        ? (rawLevel as ValidLevel)
        : "log";
      const args = Array.isArray(data.args) ? (data.args as string[]) : [String(data.args)];
      const id = entryIdRef.current++;
      setConsoleEntries((prev) => [...prev.slice(-199), { id, level: level as ConsoleEntry["level"], args, ts: Date.now() }]);
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // Scroll console to bottom on new entries
  useEffect(() => {
    if (consoleOpen && consoleEndRef.current) {
      consoleEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [consoleEntries, consoleOpen]);

  const refresh = useCallback(() => {
    setHealthWarning(null);
    setConsoleEntries([]);
    setIframeKey((k) => k + 1);
  }, []);

  // Auto-refresh when project finishes building
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = project.status;
    if (prev === "building" && project.status !== "building" && hasFiles) {
      setHealthWarning(null);
      setConsoleEntries([]);
      setIframeKey((k) => k + 1);
    }
  }, [project.status, hasFiles]);

  const handleIframeLoad = useCallback(() => {
    setHealthWarning(null);
    if (healthTimerRef.current) clearTimeout(healthTimerRef.current);
  }, []);

  useEffect(() => () => {
    if (healthTimerRef.current) clearTimeout(healthTimerRef.current);
  }, []);

  const errorCount = consoleEntries.filter((e) => e.level === "error").length;
  const warnCount = consoleEntries.filter((e) => e.level === "warn").length;

  // Shared iframe renderer — the console bridge is injected server-side in the
  // preview route, so we always use a plain src iframe.
  const renderIframe = (extraClass?: string, extraStyle?: React.CSSProperties) => (
    <iframe
      key={`src-${device}-${iframeKey}`}
      ref={iframeRef}
      src={previewSrc}
      title="App preview"
      aria-label="App preview"
      className={cn("w-full border-0", extraClass)}
      style={extraStyle}
      sandbox="allow-scripts allow-forms allow-popups"
      onLoad={handleIframeLoad}
    />
  );

  return (
    <div className="flex flex-col h-full bg-background">

      {/* Preview toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border bg-card">

        {/* Device size switcher */}
        <div className="flex items-center bg-muted border border-border rounded-lg p-0.5 gap-0.5 shrink-0">
          {(["desktop", "tablet", "mobile"] as DeviceFrame[]).map((d) => {
            const Icon = DEVICE_ICONS[d];
            return (
              <button
                key={d}
                onClick={() => setDevice(d)}
                title={DEVICE_LABELS[d]}
                className={cn(
                  "flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-colors text-[11px] font-medium",
                  device === d
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3 w-3" />
                <span className="hidden sm:inline">{DEVICE_LABELS[d]}</span>
              </button>
            );
          })}
        </div>

        {/* Mobile Phase 4 — subtle hover hint, not an interactive control */}
        <div className="relative shrink-0 group">
          <div
            className="flex items-center gap-1 px-2 py-1 rounded-md text-[10px] text-muted-foreground/30 border border-dashed border-border/25 cursor-default select-none"
            aria-hidden="true"
          >
            <Smartphone className="h-3 w-3" />
            <span>iOS / Android</span>
          </div>
          {/* Tooltip shown on hover only */}
          <div className="absolute top-full left-0 mt-1.5 z-50 w-52 bg-popover border border-border rounded-lg shadow-xl p-2.5 text-[11px] text-muted-foreground hidden group-hover:block pointer-events-none">
            <div className="font-semibold text-foreground mb-1">Mobile — Phase 4</div>
            <p>iOS and Android publishing is planned for a future release. MustaFlow currently generates web apps.</p>
          </div>
        </div>

        <div className="w-px h-4 bg-border shrink-0" />

        {/* Status indicator */}
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
            "w-1.5 h-1.5 rounded-full shrink-0",
            project.status === "building" ? "bg-primary animate-pulse" :
            project.status === "published" ? "bg-green-500" :
            project.status === "testing" ? "bg-yellow-500" :
            project.status === "failed" ? "bg-destructive" : "bg-muted-foreground",
          )} />
          {project.status}
        </div>

        <div className="flex-1" />

        {/* Console toggle */}
        {hasFiles && (
          <button
            onClick={() => setConsoleOpen((o) => !o)}
            aria-label={consoleOpen ? "Close console" : "Open console"}
            aria-pressed={consoleOpen}
            className={cn(
              "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 border",
              consoleOpen
                ? "bg-zinc-800 text-zinc-100 border-zinc-700"
                : errorCount > 0
                ? "bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/15"
                : "bg-muted text-muted-foreground border-border hover:text-foreground",
            )}
            title="Console"
          >
            <Terminal className="h-3 w-3" />
            Console
            {errorCount > 0 && (
              <span className="px-1 py-0.5 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold leading-none">
                {errorCount}
              </span>
            )}
            {errorCount === 0 && warnCount > 0 && (
              <span className="px-1 py-0.5 rounded-full bg-yellow-500 text-black text-[9px] font-bold leading-none">
                {warnCount}
              </span>
            )}
          </button>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={refresh}
            title="Refresh preview"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            asChild
            title="Open in new tab"
          >
            <a href={previewSrc} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </Button>
          {onToggleFocusMode && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleFocusMode}
              title={focusMode ? "Exit focus mode (Esc)" : "Focus mode — expand preview"}
            >
              {focusMode ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
          )}
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
      <div className="flex-1 min-h-0 bg-[#1a1a1f] overflow-auto flex items-start justify-center p-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-muted-foreground">
            <Loader2 className="h-8 w-8 animate-spin text-primary/50" />
            <span className="text-sm">Loading preview…</span>
          </div>
        ) : hasFiles ? (
          device === "desktop" ? (
            /* ── Desktop browser chrome ── */
            <div className="w-full h-full flex flex-col rounded-xl overflow-hidden shadow-2xl border border-white/5">
              {/* Tab bar */}
              <div className="h-8 bg-zinc-900 flex items-end px-2 gap-0.5 shrink-0">
                <div className="h-7 flex items-center gap-2 px-3 bg-zinc-800 rounded-t-lg border border-zinc-700 border-b-0 min-w-[140px] max-w-[200px]">
                  <Globe className="h-3 w-3 text-zinc-400 shrink-0" />
                  <span className="text-[11px] text-zinc-300 truncate flex-1">{project.name ?? "Preview"}</span>
                  <X className="h-2.5 w-2.5 text-zinc-500 shrink-0" />
                </div>
              </div>
              {/* Address bar */}
              <div className="h-9 bg-zinc-800 border-b border-zinc-700 flex items-center gap-2 px-3 shrink-0">
                <div className="flex items-center gap-1.5">
                  <div className="w-3.5 h-3.5 rounded-full bg-red-500/80" />
                  <div className="w-3.5 h-3.5 rounded-full bg-yellow-500/80" />
                  <div className="w-3.5 h-3.5 rounded-full bg-green-500/80" />
                </div>
                <button onClick={refresh} className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-700">
                  <RefreshCw className="h-3 w-3" />
                </button>
                <div className="flex-1 flex items-center bg-zinc-900 border border-zinc-700 rounded-md px-3 h-6 gap-2 max-w-md mx-auto">
                  <Globe className="h-3 w-3 text-zinc-500 shrink-0" />
                  <span className="text-[11px] text-zinc-300 font-mono truncate flex-1">
                    preview/{project.id}/
                  </span>
                </div>
              </div>
              {/* iframe */}
              <div className="flex-1 min-h-0 bg-white overflow-hidden">
                {renderIframe("h-full")}
              </div>
            </div>
          ) : device === "mobile" ? (
            /* ── Mobile phone shell ── */
            <div className="flex items-center justify-center py-4">
              <div
                className="relative flex flex-col rounded-[40px] shadow-2xl border-[6px] border-zinc-800 bg-zinc-800 overflow-hidden"
                style={{ width: 390, minHeight: 844 }}
              >
                {/* Dynamic Island / Notch */}
                <div className="shrink-0 h-12 bg-black flex justify-center items-center">
                  <div className="w-28 h-7 bg-zinc-900 rounded-full flex items-center justify-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-zinc-700" />
                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                  </div>
                </div>
                {/* Screen */}
                <div className="flex-1 bg-white overflow-hidden">
                  {renderIframe(undefined, { height: 780 })}
                </div>
                {/* Home bar */}
                <div className="shrink-0 bg-black flex justify-center py-3">
                  <div className="w-24 h-1 rounded-full bg-zinc-600" />
                </div>
              </div>
            </div>
          ) : (
            /* ── Tablet frame ── */
            <div className="flex items-center justify-center py-4">
              <div
                className="relative flex flex-col rounded-[24px] shadow-2xl border-[6px] border-zinc-800 bg-zinc-800 overflow-hidden"
                style={{ width: 768, minHeight: 1024 }}
              >
                {/* Camera */}
                <div className="shrink-0 h-7 bg-zinc-900 flex justify-center items-center">
                  <div className="w-2 h-2 rounded-full bg-zinc-700" />
                </div>
                {/* Screen */}
                <div className="flex-1 bg-white overflow-hidden">
                  {renderIframe(undefined, { height: 970 })}
                </div>
                {/* Home bar */}
                <div className="shrink-0 bg-zinc-900 flex justify-center py-2">
                  <div className="w-16 h-1 rounded-full bg-zinc-600" />
                </div>
              </div>
            </div>
          )
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

      {/* Console panel */}
      {hasFiles && consoleOpen && (
        <div className="shrink-0 border-t border-zinc-800 bg-zinc-950 flex flex-col" style={{ height: 200 }}>
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-800 shrink-0">
            <Terminal className="h-3.5 w-3.5 text-zinc-400" />
            <span className="text-[11px] font-medium text-zinc-300">Console</span>
            {consoleEntries.length > 0 && (
              <span className="text-[10px] text-zinc-500">
                {consoleEntries.length} {consoleEntries.length === 1 ? "entry" : "entries"}
              </span>
            )}
            <div className="flex-1" />
            {consoleEntries.length > 0 && (
              <button
                onClick={() => setConsoleEntries([])}
                className="text-zinc-600 hover:text-zinc-400 transition-colors p-0.5 rounded"
                title="Clear console"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={() => setConsoleOpen(false)}
              className="text-zinc-600 hover:text-zinc-300 transition-colors p-0.5 rounded"
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto font-mono text-[11px] leading-5">
            {consoleEntries.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-1.5 text-zinc-600">
                <Terminal className="h-4 w-4" />
                <span>Listening for console output…</span>
              </div>
            ) : (
              <div>
                {consoleEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className={cn(
                      "flex items-start gap-2 px-3 py-0.5 border-b border-zinc-900 hover:bg-zinc-900/50",
                      entry.level === "error" ? "text-red-400 bg-red-950/20" :
                      entry.level === "warn" ? "text-yellow-400" :
                      entry.level === "info" ? "text-blue-400" :
                      "text-zinc-300",
                    )}
                  >
                    <span className={cn(
                      "shrink-0 uppercase text-[9px] font-bold tracking-wider mt-0.5 w-7",
                      entry.level === "error" ? "text-red-500" :
                      entry.level === "warn" ? "text-yellow-500" :
                      entry.level === "info" ? "text-blue-500" :
                      "text-zinc-600",
                    )}>
                      {entry.level}
                    </span>
                    <span className="flex-1 break-all whitespace-pre-wrap">{entry.args.join(" ")}</span>
                    <span className="text-zinc-700 text-[9px] shrink-0 mt-0.5">
                      {new Date(entry.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </div>
                ))}
                <div ref={consoleEndRef} />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Collapsed console tab strip */}
      {hasFiles && !consoleOpen && (
        <div className="shrink-0 border-t border-zinc-800/60 bg-zinc-950/80">
          <button
            onClick={() => setConsoleOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-1.5 text-[11px] text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <Terminal className="h-3 w-3" />
            <span>Console</span>
            {errorCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-destructive/20 text-destructive text-[9px] font-bold">{errorCount} error{errorCount !== 1 ? "s" : ""}</span>
            )}
            {errorCount === 0 && warnCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-[9px] font-bold">{warnCount} warning{warnCount !== 1 ? "s" : ""}</span>
            )}
            <div className="flex-1" />
            <ChevronUp className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
