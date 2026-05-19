import { useParams } from "wouter";
import { CreateProjectModal } from "@/components/create-project-modal";
import {
  useGetProject,
  useListMessages,
  useListVersions,
  useListProjectFiles,
  useRollbackVersion,
  useSendMessage,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
} from "@workspace/api-client-react";
import { CodeEditorTab } from "./components/code-editor-tab";
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
  KeyRound,
  ShieldCheck,
  Mic,
  Paintbrush2,
  Cpu,
  Activity,
  Rocket,
  ChevronRight,
  FolderOpen,
  Code2,
  FilePen,
  Sparkles,
  Monitor,
  Tablet,
  Smartphone,
  Wrench,
  Plus,
  MessageSquare,
  ExternalLink,
  GitCommit,
  RotateCcw,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
import { IntegrationSetupCard } from "./components/integration-setup-card";
import { ToolsTab } from "./components/tools-tab";
import { PublishingTab } from "./components/publishing-tab";
import { LogsTab } from "./components/logs-tab";
import { AnalyticsTab } from "./components/analytics-tab";
import { ResourcesTab } from "./components/resources-tab";
import { DomainsTab } from "./components/domains-tab";
import { ManageTab } from "./components/manage-tab";
import { ActivityStream } from "./components/activity-stream";
import { cn } from "@/lib/utils";

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
};

type ChatPlanPayload =
  | { kind: "report"; report: TaskReport; taskId?: number }
  | { kind: "task-queued"; taskId: number }
  | { kind: "task-done"; taskId: number }
  | { kind: "error"; message: string; suggestions?: string[] }
  | Record<string, unknown>;

type StructuredPlan = {
  summary?: string;
  goal?: string;
  approach?: string;
  pages?: string[];
  backend?: string[];
  database?: string[];
  integrations?: string[];
  keysNeeded?: string[];
  filesAffected?: string[];
  risks?: string[];
  testPlan?: string[];
};

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

function PlanCard({
  plan,
  onMain,
  onBackground,
  disabled,
}: {
  plan: StructuredPlan | null;
  onMain: () => void;
  onBackground: () => void;
  disabled: boolean;
}) {
  const PlanSection = ({
    label,
    items,
    color = "text-foreground",
  }: {
    label: string;
    items?: string[];
    color?: string;
  }) => {
    if (!items || items.length === 0) return null;
    return (
      <div>
        <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">{label}</div>
        <div className="space-y-0.5">
          {items.map((item, i) => (
            <div key={i} className={cn("text-[11px] flex items-start gap-1", color)}>
              <span className="mt-0.5 opacity-50">•</span>
              <span>{item}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-3">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <BrainCircuit className="h-3.5 w-3.5 text-secondary" />
        Plan ready
      </div>

      {plan && (
        <div className="space-y-2.5 max-h-48 overflow-y-auto pr-1">
          {plan.goal && (
            <div className="text-[11px] text-muted-foreground bg-muted rounded p-2 leading-relaxed">
              {plan.goal}
            </div>
          )}
          <div className="grid grid-cols-2 gap-2">
            <PlanSection label="Pages / Screens" items={plan.pages} />
            <PlanSection label="Backend / API" items={plan.backend} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <PlanSection label="Database" items={plan.database} />
            <PlanSection label="Integrations" items={plan.integrations} />
          </div>
          {plan.keysNeeded && plan.keysNeeded.length > 0 && (
            <PlanSection label="API Keys needed" items={plan.keysNeeded} color="text-yellow-400" />
          )}
          {plan.risks && plan.risks.length > 0 && (
            <PlanSection label="Risks" items={plan.risks} color="text-orange-400" />
          )}
        </div>
      )}

      <div className="flex gap-2 pt-1 border-t border-border">
        <Button size="sm" className="flex-1 h-7 text-xs" onClick={onMain} disabled={disabled}>
          Build now
        </Button>
        <Button size="sm" variant="secondary" className="flex-1 h-7 text-xs" onClick={onBackground} disabled={disabled}>
          <ServerCog className="h-3 w-3 mr-1" /> Background
        </Button>
      </div>
    </div>
  );
}

const AGENT_STEPS = [
  { Icon: FolderOpen, msg: "Reading context" },
  { Icon: BrainCircuit, msg: "Analyzing request" },
  { Icon: Code2, msg: "Generating code" },
  { Icon: FilePen, msg: "Writing files" },
  { Icon: CheckCircle2, msg: "Verifying output" },
];

function AgentStepTicker() {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setStep((s) => (s + 1) % AGENT_STEPS.length), 2200);
    return () => clearInterval(id);
  }, []);

  const visible = [
    AGENT_STEPS[(step + AGENT_STEPS.length - 1) % AGENT_STEPS.length],
    AGENT_STEPS[step],
    AGENT_STEPS[(step + 1) % AGENT_STEPS.length],
  ];

  return (
    <div className="px-3 py-1.5 flex items-center gap-2">
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
      </span>
      <span className="text-[11px] font-semibold text-primary shrink-0">Building</span>
      <div className="flex items-center gap-1 overflow-x-hidden flex-1 min-w-0">
        {visible.map((ev, i) => {
          const isCurrent = i === 1;
          const isPast = i === 0;
          return (
            <div key={`${step}-${i}`} className="flex items-center gap-1 shrink-0">
              <div className={cn(
                "flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px] transition-all duration-500",
                isCurrent
                  ? "bg-primary/15 text-primary border border-primary/25"
                  : isPast
                  ? "text-green-500/60"
                  : "text-muted-foreground/30",
              )}>
                <ev.Icon className={cn("h-3 w-3", isCurrent && "animate-pulse")} />
                {ev.msg}
                {isPast && <CheckCircle2 className="h-3 w-3 ml-0.5" />}
              </div>
              {i < 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0" />}
            </div>
          );
        })}
      </div>
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
  return (
    <div className="mt-2 bg-destructive/10 border border-destructive/30 rounded-xl p-3 text-xs space-y-2.5">
      <div className="flex items-start gap-2">
        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
        <span className="text-destructive/90 leading-relaxed">{message}</span>
      </div>
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
  { label: "Preview", value: "preview" },
  { label: "Code", value: "code" },
  { label: "Canvas", value: "canvas" },
  { label: "Tools & Files", value: "tools-files" },
  { label: "Publishing", value: "publishing" },
  { label: "Logs", value: "logs" },
  { label: "Analytics", value: "analytics" },
  { label: "Resources", value: "resources" },
  { label: "Domains", value: "domains" },
  { label: "Manage", value: "manage" },
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
  const { data: messages } = useListMessages(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getListMessagesQueryKey(projectId),
      // Poll fast while building, back off to 15 s when idle to reduce server load
      refetchInterval: project?.status === "building" ? 2000 : 15000,
    },
  });
  const sendMessage = useSendMessage();
  const { data: versions } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });
  const { data: files = [] } = useListProjectFiles(projectId, {
    query: { enabled: !!projectId, queryKey: getListProjectFilesQueryKey(projectId) },
  });
  const rollbackVersion = useRollbackVersion();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<"lite" | "eco" | "power" | "pro">("power");
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [deviceMode, setDeviceMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [activeTab, setActiveTab] = useState("preview");
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [leftPanelTab, setLeftPanelTab] = useState<"chat" | "files" | "history">("chat");
  const [selectedCodeFileId, setSelectedCodeFileId] = useState<number | null>(null);
  const [splitPct, setSplitPct] = useState<number>(() => {
    const stored = localStorage.getItem("mustaflow_split_pct");
    return stored ? Math.min(65, Math.max(25, parseFloat(stored))) : 40;
  });
  const [isDragging, setIsDragging] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoAnalyzedRef = useRef(false);
  const isDraggingRef = useRef(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId]);

  // Auto-generate a plan analysis when a project opens with no messages yet
  useEffect(() => {
    if (!project || messages === undefined || autoAnalyzedRef.current) return;
    if (messages.length > 0) { autoAnalyzedRef.current = true; return; }
    if (sendMessage.isPending) return;
    autoAnalyzedRef.current = true;
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
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
        },
      },
    );
  }, [project, messages, projectId, sendMessage, queryClient]);

  const send = useCallback((content: string, opts?: { planMode?: boolean; background?: boolean }) => {
    if (!content.trim()) return;
    sendMessage.mutate(
      {
        id: projectId,
        data: {
          content,
          agentMode,
          planMode: opts?.planMode ?? planMode,
          background: opts?.background ?? runInBackground,
        },
      },
      {
        onSuccess: (data) => {
          // Invalidate immediately: messages + project status drive UI visibility
          void queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
          // Stagger file/version/task invalidations to avoid a burst of 5 parallel refetches
          setTimeout(() => {
            void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
            void queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
          }, 3000);
          const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
          const tid = plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
          if (tid) setActiveTaskId(tid);
        },
      },
    );
  }, [projectId, agentMode, planMode, runInBackground, sendMessage, queryClient]);

  const handleSend = () => {
    const currentPrompt = prompt;
    setPrompt("");
    send(currentPrompt);
  };

  const runPlanned = (planMessageContent: string, background: boolean) => {
    send(`Execute this plan now:\n${planMessageContent}`, { planMode: false, background });
  };

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
    updateSplit(40);
  }, [updateSplit]);

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
            {WORKSPACE_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={cn(
                  "px-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2 h-full",
                  activeTab === tab.value
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </button>
            ))}
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
          "flex-1 flex min-h-0 overflow-hidden select-none",
          isDragging && "cursor-col-resize",
        )}
        onMouseMove={handleSplitDrag}
        onMouseUp={stopSplitDrag}
        onMouseLeave={stopSplitDrag}
      >
        {/* ── LEFT: AI Chat Panel ── */}
        <div
          className="flex flex-col min-h-0 border-r border-border bg-card/40"
          style={{ width: `${splitPct}%`, minWidth: 260, maxWidth: "72%" }}
        >
          {/* Left panel tab bar: Chat | Files | History */}
          <div className="shrink-0 flex border-b border-border bg-card/60">
            {(["chat", "files", "history"] as const).map((t) => {
              const Icon = t === "chat" ? MessageSquare : t === "files" ? FileCode2 : History;
              const badge =
                t === "files" && files.length > 0
                  ? files.length
                  : t === "history" && (versions ?? []).length > 0
                  ? (versions ?? []).length
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
          </div>

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
              sendMessage.isPending ? "bg-primary/15 text-primary" : "bg-green-500/15 text-green-400"
            )}>
              {sendMessage.isPending ? "Working…" : "Ready"}
            </span>
          </div>

          {/* Messages */}
          <div
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
                        onMain={() => runPlanned(msg.content, false)}
                        onBackground={() => runPlanned(msg.content, true)}
                        disabled={sendMessage.isPending}
                      />
                    )}
                  </div>
                </div>
              );
            })}

            {sendMessage.isPending && !activeTaskId && (
              <div className="flex justify-start">
                <div className="bg-muted border border-border rounded-xl rounded-bl-sm px-3 py-2 text-xs flex items-center gap-2">
                  <div className="animate-pulse w-1.5 h-1.5 rounded-full bg-primary" />
                  <span className="text-muted-foreground">MustaFlow is working…</span>
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
              <AgentStepTicker />
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
            <div className="flex-1 min-h-0 flex flex-col">
              <div className="px-3 py-2 border-b border-border/50 flex items-center gap-2">
                <GitCommit className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  {(versions ?? []).length} checkpoint{(versions ?? []).length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex-1 overflow-y-auto py-3 px-3">
                {(versions ?? []).length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
                    <GitCommit className="h-8 w-8 opacity-25" />
                    <div className="text-center">
                      <div className="text-xs font-medium text-foreground/60">No checkpoints yet</div>
                      <div className="text-[10px] opacity-50 mt-0.5">Each successful build saves a checkpoint</div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {(versions ?? []).map((v, idx) => (
                      <div key={v.id} className="relative flex gap-3 pb-4">
                        {idx < (versions ?? []).length - 1 && (
                          <div className="absolute left-[9px] top-5 bottom-0 w-px bg-border/60" />
                        )}
                        <div className={cn(
                          "mt-0.5 w-[18px] h-[18px] rounded-full border-2 shrink-0 flex items-center justify-center z-10",
                          idx === 0 ? "bg-primary/20 border-primary" : "bg-muted border-border",
                        )}>
                          <GitCommit className={cn("h-2.5 w-2.5", idx === 0 ? "text-primary" : "text-muted-foreground")} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 mb-1">
                            <span className={cn("text-[11px] font-semibold", idx === 0 ? "text-primary" : "text-foreground")}>
                              {idx === 0 ? "Latest" : `v${(versions ?? []).length - idx}`}
                            </span>
                            {idx === 0 && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20 font-medium">current</span>
                            )}
                            <span className="text-[9px] text-muted-foreground ml-auto shrink-0">
                              {new Date(v.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                          {idx > 0 && (
                            <button
                              onClick={() => rollbackVersion.mutate(
                                { id: projectId, versionId: v.id },
                                { onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) }) }
                              )}
                              disabled={rollbackVersion.isPending}
                              className="flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md border border-border text-muted-foreground hover:text-foreground hover:border-primary/40 hover:bg-primary/5 transition-colors disabled:opacity-40"
                            >
                              <RotateCcw className="h-2.5 w-2.5" /> Restore this version
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* ── Drag handle ── */}
        <div
          className={cn(
            "w-[5px] shrink-0 relative flex items-center justify-center group cursor-col-resize transition-colors duration-100",
            isDragging ? "bg-primary/40" : "bg-border hover:bg-primary/30",
          )}
          onMouseDown={startSplitDrag}
          onDoubleClick={resetSplit}
          title="Drag to resize · Double-click to reset"
        >
          {/* Wider invisible grab zone so it's easy to click */}
          <div className="absolute inset-y-0 -left-[5px] -right-[5px] z-10" />
          {/* Grip dot indicator */}
          <div className="relative z-20 flex flex-col gap-[4px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className={cn(
                  "w-[3px] h-[3px] rounded-full transition-colors duration-100",
                  isDragging
                    ? "bg-primary"
                    : "bg-muted-foreground/25 group-hover:bg-primary/60",
                )}
              />
            ))}
          </div>
        </div>

        {/* ── RIGHT: Preview / Tab Content ── */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-background">
          {activeTab === "preview" && (
            <div className="shrink-0 border-b border-border px-3 py-1.5 flex items-center gap-2 bg-card">
              <div className="flex items-center bg-muted border border-border rounded-lg p-0.5 gap-0.5">
                {([
                  { mode: "desktop", Icon: Monitor },
                  { mode: "tablet", Icon: Tablet },
                  { mode: "mobile", Icon: Smartphone },
                ] as const).map(({ mode, Icon }) => (
                  <button
                    key={mode}
                    onClick={() => setDeviceMode(mode)}
                    className={cn(
                      "w-7 h-6 flex items-center justify-center rounded-md transition-colors",
                      deviceMode === mode ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                    title={mode}
                  >
                    <Icon style={{ width: 13, height: 13 }} />
                  </button>
                ))}
              </div>
              <div className="ml-auto flex items-center gap-2">
                <button
                  onClick={() => window.open(`/api/projects/${projectId}/preview/`, "_blank")}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-md text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border border-transparent hover:border-border"
                  title="Open preview in new tab"
                >
                  <ExternalLink className="h-3 w-3" />
                  New tab
                </button>
                <div className="w-px h-3.5 bg-border" />
                <span className="text-[10px] text-muted-foreground uppercase tracking-wide font-medium">Live Preview</span>
                <div className={cn("w-1.5 h-1.5 rounded-full shrink-0",
                  project.status === "building" ? "bg-primary animate-pulse" : "bg-green-500"
                )} />
              </div>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-hidden">
            {activeTab === "preview" && <PreviewTab project={project} />}
            {activeTab === "code" && <CodeEditorTab projectId={projectId} initialFileId={selectedCodeFileId} />}
            {activeTab === "canvas" && <CanvasTab projectId={projectId} />}
            {activeTab === "tools-files" && <ToolsTab projectId={projectId} />}
            {activeTab === "publishing" && <PublishingTab projectId={projectId} />}
            {activeTab === "logs" && (
              <LogsTab
                projectId={projectId}
                onTryFix={(text) => {
                  setPrompt(text);
                  setActiveTab("preview");
                }}
              />
            )}
            {activeTab === "analytics" && <AnalyticsTab />}
            {activeTab === "resources" && <ResourcesTab />}
            {activeTab === "domains" && <DomainsTab />}
            {activeTab === "manage" && <ManageTab projectId={projectId} />}
          </div>
        </div>
      </div>
    </div>
  );
}
