import { useState, useCallback, useEffect, useRef } from "react";
import { useParams } from "wouter";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  useGetProject,
  useListProjectFiles,
  useUpdateProject,
  getGetProjectQueryKey,
  getListProjectFilesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { X, Bot, Send, Loader2 } from "lucide-react";

import { IconRail, type PanelId } from "./components/icon-rail";
import { TopBar, type PaneLayout } from "./components/top-bar";
import { FileTree } from "./components/file-tree";
import { SearchPanel } from "./components/search-panel";
import { ResourcesPanel } from "./components/resources-panel";
import { ToolsPanel } from "./components/tools-panel";
import { PlaceholderPanel } from "./components/placeholder-panel";
import { MonacoEditorPane, type EditorTab } from "./components/monaco-editor-pane";
import { TerminalPanel } from "./components/terminal-panel";
import { PreviewPane } from "./components/preview-pane";
import { DevCanvasTab } from "./components/canvas-tab";

type ContainerStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

interface DiffView {
  fileId: number;
  path: string;
  original: string;
  modified: string;
}

interface FileEntry {
  id: number;
  path: string;
  content?: string;
}

interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

// ── Zero Agent right-docked chat panel ────────────────────────────────────────
function ZeroAgentPanel({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      if (res.ok) {
        const data = (await res.json()) as { response?: string; message?: string };
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: data.response ?? data.message ?? "(no response)" },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: "Sorry, I ran into an error. Please try again." },
        ]);
      }
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Network error. Please check your connection." },
      ]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, projectId]);

  return (
    <div className="flex flex-col h-full border-l border-border bg-zinc-950 min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-primary" />
          <span className="text-xs font-semibold text-foreground">Zero Agent</span>
        </div>
        <button
          onClick={onClose}
          className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center gap-3 pt-8 text-center">
            <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
              <Bot className="h-5 w-5 text-primary" />
            </div>
            <div>
              <div className="text-sm font-medium text-foreground mb-1">Zero Agent</div>
              <div className="text-[11px] text-muted-foreground max-w-[180px] leading-relaxed">
                Ask me to write code, fix bugs, explain errors, or refactor files.
              </div>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={msg.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                msg.role === "user"
                  ? "bg-primary/15 border border-primary/20 text-foreground text-[11px] rounded-xl rounded-br-sm px-3 py-2 max-w-[85%] leading-relaxed"
                  : "bg-muted/60 border border-border text-foreground text-[11px] rounded-xl rounded-bl-sm px-3 py-2 max-w-[85%] leading-relaxed whitespace-pre-wrap"
              }
            >
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-muted/60 border border-border text-muted-foreground text-[11px] rounded-xl rounded-bl-sm px-3 py-2">
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-border p-2">
        <div className="flex items-end gap-1.5 bg-muted/40 border border-border rounded-xl px-3 py-2 focus-within:border-primary/40 transition-colors">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask Zero Agent…"
            rows={2}
            className="flex-1 bg-transparent text-xs text-foreground placeholder:text-muted-foreground/60 outline-none resize-none leading-relaxed"
          />
          <button
            onClick={() => void send()}
            disabled={!input.trim() || loading}
            className="flex items-center justify-center h-6 w-6 rounded-lg bg-primary text-primary-foreground disabled:opacity-40 transition-opacity shrink-0"
          >
            <Send className="h-3 w-3" />
          </button>
        </div>
        <p className="text-[9px] text-muted-foreground/50 text-center mt-1">
          Enter to send · Shift+Enter for new line
        </p>
      </div>
    </div>
  );
}

export default function DevWorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const projectId = Number(id);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const updateProject = useUpdateProject();

  // ── Project data ──────────────────────────────────────────────────────────
  const { data: project } = useGetProject(projectId, {
    query: {
      queryKey: getGetProjectQueryKey(projectId),
      refetchInterval: 5000,
    },
  });

  // ── Container state ───────────────────────────────────────────────────────
  const [containerStatus, setContainerStatus] = useState<ContainerStatus>("stopped");
  const [containerUrl, setContainerUrl] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);

  useEffect(() => {
    if (project) {
      setContainerStatus((project.containerStatus as ContainerStatus | undefined) ?? "stopped");
      setContainerUrl((project as { containerUrl?: string | null }).containerUrl ?? null);
    }
  }, [project]);

  const handleStartContainer = useCallback(async () => {
    setIsStarting(true);
    setContainerStatus("starting");
    try {
      const res = await fetch(`/api/projects/${projectId}/container/start`, { method: "POST" });
      if (res.ok) {
        const data = (await res.json()) as { containerStatus?: string; containerUrl?: string };
        setContainerStatus((data.containerStatus as ContainerStatus | undefined) ?? "starting");
        setContainerUrl(data.containerUrl ?? null);
      } else {
        setContainerStatus("error");
        toast({ title: "Failed to start container", variant: "destructive" });
      }
    } catch {
      setContainerStatus("error");
      toast({ title: "Failed to start container", variant: "destructive" });
    } finally {
      setIsStarting(false);
    }
  }, [projectId, toast]);

  const handleStopContainer = useCallback(async () => {
    try {
      await fetch(`/api/projects/${projectId}/container/stop`, { method: "POST" });
      setContainerStatus("hibernated");
      setContainerUrl(null);
    } catch {
      toast({ title: "Failed to stop container", variant: "destructive" });
    }
  }, [projectId, toast]);

  // ── Panel state ───────────────────────────────────────────────────────────
  const [activePanel, setActivePanel] = useState<PanelId>("files");
  const [leftPanelVisible, setLeftPanelVisible] = useState(true);
  const [zeroAgentOpen, setZeroAgentOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>("default");

  const handlePanelToggle = useCallback(
    (panel: PanelId) => {
      if (panel === "zero-agent") {
        setZeroAgentOpen((v) => !v);
        return;
      }
      if (panel === "canvas") {
        setCanvasOpen((v) => !v);
        return;
      }
      if (activePanel === panel) {
        setLeftPanelVisible((v) => !v);
      } else {
        setActivePanel(panel);
        setLeftPanelVisible(true);
      }
    },
    [activePanel],
  );

  const handlePaneLayout = useCallback((layout: PaneLayout) => {
    if (layout === "editor-split") {
      setLeftPanelVisible((v) => !v);
      setPaneLayout("default");
    } else {
      setPaneLayout((prev) => (prev === layout ? "default" : layout));
    }
  }, []);

  // Derived visibility from pane layout
  const showPreview = paneLayout !== "editor-max";
  const showLeftPanel =
    leftPanelVisible && paneLayout !== "editor-max" && paneLayout !== "preview-max";

  // ── Editor state ──────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  const { data: allFiles } = useListProjectFiles(projectId, {
    query: { queryKey: getListProjectFilesQueryKey(projectId) },
  });

  const openFile = useCallback(
    async (file: FileEntry, lineNumber?: number) => {
      const existingIdx = tabs.findIndex((t) => t.fileId === file.id);
      if (existingIdx !== -1) {
        setActiveTabIndex(existingIdx);
        if (lineNumber) {
          setTabs((prev) => prev.map((t, i) => (i === existingIdx ? { ...t, lineNumber } : t)));
        }
        return;
      }

      let content = file.content ?? "";
      if (!content) {
        try {
          const res = await fetch(`/api/projects/${projectId}/files/${file.id}`);
          if (res.ok) {
            const data = (await res.json()) as { content?: string };
            content = data.content ?? "";
          }
        } catch {
          /* ignore */
        }
      }

      const newTab: EditorTab = {
        fileId: file.id,
        path: file.path,
        content,
        isDirty: false,
        lineNumber,
      };

      setTabs((prev) => {
        const next = [...prev, newTab];
        setActiveTabIndex(next.length - 1);
        return next;
      });
    },
    [tabs, projectId],
  );

  const handleFileOpen = useCallback(
    (file: FileEntry) => {
      void openFile(file);
    },
    [openFile],
  );

  const handleNavigateToFile = useCallback(
    (fileId: number, lineNumber?: number) => {
      const typedFiles = (allFiles as FileEntry[] | undefined) ?? [];
      const file = typedFiles.find((f) => f.id === fileId);
      if (file) void openFile(file, lineNumber);
    },
    [allFiles, openFile],
  );

  const handleTabClose = useCallback((index: number) => {
    setTabs((prev) => {
      const next = prev.filter((_, i) => i !== index);
      setActiveTabIndex((active) => {
        if (active >= next.length) return Math.max(0, next.length - 1);
        if (active > index) return active - 1;
        return active;
      });
      return next;
    });
  }, []);

  const handleContentChange = useCallback((index: number, content: string) => {
    setTabs((prev) => prev.map((t, i) => (i === index ? { ...t, content, isDirty: true } : t)));
  }, []);

  const handleFileSaved = useCallback(
    (fileId: number) => {
      setTabs((prev) => prev.map((t) => (t.fileId === fileId ? { ...t, isDirty: false } : t)));
      setRefreshTrigger((n) => n + 1);
      toast({ title: "File saved" });
    },
    [toast],
  );

  // ── Project name ──────────────────────────────────────────────────────────
  const handleNameChange = useCallback(
    (name: string) => {
      void updateProject.mutateAsync(
        { id: projectId, data: { name } },
        {
          onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: getGetProjectQueryKey(projectId) });
          },
        },
      );
    },
    [projectId, updateProject, queryClient],
  );

  // ── Open new tab ──────────────────────────────────────────────────────────
  const handleOpenNewTab = useCallback(() => {
    window.open(window.location.href, "_blank");
  }, []);

  const projectName = project?.name ?? "Untitled";
  const previewUrl = (project as { publicSlug?: string | null } | undefined)?.publicSlug
    ? `/api/p/${(project as { publicSlug: string }).publicSlug}/`
    : null;

  return (
    <TooltipProvider>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-background text-foreground">
        {/* Top bar */}
        <TopBar
          projectId={projectId}
          projectName={projectName}
          containerStatus={containerStatus}
          isStarting={isStarting}
          onStartContainer={() => void handleStartContainer()}
          onStopContainer={() => void handleStopContainer()}
          onNameChange={handleNameChange}
          onOpenNewTab={handleOpenNewTab}
          paneLayout={paneLayout}
          onPaneLayout={handlePaneLayout}
        />

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Icon rail */}
          <IconRail
            activePanel={zeroAgentOpen ? "zero-agent" : canvasOpen ? "canvas" : activePanel}
            onPanelToggle={handlePanelToggle}
          />

          {/* Main panel group */}
          <PanelGroup direction="horizontal" className="flex-1 min-w-0">
            {/* Left panel */}
            {showLeftPanel && (
              <>
                <Panel
                  defaultSize={18}
                  minSize={12}
                  maxSize={35}
                  className="border-r border-border bg-zinc-950 overflow-hidden"
                >
                  {activePanel === "files" && (
                    <FileTree
                      projectId={projectId}
                      onFileOpen={handleFileOpen}
                      activeFilePath={tabs[activeTabIndex]?.path}
                    />
                  )}
                  {activePanel === "search" && (
                    <SearchPanel projectId={projectId} onNavigateToFile={handleNavigateToFile} />
                  )}
                  {activePanel === "tools" && <ToolsPanel projectId={projectId} />}
                  {activePanel === "packages" && <PlaceholderPanel type="packages" />}
                  {activePanel === "git" && <PlaceholderPanel type="git" />}
                  {activePanel === "secrets" && <PlaceholderPanel type="secrets" />}
                  {activePanel === "resources" && (
                    <ResourcesPanel projectId={projectId} containerStatus={containerStatus} />
                  )}
                </Panel>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
              </>
            )}

            {/* Center: tab bar + canvas board OR editor + terminal */}
            <Panel
              defaultSize={showLeftPanel ? (showPreview ? 50 : 82) : showPreview ? 65 : 100}
              minSize={25}
            >
              <div className="flex flex-col h-full min-h-0">
                {/* Center-panel tab bar */}
                <div className="shrink-0 flex items-center gap-0 border-b border-border bg-zinc-950 px-2">
                  <button
                    onClick={() => setCanvasOpen(false)}
                    className={[
                      "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                      !canvasOpen
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    Editor
                  </button>
                  <button
                    onClick={() => setCanvasOpen(true)}
                    className={[
                      "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                      canvasOpen
                        ? "border-primary text-foreground"
                        : "border-transparent text-muted-foreground hover:text-foreground",
                    ].join(" ")}
                  >
                    Canvas
                  </button>
                </div>

                {/* Tab content */}
                <div className="flex-1 min-h-0 overflow-hidden">
                  {canvasOpen ? (
                    <DevCanvasTab
                      projectId={projectId}
                      onProjectFilesChanged={() => {
                        setRefreshTrigger((n) => n + 1);
                        void queryClient.invalidateQueries({
                          queryKey: getListProjectFilesQueryKey(projectId),
                        });
                      }}
                    />
                  ) : (
                    <PanelGroup direction="vertical">
                      {/* Monaco editor */}
                      <Panel defaultSize={70} minSize={30} className="overflow-hidden">
                        <MonacoEditorPane
                          projectId={projectId}
                          tabs={tabs}
                          activeTabIndex={activeTabIndex}
                          diffView={diffView}
                          onTabClose={handleTabClose}
                          onTabActivate={setActiveTabIndex}
                          onContentChange={handleContentChange}
                          onFileSaved={handleFileSaved}
                          onDiffClose={() => setDiffView(null)}
                        />
                      </Panel>

                      <PanelResizeHandle className="h-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />

                      {/* Terminal panel */}
                      <Panel defaultSize={30} minSize={15} maxSize={60} className="overflow-hidden">
                        <TerminalPanel
                          projectId={projectId}
                          containerStatus={containerStatus}
                          containerUrl={containerUrl}
                          onStartContainer={() => void handleStartContainer()}
                          isStarting={isStarting}
                        />
                      </Panel>
                    </PanelGroup>
                  )}
                </div>
              </div>
            </Panel>

            {/* Right: preview pane */}
            {showPreview && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
                <Panel defaultSize={32} minSize={20} maxSize={60} className="overflow-hidden">
                  <PreviewPane
                    projectId={projectId}
                    containerUrl={containerUrl}
                    containerStatus={containerStatus}
                    previewUrl={previewUrl}
                    refreshTrigger={refreshTrigger}
                  />
                </Panel>
              </>
            )}

            {/* Zero Agent: right-docked chat panel */}
            {zeroAgentOpen && (
              <>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
                <Panel defaultSize={26} minSize={20} maxSize={45} className="overflow-hidden">
                  <ZeroAgentPanel projectId={projectId} onClose={() => setZeroAgentOpen(false)} />
                </Panel>
              </>
            )}
          </PanelGroup>
        </div>
      </div>
    </TooltipProvider>
  );
}
