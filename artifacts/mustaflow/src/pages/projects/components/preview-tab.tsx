import { authFetch } from "@/lib/api-fetch";
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
  ChevronRight,
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
  ArrowLeft,
  ArrowRight,
  Home,
  Camera,
  Crosshair,
  EyeOff,
  ListTree,
  MousePointerClick,
  Type as TypeIcon,
  Palette,
  Code2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useState, useRef, useEffect, useCallback } from "react";
import { STATUS_LABELS, type UseWebContainerResult } from "@/hooks/use-web-container";
import type { ProjectFilesChangedPayload } from "@/lib/event-types";
import { logPreviewTiming, selectPreviewRevisionSubstrate } from "@/lib/preview-reconciliation";
import { cn } from "@/lib/utils";
import type { SnapshotObserveRequest, SnapshotObserveResult } from "@/lib/snapshot-observe";
import {
  useListProjectFiles,
  getListProjectFilesQueryKey,
  useListSecrets,
  getListSecretsQueryKey,
  type PreviewAccess,
} from "@workspace/api-client-react";
import {
  getPreviewAddress,
  getPreviewRecoveryControl,
  getServerPreviewBadge,
  hasServerPreviewAccess,
  presentAgenticPreviewUnavailable,
} from "@/lib/preview-access-ui";
import {
  fetchWorkspaceReadinessReceipt,
  WORKSPACE_READINESS_UNBLOCK_LABELS,
  type WorkspaceReadinessReceipt,
} from "@/lib/workspace-readiness";
import { SharePreviewControl } from "./share-preview-control";

type Platform = "web" | "ios" | "android";
type DeviceFrame = "desktop" | "tablet" | "mobile";

const DEVICE_LABELS: Record<DeviceFrame, string> = {
  desktop: "Desktop",
  tablet: "Tablet",
  mobile: "Mobile",
};

function rgbToHex(input: string): string {
  if (!input) return "";
  if (input.startsWith("#")) return input;
  const m = input.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (!m) return "";
  const h = (n: number) => n.toString(16).padStart(2, "0");
  return "#" + h(Number(m[1])) + h(Number(m[2])) + h(Number(m[3]));
}

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

type CaptureRect = { x: number; y: number; width: number; height: number };

function normalizedCaptureRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
): CaptureRect {
  return {
    x: Math.round(Math.min(startX, endX)),
    y: Math.round(Math.min(startY, endY)),
    width: Math.round(Math.abs(endX - startX)),
    height: Math.round(Math.abs(endY - startY)),
  };
}

type Project = {
  id: number;
  status: string;
  updatedAt: string;
  name?: string;
  kind?: string;
  projectFormat?: string;
  publicSlug?: string | null;
  /** Task #768: full-stack projects have a containerId. Presence gates Test Environment UI. */
  containerId?: string | null;
  /** Task #768: current testing workflow state. */
  testingStatus?: string | null;
  /** Task #768: version ID of the most recently approved test snapshot. */
  testedSnapshotId?: number | null;
  /** Task #768: live status of the test container. */
  testContainerStatus?: string | null;
  /** Task #738: builder mode — 'agentic' or 'static-legacy'. */
  builderMode?: string | null;
};

type TestEnvironmentStatus = {
  testingStatus: string;
  testingCandidateSnapshotId: number | null;
  runningTestSnapshotId: number | null;
  testedSnapshotId: number | null;
  testContainerStatus: string | null;
  isFullStack: boolean;
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
  onSnapshotObserve?: (request: SnapshotObserveRequest) => Promise<SnapshotObserveResult>;
  onOpenFileInEditor?: (fileId: number) => void;
  /** Server-side container status (Phase C). When provided, shows a waking/starting overlay. */
  containerStatus?: ContainerStatus;
  /** Proxied URL to the running container dev server. Shown in the address bar when active. */
  containerUrl?: string | null;
  /** Server-derived browser preview transport. Never inferred from containerUrl. */
  previewAccess?: PreviewAccess;
  /** Called when user clicks "Wake container" from the preview overlay. */
  onStartContainer?: () => void;
  /** Re-check provider truth without mutating runtime state. */
  onRefreshContainerStatus?: () => void;
  /** Most recent build report — used to populate the mobile readiness panel. */
  latestReport?: ReadinessReport | null;
  /** Switch to the Secrets / Tools panel so the user can fill in missing keys. */
  onJumpToSecrets?: () => void;
  /** Task #768: navigate to the Test Environment tab when the user wants to start / approve a test build. */
  onNavigateToTestEnv?: () => void;
  /** Refresh the project record after testing state changes. */
  onTestingStatusChanged?: () => void;
  /**
   * Incrementing counter: whenever this value changes the preview iframe
   * is force-reloaded so freshly-built files are visible immediately.
   * Pass a value that increments each time a build task completes.
   */
  refreshTrigger?: number;
  /**
   * Ref holding the latest ProjectFilesChangedPayload from a project_files_changed SSE event.
   * When filesPayloadSeq changes, PreviewTab syncs the payload into the WebContainer FS.
   */
  filesPayloadRef?: React.RefObject<ProjectFilesChangedPayload | null>;
  /** Increments each time a new files payload arrives — triggers the WC sync effect. */
  filesPayloadSeq?: number;
  /** Called only after file sync, dependency install, and dev-server readiness complete. */
  onPreviewRevisionApplied?: (payload: ProjectFilesChangedPayload) => void;
  /** Called when an authoritative revision cannot be applied to the WebContainer. */
  onPreviewRevisionFailed?: (payload: ProjectFilesChangedPayload) => void;
  /** A page-map card can request a concrete route without coupling to Preview internals. */
  navigationRequest?: { path: string; requestId: number } | null;
  /**
   * When true the active task is in needs_review / staged state. A banner is shown
   * informing the user that changes are staged and the preview reflects the last live
   * build, not the pending staged files.
   */
  isTaskStaged?: boolean;
  /** Durable terminal for the exact version represented by this preview. */
  readinessTerminal?: unknown;
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
  onSnapshotObserve,
  onOpenFileInEditor,
  containerStatus,
  containerUrl,
  previewAccess,
  onStartContainer,
  onRefreshContainerStatus,
  latestReport,
  onJumpToSecrets,
  onNavigateToTestEnv,
  onTestingStatusChanged,
  refreshTrigger,
  filesPayloadRef,
  filesPayloadSeq,
  onPreviewRevisionApplied,
  onPreviewRevisionFailed,
  navigationRequest,
  isTaskStaged,
  readinessTerminal,
}: PreviewTabProps) {
  const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(project.kind ?? "");
  const [readinessDismissed, setReadinessDismissed] = useState(false);
  const [snapshotObserveState, setSnapshotObserveState] = useState<
    | { kind: "idle" }
    | { kind: "sending" }
    | { kind: "success"; message: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const [regionCaptureOpen, setRegionCaptureOpen] = useState(false);
  const [captureRegion, setCaptureRegion] = useState<CaptureRect | null>(null);
  const [captureRedactions, setCaptureRedactions] = useState<CaptureRect[]>([]);
  const [captureAnnotation, setCaptureAnnotation] = useState("");
  const [markingRedaction, setMarkingRedaction] = useState(false);
  const [captureDrag, setCaptureDrag] = useState<{
    kind: "region" | "redaction";
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const pointContextWaiterRef = useRef<{
    requestId: string;
    resolve: (domPath: string | undefined) => void;
  } | null>(null);
  const [readinessExpanded, setReadinessExpanded] = useState(false);
  const [testEnvironmentStatus, setTestEnvironmentStatus] = useState<TestEnvironmentStatus | null>(
    null,
  );
  const [testEnvironmentBusy, setTestEnvironmentBusy] = useState(false);
  const [testEnvironmentError, setTestEnvironmentError] = useState<{
    code: string;
    message: string;
  } | null>(null);
  const [workspaceReadiness, setWorkspaceReadiness] = useState<WorkspaceReadinessReceipt | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    setWorkspaceReadiness(null);
    if (readinessTerminal == null) return () => undefined;
    void fetchWorkspaceReadinessReceipt({
      projectId: project.id,
      terminal: readinessTerminal,
      env: "testing",
      surface: "preview",
    })
      .then((receipt) => {
        if (!cancelled) setWorkspaceReadiness(receipt);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceReadiness(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, readinessTerminal]);
  const refreshTestEnvironment = useCallback(async () => {
    if (!project.containerId) return null;
    const response = await authFetch(`/api/projects/${project.id}/preview-env/status`);
    const body = (await response.json().catch(() => null)) as TestEnvironmentStatus | null;
    if (!response.ok || body === null) {
      throw new Error("The test environment status could not be read.");
    }
    setTestEnvironmentStatus(body);
    return body;
  }, [project.containerId, project.id]);
  useEffect(() => {
    if (!project.containerId || project.testingStatus === "passed") return;
    void refreshTestEnvironment().catch(() => {
      setTestEnvironmentError({
        code: "test_environment_status_unavailable",
        message: "The test environment status could not be read.",
      });
    });
  }, [project.containerId, project.testingStatus, refreshTestEnvironment]);
  useEffect(() => {
    if (testEnvironmentStatus?.testingStatus !== "building") return;
    const timer = window.setInterval(() => {
      void refreshTestEnvironment().catch(() => {
        setTestEnvironmentError({
          code: "test_environment_status_unavailable",
          message: "The test environment status could not be read.",
        });
      });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [refreshTestEnvironment, testEnvironmentStatus?.testingStatus]);
  const runTestEnvironmentAction = useCallback(
    async (action: "start" | "rebuild" | "approve") => {
      setTestEnvironmentBusy(true);
      setTestEnvironmentError(null);
      try {
        const response = await authFetch(`/api/projects/${project.id}/preview-env/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        const body = (await response.json().catch(() => null)) as
          | (Partial<TestEnvironmentStatus> & {
              code?: string;
              error?: string;
              testedSnapshotId?: number;
            })
          | null;
        if (!response.ok) {
          setTestEnvironmentError({
            code: body?.code ?? "test_environment_action_failed",
            message: body?.error ?? "The test environment action failed.",
          });
          return;
        }
        if (action === "approve") {
          setTestEnvironmentStatus((current) =>
            current === null
              ? null
              : {
                  ...current,
                  testingStatus: "passed",
                  testedSnapshotId: body?.testedSnapshotId ?? current.testingCandidateSnapshotId,
                },
          );
        } else {
          await refreshTestEnvironment();
        }
        onTestingStatusChanged?.();
      } catch {
        setTestEnvironmentError({
          code: "test_environment_transport_failed",
          message: "The test environment request could not be completed.",
        });
      } finally {
        setTestEnvironmentBusy(false);
      }
    },
    [onTestingStatusChanged, project.id, refreshTestEnvironment],
  );
  const effectiveTestingStatus =
    testEnvironmentStatus?.testingStatus ?? project.testingStatus ?? "idle";
  const startTestingAction = testEnvironmentStatus?.testingCandidateSnapshotId
    ? "rebuild"
    : "start";
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
  const activePreviewSyncRef = useRef<Promise<void> | null>(null);
  const syncFromBackend = wc.syncFromBackend;
  const previewRevisionSubstrate = selectPreviewRevisionSubstrate({
    containerId: project.containerId,
    containerStatus,
    webContainerReady: wc.status === "ready",
  });
  const syncPreviewPayload = useCallback(
    (payload: ProjectFilesChangedPayload, reloadAfter = false): Promise<void> => {
      const run = async (): Promise<void> => {
        const syncStartedAt = new Date().toISOString();
        logPreviewTiming({
          phase: "sync_start",
          projectId: payload.projectId,
          revision: payload.revision,
          backendEmittedAt: payload.generatedAt,
          syncStartedAt,
        });
        try {
          // Resolves only after writes, dependency installation, and any required
          // dev-server restart have reached WebContainer readiness.
          await syncFromBackend(payload);
          onPreviewRevisionApplied?.(payload);
          if (reloadAfter) setIframeKey((key) => key + 1);
        } catch (error) {
          logPreviewTiming({
            phase: "sync_failed",
            projectId: payload.projectId,
            revision: payload.revision,
            syncStartedAt,
            reason: error instanceof Error ? error.message : String(error),
          });
          onPreviewRevisionFailed?.(payload);
        }
      };
      const active = run();
      activePreviewSyncRef.current = active;
      void active.finally(() => {
        if (activePreviewSyncRef.current === active) activePreviewSyncRef.current = null;
      });
      return active;
    },
    [onPreviewRevisionApplied, onPreviewRevisionFailed, syncFromBackend],
  );
  const prevRefreshTriggerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (refreshTrigger === undefined) return;
    if (prevRefreshTriggerRef.current === undefined) {
      prevRefreshTriggerRef.current = refreshTrigger;
      return;
    }
    if (refreshTrigger !== prevRefreshTriggerRef.current) {
      prevRefreshTriggerRef.current = refreshTrigger;
      // Sync-first-then-reload: a live runtime already owns the authoritative
      // backend snapshot, while WebContainer-backed previews must finish their
      // browser-side file application before acknowledging the revision.
      const remaining = filesPayloadRef?.current ?? null;
      if (remaining && previewRevisionSubstrate === "live-runtime") {
        if (filesPayloadRef) filesPayloadRef.current = null;
        onPreviewRevisionApplied?.(remaining);
        setIframeKey((key) => key + 1);
      } else if (remaining && previewRevisionSubstrate === "webcontainer") {
        if (filesPayloadRef) filesPayloadRef.current = null;
        void syncPreviewPayload(remaining, true);
      } else if (activePreviewSyncRef.current) {
        void activePreviewSyncRef.current.then(() => setIframeKey((key) => key + 1));
      } else {
        setIframeKey((k) => k + 1);
      }
    }
  }, [
    refreshTrigger,
    filesPayloadRef,
    onPreviewRevisionApplied,
    previewRevisionSubstrate,
    syncPreviewPayload,
  ]);

  // When a project_files_changed SSE event arrives, acknowledge it through the
  // substrate that actually serves this preview. A live runtime needs a reload,
  // not a WebContainer write; WC-backed projects retain apply/failure receipts.
  // Clears filesPayloadRef.current before the async call to prevent double-apply if
  // the refreshTrigger effect races with a subsequent filesPayloadSeq increment.
  const prevFilesPayloadSeqRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (filesPayloadSeq === undefined) return;
    if (prevFilesPayloadSeqRef.current === filesPayloadSeq) return;
    if (!filesPayloadRef?.current) return;
    if (previewRevisionSubstrate === "waiting") return;
    prevFilesPayloadSeqRef.current = filesPayloadSeq;
    const payload = filesPayloadRef.current;
    filesPayloadRef.current = null; // clear before await — prevents double-apply
    if (previewRevisionSubstrate === "live-runtime") {
      onPreviewRevisionApplied?.(payload);
      setIframeKey((key) => key + 1);
      return;
    }
    void syncPreviewPayload(payload);
  }, [
    filesPayloadSeq,
    filesPayloadRef,
    onPreviewRevisionApplied,
    previewRevisionSubstrate,
    syncPreviewPayload,
  ]);
  const [healthWarning, setHealthWarning] = useState<string | null>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [validationDismissed, setValidationDismissed] = useState(false);
  const [nativeFeaturesDismissed, setNativeFeaturesDismissed] = useState(false);
  const prevWarningsRef = useRef<string[]>([]);
  const prevNativeFeaturesRef = useRef<string[]>([]);
  const [buildIssuesOpen, setBuildIssuesOpen] = useState(false);
  const [crashBanner, setCrashBanner] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [mocksOpen, setMocksOpen] = useState(false);

  // ── Visual Edit (Task #539) ──
  type VeSelection = {
    mfmId: string;
    tag: string;
    text: string;
    color: string;
    backgroundColor: string;
    padding: string;
    margin: string;
    width: string;
    height: string;
    display: string;
    textAlign: string;
    fontFamily: string;
    fontWeight: string;
    href: string;
    src: string;
    rect: { top: number; left: number; width: number; height: number };
  };
  const [editMode, setEditMode] = useState(false);
  const [veSessionId, setVeSessionId] = useState<string | null>(null);
  const [veCanUndo, setVeCanUndo] = useState(false);
  const [veSelection, setVeSelection] = useState<VeSelection | null>(null);
  const [veSelections, setVeSelections] = useState<VeSelection[]>([]);
  const [vePanel, setVePanel] = useState<
    null | "text" | "color" | "background" | "padding" | "layout" | "font" | "link"
  >(null);
  const [veDraftText, setVeDraftText] = useState("");
  const [veDraftColor, setVeDraftColor] = useState("#ffffff");
  const [veDraftPadding, setVeDraftPadding] = useState("");
  const [veDraftValue, setVeDraftValue] = useState("");
  const [veToast, setVeToast] = useState<string | null>(null);
  const [veDirectDrag, setVeDirectDrag] = useState<{
    kind: "resize" | "reorder";
    startX: number;
    startY: number;
    width: number;
    height: number;
    currentX: number;
    currentY: number;
  } | null>(null);
  const referenceOverlayInputRef = useRef<HTMLInputElement>(null);
  const [referenceOverlay, setReferenceOverlay] = useState<string | null>(null);
  const [referenceOpacity, setReferenceOpacity] = useState(50);
  // Tracks whether the in-iframe bridge has signalled "ready" for the current
  // iframe load (reset whenever iframeKey changes so reloads re-handshake).
  const veReadyRef = useRef(false);
  useEffect(() => {
    veReadyRef.current = false;
  }, [iframeKey]);
  // Notify the iframe whenever editMode toggles. The bridge announces itself
  // when possible, but always send the current mode as well:
  // the bridge's one-time ready message can legitimately arrive before this
  // parent listener mounts, while a later user toggle happens after the
  // iframe listener is ready. The bridge ready handler still replays the
  // mode for the opposite race (parent toggles before the iframe is ready).
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (win) {
      try {
        win.postMessage({ __mustaflow_edit: true, type: "setMode", on: editMode }, "*");
      } catch {
        /* cross-origin send is fine, target="*" */
      }
    }
    if (!editMode) {
      setVeSelection(null);
      setVeSelections([]);
      setVePanel(null);
    }
  }, [editMode, iframeKey]);
  useEffect(() => {
    if (!editMode) return;
    const timeout = window.setTimeout(() => {
      if (veReadyRef.current) return;
      setVeToast("This preview cannot be edited directly. Ask Zero to make the change instead.");
      setEditMode(false);
    }, 2_500);
    return () => window.clearTimeout(timeout);
  }, [editMode, iframeKey]);
  useEffect(() => {
    let cancelled = false;
    if (editMode && !veSessionId) {
      void authFetch(`/api/projects/${project.id}/visual-edit/sessions`, {
        method: "POST",
        credentials: "include",
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            sessionId?: string;
            error?: string;
          } | null;
          if (!response.ok || !body?.sessionId) throw new Error("visual edit session unavailable");
          if (!cancelled) setVeSessionId(body.sessionId);
        })
        .catch(() => {
          if (cancelled) return;
          setVeToast("Visual editing could not start. Nothing was changed.");
          setEditMode(false);
        });
    }
    if (!editMode && veSessionId) {
      const closingSessionId = veSessionId;
      void authFetch(`/api/projects/${project.id}/visual-edit/sessions/${closingSessionId}/close`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: "Restyled the current page" }),
      })
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as {
            versionId?: number | null;
          } | null;
          if (!response.ok) throw new Error("visual edit close unavailable");
          if (!cancelled) {
            setVeSessionId(null);
            setVeCanUndo(false);
            if (body?.versionId) {
              setVeToast(`Saved as restorable version #${body.versionId}`);
              setTimeout(() => setVeToast(null), 3000);
            }
          }
        })
        .catch(() => {
          if (!cancelled) {
            setVeToast("The edits remain saved, but the restorable version is still open.");
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [editMode, project.id, veSessionId]);
  const closeVe = useCallback(() => {
    setVeSelection(null);
    setVeSelections([]);
    setVePanel(null);
  }, []);
  // Apply edit — direct-patch fast path, with refine fallback
  const applyVisualEdit = useCallback(
    async (
      payload:
        | { kind: "text"; newText: string }
        | { kind: "color"; target: "color" | "background"; newColor: string }
        | { kind: "padding"; newPadding: string }
        | {
            kind: "style";
            property:
              | "width"
              | "height"
              | "margin"
              | "text-align"
              | "display"
              | "object-fit"
              | "font-family"
              | "font-weight";
            value: string;
          }
        | { kind: "attribute"; attribute: "href" | "src"; value: string }
        | { kind: "reorder"; direction: "up" | "down" }
        | { kind: "delete" },
    ) => {
      if (!veSelection || !veSessionId) {
        setVeToast("Visual editing is still starting. Please try that change again.");
        return;
      }
      const bulkEligible =
        payload.kind === "color" ||
        payload.kind === "padding" ||
        payload.kind === "style" ||
        payload.kind === "delete";
      if (veSelections.length > 1 && bulkEligible) {
        try {
          for (const selection of veSelections) {
            const body: Record<string, unknown> = {
              mfmId: selection.mfmId,
              sessionId: veSessionId,
              breakpoint: device,
              text: selection.text,
            };
            if (payload.kind === "color") {
              body.kind = "color";
              body.target = payload.target;
              body.oldColor =
                payload.target === "background" ? selection.backgroundColor : selection.color;
              body.newColor = payload.newColor;
            } else if (payload.kind === "padding") {
              body.kind = "padding";
              body.oldPadding = selection.padding;
              body.newPadding = payload.newPadding;
            } else if (payload.kind === "style") {
              body.kind = "style";
              body.property = payload.property;
              body.value = payload.value;
            } else {
              body.kind = "delete";
            }
            const response = await authFetch(`/api/projects/${project.id}/visual-edit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
              credentials: "include",
            });
            const result = (await response.json().catch(() => null)) as {
              patched?: boolean;
              suggestedPrompt?: string;
            } | null;
            if (!response.ok || !result?.patched) {
              throw new Error(result?.suggestedPrompt ?? "bulk visual edit unavailable");
            }
          }
          setVeCanUndo(true);
          setVeToast(`Saved the change to ${veSelections.length} selected elements`);
          setIframeKey((key) => key + 1);
        } catch {
          setVeToast(
            "The group change stopped before every element was updated. Review it or undo the session.",
          );
        }
        setTimeout(() => setVeToast(null), 3000);
        closeVe();
        return;
      }
      const win = iframeRef.current?.contentWindow;
      // Optimistic preview update
      try {
        if (payload.kind === "text") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "setText",
              mfmId: veSelection.mfmId,
              text: payload.newText,
            },
            "*",
          );
        } else if (payload.kind === "color") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: payload.target === "background" ? "setBackgroundColor" : "setColor",
              mfmId: veSelection.mfmId,
              color: payload.newColor,
            },
            "*",
          );
        } else if (payload.kind === "padding") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "setPadding",
              mfmId: veSelection.mfmId,
              padding: payload.newPadding,
            },
            "*",
          );
        } else if (payload.kind === "style") {
          const camelProperty = payload.property.replace(/-([a-z])/gu, (_match, letter: string) =>
            letter.toUpperCase(),
          );
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "setStyle",
              mfmId: veSelection.mfmId,
              property: camelProperty,
              value: payload.value,
            },
            "*",
          );
        } else if (payload.kind === "attribute") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "setAttribute",
              mfmId: veSelection.mfmId,
              attribute: payload.attribute,
              value: payload.value,
            },
            "*",
          );
        } else if (payload.kind === "reorder") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "move",
              mfmId: veSelection.mfmId,
              direction: payload.direction,
            },
            "*",
          );
        } else if (payload.kind === "delete") {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "delete",
              mfmId: veSelection.mfmId,
            },
            "*",
          );
        }
      } catch {
        /* ignore */
      }
      // Persist server-side (direct patch or refine fallback)
      try {
        const body: Record<string, unknown> = {
          mfmId: veSelection.mfmId,
          sessionId: veSessionId,
          breakpoint: device,
        };
        if (payload.kind === "text") {
          body.kind = "text";
          body.oldText = veSelection.text;
          body.newText = payload.newText;
        } else if (payload.kind === "color") {
          body.kind = "color";
          body.target = payload.target;
          body.oldColor =
            payload.target === "background" ? veSelection.backgroundColor : veSelection.color;
          body.newColor = payload.newColor;
          body.text = veSelection.text;
        } else if (payload.kind === "padding") {
          body.kind = "padding";
          body.oldPadding = veSelection.padding;
          body.newPadding = payload.newPadding;
          body.text = veSelection.text;
        } else if (payload.kind === "style") {
          body.kind = "style";
          body.property = payload.property;
          body.value = payload.value;
          body.text = veSelection.text;
        } else if (payload.kind === "attribute") {
          body.kind = "attribute";
          body.attribute = payload.attribute;
          body.value = payload.value;
          body.oldValue = payload.attribute === "href" ? veSelection.href : veSelection.src;
          body.text = veSelection.text;
        } else if (payload.kind === "reorder") {
          body.kind = "reorder";
          body.direction = payload.direction;
          body.text = veSelection.text;
        } else {
          body.kind = "delete";
          body.text = veSelection.text;
        }
        const res = await authFetch(`/api/projects/${project.id}/visual-edit`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        const json = (await res.json()) as {
          ok: boolean;
          patched: boolean;
          filePath?: string;
          fileId?: number;
          suggestedPrompt?: string;
        };
        if (json.patched) {
          setVeCanUndo(true);
          setVeToast(`Saved to ${json.filePath ?? "file"}`);
          setTimeout(() => setVeToast(null), 2500);
          // Sync the patched file into the WebContainer FS so Vite HMR delivers the
          // update instantly for React/Vite projects. Falls back to iframe reload for
          // static HTML projects (where WC is not active).
          if (wc.status === "ready" && json.filePath) {
            try {
              const fileRes = await authFetch(
                `/api/projects/${project.id}/preview/${json.filePath}`,
                {
                  credentials: "include",
                },
              );
              if (fileRes.ok) {
                const content = await fileRes.text();
                await wc.syncFromBackend({
                  projectId: project.id,
                  revision: 0,
                  changedPaths: [json.filePath],
                  files: { [json.filePath]: content },
                  removedPaths: [],
                  operationType: "visual-edit",
                  requiresInstall: false,
                  requiresRestart: false,
                  generatedAt: new Date().toISOString(),
                  authoritative: false,
                });
              }
            } catch {
              // Non-fatal — fall through to iframe reload
            }
          }
          // Reload so the iframe (static) or WC dev server reflect the change.
          setIframeKey((k) => k + 1);
        } else if (json.suggestedPrompt && (onAutoSendPrompt ?? onFixPrompt)) {
          const target = onAutoSendPrompt ?? onFixPrompt!;
          target(json.suggestedPrompt);
          setVeToast("Sent to NabuFlow…");
          setTimeout(() => setVeToast(null), 2500);
          setEditMode(false);
        }
      } catch {
        setVeToast("Visual edit failed");
        setTimeout(() => setVeToast(null), 2500);
      }
      closeVe();
    },
    [
      veSelection,
      veSelections,
      veSessionId,
      project.id,
      device,
      onAutoSendPrompt,
      onFixPrompt,
      closeVe,
      wc,
    ],
  );

  useEffect(() => {
    if (!veDirectDrag || !veSelection) return;
    const onMove = (event: PointerEvent) => {
      setVeDirectDrag((current) =>
        current ? { ...current, currentX: event.clientX, currentY: event.clientY } : null,
      );
      if (veDirectDrag.kind !== "resize") return;
      const width = Math.max(
        16,
        Math.round(veDirectDrag.width + event.clientX - veDirectDrag.startX),
      );
      const height = Math.max(
        16,
        Math.round(veDirectDrag.height + event.clientY - veDirectDrag.startY),
      );
      try {
        const win = iframeRef.current?.contentWindow;
        for (const [property, value] of [
          ["width", `${width}px`],
          ["height", `${height}px`],
        ] as const) {
          win?.postMessage(
            {
              __mustaflow_edit: true,
              type: "apply",
              action: "setStyle",
              mfmId: veSelection.mfmId,
              property,
              value,
            },
            "*",
          );
        }
      } catch {
        // The persisted edit remains authoritative if an optimistic frame update is unavailable.
      }
    };
    const onUp = (event: PointerEvent) => {
      const drag = veDirectDrag;
      setVeDirectDrag(null);
      if (drag.kind === "reorder") {
        const delta = event.clientY - drag.startY;
        if (Math.abs(delta) >= 20) {
          void applyVisualEdit({ kind: "reorder", direction: delta < 0 ? "up" : "down" });
        }
        return;
      }
      const width = Math.max(16, Math.round(drag.width + event.clientX - drag.startX));
      const height = Math.max(16, Math.round(drag.height + event.clientY - drag.startY));
      void (async () => {
        await applyVisualEdit({ kind: "style", property: "width", value: `${width}px` });
        await applyVisualEdit({ kind: "style", property: "height", value: `${height}px` });
      })();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [applyVisualEdit, veDirectDrag, veSelection]);

  const undoVisualEdit = useCallback(async () => {
    if (!veSessionId || !veCanUndo) return;
    try {
      const response = await authFetch(
        `/api/projects/${project.id}/visual-edit/sessions/${veSessionId}/undo`,
        { method: "POST", credentials: "include" },
      );
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? "undo unavailable");
      setVeToast("Last visual change undone");
      setVeCanUndo(false);
      setIframeKey((key) => key + 1);
    } catch (error) {
      setVeToast(error instanceof Error ? error.message : "That change could not be undone.");
    }
    setTimeout(() => setVeToast(null), 2500);
  }, [project.id, veCanUndo, veSessionId]);

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
      const res = await authFetch(`/api/projects/${project.id}/eas/builds`);
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
  type PreviewIssue = "proxy-unavailable" | "server-unreachable" | "container-error";
  const [previewIssue, setPreviewIssue] = useState<PreviewIssue | null>(null);

  const { data: files, isLoading: filesLoading } = useListProjectFiles(project.id, {
    query: {
      enabled: !!project.id,
      queryKey: getListProjectFilesQueryKey(project.id),
    },
  });

  const hasFiles = (files?.length ?? 0) > 0;
  const isLoading = filesLoading && files === undefined;

  // ── In-preview navigation: path stack, editable URL, routes dropdown ──
  // Iframe is sandboxed without same-origin, so we cannot read the iframe's
  // own location changes. The URL bar reflects explicit navigations made
  // from this toolbar (typing a path, clicking back/forward, picking a route).
  const [currentPath, setCurrentPath] = useState<string>("/");
  const [pathHistory, setPathHistory] = useState<string[]>(["/"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [urlInput, setUrlInput] = useState<string>("/");
  const [routesOpen, setRoutesOpen] = useState(false);

  const navigateTo = useCallback(
    (rawPath: string) => {
      const normalized = (() => {
        let p = rawPath.trim();
        if (!p) p = "/";
        if (!p.startsWith("/")) p = "/" + p;
        return p;
      })();
      setCurrentPath(normalized);
      setUrlInput(normalized);
      setPathHistory((prev) => {
        const trimmed = prev.slice(0, historyIndex + 1);
        if (trimmed[trimmed.length - 1] === normalized) return trimmed;
        return [...trimmed, normalized];
      });
      setHistoryIndex((prev) => {
        const trimmedLen = pathHistory.slice(0, prev + 1).length;
        const lastSame = pathHistory.slice(0, prev + 1)[trimmedLen - 1] === normalized;
        return lastSame ? prev : prev + 1;
      });
      setIframeKey((k) => k + 1);
      setRoutesOpen(false);
    },
    [historyIndex, pathHistory],
  );

  const handledNavigationRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (!navigationRequest || handledNavigationRequestRef.current === navigationRequest.requestId) {
      return;
    }
    handledNavigationRequestRef.current = navigationRequest.requestId;
    navigateTo(navigationRequest.path);
    // The request ID is the one-shot signal. navigateTo intentionally carries
    // local history state and must not replay the same external request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigationRequest?.requestId]);

  const goBack = useCallback(() => {
    setHistoryIndex((idx) => {
      const next = Math.max(0, idx - 1);
      const path = pathHistory[next] ?? "/";
      setCurrentPath(path);
      setUrlInput(path);
      setIframeKey((k) => k + 1);
      return next;
    });
  }, [pathHistory]);

  const goForward = useCallback(() => {
    setHistoryIndex((idx) => {
      const next = Math.min(pathHistory.length - 1, idx + 1);
      const path = pathHistory[next] ?? "/";
      setCurrentPath(path);
      setUrlInput(path);
      setIframeKey((k) => k + 1);
      return next;
    });
  }, [pathHistory]);

  const goHome = useCallback(() => {
    navigateTo("/");
  }, [navigateTo]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < pathHistory.length - 1;

  // Routes — derived from project files.
  //   • Top-level *.html → web routes (`/`, `/about.html`, …)
  //   • app/**/*.tsx (excluding _layout.tsx) → informational entries (Expo Router structure)
  const routes = (() => {
    const all = files ?? [];
    const webRoutes = all
      .filter((f) => /^[^/]+\.html$/.test(f.path))
      .map((f) => ({
        label: f.path === "index.html" ? "/" : `/${f.path}`,
        path: f.path === "index.html" ? "/" : `/${f.path}`,
        kind: "web" as const,
      }));
    const expoRoutes = all
      .filter((f) => f.path.startsWith("app/") && /\.(tsx|jsx)$/.test(f.path))
      .filter((f) => !/(^|\/)_layout\.(tsx|jsx)$/.test(f.path))
      .map((f) => {
        // app/index.tsx → /, app/(tabs)/home.tsx → /home, app/foo/[id].tsx → /foo/[id]
        let r = f.path.replace(/^app\//, "").replace(/\.(tsx|jsx)$/, "");
        r = r.replace(/\([^)]+\)\//g, ""); // strip route groups
        r = r === "index" ? "/" : "/" + r.replace(/\/index$/, "");
        return { label: r, path: r, kind: "expo" as const, fileId: f.id };
      });
    // Dedupe by path
    const seen = new Set<string>();
    return [...webRoutes, ...expoRoutes].filter((r) => {
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    });
  })();

  // Compose the iframe src from currentPath + cache-buster
  const previewSrc = (() => {
    const path = currentPath === "/" ? "/" : currentPath;
    const sep = path.includes("?") ? "&" : "?";
    return `/api/projects/${project.id}/preview${path}${sep}t=${iframeKey}`;
  })();

  // Backend file events are content-aware and coalesced by useWebContainer.
  // Build completion must not reboot the browser runtime: source edits belong
  // to Vite HMR, while dependency/config changes trigger their precise actions.
  const isAgentic = project.builderMode === "agentic";
  const serverPreviewLive = isAgentic && hasServerPreviewAccess(previewAccess);
  const agenticPreviewUnavailable = isAgentic && !serverPreviewLive;
  const previewRecoveryControl = getPreviewRecoveryControl({
    hasRuntime: Boolean(project.containerId),
    status: containerStatus,
  });
  const webContainerLive =
    isReactVite && !serverPreviewLive && wc.status === "ready" && wc.previewUrl != null;

  // Detect agentic preview failure class from the backend header. A 502 can mean
  // either the Fly proxy is unreachable or the app server crashed; keep those
  // separate so the UI suggests the right action.
  useEffect(() => {
    if (!serverPreviewLive) {
      setPreviewIssue(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await authFetch(`/api/projects/${project.id}/preview/?t=${Date.now()}`, {
          method: "GET",
          credentials: "include",
        });
        if (!cancelled) {
          const state = res.headers.get("X-MustaFlow-Preview-State");
          if (
            state === "proxy-unavailable" ||
            state === "server-unreachable" ||
            state === "container-error"
          ) {
            setPreviewIssue(state);
          } else {
            setPreviewIssue(null);
          }
        }
      } catch {
        // Network error — clear any stale flag so the iframe can attempt to load.
        if (!cancelled) setPreviewIssue(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [serverPreviewLive, project.id, iframeKey]);

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
      if (!data || typeof data !== "object") return;
      // ── Visual Edit messages (Task #539) ──
      if (data.__mustaflow_edit) {
        if (data.type === "modeApplied") {
          veReadyRef.current = true;
          return;
        }
        if (data.type === "pointContext") {
          const waiter = pointContextWaiterRef.current;
          if (waiter && waiter.requestId === data.requestId) {
            waiter.resolve(typeof data.mfmId === "string" ? data.mfmId : undefined);
            pointContextWaiterRef.current = null;
          }
          return;
        }
        if (data.type === "ready") {
          veReadyRef.current = true;
          // Replay current edit mode now that the bridge is listening.
          try {
            iframeRef.current?.contentWindow?.postMessage(
              { __mustaflow_edit: true, type: "setMode", on: editMode },
              "*",
            );
          } catch {
            /* ignore */
          }
          return;
        }
        if (data.type === "click" && typeof data.mfmId === "string") {
          const sel: VeSelection = {
            mfmId: data.mfmId,
            tag: String(data.tag ?? "div"),
            text: String(data.text ?? ""),
            color: String(data.color ?? ""),
            backgroundColor: String(data.backgroundColor ?? ""),
            padding: String(data.padding ?? ""),
            margin: String(data.margin ?? ""),
            width: String(data.width ?? ""),
            height: String(data.height ?? ""),
            display: String(data.display ?? ""),
            textAlign: String(data.textAlign ?? ""),
            fontFamily: String(data.fontFamily ?? ""),
            fontWeight: String(data.fontWeight ?? ""),
            href: String(data.href ?? ""),
            src: String(data.src ?? ""),
            rect: data.rect ?? { top: 0, left: 0, width: 0, height: 0 },
          };
          setVeSelections((current) => {
            const next = !data.additive
              ? [sel]
              : !data.selected
                ? current.filter((item) => item.mfmId !== sel.mfmId)
                : [...current.filter((item) => item.mfmId !== sel.mfmId), sel].slice(-20);
            setVeSelection(next.at(-1) ?? null);
            return next;
          });
          setVeDraftText(sel.text);
          setVeDraftColor(rgbToHex(sel.color) || "#ffffff");
          setVeDraftPadding(sel.padding || "");
          setVePanel(null);
        }
        return;
      }
      if (!data.__mustaflow) return;
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
  }, [editMode]);

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

  const requestServerStartupFix = useCallback(() => {
    const target = onAutoSendPrompt ?? onFixPrompt;
    target?.(
      "Fix the server startup so the container preview can run inside NabuFlow. Check the server logs, health endpoint, package scripts, and port binding.",
    );
  }, [onAutoSendPrompt, onFixPrompt]);

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

  const previewCaptureGeometry = useCallback(() => {
    const bounds = iframeRef.current?.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.round(bounds?.width ?? 1280));
    const cssHeight = Math.max(1, Math.round(bounds?.height ?? 800));
    return {
      bounds,
      cssWidth,
      cssHeight,
      viewport: {
        width: Math.min(1920, Math.max(320, cssWidth)),
        height: Math.min(1200, Math.max(240, cssHeight)),
      },
    };
  }, []);

  const askPreviewPointContext = useCallback(
    async (point: { x: number; y: number }): Promise<string | undefined> => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return undefined;
      const requestId = crypto.randomUUID();
      return await new Promise<string | undefined>((resolve) => {
        const timer = window.setTimeout(() => {
          if (pointContextWaiterRef.current?.requestId === requestId) {
            pointContextWaiterRef.current = null;
          }
          resolve(undefined);
        }, 800);
        pointContextWaiterRef.current = {
          requestId,
          resolve: (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
        };
        target.postMessage(
          { __mustaflow_edit: true, type: "describePoint", requestId, ...point },
          "*",
        );
      });
    },
    [],
  );

  const snapshotToAi = useCallback(async () => {
    if (!onSnapshotObserve || snapshotObserveState.kind === "sending") return;
    const { viewport } = previewCaptureGeometry();
    setSnapshotObserveState({ kind: "sending" });
    try {
      const result = await onSnapshotObserve({
        path: currentPath,
        previewSource: webContainerLive ? "webcontainer" : "server",
        viewport,
      });
      setSnapshotObserveState(
        result.ok
          ? { kind: "success", message: "Zero observed this preview in Chat." }
          : { kind: "error", message: result.message },
      );
    } catch {
      setSnapshotObserveState({
        kind: "error",
        message: "I couldn't capture this preview safely. Please try again.",
      });
    }
  }, [
    currentPath,
    onSnapshotObserve,
    previewCaptureGeometry,
    snapshotObserveState.kind,
    webContainerLive,
  ]);

  const closeRegionCapture = useCallback(() => {
    setRegionCaptureOpen(false);
    setCaptureRegion(null);
    setCaptureRedactions([]);
    setCaptureAnnotation("");
    setMarkingRedaction(false);
    setCaptureDrag(null);
  }, []);

  const sendRegionToAi = useCallback(async () => {
    if (!onSnapshotObserve || !captureRegion || snapshotObserveState.kind === "sending") return;
    const { cssWidth, cssHeight, viewport } = previewCaptureGeometry();
    const scaleX = viewport.width / cssWidth;
    const scaleY = viewport.height / cssHeight;
    const scaleRect = (rect: CaptureRect): CaptureRect => ({
      x: Math.max(0, Math.round(rect.x * scaleX)),
      y: Math.max(0, Math.round(rect.y * scaleY)),
      width: Math.max(16, Math.round(rect.width * scaleX)),
      height: Math.max(16, Math.round(rect.height * scaleY)),
    });
    const region = scaleRect(captureRegion);
    region.width = Math.min(region.width, viewport.width - region.x);
    region.height = Math.min(region.height, viewport.height - region.y);
    const domPath = await askPreviewPointContext({
      x: captureRegion.x + captureRegion.width / 2,
      y: captureRegion.y + captureRegion.height / 2,
    });
    setSnapshotObserveState({ kind: "sending" });
    try {
      const result = await onSnapshotObserve({
        path: currentPath,
        previewSource: webContainerLive ? "webcontainer" : "server",
        viewport,
        region,
        domPath,
        annotation: captureAnnotation.trim() || undefined,
        redactions: captureRedactions.map(scaleRect),
      });
      setSnapshotObserveState(
        result.ok
          ? { kind: "success", message: "Zero received this exact region in Chat." }
          : { kind: "error", message: result.message },
      );
      if (result.ok) closeRegionCapture();
    } catch {
      setSnapshotObserveState({
        kind: "error",
        message: "I couldn't capture this preview safely. Please try again.",
      });
    }
  }, [
    askPreviewPointContext,
    captureAnnotation,
    captureRedactions,
    captureRegion,
    closeRegionCapture,
    currentPath,
    onSnapshotObserve,
    previewCaptureGeometry,
    snapshotObserveState.kind,
    webContainerLive,
  ]);

  // Shared iframe renderer.
  // For react-vite projects with a live WebContainer dev server, the iframe points
  // at the WC-provided URL (no sandbox needed — WC handles its own isolation).
  // For static-html projects, the existing DB-served preview route is used.
  const renderIframe = (extraClass?: string, extraStyle?: React.CSSProperties) => {
    if (agenticPreviewUnavailable) {
      const presentation = presentAgenticPreviewUnavailable(containerStatus);
      const action = presentation.action === "wake" ? onStartContainer : onRefreshContainerStatus;
      return (
        <div
          className={cn(
            "flex h-full w-full items-center justify-center bg-[#0d0f17] px-6 text-center",
            extraClass,
          )}
          style={extraStyle}
          data-testid="agentic-preview-unavailable"
        >
          <div className="flex max-w-sm flex-col items-center gap-3">
            <ServerCrash className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">{presentation.title}</p>
              <p className="mt-1 text-xs text-muted-foreground">{presentation.message}</p>
            </div>
            {presentation.actionLabel && action && (
              <Button type="button" size="sm" onClick={action}>
                {presentation.actionLabel}
              </Button>
            )}
          </div>
        </div>
      );
    }
    const src = webContainerLive ? wc.previewUrl! : previewSrc;
    return (
      <iframe
        key={webContainerLive ? `wc-${device}-${wc.previewUrl}` : `src-${device}-${iframeKey}`}
        ref={iframeRef}
        src={src}
        title="App preview"
        aria-label="App preview"
        className={cn("w-full border-0", extraClass)}
        style={extraStyle}
        sandbox={
          webContainerLive
            ? "allow-scripts allow-forms allow-popups allow-same-origin allow-modals"
            : "allow-scripts allow-forms allow-popups"
        }
        onLoad={handleIframeLoad}
      />
    );
  };

  const renderReferenceOverlay = () =>
    referenceOverlay ? (
      <img
        src={referenceOverlay}
        alt="Visual reference overlay"
        className="pointer-events-none absolute inset-0 z-20 h-full w-full object-fill"
        style={{ opacity: referenceOpacity / 100 }}
        data-testid="preview-reference-overlay"
      />
    ) : null;

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

  // Compute toolbar overlay position from iframe + selection rect
  const veOverlayStyle: React.CSSProperties | null = (() => {
    if (!veSelection || !iframeRef.current) return null;
    const iframeRect = iframeRef.current.getBoundingClientRect();
    const top = iframeRect.top + veSelection.rect.top + veSelection.rect.height + 6;
    const left = iframeRect.left + veSelection.rect.left;
    return { position: "fixed", top, left, zIndex: 60 };
  })();
  const captureBounds = regionCaptureOpen ? iframeRef.current?.getBoundingClientRect() : null;
  const activeCaptureRect = captureDrag
    ? normalizedCaptureRect(
        captureDrag.startX,
        captureDrag.startY,
        captureDrag.currentX,
        captureDrag.currentY,
      )
    : null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Staged-state banner — shown when the active task is in needs_review mode */}
      {isTaskStaged && (
        <div className="flex items-center gap-2 px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-300 shrink-0">
          <Info className="h-3 w-3 shrink-0" />
          Changes are staged — apply to update preview
        </div>
      )}
      {/* Visual Edit toast */}
      {veToast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[70] px-3 py-1.5 rounded-md bg-zinc-900 border border-zinc-700 text-xs text-zinc-100 shadow-lg">
          {veToast}
        </div>
      )}
      {regionCaptureOpen && captureBounds && (
        <>
          <div
            className="fixed z-[65] cursor-crosshair bg-black/5 ring-2 ring-cyan-400/70"
            style={{
              left: captureBounds.left,
              top: captureBounds.top,
              width: captureBounds.width,
              height: captureBounds.height,
              touchAction: "none",
            }}
            aria-label={
              markingRedaction
                ? "Drag over private information to hide it"
                : "Drag over the preview region for Zero"
            }
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              event.currentTarget.setPointerCapture(event.pointerId);
              const point = {
                x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
                y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
              };
              setCaptureDrag({
                kind: markingRedaction ? "redaction" : "region",
                startX: point.x,
                startY: point.y,
                currentX: point.x,
                currentY: point.y,
              });
            }}
            onPointerMove={(event) => {
              if (!captureDrag) return;
              const rect = event.currentTarget.getBoundingClientRect();
              setCaptureDrag((current) =>
                current
                  ? {
                      ...current,
                      currentX: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
                      currentY: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
                    }
                  : null,
              );
            }}
            onPointerUp={(event) => {
              if (!captureDrag) return;
              event.currentTarget.releasePointerCapture(event.pointerId);
              const rect = normalizedCaptureRect(
                captureDrag.startX,
                captureDrag.startY,
                captureDrag.currentX,
                captureDrag.currentY,
              );
              if (rect.width >= 16 && rect.height >= 16) {
                if (captureDrag.kind === "redaction") {
                  setCaptureRedactions((current) => [...current, rect].slice(0, 12));
                  setMarkingRedaction(false);
                } else {
                  setCaptureRegion(rect);
                }
              }
              setCaptureDrag(null);
            }}
          >
            {captureRegion && (
              <div
                className="absolute border-2 border-cyan-400 bg-cyan-400/10"
                style={{
                  left: captureRegion.x,
                  top: captureRegion.y,
                  width: captureRegion.width,
                  height: captureRegion.height,
                }}
              />
            )}
            {captureRedactions.map((rect, index) => (
              <div
                key={`${rect.x}-${rect.y}-${index}`}
                className="absolute bg-black ring-1 ring-white/70"
                style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
              />
            ))}
            {activeCaptureRect && (
              <div
                className={cn(
                  "absolute border-2",
                  captureDrag?.kind === "redaction"
                    ? "border-white bg-black/80"
                    : "border-cyan-300 bg-cyan-300/10",
                )}
                style={{
                  left: activeCaptureRect.x,
                  top: activeCaptureRect.y,
                  width: activeCaptureRect.width,
                  height: activeCaptureRect.height,
                }}
              />
            )}
            {!captureRegion && !captureDrag && (
              <div className="absolute left-1/2 top-4 -translate-x-1/2 rounded-md bg-zinc-950/95 px-3 py-2 text-xs text-white shadow-xl">
                Drag over what you want Zero to see.
              </div>
            )}
          </div>
          {captureRegion && (
            <div
              className="fixed z-[66] flex w-[min(520px,calc(100vw-24px))] flex-col gap-2 rounded-lg border border-cyan-500/40 bg-zinc-950/95 p-3 text-white shadow-2xl"
              style={{
                left: Math.max(12, Math.min(captureBounds.left, window.innerWidth - 532)),
                top: Math.max(12, Math.min(captureBounds.bottom + 8, window.innerHeight - 156)),
              }}
            >
              <label className="text-xs font-medium" htmlFor="snapshot-annotation">
                What should Zero notice? <span className="text-zinc-500">Optional</span>
              </label>
              <input
                id="snapshot-annotation"
                value={captureAnnotation}
                onChange={(event) => setCaptureAnnotation(event.target.value.slice(0, 200))}
                onPointerDown={(event) => event.stopPropagation()}
                placeholder="For example: this button does nothing"
                className="rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-2 text-xs outline-none focus:border-cyan-500"
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" size="sm" variant="ghost" onClick={closeRegionCapture}>
                  Cancel
                </Button>
                {captureRedactions.length > 0 && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setCaptureRedactions((current) => current.slice(0, -1))}
                  >
                    Undo hide
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={markingRedaction ? "default" : "outline"}
                  className="gap-1.5"
                  onClick={() => setMarkingRedaction(true)}
                >
                  <EyeOff className="h-3.5 w-3.5" /> Hide private area
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="ml-auto gap-1.5"
                  disabled={snapshotObserveState.kind === "sending" || markingRedaction}
                  onClick={() => void sendRegionToAi()}
                >
                  {snapshotObserveState.kind === "sending" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Crosshair className="h-3.5 w-3.5" />
                  )}
                  Send exact region
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      {editMode && veDirectDrag && (
        <div className="pointer-events-none fixed inset-0 z-[69]" aria-hidden="true">
          <div className="absolute left-1/2 top-0 h-full border-l border-cyan-400/70" />
          <div className="absolute left-0 top-1/2 w-full border-t border-cyan-400/70" />
          <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded bg-cyan-950/90 px-2 py-1 text-[10px] text-cyan-100">
            {veDirectDrag.kind === "resize"
              ? "Release to save this size"
              : "Release above or below to reorder"}
          </div>
        </div>
      )}
      {/* Visual Edit inline toolbar — anchored under the selected iframe element */}
      {editMode && veSelection && veOverlayStyle && (
        <div
          style={veOverlayStyle}
          className="rounded-md border border-violet-500/40 bg-zinc-900/95 backdrop-blur shadow-xl p-1 flex flex-col gap-1 min-w-[220px] max-w-[320px]"
          role="dialog"
          aria-label="Visual edit toolbar"
        >
          <div className="flex items-center gap-1 px-1.5 pt-1 pb-0.5">
            <span className="text-[10px] uppercase tracking-wider text-violet-300 font-semibold">
              {veSelection.tag}
            </span>
            <span className="text-[10px] text-zinc-500 truncate flex-1">
              {veSelections.length > 1
                ? `${veSelections.length} elements selected · changes to style, spacing, visibility, and delete apply to all`
                : veSelection.text.slice(0, 40) || "(no text)"}
            </span>
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                setVeDirectDrag({
                  kind: "reorder",
                  startX: event.clientX,
                  startY: event.clientY,
                  width: veSelection.rect.width,
                  height: veSelection.rect.height,
                  currentX: event.clientX,
                  currentY: event.clientY,
                });
              }}
              className="inline-flex cursor-ns-resize items-center justify-center rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
              title="Drag up or down to reorder"
              aria-label="Drag selected element to reorder"
            >
              <ListTree className="h-3 w-3" />
            </button>
            <button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault();
                setVeDirectDrag({
                  kind: "resize",
                  startX: event.clientX,
                  startY: event.clientY,
                  width: veSelection.rect.width,
                  height: veSelection.rect.height,
                  currentX: event.clientX,
                  currentY: event.clientY,
                });
              }}
              className="inline-flex cursor-nwse-resize items-center justify-center rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
              title="Drag to resize"
              aria-label="Drag selected element to resize"
            >
              <Maximize2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              onClick={() => void applyVisualEdit({ kind: "reorder", direction: "up" })}
              className="inline-flex items-center justify-center text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
              title="Move before the previous sibling"
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => void applyVisualEdit({ kind: "reorder", direction: "down" })}
              className="inline-flex items-center justify-center text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
              title="Move after the next sibling"
            >
              ↓
            </button>
            {veCanUndo && (
              <button
                type="button"
                onClick={() => void undoVisualEdit()}
                className="text-[10px] text-zinc-400 hover:text-violet-300 px-1"
                title="Undo last visual change"
              >
                Undo
              </button>
            )}
            {onOpenFileInEditor && (
              <button
                type="button"
                onClick={async () => {
                  if (!veSelection?.text) return;
                  try {
                    const res = await authFetch(`/api/projects/${project.id}/visual-edit/resolve`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      credentials: "include",
                      body: JSON.stringify({ text: veSelection.text }),
                    });
                    if (res.ok) {
                      const j = (await res.json()) as { fileId?: number; filePath?: string };
                      if (typeof j.fileId === "number") {
                        onOpenFileInEditor(j.fileId);
                        closeVe();
                        return;
                      }
                    }
                    setVeToast("Couldn't find a unique source location");
                    setTimeout(() => setVeToast(null), 2500);
                  } catch {
                    setVeToast("Deep-link failed");
                    setTimeout(() => setVeToast(null), 2500);
                  }
                }}
                className="text-zinc-400 hover:text-violet-300 p-0.5"
                title="View in Code"
              >
                <Code2 className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={closeVe}
              className="text-zinc-500 hover:text-zinc-200 p-0.5"
              title="Close"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {vePanel === null && (
            <div className="grid grid-cols-4 items-center gap-1 px-1 pb-1">
              <button
                type="button"
                onClick={() => setVePanel("text")}
                className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                title="Edit text"
              >
                <TypeIcon className="h-3 w-3" /> Text
              </button>
              <button
                type="button"
                onClick={() => setVePanel("color")}
                className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                title="Edit color"
              >
                <Palette className="h-3 w-3" /> Color
              </button>
              <button
                type="button"
                onClick={() => setVePanel("padding")}
                className="flex-1 inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                title="Edit padding"
              >
                <LayoutTemplate className="h-3 w-3" /> Pad
              </button>
              <button
                type="button"
                onClick={() => {
                  setVeDraftValue(veSelection.width);
                  setVePanel("layout");
                }}
                className="inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                title="Size, margin, alignment, or visibility"
              >
                Layout
              </button>
              <button
                type="button"
                onClick={() => {
                  setVeDraftValue(veSelection.fontFamily);
                  setVePanel("font");
                }}
                className="inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                title="Font and weight"
              >
                Font
              </button>
              {(veSelection.tag === "a" || veSelection.tag === "img") && (
                <button
                  type="button"
                  onClick={() => {
                    setVeDraftValue(veSelection.tag === "a" ? veSelection.href : veSelection.src);
                    setVePanel("link");
                  }}
                  className="inline-flex items-center justify-center gap-1 text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                  title={veSelection.tag === "a" ? "Change link destination" : "Replace image"}
                >
                  {veSelection.tag === "a" ? "Link" : "Image"}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (window.confirm("Delete this element?")) {
                    void applyVisualEdit({ kind: "delete" });
                  }
                }}
                className="inline-flex items-center justify-center text-[11px] px-2 py-1 rounded bg-red-600/20 hover:bg-red-600/40 text-red-300"
                title="Delete element"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          )}
          {vePanel === "text" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              <textarea
                value={veDraftText}
                onChange={(e) => setVeDraftText(e.target.value)}
                rows={2}
                className="w-full text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500 resize-none"
                autoFocus
              />
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setVePanel(null)}
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Cancel
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => void applyVisualEdit({ kind: "text", newText: veDraftText })}
                  disabled={veDraftText === veSelection.text}
                  className="text-[11px] px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          {vePanel === "color" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  value={veDraftColor}
                  onChange={(e) => setVeDraftColor(e.target.value)}
                  className="h-7 w-10 rounded border border-zinc-700 bg-zinc-800 cursor-pointer"
                />
                <input
                  type="text"
                  value={veDraftColor}
                  onChange={(e) => setVeDraftColor(e.target.value)}
                  className="flex-1 text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500 font-mono"
                />
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setVePanel(null)}
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Cancel
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({
                      kind: "color",
                      target: "background",
                      newColor: veDraftColor,
                    })
                  }
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-100"
                >
                  Background
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({
                      kind: "color",
                      target: "color",
                      newColor: veDraftColor,
                    })
                  }
                  className="text-[11px] px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white"
                >
                  Text color
                </button>
              </div>
            </div>
          )}
          {vePanel === "padding" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              {(() => {
                const m = /^(\d+)px$/.exec(veDraftPadding.trim());
                const numeric = m ? Number(m[1]) : 0;
                return (
                  <>
                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={64}
                        step={1}
                        value={numeric}
                        onChange={(e) => setVeDraftPadding(`${e.target.value}px`)}
                        className="flex-1 accent-violet-500"
                        aria-label="Padding"
                      />
                      <span className="text-[11px] text-zinc-300 font-mono min-w-[44px] text-right">
                        {numeric}px
                      </span>
                    </div>
                    <input
                      type="text"
                      value={veDraftPadding}
                      onChange={(e) => setVeDraftPadding(e.target.value)}
                      placeholder="e.g. 16px or 16px 24px"
                      className="w-full text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500 font-mono"
                    />
                  </>
                );
              })()}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setVePanel(null)}
                  className="text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
                >
                  Cancel
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({ kind: "padding", newPadding: veDraftPadding })
                  }
                  disabled={!veDraftPadding}
                  className="text-[11px] px-2 py-1 rounded bg-violet-600 hover:bg-violet-500 text-white disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Apply
                </button>
              </div>
            </div>
          )}
          {vePanel === "layout" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              <input
                value={veDraftValue}
                onChange={(event) => setVeDraftValue(event.target.value)}
                placeholder="For example: 320px or 50%"
                className="w-full text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500 font-mono"
              />
              <div className="grid grid-cols-3 gap-1">
                {(["width", "height", "margin"] as const).map((property) => (
                  <button
                    key={property}
                    type="button"
                    onClick={() =>
                      void applyVisualEdit({ kind: "style", property, value: veDraftValue })
                    }
                    disabled={!veDraftValue}
                    className="rounded bg-zinc-800 px-2 py-1 text-[10px] capitalize text-zinc-100 hover:bg-zinc-700 disabled:opacity-40"
                  >
                    {property}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-4 gap-1">
                {(["left", "center", "right"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      void applyVisualEdit({ kind: "style", property: "text-align", value })
                    }
                    className="rounded bg-zinc-800 px-1 py-1 text-[10px] capitalize text-zinc-100 hover:bg-zinc-700"
                  >
                    {value}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({ kind: "style", property: "display", value: "none" })
                  }
                  className="rounded bg-amber-600/20 px-1 py-1 text-[10px] text-amber-200 hover:bg-amber-600/30"
                >
                  Hide
                </button>
              </div>
              <button
                type="button"
                onClick={() => setVePanel(null)}
                className="self-start text-[11px] px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300"
              >
                Cancel
              </button>
            </div>
          )}
          {vePanel === "font" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              <input
                value={veDraftValue}
                onChange={(event) => setVeDraftValue(event.target.value)}
                placeholder="Font family"
                className="w-full text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({
                      kind: "style",
                      property: "font-family",
                      value: veDraftValue,
                    })
                  }
                  disabled={!veDraftValue}
                  className="rounded bg-violet-600 px-2 py-1 text-[10px] text-white disabled:opacity-40"
                >
                  Apply family
                </button>
                {(["400", "600", "700"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() =>
                      void applyVisualEdit({ kind: "style", property: "font-weight", value })
                    }
                    className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
                  >
                    {value}
                  </button>
                ))}
              </div>
            </div>
          )}
          {vePanel === "link" && (
            <div className="px-1 pb-1 flex flex-col gap-1.5">
              <input
                value={veDraftValue}
                onChange={(event) => setVeDraftValue(event.target.value)}
                placeholder={veSelection.tag === "a" ? "https://example.com" : "Image URL"}
                className="w-full text-[12px] px-2 py-1 rounded bg-zinc-800 border border-zinc-700 text-zinc-100 focus:outline-none focus:border-violet-500"
              />
              <div className="flex gap-1">
                <button
                  type="button"
                  onClick={() => setVePanel(null)}
                  className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-300"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() =>
                    void applyVisualEdit({
                      kind: "attribute",
                      attribute: veSelection.tag === "a" ? "href" : "src",
                      value: veDraftValue,
                    })
                  }
                  disabled={!veDraftValue}
                  className="ml-auto rounded bg-violet-600 px-2 py-1 text-[10px] text-white disabled:opacity-40"
                >
                  Apply
                </button>
              </div>
              {veSelection.tag === "img" && (
                <div className="grid grid-cols-3 gap-1 border-t border-zinc-800 pt-1.5">
                  <button
                    type="button"
                    onClick={() =>
                      void applyVisualEdit({
                        kind: "style",
                        property: "object-fit",
                        value: "cover",
                      })
                    }
                    className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
                  >
                    Crop to frame
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const target = onAutoSendPrompt ?? onFixPrompt;
                      target?.(
                        `Remove the background from the selected image at ${veSelection.mfmId}. Use the shared Assets & Image Studio pipeline, replace the project reference, and keep the rest of the page unchanged.`,
                      );
                      setVeToast("Sent the selected image to Zero for background removal");
                      setEditMode(false);
                    }}
                    className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
                  >
                    Remove background
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const target = onAutoSendPrompt ?? onFixPrompt;
                      target?.(
                        `Generate a replacement for the selected image at ${veSelection.mfmId}. Use the shared Assets & Image Studio pipeline, ask one focused question only if the desired image is ambiguous, and keep the rest of the page unchanged.`,
                      );
                      setVeToast("Sent the selected image to Zero for replacement");
                      setEditMode(false);
                    }}
                    className="rounded bg-zinc-800 px-2 py-1 text-[10px] text-zinc-100 hover:bg-zinc-700"
                  >
                    Generate
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Preview toolbar */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-1.5 border-b border-border bg-card">
        <input
          ref={referenceOverlayInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            if (file.size > 25 * 1024 * 1024) {
              setVeToast("Choose a reference image smaller than 25 MB.");
              return;
            }
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") setReferenceOverlay(reader.result);
            };
            reader.readAsDataURL(file);
          }}
        />
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

        {referenceOverlay ? (
          <div className="flex items-center gap-1.5 rounded-lg border border-violet-500/30 bg-violet-500/10 px-2 py-1">
            <span className="text-[10px] font-medium text-violet-300">Reference</span>
            <input
              type="range"
              min={5}
              max={95}
              value={referenceOpacity}
              onChange={(event) => setReferenceOpacity(Number(event.target.value))}
              aria-label="Reference overlay opacity"
              className="w-20 accent-violet-500"
            />
            <button
              type="button"
              onClick={() => setReferenceOverlay(null)}
              className="text-[10px] text-violet-200 hover:text-white"
            >
              Clear
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => referenceOverlayInputRef.current?.click()}
            className="rounded-lg border border-border bg-muted px-2 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Add reference overlay
          </button>
        )}

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

        {/* ── Cluster divider ── */}
        {hasFiles && <div className="h-5 w-px bg-border shrink-0" />}

        {/* ── Navigation cluster: Back / Forward / Refresh / Home / URL bar / Routes ── */}
        {hasFiles && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={goBack}
              disabled={!canGoBack}
              title="Back"
              aria-label="Back"
              className={cn(
                "h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors",
                canGoBack
                  ? "text-foreground hover:bg-muted"
                  : "text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              <ArrowLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={goForward}
              disabled={!canGoForward}
              title="Forward"
              aria-label="Forward"
              className={cn(
                "h-7 w-7 inline-flex items-center justify-center rounded-md transition-colors",
                canGoForward
                  ? "text-foreground hover:bg-muted"
                  : "text-muted-foreground/40 cursor-not-allowed",
              )}
            >
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={refresh}
              title="Refresh preview"
              aria-label="Refresh"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-foreground hover:bg-muted transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={goHome}
              title="Home (/)"
              aria-label="Home"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-foreground hover:bg-muted transition-colors"
            >
              <Home className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Editable URL bar */}
        {hasFiles && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              navigateTo(urlInput);
            }}
            className="flex-1 min-w-[140px] max-w-md shrink"
          >
            <div className="flex items-center gap-1.5 px-2 py-1 bg-muted border border-border rounded-md focus-within:border-primary/40 focus-within:bg-background transition-colors">
              <Globe className="h-3 w-3 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                spellCheck={false}
                autoComplete="off"
                placeholder="/"
                className="flex-1 min-w-0 bg-transparent border-0 outline-none text-[11px] font-mono text-foreground placeholder:text-muted-foreground/50"
                aria-label="Preview path"
              />
            </div>
          </form>
        )}

        {/* Routes dropdown */}
        {hasFiles && routes.length > 0 && (
          <div className="relative shrink-0">
            <button
              onClick={() => setRoutesOpen((o) => !o)}
              title={`Routes (${routes.length})`}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium border transition-colors",
                routesOpen
                  ? "bg-primary/15 text-primary border-primary/30"
                  : "bg-muted text-muted-foreground border-border hover:text-foreground",
              )}
            >
              <ListTree className="h-3 w-3" />
              <span className="hidden sm:inline">Routes</span>
              <span className="text-[9px] font-bold opacity-60">{routes.length}</span>
              <ChevronDown className="h-2.5 w-2.5 opacity-60" />
            </button>
            {routesOpen && (
              <div className="absolute top-full left-0 mt-2 z-50 w-64 max-h-72 overflow-y-auto bg-popover border border-border rounded-xl shadow-2xl p-1">
                {routes.map((r) => (
                  <button
                    key={`${r.kind}:${r.path}`}
                    onClick={() => {
                      if (r.kind === "web") {
                        navigateTo(r.path);
                      } else {
                        setRoutesOpen(false);
                        if ("fileId" in r && r.fileId && onOpenFileInEditor) {
                          onOpenFileInEditor(r.fileId);
                        }
                      }
                    }}
                    className={cn(
                      "w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-md text-[11px] hover:bg-muted transition-colors",
                      r.kind === "web" && r.path === currentPath
                        ? "bg-primary/10 text-primary"
                        : "text-foreground",
                    )}
                    title={
                      r.kind === "web" ? `Navigate to ${r.path}` : `Open source file for ${r.path}`
                    }
                  >
                    {r.kind === "web" ? (
                      <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <Smartphone className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                    <span className="font-mono truncate flex-1">{r.label}</span>
                    {r.kind === "expo" && (
                      <span className="text-[9px] px-1 rounded bg-muted text-muted-foreground shrink-0">
                        source
                      </span>
                    )}
                  </button>
                ))}
                <div className="px-2 py-1 mt-1 border-t border-border text-[10px] text-muted-foreground">
                  Web routes navigate the preview. Expo routes open the source file.
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Cluster divider ── */}
        {hasFiles && <div className="h-5 w-px bg-border shrink-0" />}

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
                        Run and approve a test preview in NabuFlow first. A public QR code is
                        available after you choose to publish.
                      </p>
                    </div>
                    <button
                      onClick={() => setQrOpen(false)}
                      className="text-[11px] text-muted-foreground hover:text-primary hover:underline"
                    >
                      Publishing options
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

        {/* Runtime mode badge — shows which preview engine is active */}
        {(() => {
          const serverBadge = getServerPreviewBadge(previewAccess);
          let label: string;
          let subtitle: string;
          let badgeClass: string;
          if (isAgentic && serverBadge) {
            label = serverBadge.label;
            subtitle = serverBadge.subtitle;
            badgeClass = "bg-blue-500/15 text-blue-400 border-blue-500/25";
          } else if (webContainerLive) {
            label = "Quick Preview — WebContainer";
            subtitle = "In-browser sandbox; some Node.js APIs unavailable";
            badgeClass = "bg-violet-500/15 text-violet-400 border-violet-500/25";
          } else if (project.status === "published") {
            label = "Published Version";
            subtitle = "Showing the frozen published snapshot";
            badgeClass = "bg-green-500/15 text-green-400 border-green-500/25";
          } else {
            label = "Quick Preview — Static";
            subtitle = "Frontend only — backend routes not available";
            badgeClass = "bg-muted text-muted-foreground border-border";
          }
          return (
            <div
              className={cn(
                "hidden lg:flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium border shrink-0 cursor-default",
                badgeClass,
              )}
              title={subtitle}
            >
              <span>{label}</span>
            </div>
          );
        })()}

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

        {/* Explicit recovery stays reachable even when provider metadata is stale. */}
        {previewRecoveryControl && onStartContainer && (
          <button
            type="button"
            onClick={onStartContainer}
            disabled={previewRecoveryControl.disabled}
            className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-medium transition-colors shrink-0 border bg-muted text-muted-foreground border-border hover:text-foreground disabled:cursor-wait disabled:opacity-60"
            title={previewRecoveryControl.label}
          >
            <RefreshCw
              className={cn("h-3 w-3", previewRecoveryControl.disabled && "animate-spin")}
            />
            <span className="hidden sm:inline">{previewRecoveryControl.label}</span>
          </button>
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

        {/* ── Share / Snapshot / Focus cluster ── */}
        <div className="flex items-center gap-1 shrink-0">
          {hasFiles && (
            <SharePreviewControl
              projectId={project.id}
              runtimeRunning={serverPreviewLive}
              readiness={workspaceReadiness}
            />
          )}
          {hasFiles && onSnapshotObserve && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={snapshotToAi}
                disabled={snapshotObserveState.kind === "sending"}
                title="Ask Zero to observe this preview"
              >
                {snapshotObserveState.kind === "sending" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Camera className="h-3.5 w-3.5" />
                )}
              </Button>
              <Button
                variant={regionCaptureOpen ? "default" : "ghost"}
                size="icon"
                className="h-7 w-7"
                onClick={() => {
                  setEditMode(false);
                  setRegionCaptureOpen(true);
                  setCaptureRegion(null);
                  setCaptureRedactions([]);
                  setCaptureAnnotation("");
                }}
                disabled={snapshotObserveState.kind === "sending"}
                title="Point to a region for Zero"
                aria-pressed={regionCaptureOpen}
              >
                <Crosshair className="h-3.5 w-3.5" />
              </Button>
            </>
          )}
          {(snapshotObserveState.kind === "success" || snapshotObserveState.kind === "error") && (
            <span
              role={snapshotObserveState.kind === "error" ? "alert" : "status"}
              className={cn(
                "max-w-56 text-[10px]",
                snapshotObserveState.kind === "error" ? "text-destructive" : "text-emerald-500",
              )}
            >
              {snapshotObserveState.message}
            </span>
          )}
          {hasFiles && (
            <Button
              variant={editMode ? "default" : "ghost"}
              size="icon"
              className={cn("h-7 w-7", editMode && "bg-violet-600 hover:bg-violet-500 text-white")}
              onClick={() => setEditMode((v) => !v)}
              title={
                editMode
                  ? "Exit visual edit"
                  : isReactVite
                    ? "Visual edit — clicks fall back to a refine prompt in the React/Vite preview"
                    : "Visual edit — click elements to change text, colors, padding"
              }
              aria-pressed={editMode}
            >
              <MousePointerClick className="h-3.5 w-3.5" />
            </Button>
          )}
          {hasFiles && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2.5 gap-1.5 text-[11px] font-medium"
              asChild
              title="Open preview in a new browser tab"
            >
              <a href={previewSrc} target="_blank" rel="noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
                Open
              </a>
            </Button>
          )}
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

      {workspaceReadiness && (
        <div
          className={cn(
            "absolute left-3 right-3 top-12 z-20 rounded-md border px-3 py-2 text-xs shadow-sm",
            workspaceReadiness.presentation.canCelebrate
              ? "border-emerald-500/25 bg-emerald-950/90 text-emerald-100"
              : "border-amber-500/25 bg-amber-950/90 text-amber-100",
          )}
          data-testid="preview-workspace-readiness"
        >
          <p className="font-semibold">{workspaceReadiness.presentation.title}</p>
          <p className="mt-0.5">{workspaceReadiness.presentation.message}</p>
          {workspaceReadiness.presentation.unblock && (
            <p className="mt-1 font-medium">
              {WORKSPACE_READINESS_UNBLOCK_LABELS[workspaceReadiness.presentation.unblock]}
            </p>
          )}
        </div>
      )}

      {/* Container waking/starting banner — Phase C server-side containers */}
      {/* Task #768: testing gate nudge — shown for full-stack projects whose draft is not yet test-approved */}
      {project.containerId && effectiveTestingStatus !== "passed" && (
        <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-between gap-2 px-3 py-2 text-xs bg-amber-500/10 border-t border-amber-500/20 text-amber-700 dark:text-amber-400">
          <div className="min-w-0 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <span>
                {effectiveTestingStatus === "stale"
                  ? "Draft changed after last test — run a new test before publishing."
                  : effectiveTestingStatus === "ready"
                    ? "The sealed test candidate is awaiting your review. Approve it to unlock production publishing."
                    : effectiveTestingStatus === "building"
                      ? "The exact sealed test candidate is being prepared."
                      : "Start a test build to preview and approve this app before publishing."}
              </span>
              {testEnvironmentError && (
                <p className="truncate text-[10px] text-destructive">
                  {workspaceReadiness?.presentation.message ??
                    "The test candidate needs attention. Open its details or retry it."}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            disabled={testEnvironmentBusy || effectiveTestingStatus === "building"}
            onClick={() =>
              void runTestEnvironmentAction(
                effectiveTestingStatus === "ready" ? "approve" : startTestingAction,
              )
            }
            className="shrink-0 rounded-md border border-amber-500/30 bg-background/70 px-2.5 py-1 font-semibold hover:bg-background focus:outline-none disabled:cursor-wait disabled:opacity-60"
          >
            {testEnvironmentBusy || effectiveTestingStatus === "building"
              ? "Testing…"
              : effectiveTestingStatus === "ready"
                ? "Approve test"
                : startTestingAction === "rebuild"
                  ? "Rebuild test"
                  : "Start test"}
          </button>
        </div>
      )}
      {!webContainerLive &&
        containerStatus &&
        ["starting", "hibernated"].includes(containerStatus) && (
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

      {/* Mobile preview readiness panel — explains why buttons may not "work" + secret checklist */}
      {showMobileReadiness && (
        <div className="shrink-0 border-b border-purple-500/30 bg-purple-500/5 dark:bg-purple-500/8">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <button
              type="button"
              onClick={() => setReadinessExpanded((v) => !v)}
              className="flex-1 flex items-center gap-2 text-left hover:opacity-80 transition-opacity"
              aria-expanded={readinessExpanded}
              title={readinessExpanded ? "Hide details" : "Show details"}
            >
              <Smartphone className="h-3.5 w-3.5 text-purple-700 dark:text-purple-300 shrink-0" />
              <span className="flex-1 text-[11px] font-semibold text-purple-700 dark:text-purple-300">
                Mobile preview readiness — what works here vs. on a real device
              </span>
              {missingSecrets.length > 0 && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                  {missingSecrets.length} missing
                </span>
              )}
              <ChevronRight
                className={cn(
                  "h-3.5 w-3.5 text-purple-700/70 dark:text-purple-300/70 shrink-0 transition-transform",
                  readinessExpanded && "rotate-90",
                )}
              />
            </button>
            <button
              type="button"
              onClick={() => setReadinessDismissed(true)}
              className="shrink-0 text-purple-700/60 hover:text-purple-700 dark:text-purple-300/60 dark:hover:text-purple-300 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {readinessExpanded && (
            <div className="px-3 pb-2 space-y-1.5">
              <div className="flex items-start gap-2 bg-purple-500/10 border border-purple-500/30 rounded-lg px-2.5 py-2">
                <Info className="h-3 w-3 text-purple-700 dark:text-purple-300 shrink-0 mt-0.5" />
                <span className="flex-1 text-[11px] text-purple-900 dark:text-purple-200/90 leading-relaxed">
                  This window shows an <span className="font-semibold">interactive mockup</span> of
                  your mobile app rendered in the browser. Buttons give visual feedback so you can
                  walk the flow, but anything that needs the phone&apos;s camera, GPS, push, deep
                  links, or a backend only runs on a real device — scan the Expo Go QR above to test
                  for real.
                </span>
              </div>

              {requiredSecretsFromReport.length > 0 && (
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg px-2.5 py-2">
                  <div className="flex items-center gap-2 mb-1.5">
                    <Plug className="h-3 w-3 text-purple-700 dark:text-purple-300 shrink-0" />
                    <span className="text-[11px] font-semibold text-purple-900 dark:text-purple-200">
                      Secrets needed for full functionality (
                      {setSecretNames.size > 0
                        ? `${requiredSecretsFromReport.length - missingSecrets.length}/${requiredSecretsFromReport.length} set`
                        : `0/${requiredSecretsFromReport.length} set`}
                      )
                    </span>
                    {onJumpToSecrets && missingSecrets.length > 0 && (
                      <button
                        onClick={onJumpToSecrets}
                        className="ml-auto shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-purple-500/25 border border-purple-500/40 text-purple-900 dark:text-purple-100 hover:bg-purple-500/40 transition-colors whitespace-nowrap"
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
                              ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-700 dark:text-emerald-300"
                              : "bg-amber-500/10 border-amber-500/40 text-amber-700 dark:text-amber-300",
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
                <div className="bg-purple-500/10 border border-purple-500/30 rounded-lg px-2.5 py-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Smartphone className="h-3 w-3 text-purple-700 dark:text-purple-300 shrink-0" />
                    <span className="text-[11px] font-semibold text-purple-900 dark:text-purple-200">
                      Device-only features in this app
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(latestReport?.nativeFeatures ?? []).map((f) => (
                      <span
                        key={f}
                        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border bg-blue-500/10 border-blue-500/40 text-blue-700 dark:text-blue-300"
                      >
                        <Smartphone className="h-2.5 w-2.5" />
                        {f}
                      </span>
                    ))}
                  </div>
                  <p className="text-[10px] text-purple-700/70 dark:text-purple-300/60 mt-1">
                    These need a real phone — they will be simulated in the preview but only run on
                    device through Expo Go.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Native features notice — mobile projects only */}
      {isMobile && nativeFeatures.length > 0 && !nativeFeaturesDismissed && (
        <div className="shrink-0 border-b border-blue-500/30 bg-blue-500/5 dark:bg-blue-500/8">
          <div className="flex items-center gap-2 px-3 pt-2 pb-1.5">
            <ShieldAlert className="h-3.5 w-3.5 text-blue-700 dark:text-blue-400 shrink-0" />
            <span className="flex-1 text-[11px] font-semibold text-blue-700 dark:text-blue-400">
              Native device features detected — web preview may not show full functionality
            </span>
            <button
              onClick={() => setNativeFeaturesDismissed(true)}
              className="shrink-0 text-blue-700/60 hover:text-blue-700 dark:text-blue-400/60 dark:hover:text-blue-400 transition-colors"
              title="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          <div className="px-3 pb-2 space-y-1">
            {nativeFeatures.map((feature, idx) => (
              <div
                key={idx}
                className="flex items-center gap-2 bg-blue-500/10 border border-blue-500/30 rounded-lg px-2.5 py-1.5"
              >
                <Smartphone className="h-3 w-3 text-blue-700 dark:text-blue-400 shrink-0" />
                <span className="flex-1 text-[11px] text-blue-800 dark:text-blue-300/90">
                  {feature}
                </span>
                <span className="text-[10px] text-blue-700/70 dark:text-blue-400/60 shrink-0">
                  Requires real device
                </span>
              </div>
            ))}
            <p className="text-[10px] text-blue-700/70 dark:text-blue-400/60 px-0.5 pt-0.5">
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
                const vRes = await authFetch(`/api/projects/${project.id}/versions`);
                if (vRes.ok) {
                  const versions = (await vRes.json()) as Array<{ id: number; label: string }>;
                  // Skip the first (current) version and roll back to the second
                  const target = versions[1];
                  if (target) {
                    const rbRes = await authFetch(
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
        ) : isAgentic && previewIssue ? (
          /* Agentic preview issue empty state */
          <div className="flex flex-col items-center justify-center h-full max-w-sm text-center gap-5 py-12">
            <div className="w-16 h-16 rounded-2xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center">
              <ServerCrash className="h-8 w-8 text-amber-500/60" />
            </div>
            <div className="space-y-2">
              <h3 className="text-base font-semibold text-foreground">
                {previewIssue === "proxy-unavailable"
                  ? "Container preview is unavailable in this development environment"
                  : "Container server is not responding"}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {previewIssue === "proxy-unavailable"
                  ? "The app files are still saved in NabuFlow. Use the test preview tools to start, retry, or inspect the container runtime."
                  : "The app files are saved, but the container app has not passed its health check. Inspect logs, fix startup, then retry the preview."}
              </p>
            </div>
            <div className="flex flex-col gap-2 w-full">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {previewIssue === "proxy-unavailable" && onNavigateToTestEnv && (
                  <Button onClick={onNavigateToTestEnv} size="sm" className="gap-2">
                    <Zap className="h-4 w-4" />
                    Start test preview
                  </Button>
                )}
                {previewIssue !== "proxy-unavailable" && (onAutoSendPrompt ?? onFixPrompt) && (
                  <Button onClick={requestServerStartupFix} size="sm" className="gap-2">
                    <Wrench className="h-4 w-4" />
                    Fix server startup
                  </Button>
                )}
                <Button onClick={refresh} size="sm" variant="secondary" className="gap-2">
                  <RefreshCw className="h-4 w-4" />
                  Retry preview
                </Button>
                <Button
                  onClick={() => setConsoleOpen(true)}
                  size="sm"
                  variant="secondary"
                  className="gap-2"
                >
                  <Terminal className="h-4 w-4" />
                  View logs
                </Button>
              </div>
              {previewIssue === "proxy-unavailable" && (onAutoSendPrompt ?? onFixPrompt) && (
                <Button
                  onClick={requestServerStartupFix}
                  size="sm"
                  variant="outline"
                  className="gap-2 w-full"
                >
                  <Wrench className="h-4 w-4" />
                  Fix server startup
                </Button>
              )}
              {onNavigateToTestEnv && (
                <button
                  type="button"
                  onClick={onNavigateToTestEnv}
                  className="text-[11px] text-muted-foreground hover:text-primary hover:underline"
                >
                  Rebuild test preview
                </button>
              )}
            </div>
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
                    {getPreviewAddress({
                      previewAccess,
                      containerUrl,
                      webContainerUrl: isReactVite ? wc.previewUrl : null,
                      projectId: project.id,
                    })}
                  </span>
                </div>
              </div>
              {/* iframe — with WC boot overlay while installing/starting */}
              <div className="flex-1 min-h-0 bg-white overflow-hidden relative">
                {isReactVite &&
                  ["booting", "installing", "starting"].includes(wc.status) &&
                  renderWcBootOverlay()}
                {renderIframe("h-full")}
                {renderReferenceOverlay()}
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
                  {renderReferenceOverlay()}
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
                  {renderReferenceOverlay()}
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
                  ? "Use NabuFlow below to describe your mobile app. NabuFlow will generate Expo/React Native code and a web preview here."
                  : "Use NabuFlow below to describe what you want to build. NabuFlow will generate your app and show a live preview here."}
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
              Type your idea in NabuFlow below and press Enter or click Send
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

      {/* Build Issues drawer — collapsible, sits above the console strip */}
      {validationWarnings.length > 0 && !validationDismissed && (
        <div className="shrink-0 border-t border-orange-500/20 bg-orange-500/5 dark:bg-orange-950/20">
          <div className="flex items-center">
            <button
              onClick={() => setBuildIssuesOpen((v) => !v)}
              className="flex-1 flex items-center gap-2 px-3 py-1.5 text-[11px] hover:bg-orange-500/5 transition-colors text-left"
            >
              <AlertTriangle className="h-3 w-3 text-orange-500 shrink-0" />
              <span className="text-orange-700 dark:text-orange-400 font-semibold">
                Build Issues
              </span>
              <span className="px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-700 dark:text-orange-300 text-[9px] font-bold leading-none">
                {validationWarnings.length}
              </span>
              <div className="flex-1" />
              {buildIssuesOpen ? (
                <ChevronDown className="h-3 w-3 text-orange-500/70 shrink-0" />
              ) : (
                <ChevronUp className="h-3 w-3 text-orange-500/70 shrink-0" />
              )}
            </button>
            <button
              onClick={() => setValidationDismissed(true)}
              className="shrink-0 px-2 py-1.5 text-orange-500/40 hover:text-orange-500/70 transition-colors"
              title="Dismiss build issues"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
          {buildIssuesOpen && (
            <div className="px-3 pb-2.5 space-y-1.5 max-h-48 overflow-y-auto">
              {validationWarnings.map((warning, idx) => (
                <div
                  key={idx}
                  className="flex items-start gap-2 bg-orange-500/8 border border-orange-500/20 rounded-lg px-2.5 py-2"
                >
                  <Wrench className="h-3 w-3 text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
                  <span className="flex-1 text-[11px] text-orange-800 dark:text-orange-300/90 leading-relaxed">
                    {warning}
                  </span>
                  {onFixPrompt && (
                    <button
                      onClick={() => onFixPrompt(`Fix this issue: ${warning}`)}
                      className="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-md bg-orange-500/20 border border-orange-500/40 text-orange-800 dark:text-orange-300 hover:bg-orange-500/30 transition-colors whitespace-nowrap"
                    >
                      Ask AI to fix
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
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
