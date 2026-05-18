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
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
import { ToolsTab } from "./components/tools-tab";
import { PublishingTab } from "./components/publishing-tab";
import { LogsTab } from "./components/logs-tab";
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
  | { kind: "report"; report: TaskReport }
  | { kind: "task-queued"; taskId: number }
  | Record<string, unknown>;

function ReportCard({ report }: { report: TaskReport }) {
  return (
    <div className="mt-3 bg-background border border-border rounded-lg p-3 text-xs space-y-3">
      <div className="flex items-center gap-2 font-semibold text-foreground">
        <CheckCircle2 className="h-4 w-4 text-green-500" />
        Builder report
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div className="bg-muted rounded p-2">
          <div className="text-muted-foreground text-[10px] uppercase">Created</div>
          <div className="font-semibold text-foreground">{report.filesCreated.length}</div>
        </div>
        <div className="bg-muted rounded p-2">
          <div className="text-muted-foreground text-[10px] uppercase">Changed</div>
          <div className="font-semibold text-foreground">{report.filesChanged.length}</div>
        </div>
        <div className="bg-muted rounded p-2">
          <div className="text-muted-foreground text-[10px] uppercase">Removed</div>
          <div className="font-semibold text-foreground">{report.filesRemoved.length}</div>
        </div>
      </div>
      {(report.filesCreated.length > 0 || report.filesChanged.length > 0) && (
        <div className="space-y-1">
          {report.filesCreated.slice(0, 6).map((p) => (
            <div key={`c-${p}`} className="font-mono text-[11px] text-green-400 truncate">+ {p}</div>
          ))}
          {report.filesChanged.slice(0, 6).map((p) => (
            <div key={`m-${p}`} className="font-mono text-[11px] text-yellow-400 truncate">~ {p}</div>
          ))}
          {report.filesRemoved.slice(0, 6).map((p) => (
            <div key={`d-${p}`} className="font-mono text-[11px] text-destructive truncate">- {p}</div>
          ))}
        </div>
      )}
      {report.integrationsNeeded && report.integrationsNeeded.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-border">
          <div className="font-semibold text-foreground flex items-center gap-1.5">
            <KeyRound className="h-3.5 w-3.5" /> Integrations recommended
          </div>
          {report.integrationsNeeded.map((i, idx) => (
            <div key={idx} className="bg-muted rounded p-2">
              <div className="font-semibold">
                {i.name} <span className="text-[10px] text-muted-foreground">({i.environment})</span>
              </div>
              <div className="text-muted-foreground">{i.why}</div>
              {i.keysNeeded.length > 0 && (
                <div className="mt-1 text-[10px] font-mono text-secondary">
                  Add to Secrets: {i.keysNeeded.join(", ")}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {report.warnings.length > 0 && (
        <div className="space-y-1 pt-2 border-t border-border">
          <div className="font-semibold text-yellow-500 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" /> Warnings
          </div>
          {report.warnings.map((w, i) => (
            <div key={i} className="text-muted-foreground">{w}</div>
          ))}
        </div>
      )}
      {report.nextRecommendation && (
        <div className="pt-2 border-t border-border text-muted-foreground italic">
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
    <div className="mt-3 bg-background border border-border rounded-lg p-3 text-xs space-y-2">
      <div className="font-semibold text-foreground">Run this plan?</div>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1" onClick={onMain} disabled={disabled}>
          Build in Main Agent
        </Button>
        <Button
          size="sm"
          variant="secondary"
          className="flex-1"
          onClick={onBackground}
          disabled={disabled}
        >
          <ServerCog className="h-3.5 w-3.5 mr-1.5" /> Background
        </Button>
      </div>
    </div>
  );
}

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
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = (content: string, opts?: { planMode?: boolean; background?: boolean }) => {
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
          // Extract taskId from the assistant plan payload so we can show the activity stream
          const plan = data?.assistantMessage?.plan as Record<string, unknown> | null | undefined;
          const tid = plan && typeof plan === "object" ? (plan.taskId as number | undefined) : undefined;
          if (tid) setActiveTaskId(tid);
        },
      },
    );
  };

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
        <p className="text-muted-foreground max-w-md">
          We couldn't find a project with that ID. It may have been deleted or the link is incorrect.
        </p>
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
    <div className="flex h-screen bg-background w-full overflow-hidden text-foreground">
      {/* Left Rail */}
      <div className="w-64 border-r border-border bg-sidebar flex flex-col z-10 shadow-lg">
        <div className="p-4 border-b border-border bg-sidebar-accent/50">
          <h2 className="font-bold text-base truncate text-sidebar-foreground">{project.name}</h2>
          <div className="flex items-center gap-2 mt-1 text-xs text-sidebar-foreground/70">
            <span className="capitalize">{project.kind}</span>
            <span className="w-1 h-1 rounded-full bg-border" />
            <span
              className={cn(
                "px-1.5 py-0.5 rounded-full font-medium",
                project.status === "building"
                  ? "bg-primary/20 text-primary"
                  : project.status === "published"
                  ? "bg-green-500/20 text-green-500"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {project.status}
            </span>
          </div>
        </div>
        <div className="p-3 space-y-1 overflow-y-auto flex-1 text-sm font-medium">
          {[
            { name: "New Task", icon: TerminalSquare },
            { name: "Plans", icon: CheckSquare },
            { name: "Tasks", icon: Zap },
            { name: "Files", icon: FileCode2 },
            { name: "Integrations", icon: Blocks },
            { name: "Secrets", icon: Lock },
            { name: "Publishing", icon: Globe },
            { name: "Security Scan", icon: Lock },
            { name: "Knowledge Vault", icon: BrainCircuit },
            { name: "Versions", icon: History },
            { name: "Settings", icon: Settings },
          ].map((item) => (
            <button
              key={item.name}
              className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-sidebar-accent text-left text-sidebar-foreground/80 hover:text-sidebar-foreground transition-colors group"
            >
              <item.icon className="h-4 w-4 opacity-70 group-hover:opacity-100 transition-opacity" />
              {item.name}
            </button>
          ))}
        </div>
      </div>

      {/* Main Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-background relative">
        <Tabs defaultValue="preview" className="flex-1 flex flex-col h-full overflow-hidden z-10">
          <div className="border-b border-border bg-card px-2 pt-2">
            <TabsList className="bg-transparent h-auto p-0 gap-2 border-b border-transparent">
              {["preview", "canvas", "tools & files", "publishing", "logs"].map((tab) => (
                <TabsTrigger
                  key={tab}
                  value={tab.toLowerCase().replace(/ /g, "-")}
                  className="data-[state=active]:bg-background data-[state=active]:shadow-none data-[state=active]:border-border data-[state=active]:border-b-background border border-transparent border-b-0 rounded-t-lg rounded-b-none px-4 py-2 text-xs font-semibold capitalize text-muted-foreground data-[state=active]:text-foreground relative top-[1px]"
                >
                  {tab}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <div className="flex-1 overflow-hidden relative">
            <TabsContent value="preview" className="h-full m-0 border-0 outline-none">
              <PreviewTab project={project} />
            </TabsContent>
            <TabsContent value="canvas" className="h-full m-0 border-0 outline-none">
              <CanvasTab />
            </TabsContent>
            <TabsContent value="tools-&-files" className="h-full m-0 border-0 outline-none">
              <ToolsTab projectId={projectId} />
            </TabsContent>
            <TabsContent value="publishing" className="h-full m-0 border-0 outline-none">
              <PublishingTab />
            </TabsContent>
            <TabsContent value="logs" className="h-full m-0 border-0 outline-none">
              <LogsTab projectId={projectId} />
            </TabsContent>
          </div>
        </Tabs>

        {/* Floating Chat Interface */}
        <div className="absolute bottom-6 right-6 w-[26rem] flex flex-col gap-4 z-50 pointer-events-none">
          <div
            className="flex flex-col gap-3 max-h-[55vh] overflow-y-auto pointer-events-auto hide-scrollbar"
            ref={scrollRef}
          >
            {messages?.slice(-6).map((msg) => {
              const plan = msg.plan as ChatPlanPayload | null | undefined;
              const isReport = plan && (plan as { kind?: string }).kind === "report";
              const isQueued = plan && (plan as { kind?: string }).kind === "task-queued";
              const isPlan = msg.planMode && msg.role === "assistant";
              return (
                <div
                  key={msg.id}
                  className={cn(
                    "p-3 rounded-2xl text-sm shadow-xl border max-w-[95%]",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground self-end rounded-br-sm border-transparent"
                      : "bg-card text-card-foreground self-start rounded-bl-sm border-border",
                  )}
                >
                  <div className="whitespace-pre-wrap">{msg.content}</div>
                  {isReport && (
                    <ReportCard
                      report={(plan as { kind: "report"; report: TaskReport }).report}
                    />
                  )}
                  {isQueued && (
                    <div className="mt-3 bg-background border border-border rounded-lg p-3 text-xs flex items-center gap-2">
                      <div className="animate-pulse w-2 h-2 rounded-full bg-secondary" />
                      Background task #{(plan as { taskId: number }).taskId} running — I'll post the
                      report here when it's done.
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
              );
            })}
            {sendMessage.isPending && !activeTaskId && (
              <div className="self-start bg-card border border-border rounded-2xl rounded-bl-sm p-3 text-sm shadow-xl flex items-center gap-2">
                <div className="animate-pulse w-2 h-2 rounded-full bg-primary" />
                <span className="text-muted-foreground">MustaFlow is working…</span>
              </div>
            )}
          </div>

          {/* Live activity stream — shown whenever there is an active task */}
          {activeTaskId !== null && (
            <div className="pointer-events-auto">
              <ActivityStream
                projectId={projectId}
                taskId={activeTaskId}
                onDismiss={() => setActiveTaskId(null)}
              />
            </div>
          )}

          <div className="bg-card border border-border rounded-2xl p-3 shadow-2xl pointer-events-auto backdrop-blur-xl bg-card/95">
            <div className="flex gap-2 mb-2 items-center flex-wrap">
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs font-semibold rounded-md",
                  planMode && "bg-secondary/20 text-secondary",
                )}
                onClick={() => setPlanMode(!planMode)}
                title="Generate a plan instead of building immediately"
              >
                Plan Mode
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  "h-7 px-2 text-xs font-semibold rounded-md",
                  runInBackground && "bg-primary/20 text-primary",
                )}
                onClick={() => setRunInBackground((v) => !v)}
                title="Run as a background task — chat stays responsive"
              >
                <ServerCog className="h-3.5 w-3.5 mr-1" /> Background
              </Button>
              <div className="flex bg-muted rounded-md p-0.5 ml-auto">
                {(["lite", "eco", "power", "pro"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={cn(
                      "px-2 py-1 text-[10px] uppercase font-bold rounded-sm transition-colors",
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
            <div className="relative">
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder={
                  planMode
                    ? "Describe what you want — I'll outline a plan first…"
                    : "Describe what to build, or ask for a change…"
                }
                className="w-full bg-background border border-border rounded-xl p-3 pr-14 min-h-[80px] max-h-[200px] resize-none focus:outline-none focus:ring-1 focus:ring-primary text-sm"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-lg"
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  className="h-8 w-8 rounded-lg shadow-sm"
                  onClick={handleSend}
                  disabled={sendMessage.isPending || !prompt.trim()}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
