import { useState, useCallback, useEffect } from "react";
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

import { IconRail, type PanelId } from "./components/icon-rail";
import { TopBar, type PaneLayout } from "./components/top-bar";
import { FileTree } from "./components/file-tree";
import { SearchPanel } from "./components/search-panel";
import { ResourcesPanel } from "./components/resources-panel";
import { ToolsPanel } from "./components/tools-panel";
import { SecretsPanel } from "./components/secrets-panel";
import { PackagesPanel } from "./components/packages-panel";
import { GitPanel } from "./components/git-panel";
import { DatabasePanel } from "./components/database-panel";
import { ObjectStoragePanel } from "./components/object-storage-panel";
import { ToolsSearchPopup } from "./components/tools-search-popup";
import { MonacoEditorPane, type EditorTab } from "./components/monaco-editor-pane";
import { TerminalPanel } from "./components/terminal-panel";
import { PreviewPane } from "./components/preview-pane";
import { DevCanvasTab } from "./components/canvas-tab";
import { DeploymentPanel } from "./components/deployment-panel";
import { DevChatPanel } from "./components/dev-chat-panel";

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
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [paneLayout, setPaneLayout] = useState<PaneLayout>("default");
  const [toolsSearchOpen, setToolsSearchOpen] = useState(false);
  const [deployPanelOpen, setDeployPanelOpen] = useState(false);

  const handlePanelToggle = useCallback(
    (panel: PanelId) => {
      if (panel === "zero-agent") {
        // Zero agent is always visible as the left main panel — nothing to toggle
        return;
      }
      if (panel === "canvas") {
        setCanvasOpen((v) => !v);
        return;
      }
      setCanvasOpen(false);
      if (activePanel === panel) {
        setLeftPanelVisible((v) => !v);
      } else {
        setActivePanel(panel);
        setLeftPanelVisible(true);
      }
    },
    [activePanel],
  );

  // Cmd+K / Ctrl+K → tools search popup
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setToolsSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const handlePaneLayout = useCallback((layout: PaneLayout) => {
    if (layout === "editor-split") {
      setLeftPanelVisible((v) => !v);
      setPaneLayout("default");
    } else {
      setPaneLayout((prev) => (prev === layout ? "default" : layout));
    }
  }, []);

  const showPreview = paneLayout !== "editor-max";
  const showToolsPanel =
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

  const handleOpenNewTab = useCallback(() => {
    window.open(window.location.href, "_blank");
  }, []);

  const projectName = project?.name ?? "Untitled";
  const projectSlug = (project as { publicSlug?: string | null } | undefined)?.publicSlug ?? null;
  const previewUrl = projectSlug ? `/api/p/${projectSlug}/` : null;

  return (
    <TooltipProvider>
      <div className="h-screen w-screen flex flex-col overflow-hidden bg-background text-foreground">
        {/* Tools search popup — Cmd+K */}
        <ToolsSearchPopup
          open={toolsSearchOpen}
          onClose={() => setToolsSearchOpen(false)}
          onSelect={(panelId) => {
            if (panelId === "canvas") {
              setCanvasOpen(true);
            } else {
              setCanvasOpen(false);
              setActivePanel(panelId);
              setLeftPanelVisible(true);
            }
            setToolsSearchOpen(false);
          }}
        />

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
          onDeploy={() => setDeployPanelOpen(true)}
        />

        {/* Deployment panel slide-over */}
        {deployPanelOpen && (
          <DeploymentPanel
            projectId={projectId}
            projectSlug={projectSlug}
            onClose={() => setDeployPanelOpen(false)}
          />
        )}

        {/* Body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Icon rail */}
          <IconRail
            activePanel={canvasOpen ? "canvas" : activePanel}
            onPanelToggle={handlePanelToggle}
            onOpenSearch={() => setToolsSearchOpen(true)}
          />

          {/* ── Main 3-column panel group ─────────────────────────────────── */}
          <PanelGroup direction="horizontal" className="flex-1 min-w-0">
            {/* ── Column 1: Tools panel (file tree, search, etc.) ─────────── */}
            {showToolsPanel && (
              <>
                <Panel
                  defaultSize={15}
                  minSize={10}
                  maxSize={30}
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
                  {activePanel === "tools" && (
                    <ToolsPanel
                      projectId={projectId}
                      onSelectTool={(toolId) => {
                        const validPanels: PanelId[] = [
                          "files",
                          "search",
                          "secrets",
                          "packages",
                          "git",
                          "database",
                          "storage",
                          "resources",
                        ];
                        if (validPanels.includes(toolId as PanelId)) {
                          setActivePanel(toolId as PanelId);
                        }
                      }}
                    />
                  )}
                  {activePanel === "secrets" && <SecretsPanel projectId={projectId} />}
                  {activePanel === "packages" && <PackagesPanel projectId={projectId} />}
                  {activePanel === "git" && <GitPanel projectId={projectId} />}
                  {activePanel === "database" && <DatabasePanel projectId={projectId} />}
                  {activePanel === "storage" && <ObjectStoragePanel projectId={projectId} />}
                  {activePanel === "resources" && (
                    <ResourcesPanel projectId={projectId} containerStatus={containerStatus} />
                  )}
                </Panel>
                <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
              </>
            )}

            {/* ── Column 2: Chat thread + Composer (stacked) ──────────────── */}
            <Panel
              defaultSize={showToolsPanel ? (showPreview ? 28 : 40) : showPreview ? 35 : 50}
              minSize={22}
              maxSize={55}
              className="overflow-hidden border-r border-border"
            >
              <DevChatPanel
                projectId={projectId}
                onBuildComplete={() => {
                  void queryClient.invalidateQueries({
                    queryKey: getListProjectFilesQueryKey(projectId),
                  });
                  setRefreshTrigger((n) => n + 1);
                }}
              />
            </Panel>

            <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />

            {/* ── Column 3: Editor + Terminal / Canvas / Preview ───────────── */}
            <Panel
              defaultSize={showToolsPanel ? (showPreview ? 57 : 60) : showPreview ? 65 : 50}
              minSize={30}
              className="overflow-hidden"
            >
              <PanelGroup direction="horizontal" className="h-full">
                {/* Editor + terminal OR canvas */}
                {paneLayout !== "preview-max" && (
                  <>
                    <Panel
                      defaultSize={showPreview ? 50 : 100}
                      minSize={25}
                      className="overflow-hidden"
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
                              <Panel defaultSize={65} minSize={30} className="overflow-hidden">
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
                              <Panel
                                defaultSize={35}
                                minSize={15}
                                maxSize={60}
                                className="overflow-hidden"
                              >
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

                    {showPreview && (
                      <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
                    )}
                  </>
                )}

                {/* Preview pane */}
                {showPreview && (
                  <Panel
                    defaultSize={paneLayout === "preview-max" ? 100 : 50}
                    minSize={20}
                    className="overflow-hidden"
                  >
                    <PreviewPane
                      projectId={projectId}
                      containerUrl={containerUrl}
                      containerStatus={containerStatus}
                      previewUrl={previewUrl}
                      refreshTrigger={refreshTrigger}
                    />
                  </Panel>
                )}
              </PanelGroup>
            </Panel>
          </PanelGroup>
        </div>
      </div>
    </TooltipProvider>
  );
}
