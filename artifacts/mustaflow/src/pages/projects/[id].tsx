import { useParams } from "wouter";
import { 
  useGetProject, 
  useListMessages, 
  useSendMessage, 
  getGetProjectQueryKey,
  getListMessagesQueryKey,
  useCreateTask,
  getListTasksQueryKey
} from "@workspace/api-client-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { 
  Send, Settings, History, Lock, FileCode2, Blocks, Globe, LayoutTemplate, 
  TerminalSquare, Zap, Mic, Paperclip, CheckSquare, BrainCircuit
} from "lucide-react";
import { useState, useRef, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PreviewTab } from "./components/preview-tab";
import { CanvasTab } from "./components/canvas-tab";
import { ToolsTab } from "./components/tools-tab";
import { PublishingTab } from "./components/publishing-tab";
import { LogsTab } from "./components/logs-tab";
import { cn } from "@/lib/utils";

export default function ProjectWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const projectId = parseInt(id, 10);
  
  const { data: project, isLoading: projectLoading, isError: projectError } = useGetProject(projectId, {
    query: { enabled: !!projectId, queryKey: getGetProjectQueryKey(projectId), retry: false },
  });
  const { data: messages } = useListMessages(projectId, {
    query: { enabled: !!projectId, queryKey: getListMessagesQueryKey(projectId) },
  });
  const sendMessage = useSendMessage();
  const createTask = useCreateTask();
  const queryClient = useQueryClient();

  const [prompt, setPrompt] = useState("");
  const [agentMode, setAgentMode] = useState<"lite"|"eco"|"power"|"pro">("power");
  const [planMode, setPlanMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!prompt.trim()) return;
    const currentPrompt = prompt;
    setPrompt("");
    sendMessage.mutate({
      id: projectId,
      data: {
        content: currentPrompt,
        agentMode,
        planMode
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListMessagesQueryKey(projectId) });
      }
    });
  };

  const handleRunTask = (title: string, kind: "main" | "background" = "main") => {
    createTask.mutate({
      id: projectId,
      data: {
        title,
        kind,
        prompt: "Run planned task"
      }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTasksQueryKey(projectId) });
      }
    });
  };

  if (projectError || (!projectLoading && !project)) return (
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

  if (!project) return (
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
            <span className={cn(
              "px-1.5 py-0.5 rounded-full font-medium",
              project.status === 'building' ? 'bg-primary/20 text-primary' : 
              project.status === 'published' ? 'bg-green-500/20 text-green-500' : 
              'bg-muted text-muted-foreground'
            )}>
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
          ].map(item => (
            <button key={item.name} className="flex items-center gap-3 w-full px-3 py-2 rounded-lg hover:bg-sidebar-accent text-left text-sidebar-foreground/80 hover:text-sidebar-foreground transition-colors group">
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
              {['preview', 'canvas', 'tools & files', 'publishing', 'logs', 'analytics', 'resources', 'domains', 'manage'].map(tab => (
                <TabsTrigger 
                  key={tab} 
                  value={tab.toLowerCase().replace(' ', '-')} 
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
            {['analytics', 'resources', 'domains', 'manage'].map(tab => (
              <TabsContent key={tab} value={tab} className="h-full m-0 p-8 flex items-center justify-center text-muted-foreground">
                <div className="text-center">
                  <div className="bg-muted w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-border">
                    <Settings className="h-8 w-8 opacity-50" />
                  </div>
                  <h3 className="font-semibold text-lg text-foreground mb-1 capitalize">{tab}</h3>
                  <p className="text-sm">This feature is coming soon.</p>
                </div>
              </TabsContent>
            ))}
          </div>
        </Tabs>

        {/* Floating Chat Interface */}
        <div className="absolute bottom-6 right-6 w-96 flex flex-col gap-4 z-50 pointer-events-none">
          {/* Chat Stream (Appears on top of the input) */}
          <div className="flex flex-col gap-3 max-h-[50vh] overflow-y-auto pointer-events-auto hide-scrollbar" ref={scrollRef}>
            {messages?.slice(-5).map(msg => (
              <div key={msg.id} className={cn(
                "p-3 rounded-2xl text-sm shadow-xl border max-w-[90%]",
                msg.role === 'user' 
                  ? "bg-primary text-primary-foreground self-end rounded-br-sm border-transparent" 
                  : "bg-card text-card-foreground self-start rounded-bl-sm border-border"
              )}>
                <div className="whitespace-pre-wrap">{msg.content}</div>
                {msg.plan && (
                  <div className="mt-3 bg-background border border-border rounded-lg p-3 text-xs">
                    <div className="font-semibold mb-2">Execution Plan</div>
                    <div className="space-y-2">
                      <Button size="sm" className="w-full" onClick={() => handleRunTask("Execute Plan", "main")}>Build in Main Agent</Button>
                      <Button size="sm" variant="secondary" className="w-full" onClick={() => handleRunTask("Execute Plan Background", "background")}>Run in Background</Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Input Area */}
          <div className="bg-card border border-border rounded-2xl p-3 shadow-2xl pointer-events-auto backdrop-blur-xl bg-card/95">
            <div className="flex gap-2 mb-2">
              <Button 
                variant="ghost" 
                size="sm" 
                className={cn("h-7 px-2 text-xs font-semibold rounded-md", planMode && "bg-secondary/20 text-secondary")}
                onClick={() => setPlanMode(!planMode)}
              >
                Plan Mode
              </Button>
              <div className="flex bg-muted rounded-md p-0.5">
                {(["lite", "eco", "power", "pro"] as const).map(mode => (
                  <button
                    key={mode}
                    className={cn(
                      "px-2 py-1 text-[10px] uppercase font-bold rounded-sm transition-colors",
                      agentMode === mode ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
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
                placeholder="Message MustaFlow AI..."
                className="w-full bg-background border border-border rounded-xl p-3 pr-24 min-h-[80px] max-h-[200px] resize-none focus:outline-none focus:ring-1 focus:ring-primary text-sm"
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
              />
              <div className="absolute bottom-2 right-2 flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-lg">
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground rounded-lg">
                  <Mic className="h-4 w-4" />
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
