import { useState, useCallback, useRef, useEffect } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  type Connection,
  type Edge,
  type Node,
  type OnNodeDrag,
  type OnEdgesDelete,
  type EdgeMouseHandler,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import html2canvas from "html2canvas";
import {
  useGetPageMap,
  usePutPageMap,
  useAnalyzePageMap,
  getGetPageMapQueryKey,
} from "@workspace/api-client-react";
import type { PageMapData } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Globe, Smartphone, Tablet, RefreshCw, Layout, Download, Layers, MapPin, FilePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageNode, type PageNodeData, type PageType } from "./page-node";
import { PageEdge, type ConnectionType } from "./page-edge";
import { PageDetailPanel, type PageMapNodeState } from "./page-detail-panel";
import { EdgeDetailPanel, type PageMapEdgeState } from "./edge-detail-panel";

type Platform = "web" | "ios" | "android";

const NODE_TYPES = { pageNode: PageNode };
const EDGE_TYPES = { pageEdge: PageEdge };

const EDGE_DEFAULTS = {
  type: "pageEdge",
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};

function runDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction = "LR",
): Node[] {
  // Create a fresh graph each call — reusing a singleton accumulates stale nodes
  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40 });

  nodes.forEach((n) => {
    g.setNode(n.id, { width: 208, height: 160 });
  });
  edges.forEach((e) => {
    g.setEdge(e.source, e.target);
  });

  dagre.layout(g);

  return nodes.map((n) => {
    const pos = g.node(n.id);
    return { ...n, position: { x: pos.x - 104, y: pos.y - 80 } };
  });
}

function platformMapToFlow(
  platformData: { nodes: PageMapNodeState[]; edges: { id: string; source: string; target: string; connectionType: string; aiGenerated: boolean }[] },
  projectId: number,
  isBuilding: boolean,
  onNodeClick: (nodeId: string) => void,
  onPreviewClick: (filePath: string) => void,
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = platformData.nodes.map((n) => ({
    id: n.id,
    type: "pageNode",
    position: n.position,
    data: {
      label: n.label,
      pageType: n.pageType as PageType,
      filePath: n.filePath,
      isNew: n.isNew,
      hasError: n.hasError,
      aiGenerated: n.aiGenerated,
      notes: n.notes,
      planned: (n as PageMapNodeState).planned ?? false,
      projectId,
      isBuilding,
      onNodeClick,
      onPreviewClick,
    } satisfies PageNodeData,
  }));

  const edges: Edge[] = platformData.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: "pageEdge",
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    data: {
      connectionType: e.connectionType as ConnectionType,
      aiGenerated: e.aiGenerated,
    },
  }));

  return { nodes, edges };
}

type PageMapTabProps = {
  projectId: number;
  isBuilding: boolean;
  isSyncingAfterEdit?: boolean;
  onSyncCleared?: () => void;
  onSwitchToPreview: (filePath?: string) => void;
  onSwitchToCode: (filePath?: string) => void;
  onSwitchToChat: (prefill?: string) => void;
};

export function PageMapTab({
  projectId,
  isBuilding,
  isSyncingAfterEdit = false,
  onSyncCleared,
  onSwitchToPreview,
  onSwitchToCode,
  onSwitchToChat,
}: PageMapTabProps) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const queryClient = useQueryClient();
  const syncStartedRef = useRef(false);

  const { data: mapResponse, isLoading, isFetching } = useGetPageMap(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetPageMapQueryKey(projectId),
      refetchInterval: isSyncingAfterEdit ? 2000 : false,
    },
  });

  const fetchStartedDuringSyncRef = useRef(false);

  const putPageMap = usePutPageMap();
  const analyzePageMap = useAnalyzePageMap();

  const platformData = mapResponse?.pageMapData?.[platform];
  const hasNodes = (platformData?.nodes?.length ?? 0) > 0 || nodes.length > 0;

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
  }, []);

  const onEdgeClick: EdgeMouseHandler = useCallback((_evt, edge) => {
    setSelectedNodeId(null);
    setSelectedEdgeId(edge.id);
  }, []);

  // Keep a stable ref to onSwitchToPreview so the callback identity
  // never forces the data-loading effect to re-run
  const onSwitchToPreviewRef = useRef(onSwitchToPreview);
  useEffect(() => { onSwitchToPreviewRef.current = onSwitchToPreview; }, [onSwitchToPreview]);

  const handlePreviewClick = useCallback((filePath: string) => {
    onSwitchToPreviewRef.current(filePath);
  }, []);

  // Effect 1: load nodes from server — only when server data or platform changes,
  // NOT when isBuilding/callbacks change (those triggered the disappearing-nodes bug)
  useEffect(() => {
    if (!platformData) return;
    const { nodes: rfNodes, edges: rfEdges } = platformMapToFlow(
      platformData as { nodes: PageMapNodeState[]; edges: { id: string; source: string; target: string; connectionType: string; aiGenerated: boolean }[] },
      projectId,
      false, // isBuilding is patched separately below; pass false here to avoid reset
      handleNodeClick,
      handlePreviewClick,
    );
    setNodes(rfNodes);
    setEdges(rfEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapResponse, platform, projectId]);

  // Effect 2: patch isBuilding flag in-place so nodes don't get re-created/disappear
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        data: { ...(n.data as PageNodeData), isBuilding },
      })),
    );
  }, [isBuilding, setNodes]);

  // Effect 3: When sync-after-edit starts, trigger an immediate refetch to kick off polling
  useEffect(() => {
    if (isSyncingAfterEdit) {
      syncStartedRef.current = true;
      fetchStartedDuringSyncRef.current = false;
      void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) });
    } else {
      syncStartedRef.current = false;
      fetchStartedDuringSyncRef.current = false;
    }
  }, [isSyncingAfterEdit, projectId, queryClient]);

  // Effect 4: Use isFetching lifecycle to detect when a sync-initiated fetch completes.
  // When isFetching transitions true → false after a fetch was started during sync,
  // the AI re-extraction has been picked up by the query and we can clear the indicator.
  useEffect(() => {
    if (!syncStartedRef.current) return;
    if (isFetching) {
      fetchStartedDuringSyncRef.current = true;
    } else if (fetchStartedDuringSyncRef.current) {
      // A fetch that started during sync just completed — dismiss indicator
      onSyncCleared?.();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isFetching]);

  const debouncedSave = useCallback((updatedNodes: Node[], updatedEdges: Edge[]) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const currentMap = mapResponse?.pageMapData ?? { web: { nodes: [], edges: [] }, ios: { nodes: [], edges: [] }, android: { nodes: [], edges: [] } };
      const updatedPlatform = {
        nodes: updatedNodes.map((n) => ({
          id: n.id,
          label: (n.data as PageNodeData).label,
          pageType: (n.data as PageNodeData).pageType,
          filePath: (n.data as PageNodeData).filePath,
          position: n.position,
          isNew: (n.data as PageNodeData).isNew,
          hasError: (n.data as PageNodeData).hasError,
          aiGenerated: (n.data as PageNodeData).aiGenerated,
          notes: (n.data as PageNodeData).notes,
          planned: (n.data as PageNodeData).planned ?? false,
        })),
        edges: updatedEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          connectionType: ((e.data as { connectionType?: string })?.connectionType ?? "nav") as ConnectionType,
          aiGenerated: (e.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
        })),
      };
      const payload: PageMapData = { ...currentMap, [platform]: updatedPlatform } as PageMapData;
      // Do NOT invalidate the query on save — refetching after every drag/edit causes
      // mapResponse to get a new object reference → Effect 1 resets all nodes → nodes
      // visually disappear/snap. The local state is already up-to-date; the next
      // scheduled refetch or explicit re-analyze will pick up server changes.
      putPageMap.mutate({ id: projectId, data: payload });
    }, 800);
  }, [mapResponse, platform, projectId, putPageMap]);

  const onNodeDragStop: OnNodeDrag = useCallback((_evt, _node, allNodes) => {
    debouncedSave(allNodes, edges);
  }, [debouncedSave, edges]);

  const onConnect = useCallback((connection: Connection) => {
    const newEdge: Edge = {
      ...connection,
      id: `edge-user-${Date.now()}`,
      type: "pageEdge",
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      data: { connectionType: "nav" as ConnectionType, aiGenerated: false },
    };
    setEdges((prev) => {
      const updated = addEdge(newEdge, prev);
      debouncedSave(nodes, updated);
      return updated;
    });
  }, [debouncedSave, nodes, setEdges]);

  const onEdgesDelete: OnEdgesDelete = useCallback((deleted) => {
    setSelectedEdgeId((prev) => {
      if (prev && deleted.some((e) => e.id === prev)) return null;
      return prev;
    });
    setEdges((prev) => {
      const deletedIds = new Set(deleted.map((e) => e.id));
      const updated = prev.filter((e) => !deletedIds.has(e.id));
      debouncedSave(nodes, updated);
      return updated;
    });
  }, [debouncedSave, nodes, setEdges]);

  const handleReanalyze = useCallback(() => {
    analyzePageMap.mutate(
      { id: projectId, params: { platform } },
      {
        onSuccess: () => {
          void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) });
        },
      },
    );
  }, [projectId, platform, analyzePageMap, queryClient]);

  const handleAutoLayout = useCallback(() => {
    const laid = runDagreLayout(nodes, edges);
    setNodes(laid);
    debouncedSave(laid, edges);
  }, [nodes, edges, setNodes, debouncedSave]);

  const handleExport = useCallback(async () => {
    if (!canvasRef.current) return;
    try {
      const canvas = await html2canvas(canvasRef.current, { backgroundColor: "#09090b", useCORS: false });
      const link = document.createElement("a");
      link.download = `page-map-${projectId}-${platform}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      /* best-effort */
    }
  }, [projectId, platform]);

  const selectedNode = selectedNodeId
    ? (nodes.find((n) => n.id === selectedNodeId)?.data as PageNodeData | undefined)
    : null;

  const selectedNodeState: PageMapNodeState | null = selectedNodeId && selectedNode
    ? {
        id: selectedNodeId,
        label: selectedNode.label,
        pageType: selectedNode.pageType,
        filePath: selectedNode.filePath,
        position: nodes.find((n) => n.id === selectedNodeId)?.position ?? { x: 0, y: 0 },
        isNew: selectedNode.isNew,
        hasError: selectedNode.hasError,
        aiGenerated: selectedNode.aiGenerated,
        notes: selectedNode.notes,
        planned: selectedNode.planned,
      }
    : null;

  const selectedEdgeState: PageMapEdgeState | null = (() => {
    if (!selectedEdgeId) return null;
    const edge = edges.find((e) => e.id === selectedEdgeId);
    if (!edge) return null;
    const sourceNode = nodes.find((n) => n.id === edge.source);
    const targetNode = nodes.find((n) => n.id === edge.target);
    return {
      id: edge.id,
      sourceLabel: (sourceNode?.data as PageNodeData | undefined)?.label ?? edge.source,
      targetLabel: (targetNode?.data as PageNodeData | undefined)?.label ?? edge.target,
      connectionType: ((edge.data as { connectionType?: ConnectionType })?.connectionType ?? "nav") as ConnectionType,
      aiGenerated: (edge.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
    };
  })();

  const handleEdgeSave = useCallback((edgeId: string, connectionType: ConnectionType) => {
    setEdges((prev) => {
      const updated = prev.map((e) =>
        e.id === edgeId
          ? { ...e, data: { ...(e.data as object), connectionType } }
          : e,
      );
      debouncedSave(nodes, updated);
      return updated;
    });
  }, [nodes, setEdges, debouncedSave]);

  const handleEdgeDelete = useCallback((edgeId: string) => {
    setSelectedEdgeId(null);
    setEdges((prev) => {
      const updated = prev.filter((e) => e.id !== edgeId);
      debouncedSave(nodes, updated);
      return updated;
    });
  }, [nodes, setEdges, debouncedSave]);

  const handleDetailSave = useCallback((updated: PageMapNodeState) => {
    setNodes((prev) => prev.map((n) => {
      if (n.id !== updated.id) return n;
      return {
        ...n,
        data: {
          ...(n.data as PageNodeData),
          label: updated.label,
          pageType: updated.pageType,
          notes: updated.notes,
        },
      };
    }));
    setTimeout(() => debouncedSave(nodes, edges), 50);
  }, [nodes, edges, setNodes, debouncedSave]);

  const handleFileOpen = useCallback((filePath: string) => {
    onSwitchToCode(filePath);
  }, [onSwitchToCode]);

  const handleAddPage = useCallback(() => {
    const id = `user-${Date.now()}`;

    // Compute canvas center in flow coordinates from current viewport
    const vp = viewportRef.current;
    const containerEl = canvasRef.current;
    const containerW = containerEl?.clientWidth ?? 800;
    const containerH = containerEl?.clientHeight ?? 600;
    const flowX = (containerW / 2 - vp.x) / vp.zoom - 104; // offset by half node width
    const flowY = (containerH / 2 - vp.y) / vp.zoom - 80;  // offset by half node height

    const newNode: Node = {
      id,
      type: "pageNode",
      position: { x: flowX, y: flowY },
      data: {
        label: "New Page",
        pageType: "other" as PageType,
        filePath: "",
        isNew: false,
        hasError: false,
        aiGenerated: false,
        notes: "",
        planned: true,
        projectId,
        isBuilding: false,
        onNodeClick: handleNodeClick,
        onPreviewClick: handlePreviewClick,
      } satisfies PageNodeData,
    };

    setNodes((prev) => {
      const updated = [...prev, newNode];

      // Immediate (non-debounced) save for the add action
      const currentMap = mapResponse?.pageMapData ?? { web: { nodes: [], edges: [] }, ios: { nodes: [], edges: [] }, android: { nodes: [], edges: [] } };
      const updatedPlatform = {
        nodes: updated.map((n) => ({
          id: n.id,
          label: (n.data as PageNodeData).label,
          pageType: (n.data as PageNodeData).pageType,
          filePath: (n.data as PageNodeData).filePath,
          position: n.position,
          isNew: (n.data as PageNodeData).isNew,
          hasError: (n.data as PageNodeData).hasError,
          aiGenerated: (n.data as PageNodeData).aiGenerated,
          notes: (n.data as PageNodeData).notes,
          planned: (n.data as PageNodeData).planned ?? false,
        })),
        edges: edges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          connectionType: ((e.data as { connectionType?: string })?.connectionType ?? "nav") as ConnectionType,
          aiGenerated: (e.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
        })),
      };
      const payload: PageMapData = { ...currentMap, [platform]: updatedPlatform } as PageMapData;
      // Do NOT invalidate query on save (same reason as debouncedSave — avoid node reset)
      putPageMap.mutate({ id: projectId, data: payload });

      return updated;
    });
    setSelectedNodeId(id);
  }, [edges, projectId, platform, mapResponse, handleNodeClick, handlePreviewClick, setNodes, putPageMap]);

  const handleModifyPage = useCallback((node: PageMapNodeState) => {
    const isPlanned = node.planned;
    const base = isPlanned ? `Build the ${node.label} page` : `Modify the ${node.label} page`;
    const suffix = node.notes ? `: ${node.notes}` : ": ";
    onSwitchToChat(base + suffix);
  }, [onSwitchToChat]);

  const handleDeleteNode = useCallback((nodeId: string) => {
    const updatedEdges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
    setEdges(updatedEdges);
    setNodes((prev) => {
      const updated = prev.filter((n) => n.id !== nodeId);
      debouncedSave(updated, updatedEdges);
      return updated;
    });
    setSelectedNodeId(null);
  }, [edges, setNodes, setEdges, debouncedSave]);

  const PLATFORMS: { key: Platform; label: string; Icon: React.ElementType }[] = [
    { key: "web", label: "Web", Icon: Globe },
    { key: "ios", label: "iOS", Icon: Smartphone },
    { key: "android", label: "Android", Icon: Tablet },
  ];

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden relative">
      {/* Top toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border bg-card/60 z-10">
        {/* Platform switcher */}
        <div className="flex bg-muted border border-border rounded-lg p-0.5 shrink-0">
          {PLATFORMS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setPlatform(key)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-colors",
                platform === key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        <div className="w-px h-5 bg-border shrink-0" />

        {platform === "web" && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleAddPage}
            >
              <FilePlus className="h-3 w-3" />
              Add page
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleReanalyze}
              disabled={analyzePageMap.isPending}
            >
              <RefreshCw className={cn("h-3 w-3", analyzePageMap.isPending && "animate-spin")} />
              {analyzePageMap.isPending ? "Analyzing…" : "Re-analyze"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={handleAutoLayout}
              disabled={!hasNodes}
            >
              <Layout className="h-3 w-3" />
              Auto-layout
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 text-xs gap-1.5"
              onClick={() => void handleExport()}
              disabled={!hasNodes}
            >
              <Download className="h-3 w-3" />
              Export PNG
            </Button>
          </>
        )}

        {(isBuilding || isSyncingAfterEdit || analyzePageMap.isPending) && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-primary font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            {(isSyncingAfterEdit || analyzePageMap.isPending) ? "Syncing page map…" : "Updating map after build…"}
          </div>
        )}
      </div>

      {/* Canvas area */}
      <div className="flex-1 relative overflow-hidden" ref={canvasRef}>
        {platform !== "web" ? (
          <ComingSoonState platform={platform} />
        ) : isLoading ? (
          <LoadingState />
        ) : !hasNodes ? (
          <EmptyState
            onAnalyze={handleReanalyze}
            isAnalyzing={analyzePageMap.isPending}
            onAddPage={handleAddPage}
          />
        ) : (
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onEdgesDelete={onEdgesDelete}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
            onMove={(_evt, viewport) => { viewportRef.current = viewport; }}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            defaultEdgeOptions={EDGE_DEFAULTS}
            fitView
            fitViewOptions={{ padding: 0.2 }}
            deleteKeyCode={["Delete", "Backspace"]}
            className="bg-background"
            proOptions={{ hideAttribution: true }}
          >
            <Background color="hsl(var(--border))" gap={20} size={1} />
            <Controls
              className="!bg-card !border !border-border !shadow-md !rounded-xl overflow-hidden"
              showInteractive={false}
            />
            <MiniMap
              className="!bg-card !border !border-border !shadow-md !rounded-xl overflow-hidden"
              nodeColor="hsl(var(--primary) / 0.4)"
              maskColor="hsl(var(--background) / 0.8)"
            />
          </ReactFlow>
        )}

        {/* Side panel — node or edge, mutually exclusive */}
        <PageDetailPanel
          node={selectedEdgeId ? null : selectedNodeState}
          onClose={() => setSelectedNodeId(null)}
          onSave={handleDetailSave}
          onFileOpen={handleFileOpen}
          onModifyPage={handleModifyPage}
          onDelete={handleDeleteNode}
        />
        <EdgeDetailPanel
          edge={selectedNodeId ? null : selectedEdgeState}
          onClose={() => setSelectedEdgeId(null)}
          onSave={handleEdgeSave}
          onDelete={handleEdgeDelete}
        />
      </div>
    </div>
  );
}

function EmptyState({ onAnalyze, isAnalyzing, onAddPage }: { onAnalyze: () => void; isAnalyzing: boolean; onAddPage: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <MapPin className="h-8 w-8 text-primary/60" />
      </div>
      <div>
        <div className="text-base font-semibold text-foreground">No pages mapped yet</div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          Analyze your app to discover existing pages, or add placeholder pages to plan your structure first.
        </div>
      </div>
      <div className="flex items-center gap-3">
        <Button onClick={onAnalyze} disabled={isAnalyzing} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", isAnalyzing && "animate-spin")} />
          {isAnalyzing ? "Analyzing app…" : "Analyze my app"}
        </Button>
        <Button variant="outline" onClick={onAddPage} className="gap-2">
          <FilePlus className="h-4 w-4" />
          Add a page
        </Button>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center animate-pulse">
          <Layers className="h-5 w-5 text-primary/60" />
        </div>
        <div className="text-sm text-muted-foreground">Loading page map…</div>
      </div>
    </div>
  );
}

function ComingSoonState({ platform }: { platform: Platform }) {
  const Icon = platform === "ios" ? Smartphone : Tablet;
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-muted border border-border flex items-center justify-center">
        <Icon className="h-8 w-8 text-muted-foreground/50" />
      </div>
      <div>
        <div className="text-base font-semibold text-foreground">
          {platform === "ios" ? "iOS" : "Android"} coming soon
        </div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          Your app will be mapped here once {platform === "ios" ? "iOS" : "Android"} generation is active. Currently only Web mapping is supported.
        </div>
      </div>
    </div>
  );
}
