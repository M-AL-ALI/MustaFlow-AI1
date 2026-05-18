import { useParams } from "wouter";
import {
  useGetProject,
  useListMessages,
  useListVersions,
  useSendMessage,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
  useSubmitTaskFeedback,
} from "@workspace/api-client-react";
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
  ThumbsUp,
  ThumbsDown,
  Wrench,
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

function ReportCard({ report }: { report: TaskReport }) {
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
      {(report.filesCreated.length > 0 || report.filesChanged.length > 0) && (
        <div className="space-y-0.5">
          {report.filesCreated.slice(0, 4).map((p) => (
            <div key={`c-${p}`} className="font-mono text-[10px] text-green-400 truncate">+ {p}</div>
          ))}
          {report.filesChanged.slice(0, 4).map((p) => (
            <div key={`m-${p}`} className="font-mono text-[10px] text-yellow-400 truncate">~ {p}</div>
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
  { label: "Canvas", value: "canvas" },
  { label: "Tools & Files", value: "tools-files" },
  { label: "Publishing", value: "publishing" },
  { label: "Logs", value: "logs" },
  { label: "Analytics", value: "analytics" },
  { label: "Resources", value: "resources" },
  { label: "Domains", value: "domains" },
  { label: "Manage", value: "manage" },
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
      refetchInterval: 4000,
    },
  });
  const sendMessage = useSendMessage();
  const { data: versions } = useListVersions(projectId, {
    query: { enabled: !!projectId, queryKey: getListVersionsQueryKey(projectId) },
  });
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<"lite" | "eco" | "power" | "pro">("power");
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [deviceMode, setDeviceMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [activeTab, setActiveTab] = useState("preview");
  const scrollRef = useRef<HTMLDivElement>(null);
  const autoAnalyzedRef = useRef(false);

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
          queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListProjectFilesQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListVersionsQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
          queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
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

  const statusColor =
    project.status === "building"
      ? "bg-primary/20 text-primary"
      : project.status === "published"
      ? "bg-green-500/20 text-green-500"
      : project.status === "failed"
      ? "bg-destructive/20 text-destructive"
      : "bg-muted text-muted-foreground";

  return (
    <div className="flex h-full bg-background w-full overflow-hidden text-foreground">

      {/* ── Slim icon rail ── */}
      <div className="w-14 bg-sidebar border-r border-border flex flex-col items-center py-3 gap-1.5 shrink-0 z-10">
        <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center mb-2 shadow-lg shadow-primary/20">
          <Cpu className="text-white" style={{ width: 16, height: 16 }} />
        </div>
        {[
          { Icon: Globe, active: activeTab === "preview", title: "Go to Preview", tab: "preview" },
          { Icon: FileCode2, active: activeTab === "tools-files", title: "Go to Files", tab: "tools-files" },
          { Icon: Blocks, active: activeTab === "canvas", title: "Go to Canvas", tab: "canvas" },
          { Icon: Activity, active: activeTab === "analytics", title: "Go to Analytics", tab: "analytics" },
          { Icon: Settings, active: activeTab === "manage", title: "Go to Settings", tab: "manage" },
        ].map(({ Icon, active, title, tab }) => (
          <button
            key={title}
            title={title}
            onClick={() => setActiveTab(tab)}
            className={cn(
              "w-10 h-10 flex items-center justify-center rounded-xl transition-colors",
              active
                ? "bg-sidebar-accent text-sidebar-foreground"
                : "text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/50",
            )}
          >
            <Icon style={{ width: 17, height: 17 }} />
          </button>
        ))}
        <div className="flex-1" />
        <div className="w-8 h-8 rounded-full bg-primary/80 border border-primary/40 flex items-center justify-center text-[11px] font-bold text-white">
          D
        </div>
      </div>

      {/* ── Main workspace column ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">

        {/* ── Top bar ── */}
        <div className="border-b border-border bg-card shrink-0 flex items-center gap-3 px-4 h-12 z-20 relative">
          <div className="flex items-center gap-2 shrink-0">
            <div className="w-5 h-5 rounded bg-primary/20 border border-primary/30 flex items-center justify-center">
              <Globe className="h-3 w-3 text-primary" />
            </div>
            <span className="text-sm font-semibold text-foreground truncate max-w-[140px]">{project.name}</span>
            <span className={cn("text-[10px] px-2 py-0.5 rounded-full font-medium border shrink-0",
              project.status === "building" ? "bg-primary/10 text-primary border-primary/20"
              : project.status === "published" ? "bg-green-500/10 text-green-400 border-green-500/20"
              : project.status === "failed" ? "bg-destructive/10 text-destructive border-destructive/20"
              : "bg-muted text-muted-foreground border-border"
            )}>
              {project.status}
            </span>
          </div>
          {/* Plain tab buttons — no shadcn Tabs context */}
          <div className="flex-1 overflow-x-auto min-w-0">
            <div className="flex items-stretch h-full">
              {WORKSPACE_TABS.map((tab) => (
                <button
                  key={tab.value}
                  aria-label={`Switch to ${tab.label} tab`}
                  data-tab={tab.value}
                  onClick={() => setActiveTab(tab.value)}
                  className={cn(
                    "px-3 py-3 text-xs font-medium whitespace-nowrap transition-colors border-b-2",
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
          {/* Device selector */}
          <div className="flex items-center gap-0.5 bg-muted rounded-xl p-1 shrink-0">
            {([
              { mode: "desktop", Icon: Monitor, label: "Desktop" },
              { mode: "tablet", Icon: Tablet, label: "Tablet" },
              { mode: "mobile", Icon: Smartphone, label: "Mobile" },
            ] as const).map(({ mode, Icon, label }) => (
              <button
                key={mode}
                onClick={() => setDeviceMode(mode)}
                aria-label={label}
                className={cn(
                  "px-2.5 py-1 rounded-lg flex items-center gap-1.5 text-[11px] font-medium transition-colors",
                  deviceMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon style={{ width: 13, height: 13 }} />
                <span className="hidden lg:inline">{label}</span>
              </button>
            ))}
          </div>
          {/* Publish button */}
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-green-500/10 border border-green-500/20 text-green-400 text-xs font-semibold hover:bg-green-500/15 transition-colors shrink-0">
            <Rocket style={{ width: 12, height: 12 }} /> Publish
          </button>
        </div>

        {/* Tab content — fills remaining space above chat */}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab === "preview" && (
            <div className="flex h-full">
              <div className="flex-1 min-w-0">
                <PreviewTab project={project} />
              </div>
              {/* ── What's Next right panel ── */}
              <div className="w-52 bg-card border-l border-border flex flex-col p-3 gap-3 overflow-y-auto shrink-0">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">What's next</div>
                {[
                  { Icon: BrainCircuit, label: "Plan full app", desc: "Blueprint before building", color: "text-violet-400", bg: "bg-violet-500/10 border-violet-500/20", onClick: () => { setPlanMode(true); } },
                  { Icon: Zap, label: "Build first draft", desc: "Generate from your prompt", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20", onClick: () => { setPlanMode(false); } },
                  { Icon: Blocks, label: "Add integrations", desc: "Auth, payments, APIs", color: "text-blue-400", bg: "bg-blue-500/10 border-blue-500/20", onClick: () => { setActiveTab("tools-files"); } },
                  { Icon: Rocket, label: "Publish app", desc: "Go live in one click", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20", onClick: () => { setActiveTab("publishing"); } },
                ].map((action) => (
                  <button key={action.label} onClick={action.onClick} className={cn("flex items-start gap-2.5 p-2.5 rounded-xl border text-left transition-all hover:scale-[1.01] active:scale-[0.99]", action.bg)}>
                    <action.Icon className={cn("h-4 w-4 mt-0.5 shrink-0", action.color)} />
                    <div className="min-w-0">
                      <div className={cn("text-xs font-semibold", action.color)}>{action.label}</div>
                      <div className="text-[10px] text-muted-foreground mt-0.5 leading-snug">{action.desc}</div>
                    </div>
                  </button>
                ))}
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider mt-1">Recent versions</div>
                {(versions ?? []).slice(0, 5).map((v, i) => (
                  <div key={v.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-muted/50 cursor-pointer">
                    <History className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-[11px] text-muted-foreground truncate">{v.label ?? `Version ${v.id}`}</span>
                    {i === 0 && <span className="ml-auto text-[9px] text-muted-foreground/50 shrink-0">latest</span>}
                  </div>
                ))}
                {(versions ?? []).length === 0 && (
                  <div className="text-[11px] text-muted-foreground/50 italic px-2">No versions yet</div>
                )}
              </div>
            </div>
          )}
          {activeTab === "canvas" && <div className="h-full"><CanvasTab projectId={projectId} /></div>}
          {activeTab === "tools-files" && <div className="h-full"><ToolsTab projectId={projectId} /></div>}
          {activeTab === "publishing" && <div className="h-full"><PublishingTab /></div>}
          {activeTab === "logs" && (
            <div className="h-full">
              <LogsTab
                projectId={projectId}
                onTryFix={(text) => {
                  setPrompt(text);
                  setActiveTab("preview");
                }}
              />
            </div>
          )}
          {activeTab === "analytics" && <div className="h-full"><AnalyticsTab /></div>}
          {activeTab === "resources" && <div className="h-full"><ResourcesTab /></div>}
          {activeTab === "domains" && <div className="h-full"><DomainsTab /></div>}
          {activeTab === "manage" && <div className="h-full"><ManageTab projectId={projectId} /></div>}
        </div>

          {/* ── AI Builder Chat ── */}
          <div className="shrink-0 border-t border-border bg-card/95 backdrop-blur-sm flex flex-col" style={{ height: 290 }}>

            {/* Messages scroll area */}
            <div
              className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0 hide-scrollbar"
              ref={scrollRef}
            >
              {messages?.slice(-12).map((msg) => {
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
                    className={cn(
                      "flex",
                      msg.role === "user" ? "justify-end" : "justify-start",
                    )}
                  >
                    <div
                      className={cn(
                        "max-w-[80%] px-3 py-2 rounded-xl text-xs",
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : isError
                          ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-bl-sm"
                          : "bg-muted text-foreground rounded-bl-sm border border-border",
                      )}
                    >
                      <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                      {isReport && (
                        <ReportCard report={(planPayload as { kind: "report"; report: TaskReport }).report} />
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

            {/* Activity ticker */}
            <div className="shrink-0 px-4 py-1.5 border-t border-border/40 flex items-center gap-3">
              {sendMessage.isPending ? (
                <>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
                    </span>
                    <span className="text-[11px] font-semibold text-primary">AI is working</span>
                  </div>
                  <div className="flex items-center gap-1.5 overflow-x-auto hide-scrollbar">
                    {[
                      { type: "reading_files", Icon: FolderOpen, msg: "Reading files" },
                      { type: "generating_code", Icon: Code2, msg: "Generating code" },
                      { type: "editing_files", Icon: FilePen, msg: "Writing files" },
                    ].map((ev, i, arr) => (
                      <div key={ev.type} className="flex items-center gap-1 shrink-0">
                        <div className={cn(
                          "flex items-center gap-1.5 px-2 py-0.5 rounded-lg text-[11px]",
                          i === arr.length - 1
                            ? "bg-primary/15 text-primary border border-primary/25"
                            : "text-muted-foreground/50",
                        )}>
                          <ev.Icon className={cn("h-3 w-3", i === arr.length - 1 && "animate-pulse")} />
                          {ev.msg}
                          {i < arr.length - 1 && <CheckCircle2 className="h-3 w-3 text-green-500/60 ml-0.5" />}
                        </div>
                        {i < arr.length - 1 && <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0" />}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                  Ready
                  <div className="ml-auto flex items-center gap-2">
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
                  </div>
                </div>
              )}
            </div>

            {/* Input section — AI avatar + unified input card */}
            <div className="shrink-0 px-3 py-2">
              <div className="flex items-start gap-2.5">
                {/* AI avatar */}
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-primary to-blue-600 flex items-center justify-center shrink-0 shadow-lg shadow-primary/20 mt-0.5">
                  <Sparkles style={{ width: 14, height: 14 }} className="text-white" />
                </div>
                {/* Input card */}
                <div className="flex-1 bg-muted border border-border rounded-2xl rounded-tl-sm overflow-hidden">
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={planMode ? "Describe your app — I'll create a plan first…" : "Describe what to build or ask for a change…"}
                    rows={2}
                    className="w-full bg-transparent px-4 pt-3 pb-1 text-sm resize-none focus:outline-none text-foreground placeholder:text-muted-foreground/60"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
                    }}
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
                        className="w-8 h-8 bg-primary rounded-xl flex items-center justify-center shadow-md shadow-primary/30 hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Send style={{ width: 14, height: 14 }} className="text-primary-foreground" />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
      </div>
    </div>
  );
}
