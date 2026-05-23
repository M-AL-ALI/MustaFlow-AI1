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
  AlertCircle,
  Terminal,
  X,
  Maximize2,
  Minimize2,
  Trash2,
  Wrench,
  QrCode,
  Info,
  Copy,
  Check,
  ShieldAlert,
  Plug,
  FileJson,
  PackageOpen,
  ServerCrash,
  Wifi,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useRef, useEffect, useCallback } from "react";
import { STATUS_LABELS, type UseWebContainerResult } from "@/hooks/use-web-container";
import { cn } from "@/lib/utils";
import {
  useListProjectFiles,
  getListProjectFilesQueryKey,
  useListSecrets,
  getListSecretsQueryKey,
} from "@workspace/api-client-react";

type Platform = "web" | "ios" | "android";
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
  isCrash?: boolean;
};

type Project = {
  id: number;
  status: string;
  updatedAt: string;
  name?: string;
  kind?: string;
  projectFormat?: string;
  publicSlug?: string | null;
};

type ReadinessReport = {
  integrationsNeeded?: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment?: "test" | "production";
  }>;
  modulesWired?: Array<{
    id: string;
    name?: string;
    secretsConsumed?: string[];
  }>;
  nativeFeatures?: string[];
};

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

type PreviewTabProps = {
  project: Project;
  wc: UseWebContainerResult;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  validationWarnings?: string[];
  nativeFeatures?: string[];
  onFixPrompt?: (text: string) => void;
  onAutoSendPrompt?: (text: string) => void;
  onOpenFileInEditor?: (fileId: number) => void;
  /** Server-side container status (Phase C). When provided, shows a waking/starting overlay. */
  containerStatus?: ContainerStatus;
  /** Proxied URL to the running container dev server. Shown in the address bar when active. */
  containerUrl?: string | null;
  /** Called when user clicks "Wake container" from the preview overlay. */
  onStartContainer?: () => void;
  /** Most recent build report — used to populate the mobile readiness panel. */
  latestReport?: ReadinessReport | null;
  /** Switch to the Secrets / Tools panel so the user can fill in missing keys. */
  onJumpToSecrets?: () => void;
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

export function PreviewTab({
  project,
  wc,
  focusMode,
  onToggleFocusMode,
  validationWarnings = [],
  nativeFeatures = [],
  onFixPrompt,
  onAutoSendPrompt,
  onOpenFileInEditor,
  containerStatus,
  containerUrl,
  onStartContainer,
  latestReport,
  onJumpToSecrets,
}: PreviewTabProps) {
  const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(project.kind ?? "");
  const [readinessDismissed, setReadinessDismissed] = useState(false);
  // Secrets — used by the mobile readiness panel to flag missing keys
  const { data: projectSecrets } = useListSecrets(project.id, {
    query: { queryKey: getListSecretsQueryKey(project.id), enabled: !!project.id && isMobile },
  });
  const setSecretNames = new Set(
    (projectSecrets ?? [])
      .map((s) => (s as { name?: string }).name)
      .filter((n): n is string => typeof n === "string" && n.length > 0),
  );
  const requiredSecretsFromReport = (() => {
    if (!latestReport) return [] as string[];
    const out = new Set<string>();
    for (const integ of latestReport.integrationsNeeded ?? []) {
      for (const k of integ.keysNeeded ?? []) if (typeof k === "string" && k) out.add(k);
    }
    for (const mod of latestReport.modulesWired ?? []) {
      for (const k of mod.secretsConsumed ?? []) if (typeof k === "string" && k) out.add(k);
    }
    return Array.from(out);
  })();
  const missingSecrets = requiredSecretsFromReport.filter((k) => !setSecretNames.has(k));
  // Re-surface the panel whenever the report's required secrets or native features change
  // (e.g. a new build introduces additional integrations the user hasn't set up yet).
  const readinessSignature = [
    ...requiredSecretsFromReport,
    "::native::",
    ...(latestReport?.nativeFeatures ?? []),
  ].join("|");
  useEffect(() => {
    setReadinessDismissed(false);
  }, [readinessSignature]);
  const showMobileReadiness =
    isMobile &&
    !readinessDismissed &&
    (requiredSecretsFromReport.length > 0 || (latestReport?.nativeFeatures?.length ?? 0) > 0);
  const isReactVite = project.projectFormat === "react-vite" && !isMobile;
  const [platform, setPlatform] = useState<Platform>("web");
  const [device, setDevice] = useState<DeviceFrame>(isMobile ? "mobile" : "desktop");
  const [iframeKey, setIframeKey] = useState(0);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [validationDismissed, setValidationDismissed] = useState(false);
  const [nativeFeaturesDismissed, setNativeFeaturesDismissed] = useState(false);
  const prevWarningsRef = useRef<string[]>([]);
  const prevNativeFeaturesRef = useRef<string[]>([]);
  const [crashBanner, setCrashBanner] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [mocksOpen, setMocksOpen] = useState(false);

  // EAS build status — fetch latest completed build for native QR
  type EasBuildEntry = {
    id: number;
    env: string;
    status: string;
    publicUrl: string | null;
    note: string | null;
    easBuildId: string | null;
    createdAt: string;
  };
  const [easBuild, setEasBuild] = useState<EasBuildEntry | null>(null);

  const fetchEasBuilds = useCallback(async () => {
    if (!isMobile) return;
    try {
      const res = await fetch(`/api/projects/${project.id}/eas/builds`);
      if (res.ok) {
        const data = (await res.json()) as { builds: EasBuildEntry[] };
        // Pick the most recent completed build (any platform)
        const ready = (data.builds ?? []).find((b) => b.status === "passed" && !!b.publicUrl);
        setEasBuild(ready ?? null);
      }
    } catch {
      /* ignore */
    }
  }, [project.id, isMobile]);

  useEffect(() => {
    void fetchEasBuilds();
    // Re-fetch when the project finishes building
  }, [fetchEasBuilds, project.status]);

  // Reset dismissed state when warnings change (new build completed)
  useEffect(() => {
    const prev = prevWarningsRef.current;
    const changed =
      validationWarnings.length !== prev.length || validationWarnings.some((w, i) => w !== prev[i]);
    if (changed) {
      setValidationDismissed(false);
      prevWarningsRef.current = validationWarnings;
    }
  }, [validationWarnings]);

  // Reset native features dismissed state when nativeFeatures change (new build)
  useEffect(() => {
    const prev = prevNativeFeaturesRef.current;
    const changed =
      nativeFeatures.length !== prev.length || nativeFeatures.some((f, i) => f !== prev[i]);
    if (changed) {
      setNativeFeaturesDismissed(false);
      prevNativeFeaturesRef.current = nativeFeatures;
    }
  }, [nativeFeatures]);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prevStatusRef = useRef<string>(project.status);
  const healthTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const entryIdRef = useRef(0);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  // Tracks whether we are within the 30-second crash-watch window after a build completes.
  const postBuildWindowRef = useRef(false);
  const postBuildTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rollbackBanner, setRollbackBanner] = useState<{ crashMsg: string } | null>(null);
  const [rollingBack, setRollingBack] = useState(false);

  const { data: files, isLoading: filesLoading } = useListProjectFiles(project.id, {
    query: {
      enabled: !!project.id,
      queryKey: getListProjectFilesQueryKey(project.id),
    },
  });

  const hasFiles = (files?.length ?? 0) > 0;
  const isLoading = filesLoading && files === undefined;
  const previewSrc = `/api/projects/${project.id}/preview/?t=${iframeKey}`;

  // After a build completes for a react-vite project, resync the WC with fresh files.
  // We detect build completion via project.status transitioning away from "building".
  // Use a ref for the restart fn to keep the effect deps stable (avoids re-running on every render).
  const wcRestartRef = useRef(wc.restart);
  wcRestartRef.current = wc.restart;
  const prevBuildStatusRef = useRef(project.status);
  useEffect(() => {
    const prev = prevBuildStatusRef.current;
    prevBuildStatusRef.current = project.status;
    if (isReactVite && prev === "building" && project.status !== "building" && hasFiles) {
      wcRestartRef.current();
    }
  }, [project.status, isReactVite, hasFiles]);

  // Step 6: Bridge WC process stdout/stderr into the PreviewTab console panel.
  // We track the last-seen WC log ID so we only forward net-new entries each render.
  const lastWcLogIdRef = useRef(-1);
  useEffect(() => {
    if (!isReactVite || wc.logs.length === 0) return;
    const newLogs = wc.logs.filter((l) => l.id > lastWcLogIdRef.current);
    if (newLogs.length === 0) return;
    lastWcLogIdRef.current = wc.logs[wc.logs.length - 1]!.id;
    setConsoleEntries((prev) => {
      const newEntries = newLogs.map((l) => ({
        id: entryIdRef.current++,
        level: "log" as const,
        args: [l.text],
        ts: l.ts,
      }));
      return [...prev, ...newEntries].slice(-200);
    });
  }, [isReactVite, wc.logs]);

  // Reset last-seen WC log pointer when the container reboots so we don't re-forward stale lines.
  useEffect(() => {
    if (wc.status === "booting") {
      lastWcLogIdRef.current = -1;
    }
  }, [wc.status]);

  // Mock API detection — derived from the file list
  const mockFiles = (files ?? []).filter(
    (f) => f.path.startsWith("_mocks/") && f.path.endsWith(".json"),
  );
  const hasMockSw = (files ?? []).some((f) => f.path === "_mocks/sw.js");
  const mockEndpointCount = mockFiles.length;

  /** Convert a _mocks/ filename back to the API path it stubs */
  function mockFileToApiPath(filePath: string): string {
    // _mocks/api/users/profile.json → /api/users/profile
    return "/" + filePath.replace(/^_mocks\//, "").replace(/\.json$/, "");
  }

  // postMessage listener — only accept messages from our preview iframe.
  // Requires both a mounted iframe ref AND a matching source window.
  // When iframeRef is null (no iframe mounted) all messages are rejected.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== "object" || !data.__mustaflow) return;
      const VALID_LEVELS = ["log", "warn", "error", "info"] as const;
      type ValidLevel = (typeof VALID_LEVELS)[number];
      const rawLevel = data.level as string;
      const level: ValidLevel = (VALID_LEVELS as readonly string[]).includes(rawLevel)
        ? (rawLevel as ValidLevel)
        : "log";
      const args = Array.isArray(data.args) ? (data.args as string[]) : [String(data.args)];
      const isCrash = data.type === "crash";
      const id = entryIdRef.current++;
      setConsoleEntries((prev) => [
        ...prev.slice(-199),
        { id, level: level as ConsoleEntry["level"], args, ts: Date.now(), isCrash },
      ]);
      if (isCrash) {
        setCrashBanner(args.join(" "));
        // If crash happens within 30s of a build completing, offer rollback
        if (postBuildWindowRef.current) {
          setRollbackBanner({ crashMsg: args.join(" ") });
        }
      }
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
    setCrashBanner(null);
    setIframeKey((k) => k + 1);
  }, []);

  // Auto-refresh when project finishes building + open 30s crash-watch window
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = project.status;
    if (prev === "building" && project.status !== "building" && hasFiles) {
      setHealthWarning(null);
      setConsoleEntries([]);
      setCrashBanner(null);
      setRollbackBanner(null);
      setIframeKey((k) => k + 1);
      // Open the crash-watch window for 30 seconds
      postBuildWindowRef.current = true;
      if (postBuildTimerRef.current) clearTimeout(postBuildTimerRef.current);
      postBuildTimerRef.current = setTimeout(() => {
        postBuildWindowRef.current = false;
      }, 30_000);
    }
  }, [project.status, hasFiles]);

  const handleIframeLoad = useCallback(() => {
    setHealthWarning(null);
    if (healthTimerRef.current) clearTimeout(healthTimerRef.current);
  }, []);

  useEffect(
    () => () => {
      if (healthTimerRef.current) clearTimeout(healthTimerRef.current);
    },
    [],
  );

  const errorCount = consoleEntries.filter((e) => e.level === "error").length;
  const warnCount = consoleEntries.filter((e) => e.level === "warn").length;

  // Shared iframe renderer.
  // For react-vite projects with a live WebContainer dev server, the iframe points
  // at the WC-provided URL (no sandbox needed — WC handles its own isolation).
  // For static-html projects, the existing DB-served preview route is used.
  const renderIframe = (extraClass?: string, extraStyle?: React.CSSProperties) => {
    const wcLive = isReactVite && wc.status === "ready" && wc.previewUrl != null;
    const src = wcLive ? wc.previewUrl! : previewSrc;
    return (
      <iframe
        key={wcLive ? `wc-${device}-${wc.previewUrl}` : `src-${device}-${iframeKey}`}
        ref={iframeRef}
        src={src}
        title="App preview"
        aria-label="App preview"
        className={cn("w-full border-0", extraClass)}
        style={extraStyle}
        sandbox={
          wcLive
            ? "allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
            : "allow-scripts allow-forms allow-popups"
        }
        onLoad={handleIframeLoad}
      />
    );
  };

  // Boot progress overlay — shown in the preview area while WC is initialising.
  const renderWcBootOverlay = () => (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#0d0f17]/80 backdrop-blur-sm gap-4 z-10">
      <div className="flex flex-col items-center gap-3">
        <div className="relative">
          <div className="w-12 h-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
            <PackageOpen className="h-6 w-6 text-primary/70" />
          </div>
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center">
            <Loader2 className="h-3 w-3 text-primary animate-spin" />
          </div>
        </div>
        <div className="text-center">
          <div className="text-sm font-medium text-foreground">{STATUS_LABELS[wc.status]}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            {wc.status === "booting"
              ? "Starting in-browser sandbox…"
              : wc.status === "installing"
                ? "npm install is running…"
                : "Vite dev server is starting…"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {(["booting", "installing", "starting"] as const).map((stage) => (
            <div key={stage} className="flex items-center gap-1">
              <div
                className={cn(
                  "w-2 h-2 rounded-full transition-colors",
                  wc.status === stage
                    ? "bg-primary animate-pulse"
                    : ["installing", "starting"].includes(wc.status) && stage === "booting"
                      ? "bg-primary/70"
                      : wc.status === "starting" && stage === "installing"
                        ? "bg-primary/70"
                        : "bg-muted",
                )}
              />
              <span
                className={cn(
                  "text-[10px]",
                  wc.status === stage
                    ? "text-primary font-medium"
                    : ["installing", "starting"].includes(wc.status) && stage === "booting"
                      ? "text-primary/60"
                      : wc.status === "starting" && stage === "installing"
                        ? "text-primary/60"
                        : "text-muted-foreground/40",
                )}
              >
                {stage === "booting" ? "Boot" : stage === "installing" ? "Install" : "Start"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
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

        {/* iOS / Android platform toggle — mobile projects only */}
        {isMobile && (
          <div className="flex items-center bg-muted border border-border rounded-lg p-0.5 gap-0.5 shrink-0">
            {(["ios", "android"] as Platform[]).map((p) => (
              <button
                key={p}
                onClick={() => setPlatform(p)}
                title={p === "ios" ? "iOS frame" : "Android frame"}
                className={cn(
                  "flex items-center gap-1 px-2 py-1 rounded-md transition-colors text-[11px] font-medium",
                  platform === p
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Smartphone className="h-3 w-3" />
                <span className="hidden sm:inline">{p === "ios" ? "iOS" : "Android"}</span>
              </button>
            ))}
          </div>
        )}

        {/* QR code panel — shown for web projects that are published */}
        {!isMobile && hasFiles && (
          <div className="relative shrink-0">
            <button
              onClick={() => setQrOpen((o) => !o)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors border",
                qrOpen
                  ? "bg-primary/15 text-primary border-primary/30"
                  : project.publicSlug
                    ? "bg-muted text-muted-foreground border-border hover:text-foreground"
                    : "bg-muted text-muted-foreground border-border hover:text-foreground",
              )}
              title="Scan on phone"
            >
              <QrCode className="h-3 w-3" />
              <span className="hidden sm:inline">Scan on phone</span>
            </button>
            {qrOpen && (
              <div className="absolute top-full left-0 mt-2 z-50 w-80 bg-popover border border-border rounded-xl shadow-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-semibold text-foreground text-sm flex items-center gap-1.5">
                    <Smartphone className="h-4 w-4 text-primary" />
                    Test on a real device
                  </div>
                  <button
                    onClick={() => setQrOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {project.publicSlug ? (
                  <>
                    <div className="flex justify-center mb-3">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(`${window.location.origin}/api/p/${project.publicSlug}/`)}&size=180x180&bgcolor=ffffff&color=000000&margin=8`}
                        alt="QR code for published app"
                        className="rounded-lg border border-border"
                        width={180}
                        height={180}
                      />
                    </div>
                    <div className="bg-muted/60 rounded-lg px-3 py-2 mb-2 flex items-center gap-2">
                      <p className="text-[10px] font-mono text-muted-foreground break-all flex-1">
                        {window.location.origin}/api/p/{project.publicSlug}/
                      </p>
                      <button
                        onClick={() => {
                          navigator.clipboard
                            .writeText(`${window.location.origin}/api/p/${project.publicSlug}/`)
                            .then(() => {
                              setCopiedUrl(true);
                              setTimeout(() => setCopiedUrl(false), 2000);
                            })
                            .catch(() => {});
                        }}
                        aria-label={copiedUrl ? "Copied" : "Copy link"}
                        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
                        title={copiedUrl ? "Copied" : "Copy link"}
                      >
                        {copiedUrl ? (
                          <Check className="h-3.5 w-3.5 text-green-500" />
                        ) : (
                          <Copy className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                    <div className="flex items-start gap-2 bg-muted/60 rounded-lg p-2.5 text-xs text-muted-foreground">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-primary" />
                      <p>
                        Scan with your phone's camera to open the live published app in your mobile
                        browser.
                      </p>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center gap-3 py-2">
                    <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center">
                      <Globe className="h-7 w-7 text-muted-foreground/50" />
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-medium text-foreground mb-1">Not published yet</p>
                      <p className="text-xs text-muted-foreground leading-relaxed">
                        Publish your app first to get a public URL you can scan and test on any
                        device.
                      </p>
                    </div>
                    <button
                      onClick={() => setQrOpen(false)}
                      className="text-xs text-primary hover:underline"
                    >
                      Go to Publishing tab to publish
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* QR code panel — shown for mobile projects */}
        {isMobile && hasFiles && (
          <div className="relative shrink-0">
            <button
              onClick={() => setQrOpen((o) => !o)}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors border",
                qrOpen
                  ? "bg-green-500/15 text-green-400 border-green-500/30"
                  : easBuild
                    ? "bg-green-500/10 text-green-400 border-green-500/20 hover:bg-green-500/15"
                    : "bg-muted text-muted-foreground border-border hover:text-foreground",
              )}
              title={easBuild ? "Native Expo Go build ready" : "Scan with Expo Go (web preview)"}
            >
              <QrCode className="h-3 w-3" />
              <span className="hidden sm:inline">{easBuild ? "Expo Go" : "Expo Go"}</span>
              {easBuild && (
                <span className="hidden sm:inline text-[9px] bg-green-500/20 text-green-400 border border-green-500/30 px-1 rounded font-bold">
                  NATIVE
                </span>
              )}
            </button>
            {qrOpen && (
              <div className="absolute top-full left-0 mt-2 z-50 w-80 bg-popover border border-border rounded-xl shadow-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="font-semibold text-foreground text-sm flex items-center gap-1.5">
                    <Smartphone className="h-4 w-4 text-green-400" />
                    {easBuild ? "Native Expo Go" : "Expo Go Preview"}
                  </div>
                  <button
                    onClick={() => setQrOpen(false)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {easBuild ? (
                  /* ── Native EAS build QR ── */
                  (() => {
                    const url = easBuild.publicUrl!;
                    const isExp = url.startsWith("exp://") || url.startsWith("exp+");
                    return (
                      <>
                        <div className="flex items-center gap-2 bg-green-500/10 border border-green-500/20 rounded-lg px-3 py-2 mb-3">
                          <span className="text-[10px] bg-green-500/20 text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded font-bold">
                            {isExp ? "EXPO GO" : "NATIVE"}
                          </span>
                          <span className="text-xs text-green-400 flex-1 truncate font-medium">
                            {isExp
                              ? "Expo Go launch URL ready"
                              : "Native build ready — scan to install"}
                          </span>
                        </div>
                        <div className="flex justify-center mb-3">
                          <img
                            src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(url)}&size=180x180&bgcolor=ffffff&color=000000&margin=8`}
                            alt={isExp ? "Expo Go QR code" : "Install QR code"}
                            className="rounded-lg border border-border"
                            width={180}
                            height={180}
                          />
                        </div>
                        <div className="bg-muted/60 rounded-lg px-3 py-2 mb-2">
                          <p className="text-[10px] font-mono text-muted-foreground break-all">
                            {url}
                          </p>
                        </div>
                        <div className="flex items-start gap-2 bg-muted/60 rounded-lg p-2.5 text-xs text-muted-foreground">
                          <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-green-400" />
                          <p>
                            {isExp
                              ? "Open Expo Go on your device and scan to launch the native app."
                              : "Scan with your camera to download the APK/IPA, then open with Expo Go or install directly."}
                          </p>
                        </div>
                      </>
                    );
                  })()
                ) : (
                  /* ── Web preview QR (fallback) ── */
                  <>
                    <div className="flex justify-center mb-3">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(window.location.origin + previewSrc)}&size=180x180&bgcolor=ffffff&color=000000&margin=8`}
                        alt="QR code for web preview"
                        className="rounded-lg border border-border"
                        width={180}
                        height={180}
                      />
                    </div>
                    <div className="flex items-start gap-2 bg-muted/60 rounded-lg p-2.5 text-xs text-muted-foreground">
                      <Info className="h-3.5 w-3.5 shrink-0 mt-0.5 text-yellow-400" />
                      <div>
                        <p className="text-foreground font-medium mb-0.5">Web preview</p>
                        <p>
                          Opens the web preview in your mobile browser. For native device sensors,
                          configure EAS Build in the Publishing tab.
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="w-px h-4 bg-border shrink-0" />

        {/* Status indicator */}
        <div
          className={cn(
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
          )}
        >
          <span
            className={cn(
              "w-1.5 h-1.5 rounded-full shrink-0",
              project.status === "building"
                ? "bg-primary animate-pulse"
                : project.status === "published"
                  ? "bg-green-500"
                  : project.status === "testing"
                    ? "bg-yellow-500"
                    : project.status === "failed"
                      ? "bg-destructive"
                      : "bg-muted-foreground",
            )}
          />
          {project.status}
        </div>

        <div className="flex-1" />

        {/* Mock API badge */}
        {hasMockSw && mockEndpointCount > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => setMocksOpen((o) => !o)}
              aria-label={mocksOpen ? "Close mock API panel" : "Open mock API panel"}
              aria-pressed={mocksOpen}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors border",
                mocksOpen
                  ? "bg-violet-500/15 text-violet-400 border-violet-500/30"
                  : "bg-violet-500/10 text-violet-400 border-violet-500/20 hover:bg-violet-500/15",
              )}
              title="Mock API endpoints active"
            >
              <Plug className="h-3 w-3" />
              <span className="hidden sm:inline">Mocked</span>
              <span className="px-1 py-0.5 rounded-full bg-violet-500/25 text-violet-300 text-[9px] font-bold leading-none">
                {mockEndpointCount}
              </span>
            </button>
            {mocksOpen && (
              <div className="absolute top-full right-0 mt-2 z-50 w-80 bg-popover border border-border rounded-xl shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-muted/40">
                  <div className="font-semibold text-foreground text-sm flex items-center gap-1.5">
                    <Plug className="h-3.5 w-3.5 text-violet-400" />
                    Mock API
                  </div>
                  <button
                    onClick={() => setMocksOpen(false)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="px-3 py-2 bg-violet-500/8 border-b border-violet-500/15">
                  <p className="text-[11px] text-violet-300/80 leading-relaxed">
                    A service worker is intercepting API calls in this preview and returning the
                    stub data below. Edits are live — save a file to update the response.
                  </p>
                </div>
                <div className="max-h-64 overflow-y-auto">
                  {mockFiles.map((file) => {
                    const apiPath = mockFileToApiPath(file.path);
                    return (
                      <button
                        key={file.id}
                        onClick={() => {
                          if (onOpenFileInEditor) {
                            onOpenFileInEditor(file.id);
                            setMocksOpen(false);
                          }
                        }}
                        className={cn(
                          "group w-full flex items-center gap-2 px-3 py-2 text-left border-b border-border/30 last:border-0 transition-colors",
                          onOpenFileInEditor
                            ? "hover:bg-muted/50 cursor-pointer"
                            : "cursor-default",
                        )}
                        title={onOpenFileInEditor ? `Edit ${file.path}` : file.path}
                        disabled={!onOpenFileInEditor}
                      >
                        <FileJson className="h-3.5 w-3.5 text-violet-400 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[11px] font-mono text-foreground truncate">
                            {apiPath}
                          </div>
                          <div className="text-[10px] text-muted-foreground truncate">
                            {file.path}
                          </div>
                        </div>
                        {onOpenFileInEditor && (
                          <span className="text-[10px] text-muted-foreground shrink-0 opacity-0 group-hover:opacity-100">
                            Edit
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {!onOpenFileInEditor && (
                  <div className="px-3 py-2 border-t border-border bg-muted/20">
                    <p className="text-[10px] text-muted-foreground">
                      Switch to the Tools &amp; Files tab to edit mock responses.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

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
          <Button variant="ghost" size="icon" className="h-7 w-7" asChild title="Open in new tab">
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
              {focusMode ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Container waking/starting banner — Phase C server-side containers */}
      {containerStatus && ["starting", "hibernated"].includes(containerStatus) && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b bg-primary/8 border-primary/15 text-primary text-xs">
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          <span className="flex-1">
            {containerStatus === "hibernated"
              ? "Container hibernated — wake it to resume the live preview."
              : "Waking up your project container… this takes 20–30 seconds."}
          </span>
          {containerStatus === "hibernated" && onStartContainer && (
            <button
              onClick={onStartContainer}
              className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-primary/20 border border-primary/30 text-primary hover:bg-primary/30 transition-colors"
            >
              Wake
            </button>
          )}
          {containerStatus === "starting" && (
            <div className="flex items-center gap-1 shrink-0">
              {(["starting", "running"] as const).map((stage) => (
                <span
                  key={stage}
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    containerStatus === stage ? "bg-primary animate-pulse" : "bg-primary/20",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* WebContainer boot status banner — only for react-vite projects */}
      {isReactVite && wc.status !== "ready" && wc.status !== "idle" && (
        <div
          className={cn(
            "shrink-0 flex items-center gap-2 px-3 py-2 border-b text-xs",
            wc.status === "error"
              ? "bg-destructive/10 border-destructive/20 text-destructive"
              : wc.status === "unsupported"
                ? "bg-muted border-border text-muted-foreground"
                : "bg-primary/8 border-primary/15 text-primary",
          )}
        >
          {wc.status === "error" ? (
            <ServerCrash className="h-3.5 w-3.5 shrink-0" />
          ) : wc.status === "unsupported" ? (
            <Wifi className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          )}
          <span className="flex-1">{wc.statusLabel}</span>
          {wc.status === "error" && (
            <button
              onClick={() => wc.restart()}
              className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-destructive/20 border border-destructive/30 text-destructive hover:bg-destructive/30 transition-colors"
            >
              Retry
            </button>
          )}
          {wc.status === "unsupported" && (
            <button
              onClick={() => window.open(`/api/projects/${project.id}/export`, "_blank")}
              className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-muted border border-border text-muted-foreground hover:bg-accent transition-colors"
            >
              Export ZIP
            </button>
          )}
          {/* Stage progress dots */}
          {!["error", "unsupported"].includes(wc.status) && (
            <div className="flex items-center gap-1 shrink-0">
              {(["booting", "installing", "starting"] as const).map((stage) => (
                <span
                  key={stage}
                  className={cn(
                    "w-1.5 h-1.5 rounded-full",
                    wc.status === stage
                      ? "bg-primary animate-pulse"
                      : ["installing", "starting", "ready"].includes(wc.status) &&
                          stage === "booting"
                        ? "bg-primary/60"
                        : wc.status === "starting" && stage === "installing"
                          ? "bg-primary/60"
                          : "bg-primary/20",
                  )}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Health warning banner */}
      {healthWarning && (
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-600 dark:text-yellow-400 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1">{healthWarning}</span>
          <button
            onClick={() => setHealthWarning(null)}
            className="shrink-0 hover:opacity-70 transition-opacity"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Validation warnings banner */}
      {validationWarnings.length > 0 && !validationDismissed && (
        <div className="shrink-0 border-b border-orange-500/20 bg-orange-500/8">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-orange-400 shrink-0" />
            <span className="flex-1 text-[11px] font-semibold text-orange-400">
              {validationWarnings.length} validation{" "}
              {validationWarnings.length === 1 ? "issue" : "issues"} found — the AI flagged problems
              it could not fully resolve
            </span>
            <button
              onClick={() => setValidationDismissed(true)}
              className="shrink-0 text-orange-400/60 hover:text-orange-400 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2 space-y-1.5">
            {validationWarnings.map((warning, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 bg-orange-500/10 border border-orange-500/20 rounded-lg px-2.5 py-2"
              >
                <Wrench className="h-3 w-3 text-orange-400 shrink-0 mt-0.5" />
                <span className="flex-1 text-[11px] text-orange-300/90 leading-relaxed">
                  {warning}
                </span>
                {onFixPrompt && (
                  <button
                    onClick={() => onFixPrompt(`Fix this issue: ${warning}`)}
                    className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30 transition-colors whitespace-nowrap"
                  >
                    Ask AI to fix this
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Mobile preview readiness panel — explains why buttons may not "work" + secret checklist */}
      {showMobileReadiness && (
        <div className="shrink-0 border-b border-purple-500/20 bg-purple-500/8">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <Smartphone className="h-3.5 w-3.5 text-purple-300 shrink-0" />
            <span className="flex-1 text-[11px] font-semibold text-purple-300">
              Mobile preview readiness — what works here vs. on a real device
            </span>
            <button
              onClick={() => setReadinessDismissed(true)}
              className="shrink-0 text-purple-300/60 hover:text-purple-300 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2 space-y-1.5">
            <div className="flex items-start gap-2 bg-purple-500/10 border border-purple-500/20 rounded-lg px-2.5 py-2">
              <Info className="h-3 w-3 text-purple-300 shrink-0 mt-0.5" />
              <span className="flex-1 text-[11px] text-purple-200/90 leading-relaxed">
                This window shows an{" "}
                <span className="font-semibold">interactive mockup</span> of your mobile app
                rendered in the browser. Buttons give visual feedback so you can walk the flow, but
                anything that needs the phone&apos;s camera, GPS, push, deep links, or a backend
                only runs on a real device — scan the Expo Go QR above to test for real.
              </span>
            </div>

            {requiredSecretsFromReport.length > 0 && (
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-2.5 py-2">
                <div className="flex items-center gap-2 mb-1.5">
                  <Plug className="h-3 w-3 text-purple-300 shrink-0" />
                  <span className="text-[11px] font-semibold text-purple-200">
                    Secrets needed for full functionality ({setSecretNames.size > 0 ? `${requiredSecretsFromReport.length - missingSecrets.length}/${requiredSecretsFromReport.length} set` : `0/${requiredSecretsFromReport.length} set`})
                  </span>
                  {onJumpToSecrets && missingSecrets.length > 0 && (
                    <button
                      onClick={onJumpToSecrets}
                      className="ml-auto shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-purple-500/25 border border-purple-500/40 text-purple-100 hover:bg-purple-500/40 transition-colors whitespace-nowrap"
                    >
                      Set up secrets
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  {requiredSecretsFromReport.map((key) => {
                    const isSet = setSecretNames.has(key);
                    return (
                      <span
                        key={key}
                        className={cn(
                          "inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border",
                          isSet
                            ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
                            : "bg-amber-500/10 border-amber-500/30 text-amber-300",
                        )}
                        title={isSet ? "Set" : "Not set — buttons that use this will be no-ops"}
                      >
                        {isSet ? (
                          <Check className="h-2.5 w-2.5" />
                        ) : (
                          <AlertTriangle className="h-2.5 w-2.5" />
                        )}
                        {key}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}

            {(latestReport?.nativeFeatures?.length ?? 0) > 0 && (
              <div className="bg-purple-500/10 border border-purple-500/20 rounded-lg px-2.5 py-2">
                <div className="flex items-center gap-2 mb-1">
                  <Smartphone className="h-3 w-3 text-purple-300 shrink-0" />
                  <span className="text-[11px] font-semibold text-purple-200">
                    Device-only features in this app
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {(latestReport?.nativeFeatures ?? []).map((f) => (
                    <span
                      key={f}
                      className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-blue-500/10 border-blue-500/30 text-blue-300"
                    >
                      <Smartphone className="h-2.5 w-2.5" />
                      {f}
                    </span>
                  ))}
                </div>
                <p className="text-[10px] text-purple-300/60 mt-1">
                  These need a real phone — they will be simulated in the preview but only run on
                  device through Expo Go.
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Native features notice — mobile projects only */}
      {isMobile && nativeFeatures.length > 0 && !nativeFeaturesDismissed && (
        <div className="shrink-0 border-b border-blue-500/20 bg-blue-500/8">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-blue-400 shrink-0" />
            <span className="flex-1 text-[11px] font-semibold text-blue-400">
              Native device features detected — web preview may not show full functionality
            </span>
            <button
              onClick={() => setNativeFeaturesDismissed(true)}
              className="shrink-0 text-blue-400/60 hover:text-blue-400 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {nativeFeatures.map((feature, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/20 rounded-lg px-2.5 py-1.5"
              >
                <Smartphone className="h-3 w-3 text-blue-400 shrink-0" />
                <span className="flex-1 text-[11px] text-blue-300/90">{feature}</span>
                <span className="text-[10px] text-blue-400/60 shrink-0">Requires real device</span>
              </div>
            ))}
            <p className="text-[10px] text-blue-400/60 px-0.5 pt-0.5">
              These native capabilities are included in the Expo/React Native code but cannot run in
              the web preview iframe. Use Expo Go on a real device to test them.
            </p>
          </div>
        </div>
      )}

      {/* Crash auto-rollback prompt — shown within 30s of a build completing */}
      {rollbackBanner && (
        <div
          role="alert"
          className="shrink-0 flex items-start gap-2 px-3 py-2.5 bg-orange-500/10 border-b border-orange-500/25 text-orange-400 text-xs"
        >
          <ShieldAlert className="h-3.5 w-3.5 shrink-0 mt-px text-orange-400" />
          <div className="flex-1 min-w-0">
            <span className="font-semibold text-orange-300">Crash detected after build. </span>
            <span className="line-clamp-1 break-all text-orange-400/80">
              {rollbackBanner.crashMsg}
            </span>
          </div>
          <button
            type="button"
            disabled={rollingBack}
            onClick={async () => {
              setRollingBack(true);
              try {
                // Fetch the most recent version to roll back to
                const vRes = await fetch(`/api/projects/${project.id}/versions`);
                if (vRes.ok) {
                  const versions = (await vRes.json()) as Array<{ id: number; label: string }>;
                  // Skip the first (current) version and roll back to the second
                  const target = versions[1];
                  if (target) {
                    const rbRes = await fetch(
                      `/api/projects/${project.id}/versions/${target.id}/rollback`,
                      { method: "POST" },
                    );
                    if (rbRes.ok) {
                      setRollbackBanner(null);
                      setCrashBanner(null);
                      refresh();
                    }
                  }
                }
              } catch {
                /* ignore */
              } finally {
                setRollingBack(false);
              }
            }}
            className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-md bg-orange-500/20 border border-orange-500/30 text-orange-300 hover:bg-orange-500/30 transition-colors whitespace-nowrap disabled:opacity-60"
          >
            {rollingBack ? "Rolling back…" : "Roll back"}
          </button>
          <button
            type="button"
            onClick={() => {
              const fixText = `Fix this crash that appeared right after the last build: ${rollbackBanner.crashMsg}`;
              if (onAutoSendPrompt) onAutoSendPrompt(fixText);
              else onFixPrompt?.(fixText);
              setRollbackBanner(null);
              setCrashBanner(null);
            }}
            className="shrink-0 text-[10px] font-semibold px-2 py-1 rounded-md bg-destructive/15 border border-destructive/25 text-destructive hover:bg-destructive/25 transition-colors whitespace-nowrap"
          >
            Fix with AI
          </button>
          <button
            type="button"
            onClick={() => setRollbackBanner(null)}
            className="shrink-0 hover:opacity-70 transition-opacity"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Runtime crash banner */}
      {crashBanner && !rollbackBanner && !consoleOpen && (
        <div
          role="alert"
          className="shrink-0 flex items-start gap-2 px-3 py-2 bg-destructive/10 border-b border-destructive/25 text-destructive text-xs"
        >
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          <span className="flex-1 line-clamp-2 break-all">{crashBanner}</span>
          {(onAutoSendPrompt || onFixPrompt) && (
            <button
              type="button"
              onClick={() => {
                const fixText = `Fix this runtime error: ${crashBanner}`;
                if (onAutoSendPrompt) {
                  onAutoSendPrompt(fixText);
                } else {
                  onFixPrompt!(fixText);
                }
                setCrashBanner(null);
              }}
              className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-destructive/20 border border-destructive/30 text-destructive hover:bg-destructive/30 transition-colors whitespace-nowrap mt-px"
            >
              Fix with AI
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setConsoleOpen(true);
              setCrashBanner(null);
            }}
            className="shrink-0 text-[10px] font-medium text-destructive/70 hover:text-destructive transition-colors whitespace-nowrap mt-px underline-offset-2 hover:underline"
          >
            Open Console
          </button>
          <button
            type="button"
            onClick={() => setCrashBanner(null)}
            className="shrink-0 hover:opacity-70 transition-opacity"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Preview area — for unsupported/error WC state the static DB snapshot is shown as
          graceful fallback (renderIframe falls back to previewSrc when wcLive is false).
          The boot-status banner above communicates the WC state to the user. */}
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
                  <span className="text-[11px] text-zinc-300 truncate flex-1">
                    {project.name ?? "Preview"}
                  </span>
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
                <button
                  onClick={isReactVite ? () => wc.restart() : refresh}
                  className="text-zinc-400 hover:text-zinc-200 transition-colors p-1 rounded hover:bg-zinc-700"
                >
                  <RefreshCw className="h-3 w-3" />
                </button>
                <div className="flex-1 flex items-center bg-zinc-900 border border-zinc-700 rounded-md px-3 h-6 gap-2 max-w-md mx-auto">
                  <Globe className="h-3 w-3 text-zinc-500 shrink-0" />
                  <span className="text-[11px] text-zinc-300 font-mono truncate flex-1">
                    {containerStatus === "running" && containerUrl
                      ? containerUrl
                      : isReactVite && wc.previewUrl
                        ? wc.previewUrl
                        : `preview/${project.id}/`}
                  </span>
                </div>
              </div>
              {/* iframe — with WC boot overlay while installing/starting */}
              <div className="flex-1 min-h-0 bg-white overflow-hidden relative">
                {isReactVite &&
                  ["booting", "installing", "starting"].includes(wc.status) &&
                  renderWcBootOverlay()}
                {renderIframe("h-full")}
              </div>
            </div>
          ) : device === "mobile" ? (
            /* ── Mobile phone shell ── */
            <div className="flex flex-col items-center justify-start py-4 gap-2">
              {/* Web simulation label */}
              {isMobile && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-[10px] font-medium shrink-0">
                  <Smartphone className="h-3 w-3" />
                  Mobile preview (web simulation) — {platform === "android"
                    ? "Android"
                    : "iOS"}{" "}
                  frame
                </div>
              )}
              <div
                className={cn(
                  "relative flex flex-col shadow-2xl overflow-hidden",
                  platform === "android"
                    ? "rounded-[32px] border-[6px] border-zinc-700 bg-zinc-700"
                    : "rounded-[40px] border-[6px] border-zinc-800 bg-zinc-800",
                )}
                style={{ width: 390, minHeight: 844 }}
              >
                {/* Dynamic Island (iOS) / Status bar (Android) */}
                {platform === "android" ? (
                  <div className="shrink-0 h-10 bg-zinc-900 flex items-center justify-between px-4">
                    <span className="text-[10px] text-zinc-400 font-medium">9:41</span>
                    <div className="flex items-center gap-1">
                      <div className="w-3 h-2 border border-zinc-500 rounded-sm relative">
                        <div className="absolute inset-0.5 bg-zinc-400 rounded-sm" />
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="shrink-0 h-12 bg-black flex justify-center items-center">
                    <div className="w-28 h-7 bg-zinc-900 rounded-full flex items-center justify-center gap-2">
                      <div className="w-2 h-2 rounded-full bg-zinc-700" />
                      <div className="w-1.5 h-1.5 rounded-full bg-zinc-600" />
                    </div>
                  </div>
                )}
                {/* Screen */}
                <div className="flex-1 bg-white overflow-hidden relative">
                  {isReactVite &&
                    ["booting", "installing", "starting"].includes(wc.status) &&
                    renderWcBootOverlay()}
                  {renderIframe(undefined, { height: 780 })}
                </div>
                {/* Home bar (iOS) / Nav bar (Android) */}
                {platform === "android" ? (
                  <div className="shrink-0 bg-zinc-900 flex justify-center items-center gap-6 py-2.5">
                    <div className="w-5 h-5 border border-zinc-600 rounded-sm" />
                    <div className="w-4 h-4 rounded-full border border-zinc-600" />
                    <div className="w-0 h-0 border-t-[8px] border-t-zinc-600 border-r-[6px] border-r-transparent border-l-[6px] border-l-transparent" />
                  </div>
                ) : (
                  <div className="shrink-0 bg-black flex justify-center py-3">
                    <div className="w-24 h-1 rounded-full bg-zinc-600" />
                  </div>
                )}
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
                <div className="flex-1 bg-white overflow-hidden relative">
                  {isReactVite &&
                    ["booting", "installing", "starting"].includes(wc.status) &&
                    renderWcBootOverlay()}
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
                {isMobile
                  ? "Use the AI Builder below to describe your mobile app. MustaFlow will generate Expo/React Native code and a web preview here."
                  : "Use the AI Builder below to describe what you want to build. MustaFlow will generate your app and show a live preview here."}
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full">
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <BrainCircuit className="h-5 w-5 text-secondary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Plan Mode</div>
                  <div className="text-muted-foreground text-[11px]">
                    Generate a detailed plan before building
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 rounded-xl bg-muted/60 border border-border text-sm text-left">
                <Zap className="h-5 w-5 text-primary shrink-0" />
                <div>
                  <div className="font-medium text-foreground text-xs">Build First Draft</div>
                  <div className="text-muted-foreground text-[11px]">
                    Generate your app immediately from a prompt
                  </div>
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
        <div
          className="shrink-0 border-t border-zinc-800 bg-zinc-950 flex flex-col"
          style={{ height: 200 }}
        >
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
                      "group flex items-start gap-2 px-3 py-0.5 border-b border-zinc-900 hover:bg-zinc-900/50",
                      entry.isCrash
                        ? "bg-destructive/10 text-destructive"
                        : entry.level === "error"
                          ? "text-red-400 bg-red-950/20"
                          : entry.level === "warn"
                            ? "text-yellow-400"
                            : entry.level === "info"
                              ? "text-blue-400"
                              : "text-zinc-300",
                    )}
                  >
                    <span
                      className={cn(
                        "shrink-0 uppercase text-[9px] font-bold tracking-wider mt-0.5 w-7",
                        entry.isCrash
                          ? "text-destructive"
                          : entry.level === "error"
                            ? "text-red-500"
                            : entry.level === "warn"
                              ? "text-yellow-500"
                              : entry.level === "info"
                                ? "text-blue-500"
                                : "text-zinc-600",
                      )}
                    >
                      {entry.isCrash ? "CRASH" : entry.level}
                    </span>
                    <span className="flex-1 break-all whitespace-pre-wrap">
                      {entry.args.join(" ")}
                    </span>
                    {entry.level === "error" && onFixPrompt && (
                      <button
                        onClick={() => {
                          onFixPrompt(`Fix this runtime error: ${entry.args.join(" ")}`);
                        }}
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/60 hover:bg-red-800/80 text-red-300 hover:text-red-100 border border-red-800/50 mt-0.5"
                        title="Fix with AI"
                      >
                        <Wrench className="h-2.5 w-2.5" />
                        Fix with AI
                      </button>
                    )}
                    <span className="text-zinc-700 text-[9px] shrink-0 mt-0.5">
                      {new Date(entry.ts).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
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
              <span className="px-1.5 py-0.5 rounded-full bg-destructive/20 text-destructive text-[9px] font-bold">
                {errorCount} error{errorCount !== 1 ? "s" : ""}
              </span>
            )}
            {errorCount === 0 && warnCount > 0 && (
              <span className="px-1.5 py-0.5 rounded-full bg-yellow-500/20 text-yellow-400 text-[9px] font-bold">
                {warnCount} warning{warnCount !== 1 ? "s" : ""}
              </span>
            )}
            <div className="flex-1" />
            <ChevronUp className="h-3 w-3" />
          </button>
        </div>
      )}
    </div>
  );
}
