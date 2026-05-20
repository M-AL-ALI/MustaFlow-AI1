import { useParams } from "wouter";
import { CreateProjectModal } from "@/components/create-project-modal";
import {
  useGetProject,
  useListMessages,
  useListVersions,
  useListProjectFiles,
  useSendMessage,
  useListTasks,
  useRollbackVersion,
  useListSuggestions,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
  getGetPageMapQueryKey,
  getListSuggestionsQueryKey,
} from "@workspace/api-client-react";
import { BuildProgressFeed } from "@/components/build-progress-feed";
import { CodeEditorTab } from "./components/code-editor-tab";
import { ChatHistory } from "./components/chat-history";
import { PageMapTab } from "./components/page-map-tab";
import { Button } from "@/components/ui/button";
import {
  Settings,
  History,
  FileCode2,
  Blocks,
  Globe,
  TerminalSquare,
  BrainCircuit,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  KeyRound,
  Paintbrush2,
  Activity,
  Rocket,
  Sparkles,
  Monitor,
  Wrench,
  Plus,
  MessageSquare,
  ExternalLink,
  BookOpen,
  ChevronRight,
  X,
  Puzzle,
  ListOrdered,
  ShieldCheck,
  Bookmark,
  Layers2,
  RotateCcw,
} from "lucide-react";
import { SuggestionChips } from "./components/suggestion-chips";
import { SavedSuggestionsTab } from "./components/saved-suggestions-tab";
import { QueueComposer } from "./components/queue-composer";
import { QueueProgressStrip } from "./components/queue-progress-strip";
import { BackgroundTasksDrawer, type BgTask } from "./components/background-tasks-drawer";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
import { IntegrationSetupCard } from "./components/integration-setup-card";
import { ToolsTab } from "./components/tools-tab";
import { PublishingTab } from "./components/publishing-tab";
import { LogsTab } from "./components/logs-tab";
import { AnalyticsTab } from "./components/analytics-tab";
import { ResourcesTab } from "./components/resources-tab";
import { ManageTab } from "./components/manage-tab";
import { KnowledgeTab } from "./components/knowledge-tab";
import { InlineLiveActivity } from "./components/activity-stream";
import { HistoryTab } from "./components/history-tab";
import { PlanCard, type StructuredPlan } from "./components/plan-card";
import { BuyCreditsSheet, CreditsSuccessBanner } from "@/components/buy-credits-sheet";
import { cn } from "@/lib/utils";

type AgentMode = "lite" | "eco" | "power" | "pro";

type TaskReport = {
  userRequest: string;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  filesUnchanged?: string[];
  previewUpdated: boolean;
  warnings: string[];
  integrationsNeeded?: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
  nextRecommendation?: string;
  knowledgeApplied?: Array<{ title: string; category: string }>;
  nativeFeatures?: string[];
  modulesWired?: Array<{ id: string; name: string; secretsConsumed: string[] }>;
  versionId?: number | null;
  auditReport?: {
    findings: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      severity: "error" | "warning" | "info";
      file: string;
      message: string;
      suggestion: string;
    }>;
    scores: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      label: string;
      pass: number;
      warnings: number;
      failures: number;
      score: number;
    }>;
    auditedAt: string;
    fileCount: number;
  } | null;
};

type ChatPlanPayload =
  | {
      kind: "report";
      report: TaskReport;
      taskId?: number;
      queueBatchId?: string;
      queueIndex?: number | null;
      queueTotalCount?: number | null;
    }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | Record<string, unknown>;

function ReportCard({
  report,
  onViewFile,
  onViewHistory,
}: {
  report: TaskReport;
  onViewFile?: (path: string) => void;
  onViewHistory?: () => void;
}) {
  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        Builder report
      </div>
      <div
        className={`grid gap-1.5 ${(report.filesUnchanged?.length ?? 0) > 0 ? "grid-cols-4" : "grid-cols-3"}`}
      >
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Created</div>
          <div className="font-semibold text-foreground">{report.filesCreated.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Changed</div>
          <div className="font-semibold text-foreground">{report.filesChanged.length}</div>
        </div>
        <div className="bg-muted rounded p-1.5">
          <div className="text-muted-foreground text-[10px] uppercase">Removed</div>
          <div className="font-semibold text-foreground">{report.filesRemoved.length}</div>
        </div>
        {(report.filesUnchanged?.length ?? 0) > 0 && (
          <div className="bg-muted rounded p-1.5">
            <div className="text-muted-foreground text-[10px] uppercase">Unchanged</div>
            <div className="font-semibold text-foreground">{report.filesUnchanged!.length}</div>
          </div>
        )}
      </div>
      {(report.filesCreated.length > 0 ||
        report.filesChanged.length > 0 ||
        report.filesRemoved.length > 0) && (
        <div className="space-y-0.5 pt-0.5 border-t border-border/50">
          {report.filesCreated.slice(0, 5).map((p) => (
            <button
              key={`c-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-green-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-green-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">+</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesChanged.slice(0, 5).map((p) => (
            <button
              key={`m-${p}`}
              onClick={() => onViewFile?.(p)}
              className={cn(
                "w-full text-left font-mono text-[10px] text-yellow-400 truncate flex items-center gap-1 group",
                onViewFile && "hover:text-yellow-300 cursor-pointer",
              )}
            >
              <span className="shrink-0">~</span>
              <span className="truncate">{p}</span>
              {onViewFile && (
                <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />
              )}
            </button>
          ))}
          {report.filesRemoved.slice(0, 3).map((p) => (
            <div
              key={`r-${p}`}
              className="font-mono text-[10px] text-red-400/70 truncate flex items-center gap-1"
            >
              <span className="shrink-0">-</span>
              <span className="truncate">{p}</span>
            </div>
          ))}
        </div>
      )}
      {report.integrationsNeeded && report.integrationsNeeded.length > 0 && (
        <div className="space-y-1 pt-1.5 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <KeyRound className="h-3 w-3" /> Integrations required
          </div>
          {report.integrationsNeeded.map((i, idx) => (
            <IntegrationSetupCard
              key={idx}
              integrationName={i.name}
              why={i.why}
              keysNeeded={i.keysNeeded}
            />
          ))}
        </div>
      )}
      {report.modulesWired && report.modulesWired.length > 0 && (
        <div className="space-y-1 pt-1.5 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <Puzzle className="h-3 w-3 text-primary" /> Modules wired
          </div>
          {report.modulesWired.map((m, i) => (
            <div key={i} className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[9px] font-medium text-primary bg-primary/10 border border-primary/20 px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                {m.id}
              </span>
              <span className="text-[11px] text-foreground">{m.name}</span>
              {m.secretsConsumed.length > 0 && (
                <span className="text-[10px] text-muted-foreground font-mono">
                  ({m.secretsConsumed.join(", ")})
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {report.knowledgeApplied && report.knowledgeApplied.length > 0 && (
        <div className="space-y-1 pt-1.5 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <BookOpen className="h-3 w-3 text-primary" /> Lessons applied
          </div>
          {report.knowledgeApplied.map((k, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-[9px] font-medium text-muted-foreground bg-muted border border-border px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0">
                {k.category}
              </span>
              <span className="text-[11px] text-foreground truncate">{k.title}</span>
            </div>
          ))}
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="pt-1.5 border-t border-border">
          <div className="font-semibold text-yellow-500 flex items-center gap-1 text-[10px]">
            <AlertTriangle className="h-3 w-3" /> {report.warnings.length} warning(s)
          </div>
        </div>
      )}
      {report.nextRecommendation && (
        <div className="pt-1.5 border-t border-border text-muted-foreground italic text-[10px]">
          {report.nextRecommendation}
        </div>
      )}
      {report.auditReport && report.auditReport.findings.length > 0 && (
        <div className="pt-1.5 border-t border-border space-y-1.5">
          <div className="font-semibold text-foreground flex items-center gap-1 text-[11px]">
            <ShieldCheck className="h-3 w-3 text-primary" /> Quality audit
          </div>
          <div className="grid grid-cols-4 gap-1">
            {report.auditReport.scores.map((s) => (
              <div key={s.category} className="bg-muted rounded p-1 text-center">
                <div
                  className={cn(
                    "text-sm font-bold leading-none",
                    s.score >= 90
                      ? "text-green-400"
                      : s.score >= 70
                        ? "text-yellow-400"
                        : "text-red-400",
                  )}
                >
                  {s.score}
                </div>
                <div className="text-[9px] text-muted-foreground mt-0.5 truncate">{s.label}</div>
              </div>
            ))}
          </div>
          {report.auditReport.findings
            .filter((f) => f.severity === "error")
            .slice(0, 3)
            .map((f, i) => (
              <div key={i} className="flex items-start gap-1 text-[10px] text-red-400">
                <AlertTriangle className="h-2.5 w-2.5 shrink-0 mt-0.5" />
                <span className="truncate">{f.message}</span>
              </div>
            ))}
          {report.auditReport.findings.filter((f) => f.severity === "warning").length > 0 && (
            <div className="text-[10px] text-muted-foreground">
              +{report.auditReport.findings.filter((f) => f.severity === "warning").length} warnings
              — see Quality tab for details
            </div>
          )}
        </div>
      )}
      {report.versionId && (
        <div className="pt-1.5 border-t border-border">
          <button
            onClick={onViewHistory}
            className="w-full flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors group"
          >
            <RotateCcw className="h-3 w-3 shrink-0 text-muted-foreground/50 group-hover:text-foreground/70 transition-colors" />
            <span>Checkpoint saved — roll back any time</span>
            <span className="ml-auto font-mono text-[9px] text-muted-foreground/40">
              #{report.versionId}
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

function ErrorCard({
  message,
  suggestions,
  onTryFix,
  onBuyCredits,
}: {
  message: string;
  suggestions?: string[];
  onTryFix?: (text: string) => void;
  onBuyCredits?: () => void;
}) {
  const isInsufficientCredits = message.startsWith("Insufficient credits");
  return (
    <div className="mt-2 bg-destructive/10 border border-destructive/30 rounded-xl p-3 text-xs space-y-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
        <span className="text-destructive/90 leading-relaxed">{message}</span>
      </div>
      {isInsufficientCredits && (
        <div className="border-t border-destructive/20 pt-2">
          <button
            onClick={onBuyCredits}
            className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2.5 py-1 rounded-lg transition-colors"
          >
            <CreditCard className="h-3 w-3" />
            Buy credits
          </button>
        </div>
      )}
      {suggestions && suggestions.length > 0 && (
        <div className="space-y-1.5 border-t border-destructive/20 pt-2">
          <div className="font-semibold text-destructive/80 flex items-center gap-1 text-[10px] uppercase tracking-wider">
            <Wrench className="h-3 w-3" /> Suggested fixes
          </div>
          {suggestions.map((s, i) => (
            <div key={i} className="flex items-start gap-2">
              <div className="w-4 h-4 rounded-full bg-destructive/20 text-destructive text-[9px] flex items-center justify-center font-bold shrink-0 mt-0.5">
                {i + 1}
              </div>
              <div className="flex-1 flex items-start gap-2 min-w-0">
                <span className="text-foreground/80 leading-relaxed flex-1">{s}</span>
                {onTryFix && (
                  <button
                    onClick={() => onTryFix(s)}
                    className="shrink-0 text-[10px] font-medium text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2 py-0.5 rounded-lg transition-colors whitespace-nowrap"
                  >
                    Try this
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const WORKSPACE_TABS = [
  { label: "Preview", value: "preview", icon: Monitor },
  { label: "Code", value: "code", icon: FileCode2 },
  { label: "Canvas", value: "canvas", icon: Paintbrush2 },
  { label: "Page Map", value: "page-map", icon: Globe },
  { label: "Tools & Files", value: "tools-files", icon: Blocks },
  { label: "Publishing", value: "publishing", icon: Rocket },
  { label: "Knowledge", value: "knowledge", icon: BrainCircuit },
  { label: "Logs", value: "logs", icon: TerminalSquare },
  { label: "Resources", value: "resources", icon: BookOpen },
  { label: "Analytics", value: "analytics", icon: Activity },
  { label: "Manage", value: "manage", icon: Settings },
];

const QUICK_ACTIONS = [
  "Add a login page",
  "Make it mobile-friendly",
  "Add dark mode",
  "Add smooth animations",
  "Fix the last error",
  "Add a contact form",
];

export default function ProjectWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);

  const {
    data: project,
    isLoading: projectLoading,
    isError: projectError,
  } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId), retry: false },
  });
  const sendMessage = useSendMessage();
  const { data: messages } = useListMessages(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: project?.status === "building" || sendMessage.isPending ? 2000 : 15000,
    },
  });
  const rollbackVersion = useRollbackVersion();
  const { data: versions } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });
  const { data: files = [] } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const queryClient = useQueryClient();

  const { data: tasksForFeed = [] } = useListTasks(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: sendMessage.isPending ? 800 : 15000,
    },
  });

  // Global suggestions poll — catches background build suggestions even when SuggestionChips
  // is not visible (background tasks don't create a foreground report card).
  const { data: allSuggestions = [] } = useListSuggestions(
    projectId,
    {},
    {
      query: {
        enabled: !!projectId,
        queryKey: getListSuggestionsQueryKey(projectId, {}),
        refetchInterval: 30000,
        staleTime: 10000,
      },
    },
  );
  const pendingSuggestionsCount = allSuggestions.filter((s) => s.status === "pending").length;

  const prevPendingSuggestionsCountRef = useRef(pendingSuggestionsCount);
  const suggestionsAnimTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestionsNewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [suggestionsAnimating, setSuggestionsAnimating] = useState(false);
  const [suggestionsShowNew, setSuggestionsShowNew] = useState(false);

  useEffect(() => {
    if (pendingSuggestionsCount > prevPendingSuggestionsCountRef.current) {
      if (suggestionsAnimTimerRef.current) clearTimeout(suggestionsAnimTimerRef.current);
      if (suggestionsNewTimerRef.current) clearTimeout(suggestionsNewTimerRef.current);
      setSuggestionsAnimating(true);
      setSuggestionsShowNew(true);
      suggestionsAnimTimerRef.current = setTimeout(() => setSuggestionsAnimating(false), 1500);
      suggestionsNewTimerRef.current = setTimeout(() => setSuggestionsShowNew(false), 3000);
    }
    prevPendingSuggestionsCountRef.current = pendingSuggestionsCount;
  }, [pendingSuggestionsCount]);

  useEffect(() => {
    return () => {
      if (suggestionsAnimTimerRef.current) clearTimeout(suggestionsAnimTimerRef.current);
      if (suggestionsNewTimerRef.current) clearTimeout(suggestionsNewTimerRef.current);
    };
  }, []);

  const [prompt, setPrompt] = useState("");
  const [activeBatchId, setActiveBatchId] = useState<string | null>(null);
  const [_batchTotalCount, setBatchTotalCount] = useState(0);
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>("power");
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [backgroundPanelOpen, setBackgroundPanelOpen] = useState(false);
  const [variantMode, setVariantMode] = useState(false);
  const [variantBatchPending, setVariantBatchPending] = useState(false);
  const [variantComparison, setVariantComparison] = useState<{
    versionA: { id: number; userRequest: string; changelogEntry?: string | null };
    versionB: { id: number; userRequest: string; changelogEntry?: string | null };
  } | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [pendingBuildStartedAt, setPendingBuildStartedAt] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<string>(() => {
    const stored = localStorage.getItem(`mustaflow_tab_${projectId}`);
    const valid = WORKSPACE_TABS.map((t) => t.value);
    return stored && valid.includes(stored) ? stored : "preview";
  });
  const [prefillSecretName, setPrefillSecretName] = useState<string | null>(null);
  const [viewingHistoryPlan, setViewingHistoryPlan] = useState<StructuredPlan | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"chat" | "files" | "history" | "saved">(() => {
    try {
      const stored = localStorage.getItem(`mustaflow_lpanel_${projectId}`);
      if (stored === "files" || stored === "history" || stored === "saved") return stored;
    } catch {
      // ignore
    }
    return "chat";
  });
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [selectedCodeFileId, setSelectedCodeFileId] = useState<number | null>(null);
  const [buyCreditsOpen, setBuyCreditsOpen] = useState(false);
  const [creditsSuccess, setCreditsSuccess] = useState(() => {
    if (typeof window === "undefined") return false;
    const params = new URLSearchParams(window.location.search);
    return params.get("credits_success") === "1";
  });

  useEffect(() => {
    if (!creditsSuccess) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("credits_success");
    window.history.replaceState({}, "", url.toString());
  }, [creditsSuccess]);
  const [focusMode, setFocusMode] = useState(false);
  const [pageMapSyncing, setPageMapSyncing] = useState(false);
  const pageMapSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [splitPct, setSplitPct] = useState<number>(() => {
    const stored = localStorage.getItem("mustaflow_split_pct");
    return stored ? Math.min(65, Math.max(25, parseFloat(stored))) : 38;
  });
  const [windowWidth, setWindowWidth] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth : 1200,
  );
  const [chatDrawerOpen, setChatDrawerOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 768,
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const filesScrollRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const autoAnalyzedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  // Track whether the pending send is plan-mode so we can show the right indicator
  const pendingIsPlanRef = useRef(false);
  const [pendingIsPlan, setPendingIsPlan] = useState(false);
  const seenPageMapEventIdsRef = useRef<Set<number>>(new Set());
  // Whether chat was scrolled to (or near) the bottom — controls auto-scroll behaviour
  const chatAtBottomRef = useRef(true);
  // Mirror of leftPanelTab as a ref so pagehide/unmount callbacks can read the current
  // value synchronously without depending on React state (which may be stale in closures).
  const leftPanelTabRef = useRef<"chat" | "files" | "history" | "saved">("chat");

  // Track window width for responsive layout
  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem(`mustaflow_tab_${projectId}`, activeTab);
  }, [projectId, activeTab]);

  useEffect(() => {
    try {
      localStorage.setItem(`mustaflow_lpanel_${projectId}`, leftPanelTab);
    } catch {
      // ignore
    }
  }, [projectId, leftPanelTab]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`mustaflow_lpanel_${projectId}`);
      if (stored === "files" || stored === "history" || stored === "saved") {
        setLeftPanelTab(stored);
      } else {
        setLeftPanelTab("chat");
      }
    } catch {
      setLeftPanelTab("chat");
    }
  }, [projectId]);

  // Persist Chat/Files scroll for the currently-active tab.
  // Called on tab switch, component unmount, and page hide so the position
  // survives both navigation and full-page refresh.
  const saveCurrentScroll = useCallback(
    (tab: "chat" | "files" | "history" | "saved") => {
      const ref = tab === "chat" ? scrollRef : tab === "files" ? filesScrollRef : null;
      if (ref?.current) {
        try {
          localStorage.setItem(
            `mustaflow_scroll_${projectId}_${tab}`,
            String(ref.current.scrollTop),
          );
        } catch {
          /* ignore */
        }
      }
    },
    [projectId],
  );

  const switchLeftPanel = useCallback(
    (newTab: "chat" | "files" | "history" | "saved") => {
      setLeftPanelTab((currentTab) => {
        saveCurrentScroll(currentTab);
        leftPanelTabRef.current = newTab;
        return newTab;
      });
    },
    [saveCurrentScroll],
  );

  // Keep leftPanelTabRef in sync whenever state changes via direct setLeftPanelTab
  // (e.g. the project-switch reset effect).
  useEffect(() => {
    leftPanelTabRef.current = leftPanelTab;
  }, [leftPanelTab]);

  // Save active tab's scroll on unmount (SPA navigation away from this project page)
  // and on pagehide (hard refresh / tab close).
  // Uses leftPanelTabRef so the callback always reads the current tab synchronously.
  useEffect(() => {
    const onPageHide = () => saveCurrentScroll(leftPanelTabRef.current);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      saveCurrentScroll(leftPanelTabRef.current);
    };
  }, [saveCurrentScroll]);

  useEffect(() => {
    const restoreRef =
      leftPanelTab === "chat" ? scrollRef : leftPanelTab === "files" ? filesScrollRef : null;
    if (!restoreRef) return;
    requestAnimationFrame(() => {
      const el = restoreRef.current;
      if (!el) return;
      try {
        const saved = localStorage.getItem(`mustaflow_scroll_${projectId}_${leftPanelTab}`);
        if (saved !== null) {
          const top = Number.isFinite(Number(saved)) ? Number(saved) : 0;
          el.scrollTop = top;
          if (leftPanelTab === "chat") {
            chatAtBottomRef.current = el.scrollHeight - top - el.clientHeight < 80;
          }
        }
      } catch {
        /* ignore */
      }
    });
  }, [leftPanelTab, projectId]);

  const isMobileLayout = windowWidth < 768;

  // Derive active module IDs from the most recent completed task report
  const wiredModuleIds = useMemo<string[] | undefined>(() => {
    if (!messages) return undefined;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        try {
          const payload = JSON.parse(msg.content) as ChatPlanPayload;
          if (
            typeof payload === "object" &&
            payload !== null &&
            "kind" in payload &&
            (payload as { kind: string }).kind === "report"
          ) {
            const rpt = (payload as { kind: "report"; report: TaskReport }).report;
            if (rpt?.modulesWired && rpt.modulesWired.length > 0) {
              return rpt.modulesWired.map((m) => m.id);
            }
            return [];
          }
        } catch {
          /* non-JSON message, skip */
        }
      }
    }
    return undefined;
  }, [messages]);

  useEffect(() => {
    if (chatAtBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId]);

  // Subscribe to the SSE event stream for the active task. When the server
  // emits "page_map_updated" (guaranteed before "completed"), invalidate the
  // page map cache so the Page Map tab refreshes without any user action.
  useEffect(() => {
    if (!activeTaskId) return;
    // Reset dedup set per task so it stays bounded across long sessions
    seenPageMapEventIdsRef.current = new Set();
    const es = new EventSource(`/api/projects/${projectId}/tasks/${activeTaskId}/events/stream`);
    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const event = JSON.parse(e.data) as { id: number; eventType: string };
        if (
          event.eventType === "page_map_updated" &&
          !seenPageMapEventIdsRef.current.has(event.id)
        ) {
          seenPageMapEventIdsRef.current.add(event.id);
          void queryClient.invalidateQueries({
            queryKey: getGetPageMapQueryKey(projectId),
          });
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => es.close();
  }, [activeTaskId, projectId, queryClient]);

  // Auto-generate a plan analysis when a project opens with no messages yet
  useEffect(() => {
    if (!project || messages === undefined || autoAnalyzedRef.current) return;
    if (messages.length > 0) {
      autoAnalyzedRef.current = true;
      return;
    }
    if (sendMessage.isPending) return;
    autoAnalyzedRef.current = true;
    pendingIsPlanRef.current = true;
    setPendingIsPlan(true);
    sendMessage.mutate(
      {
        id: projectId,
        data: {
          content: `Analyze this project idea and create a structured plan: "${project.name}". Identify the recommended pages/screens, tech stack, backend requirements, database, integrations needed, API keys required, risks, and suggested next steps. Be specific and concrete.`,
          agentMode: "eco",
          planMode: true,
          background: false,
        },
      },
      {
        onSuccess: () => {
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
        },
        onError: () => {
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
        },
      },
    );
  }, [project, messages, projectId, sendMessage, queryClient]);

  const send = useCallback(
    (
      content: string,
      opts?: { planMode?: boolean; background?: boolean; agentMode?: AgentMode },
    ) => {
      if (!content.trim()) return;
      setActiveTaskId(null);
      chatAtBottomRef.current = true;
      setPendingBuildStartedAt(new Date());
      if (opts?.background ?? runInBackground) setBackgroundPanelOpen(true);
      const effectiveMode = opts?.agentMode ?? agentMode;
      const effectivePlanMode = opts?.planMode ?? planMode;
      pendingIsPlanRef.current = effectivePlanMode;
      setPendingIsPlan(effectivePlanMode);
      sendMessage.mutate(
        {
          id: projectId,
          data: {
            content,
            agentMode: effectiveMode,
            planMode: effectivePlanMode,
            background: opts?.background ?? runInBackground,
          },
        },
        {
          onSuccess: (data) => {
            setPendingBuildStartedAt(null);
            pendingIsPlanRef.current = false;
            setPendingIsPlan(false);
            void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
            setTimeout(() => {
              void queryClient.invalidateQueries({
                queryKey: getListProjectFilesQueryKey(projectId),
              });
              void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
              void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) });
              void queryClient.invalidateQueries({
                queryKey: getListSuggestionsQueryKey(projectId, {}),
              });
            }, 3000);
            const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
            const tid =
              plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
            if (tid) setActiveTaskId(tid);
          },
          onError: () => {
            setPendingBuildStartedAt(null);
            pendingIsPlanRef.current = false;
            setPendingIsPlan(false);
          },
        },
      );
    },
    [projectId, agentMode, planMode, runInBackground, sendMessage, queryClient],
  );

  const handleAddKey = useCallback((keyName: string) => {
    setPrefillSecretName(keyName);
    setActiveTab("tools-files");
  }, []);

  const _handleSend = () => {
    const currentPrompt = prompt;
    setPrompt("");
    send(currentPrompt);
  };

  // Restore active batch from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem(`mustaflow_batch_${projectId}`);
    if (stored) {
      setActiveBatchId(stored);
    }
  }, [projectId]);

  const handleBatchStarted = useCallback(
    (batchId: string, totalCount: number) => {
      setActiveBatchId(batchId);
      setBatchTotalCount(totalCount);
      setBackgroundPanelOpen(true);
      localStorage.setItem(`mustaflow_batch_${projectId}`, batchId);
      void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
      void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
      // Track if this batch was started in variant mode
      if (variantMode) {
        setVariantBatchPending(true);
        setVariantComparison(null);
      }
    },
    [projectId, queryClient, variantMode],
  );

  const handleBatchComplete = useCallback(() => {
    setActiveBatchId(null);
    setBatchTotalCount(0);
    localStorage.removeItem(`mustaflow_batch_${projectId}`);
    void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
    void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
    // If this was a variant batch, show comparison of last 2 versions after data refreshes
    if (variantBatchPending) {
      setVariantBatchPending(false);
      // Give the versions query time to refresh, then build comparison
      setTimeout(() => {
        void queryClient
          .fetchQuery({
            queryKey: getListVersionsQueryKey(projectId),
            staleTime: 0,
          })
          .then((fetchedVersions: unknown) => {
            const vs = fetchedVersions as Array<{
              id: number;
              userRequest: string;
              changelogEntry?: string | null;
            }>;
            if (Array.isArray(vs) && vs.length >= 2) {
              const [vB, vA] = vs.slice(0, 2);
              if (vA && vB) {
                setVariantComparison({ versionA: vA, versionB: vB });
                setActiveTab("preview");
              }
            }
          })
          .catch(() => undefined);
      }, 1500);
    }
  }, [projectId, queryClient, variantBatchPending]);

  const handleBatchRetry = useCallback(
    async (remainingMessages: string[], retryMode: string) => {
      setActiveBatchId(null);
      setBatchTotalCount(0);
      localStorage.removeItem(`mustaflow_batch_${projectId}`);
      if (remainingMessages.length === 0) return;
      if (remainingMessages.length === 1) {
        send(remainingMessages[0]!, { agentMode: retryMode as AgentMode });
        return;
      }
      try {
        const res = await fetch(`/api/projects/${projectId}/queue`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: remainingMessages, agentMode: retryMode, planMode }),
          credentials: "include",
        });
        if (res.ok) {
          const data = (await res.json()) as { batchId: string; totalTasks: number };
          handleBatchStarted(data.batchId, data.totalTasks);
        }
      } catch {
        send(remainingMessages[0]!, { agentMode: retryMode as AgentMode });
      }
    },
    [projectId, send, planMode, handleBatchStarted],
  );

  // When page-map requests a chat prefill, switch to chat and set the prompt
  useEffect(() => {
    if (chatPrefill !== null) {
      setPrompt(chatPrefill);
      switchLeftPanel("chat");
      setActiveTab("preview");
      setChatPrefill(null);
    }
  }, [chatPrefill, switchLeftPanel]);

  /** Called from PlanCard "Build now" / "Background" buttons */
  const runPlanned = useCallback(
    (editedPrompt: string, mode: AgentMode, background: boolean) => {
      setAgentMode(mode);
      send(editedPrompt, { planMode: false, background, agentMode: mode });
    },
    [send],
  );

  const updateSplit = useCallback((pct: number) => {
    const clamped = Math.min(65, Math.max(25, pct));
    setSplitPct(clamped);
    localStorage.setItem("mustaflow_split_pct", String(clamped));
  }, []);

  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    setIsDragging(true);
  }, []);

  const handleSplitDrag = useCallback(
    (e: React.MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      updateSplit(((e.clientX - rect.left) / rect.width) * 100);
    },
    [updateSplit],
  );

  const stopSplitDrag = useCallback(() => {
    isDraggingRef.current = false;
    setIsDragging(false);
  }, []);

  const resetSplit = useCallback(() => {
    updateSplit(38);
  }, [updateSplit]);

  // ESC key exits focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && focusMode) setFocusMode(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusMode]);

  const handleHtmlFileSaved = useCallback(() => {
    setPageMapSyncing(true);
    if (pageMapSyncTimerRef.current) clearTimeout(pageMapSyncTimerRef.current);
    pageMapSyncTimerRef.current = setTimeout(() => setPageMapSyncing(false), 15000);
  }, []);

  const handlePageMapSyncCleared = useCallback(() => {
    setPageMapSyncing(false);
    if (pageMapSyncTimerRef.current) {
      clearTimeout(pageMapSyncTimerRef.current);
      pageMapSyncTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pageMapSyncTimerRef.current) clearTimeout(pageMapSyncTimerRef.current);
    };
  }, []);

  // Discover the active task ID during sendMessage.isPending so BuildProgressFeed
  // can show real events even before the API call resolves (for synchronous builds).
  const pendingFeedTaskId = sendMessage.isPending
    ? (tasksForFeed
        .filter((t) => {
          const activeStatuses = new Set(["planning", "building", "testing"]);
          if (!activeStatuses.has(t.status)) return false;
          if (!pendingBuildStartedAt) return true;
          return new Date(t.createdAt).getTime() >= pendingBuildStartedAt.getTime() - 5000;
        })
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]?.id ??
      null)
    : null;

  const backgroundTasks = useMemo(
    () =>
      (tasksForFeed as BgTask[])
        .filter((t) => t.kind === "background")
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 20),
    [tasksForFeed],
  );
  const bgActiveCount = backgroundTasks.filter(
    (t) => !["completed", "failed", "canceled"].includes(t.status),
  ).length;

  if (projectError || (!projectLoading && !project))
    return (
      <div className="flex flex-col items-center justify-center h-screen bg-background gap-4 px-6 text-center">
        <div className="bg-destructive/10 p-4 rounded-full">
          <TerminalSquare className="h-8 w-8 text-destructive" />
        </div>
        <h1 className="text-xl font-semibold">Project not found</h1>
        <p className="text-muted-foreground max-w-md">We couldn't find a project with that ID.</p>
        <Button onClick={() => window.history.back()}>Go back</Button>
      </div>
    );

  if (!project)
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="animate-pulse bg-primary/20 p-4 rounded-full">
          <TerminalSquare className="h-8 w-8 text-primary" />
        </div>
      </div>
    );

  return (
    <div className="flex flex-col h-full bg-background w-full overflow-hidden text-foreground">
      <CreateProjectModal open={newProjectOpen} onOpenChange={setNewProjectOpen} />

      {/* ── Top bar ── */}
      <div className="border-b border-border bg-card shrink-0 flex items-center gap-2 px-4 h-12 z-20 relative">
        <div className="flex items-center gap-2 shrink-0 mr-1">
          <div className="w-5 h-5 rounded bg-primary/20 border border-primary/30 flex items-center justify-center">
            <Globe className="h-3 w-3 text-primary" />
          </div>
          <span className="text-sm font-semibold text-foreground truncate max-w-[130px]">
            {project.name}
          </span>
          <span
            className={cn(
              "text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0",
              project.status === "building"
                ? "bg-primary/10 text-primary border-primary/20"
                : project.status === "published"
                  ? "bg-green-500/10 text-green-400 border-green-500/20"
                  : project.status === "failed"
                    ? "bg-destructive/10 text-destructive border-destructive/20"
                    : "bg-muted text-muted-foreground border-border",
            )}
          >
            {project.status}
          </span>
        </div>
        <div className="w-px h-5 bg-border shrink-0" />
        <div className="flex-1 overflow-x-auto min-w-0">
          <div className="flex items-stretch h-12">
            {WORKSPACE_TABS.filter(
              (tab) => tab.value !== "analytics" || project.status === "published",
            ).map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  data-tab={tab.value}
                  className={cn(
                    "relative flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full shrink-0",
                    activeTab === tab.value
                      ? "border-primary text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3 shrink-0" />
                  {tab.label}
                  {tab.value === "page-map" && pageMapSyncing && (
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-500" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={() => setNewProjectOpen(true)}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-border text-muted-foreground text-xs font-medium hover:bg-muted hover:text-foreground transition-colors"
          >
            <Plus style={{ width: 11, height: 11 }} /> New
          </button>
          <button
            onClick={() => setActiveTab("publishing")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-semibold hover:bg-green-500/15 transition-colors"
          >
            <Rocket style={{ width: 12, height: 12 }} /> Publish
          </button>
        </div>
      </div>

      {/* ── Main split: chat LEFT + preview RIGHT ── */}
      <div
        ref={splitContainerRef}
        className={cn(
          "flex-1 flex min-h-0 overflow-hidden select-none relative",
          isDragging && "cursor-col-resize",
        )}
        onMouseMove={isMobileLayout ? undefined : handleSplitDrag}
        onMouseUp={isMobileLayout ? undefined : stopSplitDrag}
        onMouseLeave={isMobileLayout ? undefined : stopSplitDrag}
      >
        {/* ── LEFT: AI Chat Panel ── */}
        <div
          className={cn(
            "flex flex-col min-h-0 border-border overflow-hidden",
            isMobileLayout
              ? cn(
                  "bg-background fixed inset-x-0 top-12 z-40 shadow-2xl transition-transform duration-300 ease-in-out",
                  chatDrawerOpen ? "translate-y-0" : "-translate-y-full",
                )
              : "bg-card/40 border-r transition-[width] duration-300 ease-in-out",
          )}
          style={
            isMobileLayout
              ? { bottom: "56px" }
              : focusMode
                ? { width: 0, minWidth: 0 }
                : { width: `${splitPct}%`, minWidth: 260, maxWidth: "72%" }
          }
        >
          {/* Left panel tab bar: Chat | Files | History | Saved */}
          <div className="shrink-0 flex border-b border-border bg-card/60">
            {(["chat", "files", "history", "saved"] as const).map((t) => {
              const Icon =
                t === "chat"
                  ? MessageSquare
                  : t === "files"
                    ? FileCode2
                    : t === "history"
                      ? History
                      : Bookmark;
              const badge =
                t === "files" && files.length > 0
                  ? files.length
                  : t === "saved" && pendingSuggestionsCount > 0
                    ? pendingSuggestionsCount
                    : null;
              return (
                <button
                  key={t}
                  onClick={() => switchLeftPanel(t)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors border-b-2",
                    leftPanelTab === t
                      ? "border-primary text-foreground bg-primary/5"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {t === "chat"
                    ? "Chat"
                    : t === "files"
                      ? "Files"
                      : t === "history"
                        ? "History"
                        : "Saved"}
                  {badge !== null && (
                    <span
                      className={cn(
                        "ml-0.5 px-1 py-0.5 rounded-full bg-muted text-[9px] font-semibold leading-none relative inline-flex items-center justify-center transition-transform",
                        t === "saved" && suggestionsAnimating && "scale-125",
                      )}
                    >
                      {t === "saved" && suggestionsAnimating && (
                        <span className="absolute inset-0 rounded-full bg-primary/40 animate-ping" />
                      )}
                      {badge}
                    </span>
                  )}
                  {t === "saved" && suggestionsShowNew && (
                    <span className="text-[9px] text-primary font-bold animate-pulse">New</span>
                  )}
                </button>
              );
            })}
            {/* Close button for mobile drawer */}
            {isMobileLayout && (
              <button
                onClick={() => setChatDrawerOpen(false)}
                className="px-3 py-2 text-muted-foreground hover:text-foreground transition-colors border-b-2 border-transparent"
                title="Close"
                aria-label="Close chat drawer"
              >
                <ChevronRight className="h-3.5 w-3.5 rotate-90" />
              </button>
            )}
          </div>

          {/* ── PLAN SNAPSHOT VIEWER (overlay over chat when viewing a history plan) ── */}
          {viewingHistoryPlan && (
            <div className="absolute inset-0 z-30 flex flex-col bg-background/95 backdrop-blur-sm">
              <div className="shrink-0 px-3 py-2 border-b border-border flex items-center gap-2">
                <BrainCircuit className="h-3.5 w-3.5 text-secondary" />
                <span className="text-xs font-semibold text-foreground flex-1">Plan snapshot</span>
                <button
                  onClick={() => setViewingHistoryPlan(null)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                  title="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-3 hide-scrollbar">
                <PlanCard
                  plan={viewingHistoryPlan}
                  projectId={projectId}
                  initialAgentMode={agentMode}
                  onBuild={runPlanned}
                  onAddKey={(keyName) => {
                    setViewingHistoryPlan(null);
                    setPrefillSecretName(keyName);
                    setActiveTab("tools-files");
                  }}
                  disabled={sendMessage.isPending}
                  readOnly
                />
              </div>
            </div>
          )}

          {/* ── CHAT TAB ── */}
          {leftPanelTab === "chat" && (
            <>
              {/* Chat panel header */}
              <div className="shrink-0 px-4 py-2 border-b border-border/50 flex items-center gap-2">
                <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center">
                  <Sparkles style={{ width: 10, height: 10 }} className="text-white" />
                </div>
                <span className="text-xs font-semibold text-foreground">AI Builder</span>
                <span
                  className={cn(
                    "ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                    sendMessage.isPending
                      ? pendingIsPlan
                        ? "bg-secondary/15 text-secondary"
                        : "bg-primary/15 text-primary"
                      : "bg-green-500/15 text-green-400",
                  )}
                >
                  {sendMessage.isPending ? (pendingIsPlan ? "Planning…" : "Working…") : "Ready"}
                </span>
                <button
                  onClick={() => setShowChatHistory((v) => !v)}
                  title={showChatHistory ? "Back to live chat" : "View chat history"}
                  className={cn(
                    "ml-1.5 flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium transition-colors border",
                    showChatHistory
                      ? "bg-primary/10 text-primary border-primary/20"
                      : "text-muted-foreground border-border hover:text-foreground hover:bg-muted",
                  )}
                >
                  <History className="h-3 w-3" />
                  {showChatHistory ? "Live" : "History"}
                </button>
              </div>

              {/* Chat History overlay */}
              {showChatHistory && (
                <div className="flex-1 min-h-0 relative">
                  <ChatHistory
                    messages={messages}
                    isLoading={messages === undefined}
                    projectId={projectId}
                    onViewFile={(path) => {
                      const f = files.find((x) => x.path === path);
                      if (f) {
                        setSelectedCodeFileId(f.id);
                        setActiveTab("code");
                      }
                    }}
                    onClose={() => setShowChatHistory(false)}
                  />
                </div>
              )}

              {/* Messages + controls (hidden in history mode) */}
              {!showChatHistory && (
                <>
                  <div
                    ref={scrollRef}
                    onScroll={() => {
                      const el = scrollRef.current;
                      if (!el) return;
                      chatAtBottomRef.current =
                        el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                    }}
                    className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-0 hide-scrollbar"
                  >
                    {creditsSuccess && (
                      <div className="sticky top-0 z-10 pb-1">
                        <CreditsSuccessBanner onDismiss={() => setCreditsSuccess(false)} />
                      </div>
                    )}
                    {(() => {
                      const visibleMsgs = messages?.slice(-20) ?? [];
                      const lastReportIdx = visibleMsgs.reduce<number>((acc, msg, idx) => {
                        const p = msg.plan as ChatPlanPayload | null | undefined;
                        const k =
                          p && typeof p === "object" ? (p as { kind?: string }).kind : undefined;
                        return k === "report" ? idx : acc;
                      }, -1);
                      return visibleMsgs.map((msg, msgIdx) => {
                        const planPayload = msg.plan as ChatPlanPayload | null | undefined;
                        const payloadKind =
                          planPayload && typeof planPayload === "object"
                            ? (planPayload as { kind?: string }).kind
                            : undefined;
                        const isReport = payloadKind === "report";
                        const isError = payloadKind === "error";
                        const isTaskQueued = payloadKind === "task-queued";
                        const isPlanCard = msg.planMode && msg.role === "assistant" && !isReport;
                        const structuredPlan =
                          isPlanCard && planPayload ? (planPayload as StructuredPlan) : null;
                        return (
                          <div
                            key={msg.id}
                            className={cn(
                              "flex",
                              msg.role === "user" ? "justify-end" : "justify-start",
                            )}
                          >
                            {isTaskQueued ? (
                              <button
                                onClick={() => setBackgroundPanelOpen(true)}
                                className="flex items-center gap-2 px-3 py-1.5 rounded-xl border border-border/40 bg-muted/30 text-[10px] text-muted-foreground hover:border-primary/30 hover:text-foreground transition-colors"
                              >
                                <Layers2 className="h-3 w-3 text-primary/60 shrink-0" />
                                <span>Task queued in background</span>
                                <ChevronRight className="h-3 w-3 shrink-0 opacity-50" />
                              </button>
                            ) : (
                              <div
                                className={cn(
                                  "max-w-[90%] px-3 py-2 rounded-xl text-xs",
                                  msg.role === "user"
                                    ? "bg-primary text-primary-foreground rounded-br-sm"
                                    : isError
                                      ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
                                      : "bg-muted text-foreground rounded-bl-sm border border-border",
                                )}
                              >
                                <div className="whitespace-pre-wrap leading-relaxed">
                                  {msg.content}
                                </div>
                                {isReport &&
                                  (() => {
                                    const rp = planPayload as {
                                      kind: "report";
                                      report: TaskReport;
                                      taskId?: number;
                                      queueBatchId?: string;
                                      queueIndex?: number | null;
                                      queueTotalCount?: number | null;
                                    };
                                    const hasBatch =
                                      rp.queueBatchId &&
                                      rp.queueTotalCount &&
                                      rp.queueTotalCount > 1;
                                    const isLastReport = msgIdx === lastReportIdx;
                                    return (
                                      <>
                                        {hasBatch && (
                                          <div className="mt-1.5 mb-0.5 flex items-center gap-1.5">
                                            <ListOrdered className="h-3 w-3 text-muted-foreground/50" />
                                            <span className="text-[10px] text-muted-foreground/70 font-medium">
                                              Task {(rp.queueIndex ?? 0) + 1} of{" "}
                                              {rp.queueTotalCount}
                                            </span>
                                          </div>
                                        )}
                                        <ReportCard
                                          report={rp.report}
                                          onViewFile={(path) => {
                                            const f = files.find((x) => x.path === path);
                                            if (f) {
                                              setSelectedCodeFileId(f.id);
                                              setActiveTab("code");
                                            }
                                          }}
                                          onViewHistory={() => switchLeftPanel("history")}
                                        />
                                        {isLastReport && rp.taskId && !sendMessage.isPending && (
                                          <SuggestionChips
                                            projectId={projectId}
                                            taskId={rp.taskId}
                                            onAccepted={(tid) => setActiveTaskId(tid)}
                                          />
                                        )}
                                      </>
                                    );
                                  })()}
                                {isError && (
                                  <ErrorCard
                                    message={(planPayload as { message: string }).message}
                                    suggestions={
                                      (planPayload as { suggestions?: string[] }).suggestions
                                    }
                                    onTryFix={(text) => {
                                      setPrompt(text);
                                    }}
                                    onBuyCredits={() => setBuyCreditsOpen(true)}
                                  />
                                )}
                                {isPlanCard && (
                                  <PlanCard
                                    plan={structuredPlan}
                                    projectId={projectId}
                                    initialAgentMode={agentMode}
                                    onBuild={runPlanned}
                                    onAddKey={handleAddKey}
                                    disabled={sendMessage.isPending}
                                    messageId={msg.id}
                                  />
                                )}
                              </div>
                            )}
                          </div>
                        );
                      });
                    })()}

                    {sendMessage.isPending ? (
                      pendingFeedTaskId !== null ? (
                        <InlineLiveActivity
                          projectId={projectId}
                          taskId={pendingFeedTaskId}
                          onDismiss={() => {}}
                        />
                      ) : (
                        <div className="flex justify-start">
                          <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2">
                            <div
                              className={cn(
                                "animate-pulse w-1.5 h-1.5 rounded-full",
                                pendingIsPlan ? "bg-secondary" : "bg-primary",
                              )}
                            />
                            <span className="text-muted-foreground">
                              {pendingIsPlan
                                ? "Thinking through the plan…"
                                : "MustaFlow is working…"}
                            </span>
                          </div>
                        </div>
                      )
                    ) : activeTaskId !== null ? (
                      <InlineLiveActivity
                        projectId={projectId}
                        taskId={activeTaskId}
                        onDismiss={() => setActiveTaskId(null)}
                      />
                    ) : null}
                  </div>

                  {/* Activity ticker / Status bar */}
                  <div className="shrink-0 border-t border-border/40">
                    {sendMessage.isPending ? (
                      <BuildProgressFeed
                        projectId={projectId}
                        taskId={pendingFeedTaskId}
                        taskStartedAt={pendingBuildStartedAt}
                      />
                    ) : (
                      <>
                        {/* Bottom status bar — shown when idle */}
                        <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/30 bg-muted/20">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                          <span className="text-[10px] text-muted-foreground font-medium">
                            Ready
                          </span>
                          {files.length > 0 && (
                            <button
                              onClick={() => switchLeftPanel("files")}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                            >
                              {files.length} file{files.length !== 1 ? "s" : ""}
                            </button>
                          )}
                          {versions && versions.length > 0 && (
                            <button
                              onClick={() => switchLeftPanel("history")}
                              className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                              title="View checkpoint history"
                            >
                              {versions.length} checkpoint{versions.length !== 1 ? "s" : ""}
                            </button>
                          )}
                          <button
                            onClick={() => setBackgroundPanelOpen((v) => !v)}
                            className={cn(
                              "flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                              bgActiveCount > 0
                                ? "border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                                : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:border-border",
                            )}
                            title="Background tasks"
                          >
                            <Layers2 className="h-2.5 w-2.5" />
                            {bgActiveCount > 0
                              ? `${bgActiveCount} running`
                              : backgroundTasks.length > 0
                                ? `${backgroundTasks.length} tasks`
                                : "Tasks"}
                          </button>
                          <div className="ml-auto flex items-center gap-1">
                            <span
                              className={cn(
                                "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border",
                                agentMode === "pro"
                                  ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                                  : agentMode === "power"
                                    ? "bg-primary/10 text-primary border-primary/20"
                                    : agentMode === "eco"
                                      ? "bg-green-500/10 text-green-400 border-green-500/20"
                                      : "bg-muted text-muted-foreground border-border",
                              )}
                            >
                              {agentMode}
                            </span>
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Quick action chips */}
                  {!sendMessage.isPending && !activeBatchId && prompt === "" && (
                    <div className="shrink-0 px-3 pt-2 pb-1 flex flex-wrap gap-1.5">
                      {QUICK_ACTIONS.map((chip) => (
                        <button
                          key={chip}
                          onClick={() => send(chip)}
                          className="px-2.5 py-1 rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                        >
                          {chip}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* Chat / Queue input */}
                  <QueueComposer
                    projectId={projectId}
                    agentMode={agentMode}
                    onAgentModeChange={setAgentMode}
                    planMode={planMode}
                    onPlanModeChange={setPlanMode}
                    runInBackground={runInBackground}
                    onRunInBackgroundChange={setRunInBackground}
                    variantMode={variantMode}
                    onVariantModeChange={setVariantMode}
                    disabled={sendMessage.isPending}
                    onSingleSend={(content) => {
                      setPrompt("");
                      send(content);
                    }}
                    onBatchStarted={handleBatchStarted}
                    promptValue={prompt}
                    onPromptValueChange={setPrompt}
                  />
                </>
              )}
            </>
          )}

          {/* ── FILES TAB ── */}
          {leftPanelTab === "files" && (
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
                <FileCode2 className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {files.length} file{files.length !== 1 ? "s" : ""}
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground">
                  Click to open in Code tab
                </span>
              </div>
              <div ref={filesScrollRef} className="flex-1 overflow-y-auto py-1">
                {files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <FileCode2 className="h-8 w-8 opacity-25" />
                    <div className="text-center">
                      <div className="text-xs font-medium text-foreground/60">No files yet</div>
                      <div className="text-[10px] opacity-50 mt-0.5">
                        Ask the AI to build something first
                      </div>
                    </div>
                  </div>
                ) : (
                  files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => {
                        setSelectedCodeFileId(file.id);
                        setActiveTab("code");
                      }}
                      className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-left text-muted-foreground hover:bg-muted hover:text-foreground transition-colors group"
                    >
                      <FileCode2 className="h-3.5 w-3.5 shrink-0 group-hover:text-primary transition-colors" />
                      <span className="truncate font-mono">{file.path}</span>
                      <ExternalLink className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-50 shrink-0 transition-opacity" />
                    </button>
                  ))
                )}
              </div>
            </div>
          )}

          {/* ── HISTORY TAB ── */}
          {leftPanelTab === "history" && (
            <HistoryTab
              key={projectId}
              projectId={projectId}
              onRetry={(text) => {
                setPrompt(text);
                switchLeftPanel("chat");
              }}
            />
          )}

          {/* ── SAVED SUGGESTIONS TAB ── */}
          {leftPanelTab === "saved" && (
            <div className="flex flex-col flex-1 min-h-0">
              <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
                <Bookmark className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  Saved Ideas
                </span>
                <span className="ml-auto text-[10px] text-muted-foreground/60">Build any time</span>
              </div>
              <SavedSuggestionsTab
                projectId={projectId}
                onAccepted={(tid) => {
                  setActiveTaskId(tid);
                  switchLeftPanel("chat");
                }}
              />
            </div>
          )}
        </div>

        {/* Plan Viewer Overlay */}
        {viewingHistoryPlan && (
          <div className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm flex items-center justify-center p-4 lg:p-8">
            <div className="w-full max-w-4xl max-h-full flex flex-col bg-card border border-border rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
              <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-border bg-muted/30">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-secondary/15 flex items-center justify-center">
                    <History className="h-5 w-5 text-secondary" />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold">Historical Plan</h2>
                    <p className="text-xs text-muted-foreground">
                      Viewing a read-only snapshot from this version
                    </p>
                  </div>
                </div>
                <button
                  onClick={() => setViewingHistoryPlan(null)}
                  className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted transition-colors"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-6">
                <PlanCard
                  plan={viewingHistoryPlan}
                  projectId={projectId}
                  initialAgentMode={agentMode}
                  onBuild={() => {}}
                  disabled={true}
                  readOnly
                />
              </div>
              <div className="shrink-0 p-4 border-t border-border bg-muted/30 flex justify-end">
                <Button onClick={() => setViewingHistoryPlan(null)}>Close Viewer</Button>
              </div>
            </div>
          </div>
        )}

        {/* ── Drag handle ── */}
        {!focusMode && !isMobileLayout && (
          <div
            className={cn(
              "shrink-0 relative flex items-center justify-center group cursor-col-resize transition-colors duration-100",
              isDragging ? "bg-primary/30" : "bg-border/60 hover:bg-primary/20",
            )}
            style={{ width: 4 }}
            onMouseDown={startSplitDrag}
            onDoubleClick={resetSplit}
            title="Drag to resize · Double-click to reset 38/62"
          >
            {/* Wider invisible grab zone */}
            <div className="absolute inset-y-0 -left-2 -right-2 z-10" />
            {/* 3 horizontal tick marks */}
            <div className="relative z-20 flex flex-col gap-[5px]">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className={cn(
                    "h-px rounded-full transition-colors duration-100",
                    isDragging
                      ? "w-3 bg-primary"
                      : "w-3 bg-muted-foreground/30 group-hover:bg-primary/70",
                  )}
                />
              ))}
            </div>
          </div>
        )}

        {/* ── RIGHT: Preview / Tab Content ── */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-background relative">
          {/* Mobile bottom tab bar */}
          {isMobileLayout && (
            <div
              className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch border-t border-border bg-card/95 backdrop-blur-sm"
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
            >
              {[
                { label: "Preview", value: "preview", icon: Monitor },
                { label: "Code", value: "code", icon: FileCode2 },
                { label: "Publish", value: "publishing", icon: Rocket },
              ].map(({ label, value, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => {
                    setActiveTab(value);
                    setChatDrawerOpen(false);
                  }}
                  className={cn(
                    "flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                    activeTab === value && !chatDrawerOpen
                      ? "text-primary"
                      : "text-muted-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
              <button
                onClick={() => setChatDrawerOpen((o) => !o)}
                className={cn(
                  "flex-1 flex flex-col items-center justify-center gap-0.5 py-2.5 text-[10px] font-medium transition-colors",
                  chatDrawerOpen ? "text-primary" : "text-muted-foreground",
                )}
              >
                <MessageSquare className="h-4 w-4" />
                Chat
              </button>
            </div>
          )}

          <div className={cn("flex-1 min-h-0 overflow-hidden", isMobileLayout && "pb-14")}>
            {activeTab === "preview" && variantComparison && (
              <div className="h-full flex flex-col">
                <div className="shrink-0 px-4 py-2.5 bg-violet-950/40 border-b border-violet-500/30 flex items-center gap-3">
                  <Layers2 className="h-4 w-4 text-violet-400 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-semibold text-violet-300">
                      Design Variants Ready
                    </span>
                    <span className="ml-2 text-[11px] text-violet-400/70">
                      Two versions were built — keep one to continue
                    </span>
                  </div>
                  <button
                    onClick={() => setVariantComparison(null)}
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 flex">
                  {/* Variant A */}
                  <div className="flex-1 min-w-0 flex flex-col border-r border-violet-500/20">
                    <div className="shrink-0 px-3 py-2 bg-muted/60 border-b border-border flex items-center gap-2">
                      <span className="text-[10px] font-bold text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        A
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-foreground">
                          Minimalist · Light palette
                        </span>
                        {variantComparison.versionA.changelogEntry && (
                          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {variantComparison.versionA.changelogEntry.split("\n")[0]}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          rollbackVersion.mutate(
                            { id: projectId, versionId: variantComparison.versionA.id },
                            {
                              onSuccess: () => {
                                setVariantComparison(null);
                                void queryClient.invalidateQueries({
                                  queryKey: getListProjectFilesQueryKey(projectId),
                                });
                              },
                            },
                          );
                        }}
                        disabled={rollbackVersion.isPending}
                        className="shrink-0 px-3 py-1 text-[11px] font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                      >
                        Keep A
                      </button>
                    </div>
                    <iframe
                      src={`/api/projects/${projectId}/versions/${variantComparison.versionA.id}/preview/`}
                      sandbox="allow-scripts allow-forms allow-popups"
                      className="flex-1 w-full border-0 bg-white"
                      title="Variant A preview"
                    />
                  </div>
                  {/* Variant B */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    <div className="shrink-0 px-3 py-2 bg-muted/60 border-b border-border flex items-center gap-2">
                      <span className="text-[10px] font-bold text-violet-400 bg-violet-500/10 px-1.5 py-0.5 rounded">
                        B
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-[11px] font-medium text-foreground">
                          Bold · Dark palette
                        </span>
                        {variantComparison.versionB.changelogEntry && (
                          <p className="text-[10px] text-muted-foreground truncate mt-0.5">
                            {variantComparison.versionB.changelogEntry.split("\n")[0]}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          rollbackVersion.mutate(
                            { id: projectId, versionId: variantComparison.versionB.id },
                            {
                              onSuccess: () => {
                                setVariantComparison(null);
                                void queryClient.invalidateQueries({
                                  queryKey: getListProjectFilesQueryKey(projectId),
                                });
                              },
                            },
                          );
                        }}
                        disabled={rollbackVersion.isPending}
                        className="shrink-0 px-3 py-1 text-[11px] font-semibold bg-violet-600 text-white rounded-lg hover:bg-violet-700 transition-colors disabled:opacity-50"
                      >
                        Keep B
                      </button>
                    </div>
                    <iframe
                      src={`/api/projects/${projectId}/versions/${variantComparison.versionB.id}/preview/`}
                      sandbox="allow-scripts allow-forms allow-popups"
                      className="flex-1 w-full border-0 bg-white"
                      title="Variant B preview"
                    />
                  </div>
                </div>
                <div className="shrink-0 px-4 py-2 bg-muted/30 border-t border-border text-[11px] text-muted-foreground flex items-center gap-2">
                  <RotateCcw className="h-3 w-3 shrink-0" />
                  Keep A or Keep B to make that version active. The other snapshot stays in Build
                  History.
                </div>
              </div>
            )}
            {activeTab === "preview" && !variantComparison && (
              <PreviewTab
                project={{ ...project, kind: project.kind }}
                focusMode={focusMode}
                onToggleFocusMode={() => setFocusMode((f) => !f)}
                validationWarnings={(() => {
                  const recentReport = [...(messages ?? [])].reverse().find((m) => {
                    const p = m.plan as ChatPlanPayload | null | undefined;
                    return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                  });
                  if (!recentReport) return [];
                  const payload = recentReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.warnings ?? [];
                })()}
                nativeFeatures={(() => {
                  const latestReport = [...(messages ?? [])].reverse().find((m) => {
                    const p = m.plan as ChatPlanPayload | null | undefined;
                    return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                  });
                  if (!latestReport) return [];
                  const payload = latestReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.nativeFeatures ?? [];
                })()}
                onFixPrompt={(text) => {
                  setPrompt(text);
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  setTimeout(() => promptInputRef.current?.focus(), 50);
                }}
                onAutoSendPrompt={(text) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(text);
                }}
                onOpenFileInEditor={(fileId) => {
                  setSelectedCodeFileId(fileId);
                  setActiveTab("code");
                }}
              />
            )}
            {activeTab === "code" && (
              <CodeEditorTab
                projectId={projectId}
                initialFileId={selectedCodeFileId}
                onHtmlFileSaved={handleHtmlFileSaved}
                onSnippetInsert={(prompt) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(prompt);
                }}
              />
            )}
            {activeTab === "canvas" && <CanvasTab projectId={projectId} />}
            {activeTab === "page-map" && (
              <PageMapTab
                projectId={projectId}
                isBuilding={project.status === "building"}
                isSyncingAfterEdit={pageMapSyncing}
                onSyncCleared={handlePageMapSyncCleared}
                onSwitchToPreview={() => setActiveTab("preview")}
                onSwitchToCode={() => setActiveTab("code")}
                onSwitchToChat={(prefill) => {
                  switchLeftPanel("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  if (prefill) {
                    // Auto-send so the build starts immediately without the user
                    // having to press Send, and stay on the Page Map so they can
                    // watch "Updating map after build…" progress.
                    send(prefill);
                  } else {
                    setTimeout(() => promptInputRef.current?.focus(), 50);
                  }
                }}
              />
            )}
            {activeTab === "tools-files" && (
              <ToolsTab
                projectId={projectId}
                projectKind={project?.kind}
                wiredModuleIds={wiredModuleIds}
                prefillSecretName={prefillSecretName}
                defaultTab={prefillSecretName ? "secrets" : undefined}
                onSendMessage={(text) => {
                  setActiveTab("preview");
                  send(text);
                }}
              />
            )}
            {activeTab === "publishing" && (
              <PublishingTab
                projectId={projectId}
                kind={project.kind}
                onNavigateToSecret={handleAddKey}
              />
            )}
            {activeTab === "logs" && (
              <LogsTab
                projectId={projectId}
                kind={project.kind}
                onTryFix={(text) => {
                  setPrompt(text);
                  setActiveTab("preview");
                }}
              />
            )}
            {activeTab === "knowledge" && <KnowledgeTab projectId={projectId} />}
            {activeTab === "analytics" && <AnalyticsTab project={project} />}
            {activeTab === "resources" && <ResourcesTab />}
            {activeTab === "manage" && <ManageTab projectId={projectId} />}
          </div>
        </div>
      </div>
      <BackgroundTasksDrawer
        projectId={projectId}
        isOpen={backgroundPanelOpen}
        onClose={() => setBackgroundPanelOpen(false)}
        tasks={backgroundTasks}
        onRollback={(versionId) => {
          rollbackVersion.mutate(
            { id: projectId, versionId },
            {
              onSuccess: () => {
                void queryClient.invalidateQueries({
                  queryKey: getListProjectFilesQueryKey(projectId),
                });
                void queryClient.invalidateQueries({
                  queryKey: getListVersionsQueryKey(projectId),
                });
                void queryClient.invalidateQueries({
                  queryKey: getListMessagesQueryKey(projectId),
                });
              },
            },
          );
        }}
        onViewCode={() => {
          setActiveTab("tools-files");
          setBackgroundPanelOpen(false);
        }}
      >
        {activeBatchId && (
          <QueueProgressStrip
            projectId={projectId}
            batchId={activeBatchId}
            onComplete={handleBatchComplete}
            onRetry={(msgs, mode) => void handleBatchRetry(msgs, mode)}
          />
        )}
      </BackgroundTasksDrawer>
      <BuyCreditsSheet
        open={buyCreditsOpen}
        onClose={() => setBuyCreditsOpen(false)}
        returnUrl={`${window.location.origin}/projects/${projectId}?credits_success=1`}
      />
    </div>
  );
}
