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
import { DevRuntimeStatusBar } from "./components/dev-runtime-status-bar";

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

// Which "view" is showing in the right-column third panel
type RightView = "preview" | "canvas" | "editor";

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
  const [activePanel, setActivePanel] = useState<PanelId>(null);
  const [leftPanelVisible, setLeftPanelVisible] = useState(false); // hidden by default like Replit
  const [rightView, setRightView] = useState<RightView>("preview");
  const [paneLayout, setPaneLayout] = useState<PaneLayout>("default");
  const [toolsSearchOpen, setToolsSearchOpen] = useState(false);
  const [deployPanelOpen, setDeployPanelOpen] = useState(false);

  const handlePanelToggle = useCallback(
    (panel: PanelId) => {
      if (panel === "zero-agent") return; // always visible
      if (panel === "canvas") {
        setRightView((v) => (v === "canvas" ? "preview" : "canvas"));
        return;
      }
      if (activePanel === panel && leftPanelVisible) {
        // Clicking the already-active panel icon collapses the sidebar
        setLeftPanelVisible(false);
      } else {
        setActivePanel(panel);
        setLeftPanelVisible(true);
      }
    },
    [activePanel, leftPanelVisible],
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

  const showPreviewOrCanvas = paneLayout !== "editor-max";
  const showToolsPanel =
    leftPanelVisible && paneLayout !== "editor-max" && paneLayout !== "preview-max";

  // ── Editor state ──────────────────────────────────────────────────────────
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [diffView, setDiffView] = useState<DiffView | null>(null);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  // Editor panel shows only when a file tab is open or editor-max layout is active
  const showEditorPanel =
    paneLayout !== "preview-max" && (tabs.length > 0 || paneLayout === "editor-max");

  // ── Project derived state ─────────────────────────────────────────────────
  const projectName = (project as { name?: string } | undefined)?.name ?? "Untitled Project";
  const projectSlug = (project as { slug?: string } | undefined)?.slug ?? "";
  const previewUrl = (project as { previewUrl?: string | null } | undefined)?.previewUrl ?? null;
  // hasContainer: true only when the project has a provisioned Fly.io machine.
  // Static HTML/SPA projects never have a container so their preview always works.
  const hasContainer = !!(project as { containerId?: string | null } | undefined)?.containerId;

  const { data: projectFiles } = useListProjectFiles(projectId, {
    query: {
      queryKey: getListProjectFilesQueryKey(projectId),
      refetchInterval: 30000,
    },
  });

  // ── File operations ───────────────────────────────────────────────────────
  const handleFileOpen = useCallback((file: FileEntry) => {
    setTabs((prev) => {
      const existing = prev.findIndex((t) => t.path === file.path);
      if (existing >= 0) {
        setActiveTabIndex(existing);
        return prev;
      }
      const newTab: EditorTab = {
        fileId: file.id,
        path: file.path,
        content: file.content ?? "",
        isDirty: false,
      };
      setActiveTabIndex(prev.length);
      return [...prev, newTab];
    });
    // Opening a file keeps preview visible alongside the editor
    setRightView((prev) => (prev === "canvas" ? "preview" : prev));
  }, []);

  const handleNavigateToFile = useCallback(
    (fileId: number, _lineNumber?: number) => {
      const files = projectFiles as FileEntry[] | undefined;
      const file = files?.find((f) => f.id === fileId);
      if (file) handleFileOpen(file);
    },
    [projectFiles, handleFileOpen],
  );

  const handleTabClose = useCallback(
    (index: number) => {
      setTabs((prev) => {
        const next = prev.filter((_, i) => i !== index);
        return next;
      });
      setActiveTabIndex((prev) => Math.max(0, Math.min(prev, tabs.length - 2)));
    },
    [tabs.length],
  );

  const handleContentChange = useCallback((index: number, content: string) => {
    setTabs((prev) => prev.map((t, i) => (i === index ? { ...t, content, isDirty: true } : t)));
  }, []);

  const handleFileSaved = useCallback((index: number) => {
    setTabs((prev) => prev.map((t, i) => (i === index ? { ...t, isDirty: false } : t)));
  }, []);

  // ── Name / container helpers ───────────────────────────────────────────────
  const handleNameChange = useCallback(
    (name: string) => {
      void updateProject.mutateAsync({
        id: projectId,
        data: { name },
      });
    },
    [projectId, updateProject],
  );

  const handleOpenNewTab = useCallback(() => {
    const url = previewUrl ?? `/api/projects/${projectId}/preview/`;
    window.open(url, "_blank");
  }, [projectId, previewUrl]);

  // ── Computed rail active panel ─────────────────────────────────────────────
  // Canvas icon highlights when canvas view is active
  const railActivePanel: PanelId =
    rightView === "canvas" ? "canvas" : leftPanelVisible && activePanel ? activePanel : null;

  return (
    <TooltipProvider>
      <div className="flex flex-col h-screen bg-background overflow-hidden">
        <ToolsSearchPopup
          open={toolsSearchOpen}
          onClose={() => setToolsSearchOpen(false)}
          onSelect={(panelId) => {
            if (panelId === "canvas") {
              setRightView("canvas");
            } else {
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
          onPanelOpen={handlePanelToggle}
        />

        {/* Infrastructure status bar — shows container/provisioning state */}
        <DevRuntimeStatusBar
          containerStatus={containerStatus}
          provisioningStatus={
            (project as { provisioningStatus?: string | null } | undefined)?.provisioningStatus
          }
          hasContainer={!!project && !!(project as { containerId?: string | null }).containerId}
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
            activePanel={railActivePanel}
            onPanelToggle={handlePanelToggle}
            onOpenSearch={() => setToolsSearchOpen(true)}
          />

          {/* ── Main panel group ──────────────────────────────────────────── */}
          <PanelGroup direction="horizontal" className="flex-1 min-w-0">
            {/* ── Column 1: Collapsible tools sidebar ──────────────────────── */}
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

            {/* ── Column 2: Chat thread + composer ─────────────────────────── */}
            <Panel
              defaultSize={
                showToolsPanel ? (showPreviewOrCanvas ? 28 : 40) : showPreviewOrCanvas ? 35 : 50
              }
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

            {/* ── Column 3: Editor (optional) + Preview/Canvas ─────────────── */}
            {showPreviewOrCanvas && (
              <Panel
                defaultSize={showToolsPanel ? 57 : 65}
                minSize={30}
                className="overflow-hidden"
              >
                <PanelGroup direction="horizontal" className="h-full">
                  {/* Editor + terminal — only shown when a tab is open */}
                  {showEditorPanel && (
                    <>
                      <Panel defaultSize={50} minSize={25} className="overflow-hidden">
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
                      </Panel>
                      <PanelResizeHandle className="w-px bg-border hover:bg-primary/40 transition-colors data-[resize-handle-state=drag]:bg-primary" />
                    </>
                  )}

                  {/* Preview / Canvas — tabs in the header bar */}
                  <Panel
                    defaultSize={showEditorPanel ? 50 : 100}
                    minSize={20}
                    className="overflow-hidden"
                  >
                    <div className="flex flex-col h-full min-h-0">
                      {/* Preview/Canvas tab bar */}
                      <div className="shrink-0 flex items-center gap-0 border-b border-border bg-zinc-950 px-2">
                        <button
                          onClick={() => setRightView("preview")}
                          className={[
                            "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                            rightView === "preview"
                              ? "border-primary text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground",
                          ].join(" ")}
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => setRightView("canvas")}
                          className={[
                            "px-3 py-1.5 text-xs font-medium border-b-2 transition-colors",
                            rightView === "canvas"
                              ? "border-primary text-foreground"
                              : "border-transparent text-muted-foreground hover:text-foreground",
                          ].join(" ")}
                        >
                          Canvas
                        </button>
                      </div>

                      {/* Content */}
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {rightView === "canvas" ? (
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
                          <PreviewPane
                            projectId={projectId}
                            containerUrl={containerUrl}
                            containerStatus={containerStatus}
                            hasContainer={hasContainer}
                            previewUrl={previewUrl}
                            refreshTrigger={refreshTrigger}
                          />
                        )}
                      </div>
                    </div>
                  </Panel>
                </PanelGroup>
              </Panel>
            )}
          </PanelGroup>
        </div>
      </div>
    </TooltipProvider>
  );
}
