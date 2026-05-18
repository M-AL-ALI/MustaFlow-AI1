import { useParams } from "wouter";
import {
  useGetProject,
  useListMessages,
  useSendMessage,
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  getListProjectFilesQueryKey,
  getListVersionsQueryKey,
  getListTasksQueryKey,
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
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
  | Record<string, unknown>;

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
          <div className="font-semibold text-foreground flex items-center gap-1">
            <KeyRound className="h-3 w-3" /> Integrations recommended
          </div>
          {report.integrationsNeeded.slice(0, 2).map((i, idx) => (
            <div key={idx} className="bg-muted rounded p-1.5">
              <div className="font-semibold text-[10px]">
                {i.name} <span className="text-muted-foreground">({i.environment})</span>
              </div>
              <div className="text-muted-foreground text-[10px]">{i.why}</div>
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

function PlanCard({
  onMain,
  onBackground,
  disabled,
}: {
  onMain: () => void;
  onBackground: () => void;
  disabled: boolean;
}) {
  return (
    <div className="mt-2 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="font-semibold text-foreground">Run this plan?</div>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-7 text-xs" onClick={onMain} disabled={disabled}>
          Main Agent
        </Button>
        <Button size="sm" variant="secondary" className="flex-1 h-7 text-xs" onClick={onBackground} disabled={disabled}>
          <ServerCog className="h-3 w-3 mr-1" /> Background
        </Button>
      </div>
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
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<"lite" | "eco" | "power" | "pro">("power");
  const [planMode, setPlanMode] = useState(false);
  const [runInBackground, setRunInBackground] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<number | null>(null);
  const [projectSidebarOpen, setProjectSidebarOpen] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, activeTaskId]);

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

      {/* ── Project sidebar (collapsible) ── */}
      <div
        className={cn(
          "bg-sidebar border-r border-border flex flex-col z-10 shrink-0 transition-all duration-200 overflow-hidden",
          projectSidebarOpen ? "w-48" : "w-0",
        )}
      >
        {projectSidebarOpen && (
          <>
            <div className="px-3 py-3 border-b border-border">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-6 h-6 rounded bg-primary/20 border border-primary/30 flex items-center justify-center shrink-0">
                  <Globe className="h-3.5 w-3.5 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate text-sidebar-foreground">{project.name}</div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] text-sidebar-foreground/50 capitalize">{project.kind}</span>
                    <span className={cn("text-[10px] px-1.5 py-px rounded-full font-medium", statusColor)}>
                      {project.status}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div className="p-2 space-y-px overflow-y-auto flex-1 text-xs">
              {PROJECT_NAV.map((item) => (
                <button
                  key={item.label}
                  className="flex items-center gap-2.5 w-full px-2.5 py-1.5 rounded-md hover:bg-sidebar-accent text-left text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" />
                  {item.label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {/* ── Main workspace column ── */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">

        {/* Tab bar */}
        <Tabs defaultValue="preview" className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="border-b border-border bg-card shrink-0 flex items-center">
            {/* Sidebar toggle */}
            <button
              onClick={() => setProjectSidebarOpen((v) => !v)}
              className="h-full px-2 text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors border-r border-border"
              title={projectSidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
            >
              {projectSidebarOpen
                ? <PanelLeftClose className="h-4 w-4" />
                : <PanelLeftOpen className="h-4 w-4" />
              }
            </button>
            <div className="flex-1 overflow-x-auto">
              <TabsList className="bg-transparent h-auto p-0 gap-0 border-b-0 rounded-none flex">
                {WORKSPACE_TABS.map((tab) => (
                  <TabsTrigger
                    key={tab.value}
                    value={tab.value}
                    className="data-[state=active]:bg-background data-[state=active]:shadow-none border-b-2 border-transparent data-[state=active]:border-primary rounded-none px-4 py-2.5 text-xs font-medium text-muted-foreground data-[state=active]:text-foreground whitespace-nowrap transition-colors hover:text-foreground"
                  >
                    {tab.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </div>

          {/* Tab content — fills remaining space above chat */}
          <div className="flex-1 min-h-0 overflow-hidden">
            <TabsContent value="preview" className="h-full m-0 border-0 outline-none">
              <PreviewTab project={project} />
            </TabsContent>
            <TabsContent value="canvas" className="h-full m-0 border-0 outline-none">
              <CanvasTab />
            </TabsContent>
            <TabsContent value="tools-files" className="h-full m-0 border-0 outline-none">
              <ToolsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="publishing" className="h-full m-0 border-0 outline-none">
              <PublishingTab />
            </TabsContent>
            <TabsContent value="logs" className="h-full m-0 border-0 outline-none">
              <LogsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="analytics" className="h-full m-0 border-0 outline-none">
              <AnalyticsTab />
            </TabsContent>
            <TabsContent value="resources" className="h-full m-0 border-0 outline-none">
              <ResourcesTab />
            </TabsContent>
            <TabsContent value="domains" className="h-full m-0 border-0 outline-none">
              <DomainsTab />
            </TabsContent>
            <TabsContent value="manage" className="h-full m-0 border-0 outline-none">
              <ManageTab projectId={projectId} />
            </TabsContent>
          </div>

          {/* ── AI Builder Chat — fixed bottom panel, NOT floating ── */}
          <div className="shrink-0 border-t border-border bg-card flex flex-col" style={{ height: 290 }}>

            {/* Messages scroll area */}
            <div
              className="flex-1 overflow-y-auto px-4 py-2 space-y-2 min-h-0 hide-scrollbar"
              ref={scrollRef}
            >
              {messages?.slice(-8).map((msg) => {
                const plan = msg.plan as ChatPlanPayload | null | undefined;
                const isReport = plan && (plan as { kind?: string }).kind === "report";
                const isQueued = plan && (plan as { kind?: string }).kind === "task-queued";
                const isPlan = msg.planMode && msg.role === "assistant";
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
                        "max-w-[75%] px-3 py-2 rounded-xl text-xs",
                        msg.role === "user"
                          ? "bg-primary text-primary-foreground rounded-br-sm"
                          : "bg-muted text-foreground rounded-bl-sm border border-border",
                      )}
                    >
                      <div className="whitespace-pre-wrap leading-relaxed">{msg.content}</div>
                      {isReport && (
                        <ReportCard report={(plan as { kind: "report"; report: TaskReport }).report} />
                      )}
                      {isQueued && (
                        <div className="mt-2 bg-background border border-border rounded-lg p-2 text-[11px] flex items-center gap-2">
                          <div className="animate-pulse w-1.5 h-1.5 rounded-full bg-secondary" />
                          Background task #{(plan as { taskId: number }).taskId} running…
                        </div>
                      )}
                      {isPlan && !isReport && (
                        <PlanCard
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

            {/* Input controls */}
            <div className="shrink-0 border-t border-border/60 px-4 py-2.5 space-y-2">
              {/* Toolbar row */}
              <div className="flex items-center gap-1.5 flex-wrap">
                {/* Plan Mode */}
                <button
                  onClick={() => setPlanMode(!planMode)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors border",
                    planMode
                      ? "bg-secondary/15 text-secondary border-secondary/30"
                      : "text-muted-foreground border-border hover:border-border hover:text-foreground",
                  )}
                >
                  <CheckSquare className="h-3 w-3" /> Plan Mode
                </button>

                {/* Background */}
                <button
                  onClick={() => setRunInBackground((v) => !v)}
                  className={cn(
                    "flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-semibold transition-colors border",
                    runInBackground
                      ? "bg-primary/10 text-primary border-primary/30"
                      : "text-muted-foreground border-border hover:text-foreground",
                  )}
                >
                  <ServerCog className="h-3 w-3" /> Background
                </button>

                {/* Status indicator */}
                <div className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground">
                  <span
                    className={cn(
                      "w-1.5 h-1.5 rounded-full",
                      sendMessage.isPending ? "bg-primary animate-pulse" : "bg-green-500",
                    )}
                  />
                  {sendMessage.isPending ? "Working…" : "Ready"}
                </div>

                <div className="ml-auto flex bg-muted rounded-md p-0.5">
                  {(["lite", "eco", "power", "pro"] as const).map((mode) => (
                    <button
                      key={mode}
                      className={cn(
                        "px-2 py-0.5 text-[9px] uppercase font-bold rounded-sm transition-colors",
                        agentMode === mode
                          ? "bg-background shadow-sm text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                      onClick={() => setAgentMode(mode)}
                    >
                      {mode}
                    </button>
                  ))}
                </div>
              </div>

              {/* Input row */}
              <div className="flex items-end gap-2">
                <div className="flex items-center gap-1">
                  <button className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Attach file">
                    <Paperclip className="h-3.5 w-3.5" />
                  </button>
                  <button className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Attach design">
                    <Paintbrush2 className="h-3.5 w-3.5" />
                  </button>
                  <button className="w-7 h-7 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors" title="Voice input">
                    <Mic className="h-3.5 w-3.5" />
                  </button>
                </div>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={
                    planMode
                      ? "Describe what you want — I'll outline a plan first…"
                      : "Describe what to build or ask for a change…"
                  }
                  rows={2}
                  className="flex-1 bg-muted border border-border rounded-xl px-3 py-2 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                />
                <Button
                  size="icon"
                  className="h-9 w-9 rounded-xl shrink-0 shadow-sm"
                  onClick={handleSend}
                  disabled={sendMessage.isPending || !prompt.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  );
}
