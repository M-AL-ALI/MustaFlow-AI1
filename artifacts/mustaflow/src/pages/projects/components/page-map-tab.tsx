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
import { Globe, Smartphone, Tablet, RefreshCw, Layout, Download, Layers, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageNode, type PageNodeData, type PageType } from "./page-node";
import { PageEdge, type ConnectionType } from "./page-edge";
import { PageDetailPanel, type PageMapNodeState } from "./page-detail-panel";

type Platform = "web" | "ios" | "android";

const NODE_TYPES = { pageNode: PageNode };
const EDGE_TYPES = { pageEdge: PageEdge };

const EDGE_DEFAULTS = {
  type: "pageEdge",
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};

const DAGRE_GRAPH = new dagre.graphlib.Graph();
DAGRE_GRAPH.setDefaultEdgeLabel(() => ({}));

function runDagreLayout(
  nodes: Node[],
  edges: Edge[],
  direction = "LR",
): Node[] {
  DAGRE_GRAPH.setGraph({ rankdir: direction, ranksep: 80, nodesep: 40 });

  nodes.forEach((n) => {
    DAGRE_GRAPH.setNode(n.id, { width: 208, height: 160 });
  });
  edges.forEach((e) => {
    DAGRE_GRAPH.setEdge(e.source, e.target);
  });

  dagre.layout(DAGRE_GRAPH);

  return nodes.map((n) => {
    const pos = DAGRE_GRAPH.node(n.id);
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
  onSwitchToPreview: (filePath?: string) => void;
  onSwitchToCode: (filePath?: string) => void;
  onSwitchToChat: (prefill?: string) => void;
};

export function PageMapTab({
  projectId,
  isBuilding,
  onSwitchToPreview,
  onSwitchToCode,
  onSwitchToChat,
}: PageMapTabProps) {
  const [platform, setPlatform] = useState<Platform>("web");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryClient = useQueryClient();

  const { data: mapResponse, isLoading } = useGetPageMap(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetPageMapQueryKey(projectId),
    },
  });

  const putPageMap = usePutPageMap();
  const analyzePageMap = useAnalyzePageMap();

  const platformData = mapResponse?.pageMapData?.[platform];
  const hasNodes = (platformData?.nodes?.length ?? 0) > 0;

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);

  const handlePreviewClick = useCallback((filePath: string) => {
    onSwitchToPreview(filePath);
  }, [onSwitchToPreview]);

  useEffect(() => {
    if (!platformData) return;
    const { nodes: rfNodes, edges: rfEdges } = platformMapToFlow(
      platformData as { nodes: PageMapNodeState[]; edges: { id: string; source: string; target: string; connectionType: string; aiGenerated: boolean }[] },
      projectId,
      isBuilding,
      handleNodeClick,
      handlePreviewClick,
    );
    setNodes(rfNodes);
    setEdges(rfEdges);
  }, [mapResponse, platform, projectId, isBuilding, handleNodeClick, handlePreviewClick]);

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
      putPageMap.mutate(
        { id: projectId, data: payload },
        { onSuccess: () => { void queryClient.invalidateQueries({ queryKey: getGetPageMapQueryKey(projectId) }); } },
      );
    }, 800);
  }, [mapResponse, platform, projectId, putPageMap, queryClient]);

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
      }
    : null;

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

  const handleModifyPage = useCallback((node: PageMapNodeState) => {
    onSwitchToChat(`Modify the ${node.label} page: `);
  }, [onSwitchToChat]);

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

        {isBuilding && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-primary font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            Updating map after build…
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

        {/* Side panel */}
        <PageDetailPanel
          node={selectedNodeState}
          onClose={() => setSelectedNodeId(null)}
          onSave={handleDetailSave}
          onFileOpen={handleFileOpen}
          onModifyPage={handleModifyPage}
        />
      </div>
    </div>
  );
}

function EmptyState({ onAnalyze, isAnalyzing }: { onAnalyze: () => void; isAnalyzing: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <MapPin className="h-8 w-8 text-primary/60" />
      </div>
      <div>
        <div className="text-base font-semibold text-foreground">No pages mapped yet</div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          Run an AI analysis to automatically discover all pages in your app and map how they connect.
        </div>
      </div>
      <Button onClick={onAnalyze} disabled={isAnalyzing} className="gap-2">
        <RefreshCw className={cn("h-4 w-4", isAnalyzing && "animate-spin")} />
        {isAnalyzing ? "Analyzing app…" : "Analyze my app"}
      </Button>
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
