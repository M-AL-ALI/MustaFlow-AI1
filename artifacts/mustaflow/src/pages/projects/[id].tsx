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
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
  getGetPageMapQueryKey,
} from "@workspace/api-client-react";
import { BuildProgressFeed } from "@/components/build-progress-feed";
import { CodeEditorTab } from "./components/code-editor-tab";
import { ChatHistory } from "./components/chat-history";
import { PageMapTab } from "./components/page-map-tab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"; // used by inner components only
import { Button } from "@/components/ui/button";
import {
  Send,
  Settings,
  History,
  Lock,
  FileCode2,
  Blocks,
  Globe,
  TerminalSquare,
  Zap,
  Paperclip,
  CheckSquare,
  BrainCircuit,
  ServerCog,
  CheckCircle2,
  AlertTriangle,
  CreditCard,
  KeyRound,
  ShieldCheck,
  Mic,
  Paintbrush2,
  Cpu,
  Activity,
  Rocket,
  Sparkles,
  Monitor,
  Tablet,
  Smartphone,
  Wrench,
  Plus,
  MessageSquare,
  ExternalLink,
  BookOpen,
  ChevronRight,
  FilePen,
  FolderOpen,
  GitCommit,
  RotateCcw,
  Pencil,
  X,
  Puzzle,
} from "lucide-react";
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
import { ActivityStream } from "./components/activity-stream";
import { HistoryTab } from "./components/history-tab";
import { PlanCard, type StructuredPlan } from "./components/plan-card";
import { cn } from "@/lib/utils";

type AgentMode = "lite" | "eco" | "power" | "pro";

type TaskReport = {
  userRequest: string;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
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
};

type ChatPlanPayload =
  | { kind: "report"; report: TaskReport; taskId?: number }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | Record<string, unknown>;

function ReportCard({ report, onViewFile }: { report: TaskReport; onViewFile?: (path: string) => void }) {
  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
        Builder report
      </div>
      <div className="grid grid-cols-3 gap-1.5">
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
      </div>
      {(report.filesCreated.length > 0 || report.filesChanged.length > 0 || report.filesRemoved.length > 0) && (
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
              {onViewFile && <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />}
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
              {onViewFile && <ExternalLink className="h-2.5 w-2.5 shrink-0 opacity-0 group-hover:opacity-60 ml-auto" />}
            </button>
          ))}
          {report.filesRemoved.slice(0, 3).map((p) => (
            <div key={`r-${p}`} className="font-mono text-[10px] text-red-400/70 truncate flex items-center gap-1">
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
    </div>
  );
}



function ErrorCard({
  message,
  suggestions,
  onTryFix,
}: {
  message: string;
  suggestions?: string[];
  onTryFix?: (text: string) => void;
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
          <a
            href="/settings?tab=credits"
            className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-primary border border-primary/30 bg-primary/5 hover:bg-primary/10 px-2.5 py-1 rounded-lg transition-colors"
          >
            <CreditCard className="h-3 w-3" />
            Top up credits
          </a>
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

const PROJECT_NAV = [
  { icon: TerminalSquare, label: "New Task" },
  { icon: CheckSquare, label: "Plans" },
  { icon: Zap, label: "Tasks" },
  { icon: FileCode2, label: "Files" },
  { icon: Blocks, label: "Integrations" },
  { icon: Lock, label: "Secrets" },
  { icon: Globe, label: "Publishing" },
  { icon: ShieldCheck, label: "Security Scan" },
  { icon: BrainCircuit, label: "Knowledge" },
  { icon: History, label: "Versions" },
  { icon: Settings, label: "Settings" },
];

const WORKSPACE_TABS = [
  { label: "Preview", value: "preview", icon: Monitor },
  { label: "Code", value: "code", icon: FileCode2 },
  { label: "Canvas", value: "canvas", icon: Paintbrush2 },
  { label: "Page Map", value: "page-map", icon: Globe },
  { label: "Tools & Files", value: "tools-files", icon: Blocks },
  { label: "Publishing", value: "publishing", icon: Rocket },
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

  const { data: project, isLoading: projectLoading, isError: projectError } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId), retry: false },
  });
  const sendMessage = useSendMessage();
  const { data: messages } = useListMessages(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListMessagesQueryKey(projectId),
      refetchInterval: (project?.status === "building" || sendMessage.isPending) ? 2000 : 15000,
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
      refetchInterval: sendMessage.isPending ? 1500 : 15000,
    },
  });

  const [prompt, setPrompt] = useState("");
  const [chatPrefill, setChatPrefill] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState<AgentMode>("power");
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [pendingBuildStartedAt, setPendingBuildStartedAt] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState("preview");
  const [prefillSecretName, setPrefillSecretName] = useState<string | null>(null);
  const [viewingHistoryPlan, setViewingHistoryPlan] = useState<StructuredPlan | null>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"chat" | "files" | "history">("chat");
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [selectedCodeFileId, setSelectedCodeFileId] = useState<number | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const [pageMapSyncing, setPageMapSyncing] = useState(false);
  const pageMapSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [splitPct, setSplitPct] = useState<number>(() => {
    const stored = localStorage.getItem("mustaflow_split_pct");
    return stored ? Math.min(65, Math.max(25, parseFloat(stored))) : 38;
  });
  const [windowWidth, setWindowWidth] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  const [chatDrawerOpen, setChatDrawerOpen] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  const scrollRef = useRef<HTMLDivElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const autoAnalyzedRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  // Track whether the pending send is plan-mode so we can show the right indicator
  const pendingIsPlanRef = useRef(false);
  const [pendingIsPlan, setPendingIsPlan] = useState(false);
  const seenPageMapEventIdsRef = useRef<Set<number>>(new Set());

  // Track window width for responsive layout
  useEffect(() => {
    const handler = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

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
        } catch { /* non-JSON message, skip */ }
      }
    }
    return undefined;
  }, [messages]);

  useEffect(() => {
    if (scrollRef.current) {
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
    const es = new EventSource(
      `/api/projects/${projectId}/tasks/${activeTaskId}/events/stream`,
    );
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
    if (messages.length > 0) { autoAnalyzedRef.current = true; return; }
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

  const send = useCallback((
    content: string,
    opts?: { planMode?: boolean; background?: boolean; agentMode?: AgentMode },
  ) => {
    if (!content.trim()) return;
    setPendingBuildStartedAt(new Date());
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
            void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) });
          }, 3000);
          const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
          const tid = plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
          if (tid) setActiveTaskId(tid);
        },
        onError: () => {
          setPendingBuildStartedAt(null);
          pendingIsPlanRef.current = false;
          setPendingIsPlan(false);
        },
      },
    );
  }, [projectId, agentMode, planMode, runInBackground, sendMessage, queryClient]);

  const handleAddKey = useCallback((keyName: string) => {
    setPrefillSecretName(keyName);
    setActiveTab("tools-files");
  }, []);

  const handleSend = () => {
    const currentPrompt = prompt;
    setPrompt("");
    send(currentPrompt);
  };

  // When page-map requests a chat prefill, switch to chat and set the prompt
  useEffect(() => {
    if (chatPrefill !== null) {
      setPrompt(chatPrefill);
      setLeftPanelTab("chat");
      setActiveTab("preview");
      setChatPrefill(null);
    }
  }, [chatPrefill]);

  /** Called from PlanCard "Build now" / "Background" buttons */
  const runPlanned = useCallback((editedPrompt: string, mode: AgentMode, background: boolean) => {
    setAgentMode(mode);
    send(editedPrompt, { planMode: false, background, agentMode: mode });
  }, [send]);

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

  const handleSplitDrag = useCallback((e: React.MouseEvent) => {
    if (!isDraggingRef.current || !splitContainerRef.current) return;
    const rect = splitContainerRef.current.getBoundingClientRect();
    updateSplit(((e.clientX - rect.left) / rect.width) * 100);
  }, [updateSplit]);

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
          const activeStatuses = new Set(["queued", "planning", "building", "testing"]);
          if (!activeStatuses.has(t.status)) return false;
          if (!pendingBuildStartedAt) return true;
          return new Date(t.createdAt).getTime() >= pendingBuildStartedAt.getTime() - 5000;
        })
        .sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        )[0]?.id ?? null)
    : null;

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
          <span className="text-sm font-semibold text-foreground truncate max-w-[130px]">{project.name}</span>
          <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0",
            project.status === "building" ? "bg-primary/10 text-primary border-primary/20"
            : project.status === "published" ? "bg-green-500/10 text-green-400 border-green-500/20"
            : project.status === "failed" ? "bg-destructive/10 text-destructive border-destructive/20"
            : "bg-muted text-muted-foreground border-border"
          )}>
            {project.status}
          </span>
        </div>
        <div className="w-px h-5 bg-border shrink-0" />
          <div className="flex-1 overflow-x-auto min-w-0">
            <div className="flex items-stretch h-12">
              {WORKSPACE_TABS.filter((tab) =>
                tab.value !== "analytics" || project.status === "published",
              ).map((tab) => {
                const Icon = tab.icon;
                return (
                  <button
                    key={tab.value}
                    onClick={() => setActiveTab(tab.value)}
                    data-tab={tab.value}
                    className={cn(
                      "flex items-center gap-1.5 px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full shrink-0",
                      activeTab === tab.value
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3 w-3 shrink-0" />
                    {tab.label}
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
            "flex flex-col min-h-0 border-border bg-card/40 overflow-hidden",
            isMobileLayout
              ? cn(
                  "fixed inset-x-0 top-0 z-40 shadow-2xl transition-transform duration-300 ease-in-out",
                  chatDrawerOpen ? "translate-y-0" : "-translate-y-full",
                )
              : "border-r transition-[width] duration-300 ease-in-out",
          )}
          style={
            isMobileLayout
              ? { bottom: "56px" }
              : focusMode
              ? { width: 0, minWidth: 0 }
              : { width: `${splitPct}%`, minWidth: 260, maxWidth: "72%" }
          }
        >
          {/* Left panel tab bar: Chat | Files | History */}
          <div className="shrink-0 flex border-b border-border bg-card/60">
            {(["chat", "files", "history"] as const).map((t) => {
              const Icon = t === "chat" ? MessageSquare : t === "files" ? FileCode2 : History;
              const badge =
                t === "files" && files.length > 0
                  ? files.length
                  : null;
              return (
                <button
                  key={t}
                  onClick={() => setLeftPanelTab(t)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 py-2 text-[11px] font-medium transition-colors border-b-2",
                    leftPanelTab === t
                      ? "border-primary text-foreground bg-primary/5"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {t === "chat" ? "Chat" : t === "files" ? "Files" : "History"}
                  {badge !== null && (
                    <span className="ml-0.5 px-1 py-0.5 rounded-full bg-muted text-[9px] font-semibold leading-none">{badge}</span>
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
            <span className={cn(
              "ml-auto text-[10px] px-1.5 py-0.5 rounded-full font-medium",
              sendMessage.isPending
                ? pendingIsPlan
                  ? "bg-secondary/15 text-secondary"
                  : "bg-primary/15 text-primary"
                : "bg-green-500/15 text-green-400"
            )}>
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
                onViewFile={(path) => {
                  const f = files.find((x) => x.path === path);
                  if (f) { setSelectedCodeFileId(f.id); setActiveTab("code"); }
                }}
                onClose={() => setShowChatHistory(false)}
              />
            </div>
          )}

          {/* Messages + controls (hidden in history mode) */}
          {!showChatHistory && <><div
            ref={scrollRef}
            className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-0 hide-scrollbar"
          >
            {messages?.slice(-20).map((msg) => {
              const planPayload = msg.plan as ChatPlanPayload | null | undefined;
              const payloadKind = planPayload && typeof planPayload === "object" ? (planPayload as { kind?: string }).kind : undefined;
              const isReport = payloadKind === "report";
              const isQueued = payloadKind === "task-queued";
              const isError = payloadKind === "error";
              const isPlanCard = msg.planMode && msg.role === "assistant" && !isReport;
              const structuredPlan = isPlanCard && planPayload ? (planPayload as StructuredPlan) : null;
              return (
                <div
                  key={msg.id}
                  className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}
                >
                  <div className={cn(
                    "max-w-[90%] px-3 py-2 rounded-xl text-xs",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : isError
                      ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
                      : "bg-muted text-foreground rounded-bl-sm border border-border",
                  )}>
                    <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                    {isReport && (
                      <ReportCard
                        report={(planPayload as { kind: "report"; report: TaskReport }).report}
                        onViewFile={(path) => {
                          const f = files.find((x) => x.path === path);
                          if (f) { setSelectedCodeFileId(f.id); setActiveTab("code"); }
                        }}
                      />
                    )}
                    {isQueued && (
                      <div className="mt-2 bg-background border border-border rounded-lg p-2 text-[11px] flex items-center gap-2">
                        <div className="animate-pulse w-1.5 h-1.5 rounded-full bg-secondary" />
                        Background task #{(planPayload as { taskId: number }).taskId} running…
                      </div>
                    )}
                    {isError && (
                      <ErrorCard
                        message={(planPayload as { message: string }).message}
                        suggestions={(planPayload as { suggestions?: string[] }).suggestions}
                        onTryFix={(text) => { setPrompt(text); }}
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
                </div>
              );
            })}

            {sendMessage.isPending && !activeTaskId && (
              <div className="flex justify-start">
                <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2">
                  <div className={cn(
                    "animate-pulse w-1.5 h-1.5 rounded-full",
                    pendingIsPlan ? "bg-secondary" : "bg-primary",
                  )} />
                  <span className="text-muted-foreground">
                    {pendingIsPlan ? "Thinking through the plan…" : "MustaFlow is working…"}
                  </span>
                </div>
              </div>
            )}

            {activeTaskId !== null && (
              <ActivityStream
                projectId={projectId}
                taskId={activeTaskId}
                onDismiss={() => setActiveTaskId(null)}
              />
            )}
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
                  <span className="text-[10px] text-muted-foreground font-medium">Ready</span>
                  {files.length > 0 && (
                    <button
                      onClick={() => setLeftPanelTab("files")}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-muted border border-border text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                    >
                      {files.length} file{files.length !== 1 ? "s" : ""}
                    </button>
                  )}
                  {versions && versions.length > 0 && (
                    <button
                      onClick={() => setLeftPanelTab("history")}
                      className="text-[10px] text-muted-foreground/60 hover:text-muted-foreground transition-colors"
                      title="View checkpoint history"
                    >
                      {versions.length} checkpoint{versions.length !== 1 ? "s" : ""}
                    </button>
                  )}
                  <div className="ml-auto flex items-center gap-1">
                    <span className={cn(
                      "text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wide border",
                      agentMode === "pro" ? "bg-purple-500/10 text-purple-400 border-purple-500/20"
                      : agentMode === "power" ? "bg-primary/10 text-primary border-primary/20"
                      : agentMode === "eco" ? "bg-green-500/10 text-green-400 border-green-500/20"
                      : "bg-muted text-muted-foreground border-border"
                    )}>
                      {agentMode}
                    </span>
                  </div>
                </div>
                {/* Plan / Background controls */}
                <div className="px-3 py-1 flex items-center gap-2">
                  <button
                    onClick={() => setPlanMode(!planMode)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors border",
                      planMode ? "bg-secondary/15 text-secondary border-secondary/30" : "text-muted-foreground border-border hover:text-foreground",
                    )}
                  >
                    <CheckSquare className="h-3 w-3" /> Plan
                  </button>
                  <button
                    onClick={() => setRunInBackground((v) => !v)}
                    className={cn(
                      "flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors border",
                      runInBackground ? "bg-primary/10 text-primary border-primary/30" : "text-muted-foreground border-border hover:text-foreground",
                    )}
                  >
                    <ServerCog className="h-3 w-3" /> Background
                  </button>
                  <span className="ml-auto text-[9px] text-muted-foreground/40">⌘↩ to send</span>
                </div>
              </>
            )}
          </div>

          {/* Quick action chips */}
          {!sendMessage.isPending && prompt === "" && (
            <div className="shrink-0 px-3 pt-2 pb-1 flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map((chip) => (
                <button
                  key={chip}
                  onClick={() => setPrompt(chip)}
                  className="px-2.5 py-1 rounded-full border border-border bg-muted/40 text-[10px] text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors"
                >
                  {chip}
                </button>
              ))}
            </div>
          )}

          {/* Chat input */}
          <div className="shrink-0 px-3 py-2.5 border-t border-border">
            <div className="flex items-start gap-2">
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shrink-0 shadow-md shadow-primary/20 mt-0.5">
                <Sparkles style={{ width: 12, height: 12 }} className="text-white" />
              </div>
              <div className="flex-1 bg-muted border border-border rounded-2xl rounded-tl-sm overflow-hidden">
                <textarea
                  ref={promptInputRef}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={planMode ? "Describe your app — I'll create a plan first…" : "Describe what to build or change…"}
                  rows={2}
                  className="w-full bg-transparent px-4 pt-3 pb-1 text-sm resize-none focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); handleSend(); }
                  }}
                  title="⌘↩ or Enter to send · Shift+Enter for new line"
                />
                <div className="h-px bg-border/40 mx-4" />
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <button className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors" title="Attach file">
                    <Paperclip className="h-3.5 w-3.5" />
                  </button>
                  <button className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors" title="Attach design">
                    <Paintbrush2 className="h-3.5 w-3.5" />
                  </button>
                  <button className="w-6 h-6 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-background/60 transition-colors" title="Voice">
                    <Mic className="h-3.5 w-3.5" />
                  </button>
                  <div className="ml-auto flex items-center gap-2">
                    <div className="flex bg-background/60 border border-border rounded-lg p-0.5">
                      {(["lite", "eco", "power", "pro"] as const).map((mode) => (
                        <button
                          key={mode}
                          onClick={() => setAgentMode(mode)}
                          className={cn(
                            "px-2 py-0.5 text-[9px] uppercase font-bold rounded-md transition-colors",
                            agentMode === mode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {mode}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={handleSend}
                      disabled={sendMessage.isPending || !prompt.trim()}
                      title="Send (⌘↩)"
                      className="w-8 h-8 bg-primary rounded-xl flex items-center justify-center shadow-md shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      <Send style={{ width: 14, height: 14 }} className="text-primary-foreground" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
          </>}
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
                <span className="ml-auto text-[10px] text-muted-foreground">Click to open in Code tab</span>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                {files.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <FileCode2 className="h-8 w-8 opacity-25" />
                    <div className="text-center">
                      <div className="text-xs font-medium text-foreground/60">No files yet</div>
                      <div className="text-[10px] opacity-50 mt-0.5">Ask the AI to build something first</div>
                    </div>
                  </div>
                ) : (
                  files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => { setSelectedCodeFileId(file.id); setActiveTab("code"); }}
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
              projectId={projectId}
              onRetry={(text) => {
                setPrompt(text);
                setLeftPanelTab("chat");
              }}
            />
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
                    <p className="text-xs text-muted-foreground">Viewing a read-only snapshot from this version</p>
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
                <Button onClick={() => setViewingHistoryPlan(null)}>
                  Close Viewer
                </Button>
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
                    isDragging ? "w-3 bg-primary" : "w-3 bg-muted-foreground/30 group-hover:bg-primary/70",
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
            <div className="fixed bottom-0 left-0 right-0 z-30 flex items-stretch border-t border-border bg-card/95 backdrop-blur-sm" style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}>
              {[
                { label: "Preview", value: "preview", icon: Monitor },
                { label: "Code", value: "code", icon: FileCode2 },
                { label: "Publish", value: "publishing", icon: Rocket },
              ].map(({ label, value, icon: Icon }) => (
                <button
                  key={value}
                  onClick={() => { setActiveTab(value); setChatDrawerOpen(false); }}
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
            {activeTab === "preview" && (
              <PreviewTab
                project={{ ...project, kind: project.kind }}
                focusMode={focusMode}
                onToggleFocusMode={() => setFocusMode((f) => !f)}
                validationWarnings={(() => {
                  const recentReport = [...(messages ?? [])]
                    .reverse()
                    .find((m) => {
                      const p = m.plan as ChatPlanPayload | null | undefined;
                      return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                    });
                  if (!recentReport) return [];
                  const payload = recentReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.warnings ?? [];
                })()}
                nativeFeatures={(() => {
                  const latestReport = [...(messages ?? [])]
                    .reverse()
                    .find((m) => {
                      const p = m.plan as ChatPlanPayload | null | undefined;
                      return p && typeof p === "object" && (p as { kind?: string }).kind === "report";
                    });
                  if (!latestReport) return [];
                  const payload = latestReport.plan as { kind: "report"; report: TaskReport };
                  return payload.report?.nativeFeatures ?? [];
                })()}
                onFixPrompt={(text) => {
                  setPrompt(text);
                  setLeftPanelTab("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  setTimeout(() => promptInputRef.current?.focus(), 50);
                }}
                onAutoSendPrompt={(text) => {
                  setLeftPanelTab("chat");
                  if (isMobileLayout) setChatDrawerOpen(true);
                  send(text);
                }}
              />
            )}
            {activeTab === "code" && <CodeEditorTab projectId={projectId} initialFileId={selectedCodeFileId} onHtmlFileSaved={handleHtmlFileSaved} />}
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
                  setLeftPanelTab("chat");
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
            {activeTab === "publishing" && <PublishingTab projectId={projectId} kind={project.kind} />}
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
            {activeTab === "analytics" && <AnalyticsTab project={project} />}
            {activeTab === "resources" && <ResourcesTab />}
            {activeTab === "manage" && <ManageTab projectId={projectId} />}
          </div>
        </div>
      </div>
    </div>
  );
}
