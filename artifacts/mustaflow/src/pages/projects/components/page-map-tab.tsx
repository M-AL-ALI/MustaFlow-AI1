import { useState, useCallback, useRef, useEffect, useMemo } from "react";
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
  type ReactFlowInstance,
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
import {
  Globe,
  Smartphone,
  Tablet,
  RefreshCw,
  Layout,
  Download,
  Layers,
  MapPin,
  FilePlus,
  AlertTriangle,
  Sparkles,
  Filter,
  ArrowUpRight,
  CircleCheck,
  ListTree,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PageNode, type PageNodeData, type PageType } from "./page-node";
import { PageEdge, type ConnectionType } from "./page-edge";
import {
  PageDetailPanel,
  type PageMapNodeState,
  type WiringEdge,
  type WiringPage,
} from "./page-detail-panel";
import { BlocksPanel } from "./blocks-panel";
import { EdgeDetailPanel, type PageMapEdgeState } from "./edge-detail-panel";
import {
  pageCardStatus,
  pagePurpose,
  pageRouteFromFilePath,
  pageRouteIsNavigable,
} from "./page-map-card-model";

type Platform = "web" | "ios" | "android";

const NODE_TYPES = { pageNode: PageNode };
const EDGE_TYPES = { pageEdge: PageEdge };

const EDGE_DEFAULTS = {
  type: "pageEdge",
  animated: false,
  markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
};

function runDagreLayout(nodes: Node[], edges: Edge[], direction = "LR"): Node[] {
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
  platformData: {
    nodes: PageMapNodeState[];
    edges: {
      id: string;
      source: string;
      target: string;
      connectionType: string;
      aiGenerated: boolean;
    }[];
  },
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
  const [view, setView] = useState<"contents" | "connections">("contents");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "issues" | "built" | "planned">("all");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const queryClient = useQueryClient();
  const syncStartedRef = useRef(false);
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const freshNodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [freshNodeIds, setFreshNodeIds] = useState<Set<string>>(new Set());
  // IDs of nodes deleted locally but not yet flushed to the server.
  // Effect 1 filters these out so background refetches can't resurrect them.
  const pendingDeletedNodeIdsRef = useRef<Set<string>>(new Set());

  const {
    data: mapResponse,
    isLoading,
    isFetching,
  } = useGetPageMap(projectId, {
    query: {
      enabled: !!projectId,
      queryKey: getGetPageMapQueryKey(projectId),
      refetchInterval: isSyncingAfterEdit ? 2000 : false,
    },
  });

  const fetchStartedDuringSyncRef = useRef(false);

  const putPageMap = usePutPageMap();
  const analyzePageMap = useAnalyzePageMap();

  // Stable refs so timer callbacks always read the latest data, not stale closures.
  // Initialized after the query so TypeScript can infer the correct type.
  const mapResponseRef = useRef(mapResponse);
  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  // True once fitView has been called — prevents the camera from jumping on every reload
  const initialisedRef = useRef(false);

  // Keep stable refs in sync with latest values so timer callbacks never capture stale closures
  useEffect(() => {
    mapResponseRef.current = mapResponse;
  }, [mapResponse]);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);
  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  // Reset the one-time fitView guard whenever the platform changes so that
  // switching back to a platform re-frames all nodes correctly on the next onInit.
  useEffect(() => {
    initialisedRef.current = false;
  }, [platform]);

  // When the user switches platforms, pending-delete IDs from the previous platform
  // are irrelevant (node IDs are platform-scoped). Clear the set so Effect 1 doesn't
  // accidentally filter nodes that happen to share an ID on the new platform.
  useEffect(() => {
    pendingDeletedNodeIdsRef.current.clear();
    seenNodeIdsRef.current.clear();
    setFreshNodeIds(new Set());
  }, [platform]);

  useEffect(() => {
    const currentIds = new Set(nodes.map((node) => node.id));
    const addedIds = nodes
      .filter((node) => !seenNodeIdsRef.current.has(node.id))
      .map((node) => node.id);
    seenNodeIdsRef.current = currentIds;
    if (addedIds.length === 0) return;

    setFreshNodeIds(new Set(addedIds));
    if (freshNodeTimerRef.current) clearTimeout(freshNodeTimerRef.current);
    freshNodeTimerRef.current = setTimeout(() => setFreshNodeIds(new Set()), 900);

    return () => {
      if (freshNodeTimerRef.current) clearTimeout(freshNodeTimerRef.current);
    };
  }, [nodes]);

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
  useEffect(() => {
    onSwitchToPreviewRef.current = onSwitchToPreview;
  }, [onSwitchToPreview]);

  const handlePreviewClick = useCallback((filePath: string) => {
    onSwitchToPreviewRef.current(pageRouteFromFilePath(filePath));
  }, []);

  // Effect 1: load nodes from server — only when server data or platform changes,
  // NOT when isBuilding/callbacks change (those triggered the disappearing-nodes bug)
  useEffect(() => {
    if (!platformData) return;
    const { nodes: rfNodes, edges: rfEdges } = platformMapToFlow(
      platformData as {
        nodes: PageMapNodeState[];
        edges: {
          id: string;
          source: string;
          target: string;
          connectionType: string;
          aiGenerated: boolean;
        }[];
      },
      projectId,
      false, // isBuilding is patched separately below; pass false here to avoid reset
      handleNodeClick,
      handlePreviewClick,
    );

    // Guard against deleted nodes reappearing from a stale background refetch.
    //
    // When a node is deleted, its ID is added to `pendingDeletedNodeIdsRef` immediately.
    // The ID is removed lazily here — only once the server snapshot confirms the node
    // is gone. This is intentionally server-driven rather than mutation-ACK-driven:
    // clearing on `onSuccess` would be premature if an older in-flight save (that
    // pre-dated the delete) ACKs first and triggers clearing before the delete save
    // has been processed by the server.
    //
    // Reconcile: any pending-delete ID absent from the server snapshot means the
    // server has already accepted the deletion — safe to evict from the guard.
    const pendingDeletes = pendingDeletedNodeIdsRef.current;
    if (pendingDeletes.size > 0) {
      const serverNodeIds = new Set(rfNodes.map((n) => n.id));
      for (const id of pendingDeletes) {
        if (!serverNodeIds.has(id)) {
          pendingDeletes.delete(id);
        }
      }
    }
    // Filter remaining pending-delete IDs (not yet confirmed deleted by server).
    const filteredNodes =
      pendingDeletes.size > 0 ? rfNodes.filter((n) => !pendingDeletes.has(n.id)) : rfNodes;
    const filteredEdges =
      pendingDeletes.size > 0
        ? rfEdges.filter((e) => !pendingDeletes.has(e.source) && !pendingDeletes.has(e.target))
        : rfEdges;

    // Auto-layout when all positions are (0,0) — sentinel for "never been positioned"
    const needsAutoLayout =
      filteredNodes.length > 0 &&
      filteredNodes.every((n) => n.position.x === 0 && n.position.y === 0);

    if (needsAutoLayout) {
      const laidOut = runDagreLayout(filteredNodes, filteredEdges);
      setNodes(laidOut);
      setEdges(filteredEdges);
      // Persist the auto-computed positions immediately so next load doesn't re-layout
      const currentMap = mapResponseRef.current?.pageMapData ?? {
        web: { nodes: [], edges: [] },
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
      };
      const updatedPlatform = {
        nodes: laidOut.map((n) => ({
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
        edges: filteredEdges.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          connectionType: ((e.data as { connectionType?: string })?.connectionType ??
            "nav") as ConnectionType,
          aiGenerated: (e.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
        })),
      };
      const payload: PageMapData = { ...currentMap, [platform]: updatedPlatform } as PageMapData;
      putPageMap.mutate({ id: projectId, data: payload });
    } else {
      setNodes(filteredNodes);
      setEdges(filteredEdges);
    }
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

  const debouncedSave = useCallback(
    (updatedNodes: Node[], updatedEdges: Edge[]) => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        // Read mapResponse from the ref so background refetches that fire between
        // scheduling and execution don't replace in-flight edits with stale data.
        const currentMap = mapResponseRef.current?.pageMapData ?? {
          web: { nodes: [], edges: [] },
          ios: { nodes: [], edges: [] },
          android: { nodes: [], edges: [] },
        };
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
            connectionType: ((e.data as { connectionType?: string })?.connectionType ??
              "nav") as ConnectionType,
            aiGenerated: (e.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
          })),
        };
        const payload: PageMapData = { ...currentMap, [platform]: updatedPlatform } as PageMapData;
        // Do NOT invalidate the query on save — refetching after every drag/edit causes
        // mapResponse to get a new object reference → Effect 1 resets all nodes → nodes
        // visually disappear/snap. The local state is already up-to-date; the next
        // scheduled refetch or explicit re-analyze will pick up server changes.
        // NOTE: do not clear pendingDeletedNodeIdsRef here. Clearing on mutation ACK
        // is premature — an older pre-delete in-flight save could ACK first. Instead,
        // Effect 1 reconciles the set lazily once the server snapshot confirms deletion.
        putPageMap.mutate({ id: projectId, data: payload });
      }, 800);
      // mapResponseRef is a stable ref — intentionally excluded from deps so the timer
      // identity doesn't change on every background refetch.
    },
    [platform, projectId, putPageMap],
  );

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_evt, _node, allNodes) => {
      debouncedSave(allNodes, edges);
    },
    [debouncedSave, edges],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const newEdge: Edge = {
        ...connection,
        id: `edge-user-${Date.now()}`,
        type: "pageEdge",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        data: { connectionType: "nav" as ConnectionType, aiGenerated: false },
      };
      setEdges((prev) => {
        const updated = addEdge(newEdge, prev);
        // Use nodesRef so we read current nodes, not the stale closure value
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [debouncedSave, setEdges],
  );

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (deleted) => {
      setSelectedEdgeId((prev) => {
        if (prev && deleted.some((e) => e.id === prev)) return null;
        return prev;
      });
      setEdges((prev) => {
        const deletedIds = new Set(deleted.map((e) => e.id));
        const updated = prev.filter((e) => !deletedIds.has(e.id));
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [debouncedSave, setEdges],
  );

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
      const canvas = await html2canvas(canvasRef.current, {
        backgroundColor: "#09090b",
        useCORS: false,
      });
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

  const selectedNodeState: PageMapNodeState | null =
    selectedNodeId && selectedNode
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
      connectionType: ((edge.data as { connectionType?: ConnectionType })?.connectionType ??
        "nav") as ConnectionType,
      aiGenerated: (edge.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
    };
  })();

  const handleEdgeSave = useCallback(
    (edgeId: string, connectionType: ConnectionType) => {
      setEdges((prev) => {
        const updated = prev.map((e) =>
          e.id === edgeId ? { ...e, data: { ...(e.data as object), connectionType } } : e,
        );
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [setEdges, debouncedSave],
  );

  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      setSelectedEdgeId(null);
      setEdges((prev) => {
        const updated = prev.filter((e) => e.id !== edgeId);
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [setEdges, debouncedSave],
  );

  const handleDetailSave = useCallback(
    (updated: PageMapNodeState) => {
      // Use a functional updater so we capture the post-setNodes array, not the
      // stale `nodes` closure that existed before setNodes ran.
      setNodes((prev) => {
        const updatedNodes = prev.map((n) => {
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
        });
        nodesRef.current = updatedNodes;
        debouncedSave(updatedNodes, edgesRef.current);
        return updatedNodes;
      });
    },
    [setNodes, debouncedSave],
  );

  const handleFileOpen = useCallback(
    (filePath: string) => {
      onSwitchToCode(filePath);
    },
    [onSwitchToCode],
  );

  const handleAddPage = useCallback(() => {
    const id = `user-${Date.now()}`;

    // Compute canvas center in flow coordinates from current viewport
    const vp = viewportRef.current;
    const containerEl = canvasRef.current;
    const containerW = containerEl?.clientWidth ?? 800;
    const containerH = containerEl?.clientHeight ?? 600;
    const flowX = (containerW / 2 - vp.x) / vp.zoom - 104; // offset by half node width
    const flowY = (containerH / 2 - vp.y) / vp.zoom - 80; // offset by half node height

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

      // Immediate (non-debounced) save for the add action.
      // Read from mapResponseRef so we get the latest server snapshot even if a
      // background refetch updated mapResponse after this callback was created.
      const currentMap = mapResponseRef.current?.pageMapData ?? {
        web: { nodes: [], edges: [] },
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
      };
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
        edges: edgesRef.current.map((e) => ({
          id: e.id,
          source: e.source,
          target: e.target,
          connectionType: ((e.data as { connectionType?: string })?.connectionType ??
            "nav") as ConnectionType,
          aiGenerated: (e.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
        })),
      };
      const payload: PageMapData = { ...currentMap, [platform]: updatedPlatform } as PageMapData;
      // Do NOT invalidate query on save (same reason as debouncedSave — avoid node reset)
      putPageMap.mutate({ id: projectId, data: payload });

      return updated;
    });
    setSelectedNodeId(id);
    // mapResponseRef and edgesRef are stable refs — intentionally omitted from deps
  }, [projectId, platform, handleNodeClick, handlePreviewClick, setNodes, putPageMap]);

  const handleModifyPage = useCallback(
    (node: PageMapNodeState) => {
      const isPlanned = node.planned;
      const base = isPlanned ? `Build the ${node.label} page` : `Modify the ${node.label} page`;
      const suffix = node.notes ? `: ${node.notes}` : ": ";
      onSwitchToChat(base + suffix);
    },
    [onSwitchToChat],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      // Register the deletion immediately so Effect 1 can filter it out of any
      // background refetch that arrives before the debounced save completes.
      pendingDeletedNodeIdsRef.current.add(nodeId);
      const updatedEdges = edges.filter((e) => e.source !== nodeId && e.target !== nodeId);
      setEdges(updatedEdges);
      setNodes((prev) => {
        const updated = prev.filter((n) => n.id !== nodeId);
        debouncedSave(updated, updatedEdges);
        return updated;
      });
      setSelectedNodeId(null);
    },
    [edges, setNodes, setEdges, debouncedSave],
  );

  // ---------------------------------------------------------------------------
  // Wiring / connectivity computation
  // ---------------------------------------------------------------------------
  // For each node, compute incoming/outgoing edge counts and heuristic flags:
  //   isOrphan = no incoming AND not a typical entry page (landing/auth/404)
  //   isDeadEnd = no outgoing AND not a typical terminal page (detail/404/modal/sheet)
  // Then build displayNodes (memoized) that injects these into each node's data
  // along with a `dimmed` flag derived from the active filter. We pass
  // displayNodes to ReactFlow, never mutating the underlying `nodes` state, so
  // drag/select tracking via onNodesChange remains correct.
  const ENTRY_TYPES = new Set<PageType>(["landing", "auth", "404"]);
  const TERMINAL_TYPES = new Set<PageType>(["detail", "404", "modal", "sheet"]);

  const connectivity = useMemo(() => {
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const e of edges) {
      outgoing.set(e.source, (outgoing.get(e.source) ?? 0) + 1);
      incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);
    }
    const perNode = new Map<
      string,
      { incoming: number; outgoing: number; isOrphan: boolean; isDeadEnd: boolean }
    >();
    for (const n of nodes) {
      const d = n.data as PageNodeData;
      const inc = incoming.get(n.id) ?? 0;
      const out = outgoing.get(n.id) ?? 0;
      const isOrphan = inc === 0 && !ENTRY_TYPES.has(d.pageType);
      const isDeadEnd = out === 0 && !TERMINAL_TYPES.has(d.pageType);
      perNode.set(n.id, { incoming: inc, outgoing: out, isOrphan, isDeadEnd });
    }
    return perNode;
    // ENTRY_TYPES / TERMINAL_TYPES are module-scoped constants in spirit (declared above)
    // but stable across renders; useMemo deps are nodes + edges only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges]);

  const issuesCount = useMemo(() => {
    let count = 0;
    for (const stats of connectivity.values()) {
      if (stats.isOrphan || stats.isDeadEnd) count++;
    }
    return count;
  }, [connectivity]);

  const displayNodes = useMemo(() => {
    return nodes.map((n) => {
      const stats = connectivity.get(n.id);
      const d = n.data as PageNodeData;
      const isOrphan = stats?.isOrphan ?? false;
      const isDeadEnd = stats?.isDeadEnd ?? false;
      const hasIssue = isOrphan || isDeadEnd;
      let dimmed = false;
      if (filter === "issues") dimmed = !hasIssue;
      else if (filter === "built") dimmed = !!d.planned;
      else if (filter === "planned") dimmed = !d.planned;
      return {
        ...n,
        data: {
          ...d,
          incoming: stats?.incoming ?? 0,
          outgoing: stats?.outgoing ?? 0,
          isOrphan,
          isDeadEnd,
          dimmed,
        } satisfies PageNodeData,
      };
    });
  }, [nodes, connectivity, filter]);

  // Wiring lists for the selected node — drives the detail panel.
  const selectedIncoming: WiringEdge[] = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.target === selectedNodeId)
      .map((e) => {
        const src = nodes.find((n) => n.id === e.source);
        const d = src?.data as PageNodeData | undefined;
        return {
          edgeId: e.id,
          page: {
            id: e.source,
            label: d?.label ?? e.source,
            pageType: (d?.pageType ?? "other") as PageType,
            planned: d?.planned,
          },
        };
      });
  }, [selectedNodeId, edges, nodes]);

  const selectedOutgoing: WiringEdge[] = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.source === selectedNodeId)
      .map((e) => {
        const tgt = nodes.find((n) => n.id === e.target);
        const d = tgt?.data as PageNodeData | undefined;
        return {
          edgeId: e.id,
          page: {
            id: e.target,
            label: d?.label ?? e.target,
            pageType: (d?.pageType ?? "other") as PageType,
            planned: d?.planned,
          },
        };
      });
  }, [selectedNodeId, edges, nodes]);

  const availableTargets: WiringPage[] = useMemo(() => {
    return nodes.map((n) => {
      const d = n.data as PageNodeData;
      return { id: n.id, label: d.label, pageType: d.pageType, planned: d.planned };
    });
  }, [nodes]);

  // Wire callbacks — create / remove edges from the side panel.
  const handleWireTo = useCallback(
    (targetNodeId: string) => {
      if (!selectedNodeId || selectedNodeId === targetNodeId) return;
      // Avoid duplicate edges between same pair
      const exists = edges.some((e) => e.source === selectedNodeId && e.target === targetNodeId);
      if (exists) return;
      const newEdge: Edge = {
        id: `edge-user-${Date.now()}`,
        source: selectedNodeId,
        target: targetNodeId,
        type: "pageEdge",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        data: { connectionType: "nav" as ConnectionType, aiGenerated: false },
      };
      setEdges((prev) => {
        const updated = [...prev, newEdge];
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [selectedNodeId, edges, setEdges, debouncedSave],
  );

  const handleUnwire = useCallback(
    (edgeId: string) => {
      setEdges((prev) => {
        const updated = prev.filter((e) => e.id !== edgeId);
        debouncedSave(nodesRef.current, updated);
        return updated;
      });
    },
    [setEdges, debouncedSave],
  );

  const handleJumpToNode = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setSelectedNodeId(nodeId);
  }, []);

  const handleAskAiToWire = useCallback(
    (node: PageMapNodeState) => {
      const stats = connectivity.get(node.id);
      const isOrphan = stats?.isOrphan ?? false;
      const isDeadEnd = stats?.isDeadEnd ?? false;
      const candidates = nodes
        .filter((n) => n.id !== node.id && !(n.data as PageNodeData).planned)
        .map((n) => (n.data as PageNodeData).label)
        .slice(0, 5);
      const lines: string[] = [];
      lines.push(`Wire up the "${node.label}" page so it is properly connected.`);
      if (node.filePath) lines.push(`File: ${node.filePath}`);
      if (isOrphan)
        lines.push(
          `- It currently has NO incoming links. Add navigation to it from a sensible existing page (e.g. ${candidates.join(", ") || "the landing / dashboard"}).`,
        );
      if (isDeadEnd)
        lines.push(
          `- It currently has NO outgoing links. Add appropriate buttons or links so users can navigate forward / back.`,
        );
      lines.push(`Keep the visual design intact — only add the missing navigation.`);
      onSwitchToChat(lines.join("\n"));
    },
    [connectivity, nodes, onSwitchToChat],
  );

  const handleFixAllWiring = useCallback(() => {
    const issues = nodes
      .map((n) => {
        const stats = connectivity.get(n.id);
        const d = n.data as PageNodeData;
        if (!stats || (!stats.isOrphan && !stats.isDeadEnd)) return null;
        const parts: string[] = [];
        if (stats.isOrphan) parts.push("no incoming links");
        if (stats.isDeadEnd) parts.push("no outgoing links");
        return `- "${d.label}"${d.filePath ? ` (${d.filePath})` : ""}: ${parts.join(" and ")}`;
      })
      .filter((x): x is string => x !== null);
    if (issues.length === 0) return;
    const msg = [
      `Fix the navigation wiring across these pages so the app is fully connected:`,
      ...issues,
      ``,
      `For each one, add the right buttons / links / redirects so users can reach it and navigate away from it. Keep existing visual design intact.`,
    ].join("\n");
    onSwitchToChat(msg);
  }, [nodes, connectivity, onSwitchToChat]);

  const PLATFORMS: { key: Platform; label: string; Icon: React.ElementType }[] = [
    { key: "web", label: "Web", Icon: Globe },
    { key: "ios", label: "iOS", Icon: Smartphone },
    { key: "android", label: "Android", Icon: Tablet },
  ];

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden relative">
      {/* Top toolbar */}
      <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-border bg-card/60 z-10">
        <div className="mr-2 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Pages</h2>
            {hasNodes && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                {nodes.length}
              </span>
            )}
          </div>
          <p className="hidden text-[10px] text-muted-foreground lg:block">
            A living table of contents for your app
          </p>
        </div>

        <div className="flex shrink-0 rounded-lg border border-border bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setView("contents")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
              view === "contents"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ListTree className="h-3 w-3" />
            Contents
          </button>
          <button
            type="button"
            onClick={() => setView("connections")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
              view === "connections"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Network className="h-3 w-3" />
            Connections
          </button>
        </div>

        <div className="w-px h-5 bg-border shrink-0" />

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

        {platform === "web" && view === "connections" && (
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

            {hasNodes && (
              <>
                <div className="w-px h-5 bg-border shrink-0" />
                <div className="flex items-center gap-1 bg-muted border border-border rounded-lg p-0.5 shrink-0">
                  <Filter className="h-3 w-3 text-muted-foreground ml-1.5" />
                  {(
                    [
                      { key: "all", label: "All" },
                      { key: "issues", label: "Issues" },
                      { key: "built", label: "Built" },
                      { key: "planned", label: "Planned" },
                    ] as const
                  ).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setFilter(key)}
                      className={cn(
                        "px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors",
                        filter === key
                          ? "bg-background text-foreground shadow-sm"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {label}
                      {key === "issues" && issuesCount > 0 && (
                        <span className="ml-1 text-[10px] text-amber-400 tabular-nums">
                          {issuesCount}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {platform === "web" && view === "contents" && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground"
            onClick={handleAddPage}
          >
            <FilePlus className="h-3 w-3" />
            Add page
          </Button>
        )}

        {(isBuilding || isSyncingAfterEdit || analyzePageMap.isPending) && (
          <div className="ml-auto flex items-center gap-1.5 text-[11px] text-primary font-medium">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            {isSyncingAfterEdit || analyzePageMap.isPending
              ? "Refreshing your pages..."
              : "Adding new pages..."}
          </div>
        )}
      </div>

      {/* Health summary — only when there are wiring issues on the active platform */}
      {platform === "web" && view === "connections" && hasNodes && issuesCount > 0 && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 border-b border-amber-500/20 bg-amber-500/5 z-10">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span className="text-[11px] text-amber-200">
            <span className="font-semibold">{issuesCount}</span>{" "}
            {issuesCount === 1 ? "page has" : "pages have"} wiring issues — not linked or goes
            nowhere.
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setFilter(filter === "issues" ? "all" : "issues")}
            className="h-6 px-2 text-[11px] text-amber-200 hover:text-amber-100 hover:bg-amber-500/10 ml-1"
          >
            {filter === "issues" ? "Show all pages" : "Highlight issues"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleFixAllWiring}
            className="ml-auto h-6 px-2 text-[11px] gap-1 border-amber-500/30 text-amber-200 hover:bg-amber-500/10"
          >
            <Sparkles className="h-3 w-3" />
            Ask AI to fix all
          </Button>
        </div>
      )}

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
        ) : view === "contents" ? (
          <PageContentsView
            nodes={nodes}
            freshNodeIds={freshNodeIds}
            onOpenPreview={(route) => onSwitchToPreview(route)}
            onOpenDetails={(nodeId) => {
              setSelectedEdgeId(null);
              setSelectedNodeId(nodeId);
              setView("connections");
            }}
          />
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onEdgesDelete={onEdgesDelete}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            onMove={(_evt, viewport) => {
              viewportRef.current = viewport;
            }}
            onInit={(instance: ReactFlowInstance) => {
              // fitView exactly once — subsequent Effect 1 re-fires must not snap the camera
              if (!initialisedRef.current) {
                initialisedRef.current = true;
                instance.fitView({ padding: 0.2 });
              }
            }}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            defaultEdgeOptions={EDGE_DEFAULTS}
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
        {view === "connections" && (
          <>
            <PageDetailPanel
              node={selectedEdgeId ? null : selectedNodeState}
              incoming={selectedIncoming}
              outgoing={selectedOutgoing}
              availableTargets={availableTargets}
              isOrphan={selectedNodeId ? !!connectivity.get(selectedNodeId)?.isOrphan : false}
              isDeadEnd={selectedNodeId ? !!connectivity.get(selectedNodeId)?.isDeadEnd : false}
              onClose={() => setSelectedNodeId(null)}
              onSave={handleDetailSave}
              onFileOpen={handleFileOpen}
              onModifyPage={handleModifyPage}
              onDelete={handleDeleteNode}
              onJumpToNode={handleJumpToNode}
              onWireTo={handleWireTo}
              onUnwire={handleUnwire}
              onAskAiToWire={handleAskAiToWire}
              blocksSlot={
                selectedNode && !selectedNode.planned && selectedNode.filePath ? (
                  <BlocksPanel
                    projectId={projectId}
                    filePath={selectedNode.filePath}
                    onAskAiToAdapt={onSwitchToChat}
                  />
                ) : null
              }
            />
            <EdgeDetailPanel
              edge={selectedNodeId ? null : selectedEdgeState}
              onClose={() => setSelectedEdgeId(null)}
              onSave={handleEdgeSave}
              onDelete={handleEdgeDelete}
            />
          </>
        )}
      </div>
    </div>
  );
}

function PageContentsView({
  nodes,
  freshNodeIds,
  onOpenPreview,
  onOpenDetails,
}: {
  nodes: Node[];
  freshNodeIds: Set<string>;
  onOpenPreview: (route: string) => void;
  onOpenDetails: (nodeId: string) => void;
}) {
  const sortedNodes = [...nodes].sort((left, right) => {
    const leftData = left.data as PageNodeData;
    const rightData = right.data as PageNodeData;
    if (!!leftData.planned !== !!rightData.planned) return leftData.planned ? 1 : -1;
    const leftRoute = pageRouteFromFilePath(leftData.filePath, leftData.notes);
    const rightRoute = pageRouteFromFilePath(rightData.filePath, rightData.notes);
    if (leftRoute === "/" && rightRoute !== "/") return -1;
    if (rightRoute === "/" && leftRoute !== "/") return 1;
    return leftRoute.localeCompare(rightRoute);
  });

  return (
    <div className="h-full overflow-y-auto px-5 py-6 sm:px-7">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">Your app at a glance</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Open any built page in Preview. Planned and dynamic pages open their details.
            </p>
          </div>
          <span className="text-[11px] text-muted-foreground">
            {nodes.length} {nodes.length === 1 ? "page" : "pages"}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {sortedNodes.map((node, index) => {
            const data = node.data as PageNodeData;
            const route = pageRouteFromFilePath(data.filePath, data.notes);
            const routeLabel = data.planned && !data.filePath ? "Not built yet" : route;
            const status = pageCardStatus(data);
            const navigable = pageRouteIsNavigable(route, data.planned);
            const isFresh = freshNodeIds.has(node.id);
            const statusClass =
              status === "Page built"
                ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                : status === "Needs attention"
                  ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
                  : status === "Updating" || status === "New"
                    ? "bg-primary/10 text-primary border-primary/20"
                    : "bg-muted text-muted-foreground border-border";

            return (
              <button
                key={node.id}
                type="button"
                data-testid={`page-map-card-${node.id}`}
                onClick={() => (navigable ? onOpenPreview(route) : onOpenDetails(node.id))}
                className={cn(
                  "group rounded-2xl border border-border bg-card/45 p-4 text-left shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:bg-card hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                  isFresh && "animate-in fade-in slide-in-from-bottom-2 duration-500",
                )}
                style={
                  isFresh
                    ? {
                        animationDelay: `${Math.min(index * 60, 300)}ms`,
                        animationFillMode: "both",
                      }
                    : undefined
                }
                aria-label={
                  navigable
                    ? `Open ${data.label} at ${route} in Preview`
                    : `View details for ${data.label}`
                }
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-primary/15 bg-primary/8 text-primary">
                    {status === "Page built" ? (
                      <CircleCheck className="h-4 w-4" />
                    ) : (
                      <Globe className="h-4 w-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h4 className="truncate text-sm font-semibold text-foreground">
                          {data.label}
                        </h4>
                        <p className="mt-0.5 truncate font-mono text-[11px] text-primary/80">
                          {routeLabel}
                        </p>
                      </div>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                          statusClass,
                        )}
                      >
                        {status}
                      </span>
                    </div>
                    <p className="mt-3 line-clamp-2 min-h-8 text-xs leading-relaxed text-muted-foreground">
                      {pagePurpose(data)}
                    </p>
                    <div className="mt-3 flex items-center justify-between gap-3 border-t border-border/50 pt-3">
                      <span className="rounded-md bg-muted px-2 py-0.5 text-[10px] capitalize text-muted-foreground">
                        {data.pageType === "other" ? "Page" : data.pageType}
                      </span>
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-primary opacity-80 transition-opacity group-hover:opacity-100">
                        {navigable ? "Open in Preview" : "View details"}
                        <ArrowUpRight className="h-3 w-3" />
                      </span>
                    </div>
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function EmptyState({
  onAnalyze,
  isAnalyzing,
  onAddPage,
}: {
  onAnalyze: () => void;
  isAnalyzing: boolean;
  onAddPage: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <MapPin className="h-8 w-8 text-primary/60" />
      </div>
      <div>
        <div className="text-base font-semibold text-foreground">
          Your app&apos;s pages will appear here as Zero builds
        </div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          Start with a page idea in Chat, or map an existing app when you are ready.
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
          Your app will be mapped here once {platform === "ios" ? "iOS" : "Android"} generation is
          active. Currently only Web mapping is supported.
        </div>
      </div>
    </div>
  );
}
