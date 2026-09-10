import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
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
  Info,
  Sparkles,
  ChevronDown,
  ArrowUpRight,
  FileText,
  ListTree,
  Network,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { PageMapLivePreview, PageNode, type PageNodeData, type PageType } from "./page-node";
import { PageEdge, type ConnectionType, type PageEdgeData } from "./page-edge";
import {
  copyPageMapTransition,
  createPageMapPendingEvidence,
  manualPageMapTransition,
  newPageMapTransitionId,
  parallelTransitionEdges,
  retainedCandidates,
  transitionEvidenceLabel,
  transitionSummary,
  type PageMapCandidate,
  type PageMapTransition,
} from "./page-map-transition-model";
import {
  PageDetailPanel,
  type PageMapNodeState,
  type WiringEdge,
  type WiringPage,
} from "./page-detail-panel";
import { BlocksPanel } from "./blocks-panel";
import { EdgeDetailPanel, type PageMapEdgeState } from "./edge-detail-panel";
import {
  PAGE_MAP_LIVE_PREVIEW_LIMIT,
  pageCardStatus,
  pagePurpose,
  pageRedesignPrompt,
  pageRouteFromFilePath,
  pageRouteIsNavigable,
} from "./page-map-card-model";

type Platform = "web" | "ios" | "android";

function isPageMapConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; response?: { status?: unknown } | null };
  return candidate.status === 409 || candidate.response?.status === 409;
}

type RevisionedPageMap = { revision: string; pageMapData: PageMapData };
type GuardedPageMap = PageMapData & { expectedRevision: string };
type PageMapOperation = {
  success: (response: unknown) => void;
  failure: (error: unknown) => void;
};
type PageMapSaveState = {
  map: PageMapData | null;
  revision: string | null;
  dirty: boolean;
  busy: "save" | "analyze" | "refresh" | null;
  problem:
    | "conflict"
    | "missing-revision"
    | "save-error"
    | "analysis-error"
    | "refresh-error"
    | null;
  hydration: number;
  refreshCandidate: RevisionedPageMap | null;
};

function emptyPageMap(): PageMapData {
  return {
    web: { nodes: [], edges: [] },
    ios: { nodes: [], edges: [] },
    android: { nodes: [], edges: [] },
  };
}

function responsePageMap(response: unknown): PageMapData | null {
  if (!response || typeof response !== "object") return null;
  const map = (response as { pageMapData?: unknown }).pageMapData;
  if (!map || typeof map !== "object") return null;
  for (const platform of ["web", "ios", "android"] as const) {
    const value = (map as Record<string, unknown>)[platform];
    if (!value || typeof value !== "object") return null;
    const lists = value as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(lists.nodes) || !Array.isArray(lists.edges)) return null;
  }
  return map as PageMapData;
}

function revisionedPageMap(response: unknown): RevisionedPageMap | null {
  const map = responsePageMap(response);
  const revision = (response as { revision?: unknown } | null)?.revision;
  if (!map || typeof revision !== "string" || !/^[0-9a-f]{64}$/.test(revision)) return null;
  return { pageMapData: map, revision };
}

function copyPageMap(map: PageMapData): PageMapData {
  return JSON.parse(JSON.stringify(map)) as PageMapData;
}

// One session owns one project. Hash revisions are opaque, not sortable timestamps.
// Clean maps follow server updates. A newer snapshot never rebases an unsaved
// draft; conflicts still require an explicit refreshed replacement.
export function createPageMapSaveCoordinator(deps: {
  projectId: number;
  save: (request: { id: number; data: GuardedPageMap }, operation: PageMapOperation) => void;
  analyze: (
    request: { id: number; params: { platform: Platform } },
    operation: PageMapOperation,
  ) => void;
  refetch: () => Promise<{ data?: unknown; isError?: boolean }>;
  changed: (state: PageMapSaveState) => void;
}) {
  const state: PageMapSaveState = {
    map: null,
    revision: null,
    dirty: false,
    busy: null,
    problem: null,
    hydration: 0,
    refreshCandidate: null,
  };
  let acknowledged: RevisionedPageMap | null = null;
  const superseded = new Set<string>();
  let editVersion = 0;
  let operationId = 0;
  let active = true;
  let detailDraftPending = false;
  const pendingEvidence = createPageMapPendingEvidence();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = () => {
    if (active) deps.changed({ ...state, dirty: state.dirty || detailDraftPending });
  };
  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const acknowledge = (snapshot: RevisionedPageMap) => {
    if (acknowledged && acknowledged.revision !== snapshot.revision)
      superseded.add(acknowledged.revision);
    acknowledged = { revision: snapshot.revision, pageMapData: copyPageMap(snapshot.pageMapData) };
    state.revision = snapshot.revision;
  };
  const adopt = (snapshot: RevisionedPageMap) => {
    detailDraftPending = false;
    acknowledge(snapshot);
    state.map = copyPageMap(snapshot.pageMapData);
    state.dirty = false;
    state.problem = null;
    state.refreshCandidate = null;
    state.hydration += 1;
    cancelTimer();
    publish();
  };

  function flush() {
    cancelTimer();
    if (
      !active ||
      state.busy ||
      detailDraftPending ||
      !state.dirty ||
      state.problem ||
      !acknowledged ||
      !state.map
    )
      return;
    // Clone once at dispatch: subsequent edits and query updates cannot mutate this pair.
    const payload: GuardedPageMap = {
      ...copyPageMap(state.map),
      expectedRevision: acknowledged.revision,
    };
    const sentVersion = editVersion;
    const sentPending = pendingEvidence.capture();
    const id = ++operationId;
    state.busy = "save";
    publish();
    deps.save(
      { id: deps.projectId, data: payload },
      {
        success: (response) => {
          if (!active || id !== operationId || state.busy !== "save") return;
          state.busy = null;
          const snapshot = revisionedPageMap(response);
          if (!snapshot) {
            state.problem = "missing-revision";
            cancelTimer();
            publish();
            return;
          }
          pendingEvidence.acknowledge(sentPending, payload, snapshot.pageMapData);
          acknowledge(snapshot);
          if (editVersion === sentVersion) {
            state.map = copyPageMap(snapshot.pageMapData);
            state.dirty = false;
          }
          publish();
          // A newer local edit is sent only after this acknowledgement, with its new revision.
          if (state.dirty && timer === null) flush();
        },
        failure: (error) => {
          if (!active || id !== operationId || state.busy !== "save") return;
          state.busy = null;
          state.problem = isPageMapConflict(error) ? "conflict" : "save-error";
          cancelTimer();
          publish();
        },
      },
    );
  }

  return {
    getState: () => ({ ...state, dirty: state.dirty || detailDraftPending }),
    hasDetailsDraft: () => detailDraftPending,
    pendingEvidence: pendingEvidence.forPlatform,
    stageDetails: () => {
      if (!active || detailDraftPending) return;
      detailDraftPending = true;
      cancelTimer();
      publish();
    },
    finishDetails: () => {
      if (!detailDraftPending) return;
      detailDraftPending = false;
      publish();
      if (state.dirty && !state.problem) timer = setTimeout(flush, 800);
    },
    activate: () => {
      active = true;
      if (state.dirty && !state.busy && !state.problem) timer = setTimeout(flush, 800);
    },
    deactivate: () => {
      active = false;
      cancelTimer();
    },
    receive: (response: unknown) => {
      if (!active || state.busy) return;
      const snapshot = revisionedPageMap(response);
      if (!snapshot) {
        if (!acknowledged && !state.dirty) {
          state.map = responsePageMap(response);
          state.hydration += 1;
        }
        state.problem = "missing-revision";
        publish();
        return;
      }
      if (acknowledged?.revision === snapshot.revision || superseded.has(snapshot.revision)) return;
      if (
        !state.dirty &&
        !detailDraftPending &&
        (!state.problem || state.problem === "missing-revision")
      ) {
        adopt(snapshot);
      } else {
        // Do not silently rebase a draft onto an arbitrary poll response.
        state.problem = "conflict";
        cancelTimer();
        publish();
      }
    },
    edit: (platform: Platform, data: PageMapData[Platform], immediate = false) => {
      if (!active) return;
      const next = copyPageMap({
        ...(state.map ?? acknowledged?.pageMapData ?? emptyPageMap()),
        [platform]: data,
      });
      if (JSON.stringify(next) === JSON.stringify(state.map)) return;
      pendingEvidence.stage(platform, state.map?.[platform], next[platform]);
      state.map = next;
      state.dirty = true;
      state.refreshCandidate = null;
      editVersion += 1;
      if (!acknowledged) state.problem = "missing-revision";
      cancelTimer();
      publish();
      if (immediate) flush();
      else if (!state.problem) timer = setTimeout(flush, 800);
    },
    retrySave: () => {
      if (state.problem !== "save-error" || state.busy) return;
      state.problem = null;
      flush();
    },
    analyze: (platform: Platform) => {
      if (
        !active ||
        state.busy ||
        state.dirty ||
        detailDraftPending ||
        (state.problem && state.problem !== "analysis-error") ||
        !acknowledged
      )
        return;
      state.problem = null;
      const startedVersion = editVersion;
      const id = ++operationId;
      state.busy = "analyze";
      publish();
      deps.analyze(
        { id: deps.projectId, params: { platform } },
        {
          success: (response) => {
            if (!active || id !== operationId || state.busy !== "analyze") return;
            state.busy = null;
            const snapshot = revisionedPageMap(response);
            if (!snapshot) {
              state.problem = "missing-revision";
              cancelTimer();
              publish();
              return;
            }
            if (state.dirty || detailDraftPending || editVersion !== startedVersion) {
              acknowledge(snapshot);
              state.problem = "conflict";
              cancelTimer();
              publish();
            } else {
              adopt(snapshot);
            }
          },
          failure: (error) => {
            if (!active || id !== operationId || state.busy !== "analyze") return;
            state.busy = null;
            state.problem = isPageMapConflict(error) ? "conflict" : "analysis-error";
            cancelTimer();
            publish();
          },
        },
      );
    },
    refresh: async () => {
      if (!active || state.busy) return;
      cancelTimer();
      const id = ++operationId;
      state.busy = "refresh";
      state.refreshCandidate = null;
      publish();
      try {
        const result = await deps.refetch();
        if (!active || id !== operationId || state.busy !== "refresh") return;
        state.busy = null;
        if (result.isError) throw new Error("Page map refresh failed");
        const snapshot = revisionedPageMap(result.data);
        if (!snapshot) {
          state.problem = "missing-revision";
          publish();
          return;
        }
        if (state.dirty || detailDraftPending) {
          state.problem = "conflict";
          state.refreshCandidate = { ...snapshot, pageMapData: copyPageMap(snapshot.pageMapData) };
          publish();
        } else {
          adopt(snapshot);
        }
      } catch {
        if (!active || id !== operationId) return;
        state.busy = null;
        state.problem = "refresh-error";
        publish();
      }
    },
    replaceWithRefreshed: () => {
      if (!active || state.busy || !state.refreshCandidate) return;
      editVersion += 1;
      pendingEvidence.clear(); // Explicitly replacing local intent, not inferring an acknowledgement.
      adopt(state.refreshCandidate);
    },
    keepLocal: () => {
      state.refreshCandidate = null;
      publish();
    },
  };
}

export function serializePageMapPlatform(
  nodes: Node[],
  edges: Edge[],
  current?: PageMapData[Platform],
): PageMapData[Platform] {
  return {
    ...retainedCandidates(current, new Set(nodes.map((node) => node.id))),
    nodes: nodes.map((node) => {
      const data = node.data as PageNodeData;
      return {
        id: node.id,
        label: data.label,
        pageType: data.pageType,
        filePath: data.filePath,
        position: { ...node.position },
        isNew: data.isNew,
        hasError: data.hasError,
        aiGenerated: data.aiGenerated,
        notes: data.notes,
        planned: data.planned ?? false,
      };
    }),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      connectionType: (edge.data as { connectionType?: ConnectionType })?.connectionType ?? "nav",
      aiGenerated: (edge.data as { aiGenerated?: boolean })?.aiGenerated ?? false,
      ...((edge.data as PageEdgeData | undefined)?.transition
        ? { transition: copyPageMapTransition((edge.data as PageEdgeData).transition) }
        : {}),
    })),
  };
}

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

export function platformMapToFlow(
  platformData: PageMapData[Platform],
  projectId: number,
  isBuilding: boolean,
  onNodeClick: (nodeId: string) => void,
  onPreviewClick: (filePath: string, route?: string) => void,
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
      ...(e.transition ? { transition: copyPageMapTransition(e.transition) } : {}),
      transitionPending: false,
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

export function PageMapTab(props: PageMapTabProps) {
  // A different project must never inherit this project's draft or queued operations.
  return <PageMapWorkspace key={props.projectId} {...props} />;
}

function PageMapWorkspace({
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
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "gaps" | "built" | "planned">("all");
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState(false);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const canvasRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<{ x: number; y: number; zoom: number }>({ x: 0, y: 0, zoom: 1 });
  const queryClient = useQueryClient();
  const syncStartedRef = useRef(false);
  const seenNodeIdsRef = useRef<Set<string>>(new Set());
  const freshNodeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [freshNodeIds, setFreshNodeIds] = useState<Set<string>>(new Set());

  const {
    data: mapResponse,
    dataUpdatedAt,
    isLoading,
    isFetching,
    isError,
    refetch,
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

  const operationsRef = useRef({ putPageMap, analyzePageMap, refetch });
  operationsRef.current = { putPageMap, analyzePageMap, refetch };
  const [persistence, setPersistence] = useState<PageMapSaveState>({
    map: null,
    revision: null,
    dirty: false,
    busy: null,
    problem: null,
    hydration: 0,
    refreshCandidate: null,
  });
  const coordinatorRef = useRef<ReturnType<typeof createPageMapSaveCoordinator> | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = createPageMapSaveCoordinator({
      projectId,
      changed: setPersistence,
      save: (request, operation) =>
        operationsRef.current.putPageMap.mutate(request, {
          onSuccess: operation.success,
          onError: operation.failure,
        }),
      analyze: (request, operation) =>
        operationsRef.current.analyzePageMap.mutate(request, {
          onSuccess: operation.success,
          onError: operation.failure,
        }),
      refetch: () => operationsRef.current.refetch({ cancelRefetch: true }),
    });
  }
  const coordinator = coordinatorRef.current;
  // Read mutable coordinator evidence on every persistence-driven render.
  const pendingEvidence = coordinator.pendingEvidence(platform);
  useEffect(() => {
    coordinator.finishDetails();
  }, [coordinator, selectedNodeId, selectedEdgeId, selectedCandidateId, view, platform]);
  useEffect(() => {
    coordinator.activate();
    return () => coordinator.deactivate();
  }, [coordinator]);
  useEffect(() => {
    if (mapResponse !== undefined) coordinator.receive(mapResponse);
  }, [coordinator, mapResponse, persistence.busy]);
  useEffect(() => {
    if (!persistence.dirty) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [persistence.dirty]);

  const nodesRef = useRef<Node[]>([]);
  const edgesRef = useRef<Edge[]>([]);
  const initialisedRef = useRef(false);

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

  // Node identities and new-page highlights are scoped to the selected platform.
  useEffect(() => {
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

  const hasNodes = nodes.length > 0;
  const canAnalyze =
    !!persistence.revision &&
    !persistence.dirty &&
    !persistence.busy &&
    (!persistence.problem || persistence.problem === "analysis-error");
  const hookConflict =
    (analyzePageMap.isError && isPageMapConflict(analyzePageMap.error)) ||
    (putPageMap.isError && isPageMapConflict(putPageMap.error));
  const hasConflict = persistence.problem === "conflict" || hookConflict;

  const handleLoadLatest = useCallback(async () => {
    await coordinator.refresh();
    if (!coordinator.getState().problem) {
      operationsRef.current.putPageMap.reset?.();
      operationsRef.current.analyzePageMap.reset?.();
    }
  }, [coordinator]);
  const handleReplaceLocal = useCallback(() => {
    if (!coordinator.getState().refreshCandidate) return;
    coordinator.replaceWithRefreshed();
    operationsRef.current.putPageMap.reset?.();
    operationsRef.current.analyzePageMap.reset?.();
  }, [coordinator]);

  const handleNodeClick = useCallback((nodeId: string) => {
    setSelectedEdgeId(null);
    setSelectedCandidateId(null);
    setSelectedNodeId(nodeId);
  }, []);

  const handleInspectTransition = useCallback((edgeId: string) => {
    setSelectedNodeId(null);
    setSelectedCandidateId(null);
    setSelectedEdgeId(edgeId);
    setView("connections");
  }, []);
  const handleInspectCandidate = useCallback((candidateId: string) => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setSelectedCandidateId(candidateId);
    setView("connections");
  }, []);
  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_evt, edge) => {
      handleInspectTransition(edge.id);
    },
    [handleInspectTransition],
  );

  // Keep a stable ref to onSwitchToPreview so the callback identity
  // never forces the data-loading effect to re-run
  const onSwitchToPreviewRef = useRef(onSwitchToPreview);
  useEffect(() => {
    onSwitchToPreviewRef.current = onSwitchToPreview;
  }, [onSwitchToPreview]);

  const handlePreviewClick = useCallback((filePath: string, mappedRoute?: string) => {
    const route = mappedRoute ?? pageRouteFromFilePath(filePath);
    if (pageRouteIsNavigable(route)) onSwitchToPreviewRef.current(route);
  }, []);

  // Hydrate acknowledged snapshots only. Clean server updates advance hydration;
  // polling and save acknowledgements cannot replace a newer local map edit.
  useEffect(() => {
    const current = coordinator.getState();
    const platformData = current.map?.[platform];
    setSelectedCandidateId(null);
    if (!platformData) {
      nodesRef.current = [];
      edgesRef.current = [];
      setNodes([]);
      setEdges([]);
      return;
    }
    const { nodes: mappedNodes, edges: mappedEdges } = platformMapToFlow(
      platformData as Parameters<typeof platformMapToFlow>[0],
      projectId,
      isBuilding,
      handleNodeClick,
      handlePreviewClick,
    );
    const needsAutoLayout =
      mappedNodes.length > 0 &&
      mappedNodes.every((node) => node.position.x === 0 && node.position.y === 0);
    const nextNodes = needsAutoLayout ? runDagreLayout(mappedNodes, mappedEdges) : mappedNodes;
    nodesRef.current = nextNodes;
    edgesRef.current = mappedEdges;
    setNodes(nextNodes);
    setEdges(mappedEdges);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    if (needsAutoLayout && current.revision && !current.problem) {
      coordinator.edit(
        platform,
        serializePageMapPlatform(nextNodes, mappedEdges, platformData),
        true,
      );
    }
    // isBuilding and callback changes must not recreate the map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coordinator, persistence.hydration, platform, projectId]);

  // A save acknowledgement normalizes descriptive evidence without resetting the
  // viewport or an unsaved details form. Newer local edits retain their metadata.
  useEffect(() => {
    if (persistence.dirty || persistence.busy || coordinator.hasDetailsDraft()) return;
    const acknowledged = persistence.map?.[platform];
    if (!acknowledged) return;
    const byId = new Map(acknowledged.edges.map((edge) => [edge.id, edge]));
    const updated = edgesRef.current.map((edge) => {
      const saved = byId.get(edge.id);
      if (!saved || saved.source !== edge.source || saved.target !== edge.target) return edge;
      return {
        ...edge,
        data: {
          ...(edge.data as PageEdgeData),
          connectionType: saved.connectionType,
          aiGenerated: saved.aiGenerated,
          transition: saved.transition ? copyPageMapTransition(saved.transition) : undefined,
          transitionPending: coordinator.pendingEvidence(platform).edges.has(edge.id),
        },
      };
    });
    edgesRef.current = updated;
    setEdges(updated);
  }, [coordinator, persistence.map, persistence.dirty, persistence.busy, platform, setEdges]);

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
    const current = coordinator.getState();
    const fetched = revisionedPageMap(mapResponse);
    if (isFetching) {
      fetchStartedDuringSyncRef.current = true;
    } else if (
      fetchStartedDuringSyncRef.current &&
      !isError &&
      !putPageMap.isPending &&
      !putPageMap.isError &&
      !analyzePageMap.isPending &&
      !analyzePageMap.isError &&
      !current.dirty &&
      !current.busy &&
      !current.problem &&
      !!fetched &&
      fetched.revision === current.revision
    ) {
      syncStartedRef.current = false;
      onSyncCleared?.();
    }
  }, [
    isFetching,
    isError,
    putPageMap.isPending,
    putPageMap.isError,
    analyzePageMap.isPending,
    analyzePageMap.isError,
    onSyncCleared,
    coordinator,
    mapResponse,
    persistence,
  ]);

  const debouncedSave = useCallback(
    (updatedNodes: Node[], updatedEdges: Edge[]) => {
      nodesRef.current = updatedNodes;
      edgesRef.current = updatedEdges;
      coordinator.edit(
        platform,
        serializePageMapPlatform(
          updatedNodes,
          updatedEdges,
          coordinator.getState().map?.[platform],
        ),
      );
    },
    [platform, coordinator],
  );

  const onNodeDragStop: OnNodeDrag = useCallback(
    (_evt, _node, draggedNodes) => {
      // ReactFlow supplies the dragged selection, not necessarily every map node.
      const moved = new Map(draggedNodes.map((node) => [node.id, node]));
      const updated = nodesRef.current.map((node) => moved.get(node.id) ?? node);
      setNodes(updated);
      debouncedSave(updated, edgesRef.current);
    },
    [debouncedSave, setNodes],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target)
        return;
      if (
        ![connection.source, connection.target].every((id) =>
          nodesRef.current.some((node) => node.id === id),
        )
      )
        return;
      const newEdge: Edge = {
        ...connection,
        id: newPageMapTransitionId(),
        type: "pageEdge",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        data: {
          connectionType: "nav" as ConnectionType,
          aiGenerated: false,
          transition: manualPageMapTransition(copyPageMapTransition()),
          transitionPending: true,
        },
      };
      // Endpoint equality is not transition identity: actions and branches differ.
      const updated = [...edgesRef.current, newEdge];
      debouncedSave(nodesRef.current, updated);
      setEdges(updated);
    },
    [debouncedSave, setEdges],
  );

  const onEdgesDelete: OnEdgesDelete = useCallback(
    (deleted) => {
      setSelectedEdgeId((prev) => {
        if (prev && deleted.some((e) => e.id === prev)) return null;
        return prev;
      });
      const deletedIds = new Set(deleted.map((edge) => edge.id));
      const updated = edgesRef.current.filter((edge) => !deletedIds.has(edge.id));
      debouncedSave(nodesRef.current, updated);
      setEdges(updated);
    },
    [debouncedSave, setEdges],
  );

  const handleReanalyze = useCallback(() => {
    coordinator.analyze(platform);
  }, [platform, coordinator]);

  const handleAutoLayout = useCallback(() => {
    const laid = runDagreLayout(nodes, edges);
    setNodes(laid);
    debouncedSave(laid, edges);
  }, [nodes, edges, setNodes, debouncedSave]);

  const handleExport = useCallback(async () => {
    if (!canvasRef.current) return;
    setIsExporting(true);
    setExportError(false);
    try {
      const canvas = await html2canvas(canvasRef.current, {
        backgroundColor: getComputedStyle(canvasRef.current).backgroundColor,
        useCORS: false,
      });
      const link = document.createElement("a");
      link.download = `page-map-${projectId}-${platform}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    } catch {
      setExportError(true);
    } finally {
      setIsExporting(false);
    }
  }, [projectId, platform]);

  const selectedNode = selectedNodeId
    ? (nodes.find((n) => n.id === selectedNodeId)?.data as PageNodeData | undefined)
    : null;

  const nextSelectedNodeState: PageMapNodeState | null =
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
  const selectedNodeStateRef = useRef<PageMapNodeState | null>(null);
  // The detail panel keeps unsaved form fields locally. Hold its input snapshot
  // until Save/Close so a server update or build-status render cannot erase them.
  if (!coordinator.hasDetailsDraft() || selectedNodeStateRef.current?.id !== selectedNodeId) {
    selectedNodeStateRef.current = nextSelectedNodeState;
  }
  const selectedNodeState = selectedNodeStateRef.current;

  const unresolvedTransitions = persistence.map?.[platform]?.unresolvedTransitions ?? [];
  const nextSelectedEdgeState: PageMapEdgeState | null = (() => {
    if (selectedCandidateId) {
      const candidate = unresolvedTransitions.find((item) => item.id === selectedCandidateId);
      if (!candidate) return null;
      const source = nodes.find((node) => node.id === candidate.source);
      return {
        id: candidate.id,
        sourceLabel:
          (source?.data as PageNodeData | undefined)?.label ??
          candidate.source ??
          "Source page unknown",
        targetLabel: candidate.transition.destination.value ?? "Destination unknown",
        connectionType: "nav",
        aiGenerated: false,
        transition: candidate.transition,
        unresolved: true,
        pending: pendingEvidence.candidates.has(candidate.id),
      };
    }
    if (!selectedEdgeId) return null;
    const edge = edges.find((item) => item.id === selectedEdgeId);
    if (!edge) return null;
    const source = nodes.find((node) => node.id === edge.source);
    const target = nodes.find((node) => node.id === edge.target);
    const data = edge.data as PageEdgeData | undefined;
    return {
      id: edge.id,
      sourceLabel: (source?.data as PageNodeData | undefined)?.label ?? edge.source,
      targetLabel: (target?.data as PageNodeData | undefined)?.label ?? edge.target,
      connectionType: data?.connectionType ?? "nav",
      aiGenerated: data?.aiGenerated ?? false,
      transition: data?.transition,
      pending: pendingEvidence.edges.has(edge.id),
    };
  })();
  const selectedEdgeStateRef = useRef<PageMapEdgeState | null>(null);
  if (
    !nextSelectedEdgeState ||
    !coordinator.hasDetailsDraft() ||
    selectedEdgeStateRef.current?.id !== nextSelectedEdgeState.id ||
    selectedEdgeStateRef.current?.unresolved !== nextSelectedEdgeState.unresolved
  ) {
    selectedEdgeStateRef.current = nextSelectedEdgeState;
  }
  const selectedEdgeState = selectedEdgeStateRef.current;

  const saveCandidates = useCallback(
    (candidates: PageMapCandidate[]) => {
      const current = coordinator.getState().map?.[platform];
      if (!current) return;
      coordinator.edit(platform, {
        ...serializePageMapPlatform(nodesRef.current, edgesRef.current, current),
        unresolvedTransitions: candidates,
      });
    },
    [coordinator, platform],
  );

  const handleEdgeSave = useCallback(
    (edgeId: string, connectionType: ConnectionType, transition: PageMapTransition) => {
      coordinator.finishDetails();
      const manual = manualPageMapTransition(transition);
      if (selectedCandidateId) {
        const candidates = coordinator.getState().map?.[platform]?.unresolvedTransitions ?? [];
        saveCandidates(
          candidates.map((candidate) =>
            candidate.id === edgeId ? { ...candidate, transition: manual } : candidate,
          ),
        );
        return;
      }
      const updated = edgesRef.current.map((edge) =>
        edge.id === edgeId
          ? {
              ...edge,
              data: {
                ...(edge.data as PageEdgeData),
                connectionType,
                aiGenerated: false,
                transition: manual,
                transitionPending: true,
              },
            }
          : edge,
      );
      debouncedSave(nodesRef.current, updated);
      setEdges(updated);
    },
    [coordinator, platform, selectedCandidateId, saveCandidates, setEdges, debouncedSave],
  );

  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      coordinator.finishDetails();
      if (selectedCandidateId) {
        const candidates = coordinator.getState().map?.[platform]?.unresolvedTransitions ?? [];
        saveCandidates(candidates.filter((candidate) => candidate.id !== edgeId));
        setSelectedCandidateId(null);
        return;
      }
      setSelectedEdgeId(null);
      const updated = edgesRef.current.filter((edge) => edge.id !== edgeId);
      debouncedSave(nodesRef.current, updated);
      setEdges(updated);
    },
    [coordinator, platform, selectedCandidateId, saveCandidates, setEdges, debouncedSave],
  );

  const handleAddCandidate = useCallback(() => {
    const current = coordinator.getState();
    const candidates = current.map?.[platform]?.unresolvedTransitions ?? [];
    if (!current.revision || !current.map || candidates.length >= 1000) return;
    const id = newPageMapTransitionId("candidate-user");
    const candidate: PageMapCandidate = {
      id,
      ...(selectedNodeId ? { source: selectedNodeId } : {}),
      transition: manualPageMapTransition(copyPageMapTransition()),
    };
    saveCandidates([...candidates, candidate]);
    handleInspectCandidate(id);
  }, [coordinator, platform, selectedNodeId, saveCandidates, handleInspectCandidate]);

  const handleDetailSave = useCallback(
    (updated: PageMapNodeState) => {
      coordinator.finishDetails();
      const updatedNodes = nodesRef.current.map((node) =>
        node.id !== updated.id
          ? node
          : {
              ...node,
              data: {
                ...(node.data as PageNodeData),
                label: updated.label,
                pageType: updated.pageType,
                notes: updated.notes,
              },
            },
      );
      debouncedSave(updatedNodes, edgesRef.current);
      setNodes(updatedNodes);
    },
    [setNodes, debouncedSave, coordinator],
  );

  const handleFileOpen = useCallback(
    (filePath: string) => {
      onSwitchToCode(filePath);
    },
    [onSwitchToCode],
  );

  const handleAddPage = useCallback(() => {
    const id = `user-${Date.now()}`;
    if (!coordinator.getState().revision) return;

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

    const updated = [...nodesRef.current, newNode];
    nodesRef.current = updated;
    setNodes(updated);
    coordinator.edit(
      platform,
      serializePageMapPlatform(updated, edgesRef.current, coordinator.getState().map?.[platform]),
      true,
    );
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setSelectedCandidateId(null);
    setView("connections");
  }, [projectId, platform, handleNodeClick, handlePreviewClick, setNodes, coordinator]);

  const handleModifyPage = useCallback(
    (node: PageMapNodeState) => {
      onSwitchToChat(pageRedesignPrompt(projectId, node, persistence.revision));
    },
    [onSwitchToChat, projectId, persistence.revision],
  );

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      const updatedEdges = edgesRef.current.filter(
        (edge) => edge.source !== nodeId && edge.target !== nodeId,
      );
      const updatedNodes = nodesRef.current.filter((node) => node.id !== nodeId);
      debouncedSave(updatedNodes, updatedEdges);
      setEdges(updatedEdges);
      setNodes(updatedNodes);
      setSelectedNodeId(null);
    },
    [setNodes, setEdges, debouncedSave],
  );

  // ---------------------------------------------------------------------------
  // Wiring / connectivity computation
  // ---------------------------------------------------------------------------
  // Legacy flag names describe missing mapped edges, never runtime failures.
  // Planned pages are excluded from the map coverage review.
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
      const isOrphan = !d.planned && inc === 0 && !ENTRY_TYPES.has(d.pageType);
      const isDeadEnd = !d.planned && out === 0 && !TERMINAL_TYPES.has(d.pageType);
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
    let livePreviewCount = 0;
    return nodes.map((n) => {
      const stats = connectivity.get(n.id);
      const d = n.data as PageNodeData;
      const isOrphan = stats?.isOrphan ?? false;
      const isDeadEnd = stats?.isDeadEnd ?? false;
      const hasIssue = isOrphan || isDeadEnd;
      let dimmed = false;
      if (filter === "gaps") dimmed = !hasIssue;
      else if (filter === "built") dimmed = !!d.planned;
      else if (filter === "planned") dimmed = !d.planned;
      const previewEligible =
        !dimmed &&
        !!d.filePath &&
        pageRouteIsNavigable(pageRouteFromFilePath(d.filePath, d.notes), d.planned);
      const previewEnabled = previewEligible && livePreviewCount++ < PAGE_MAP_LIVE_PREVIEW_LIMIT;
      return {
        ...n,
        data: {
          ...d,
          incoming: stats?.incoming ?? 0,
          outgoing: stats?.outgoing ?? 0,
          isOrphan,
          isDeadEnd,
          dimmed,
          previewEnabled,
          previewRevision: dataUpdatedAt ?? persistence.revision ?? undefined,
        } satisfies PageNodeData,
      };
    });
  }, [nodes, connectivity, filter, dataUpdatedAt, persistence.revision]);

  const displayEdges = useMemo(
    () =>
      parallelTransitionEdges(
        edges.map((edge) => ({
          ...edge,
          data: { ...edge.data, transitionPending: pendingEvidence.edges.has(edge.id) },
        })),
        handleInspectTransition,
      ).map((edge) => ({
        ...edge,
        selected: edge.id === selectedEdgeId || edge.selected,
      })),
    [edges, selectedEdgeId, handleInspectTransition, pendingEvidence],
  );

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
          transition: (e.data as PageEdgeData | undefined)?.transition,
          pending: pendingEvidence.edges.has(e.id),
          page: {
            id: e.source,
            label: d?.label ?? e.source,
            pageType: (d?.pageType ?? "other") as PageType,
            planned: d?.planned,
          },
        };
      });
  }, [selectedNodeId, edges, nodes, pendingEvidence]);

  const selectedOutgoing: WiringEdge[] = useMemo(() => {
    if (!selectedNodeId) return [];
    return edges
      .filter((e) => e.source === selectedNodeId)
      .map((e) => {
        const tgt = nodes.find((n) => n.id === e.target);
        const d = tgt?.data as PageNodeData | undefined;
        return {
          edgeId: e.id,
          transition: (e.data as PageEdgeData | undefined)?.transition,
          pending: pendingEvidence.edges.has(e.id),
          page: {
            id: e.target,
            label: d?.label ?? e.target,
            pageType: (d?.pageType ?? "other") as PageType,
            planned: d?.planned,
          },
        };
      });
  }, [selectedNodeId, edges, nodes, pendingEvidence]);

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
      if (
        ![selectedNodeId, targetNodeId].every((id) =>
          nodesRef.current.some((node) => node.id === id),
        )
      )
        return;
      const newEdge: Edge = {
        id: newPageMapTransitionId(),
        source: selectedNodeId,
        target: targetNodeId,
        type: "pageEdge",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        data: {
          connectionType: "nav" as ConnectionType,
          aiGenerated: false,
          transition: manualPageMapTransition(copyPageMapTransition()),
          transitionPending: true,
        },
      };
      const updated = [...edgesRef.current, newEdge];
      debouncedSave(nodesRef.current, updated);
      setEdges(updated);
    },
    [selectedNodeId, setEdges, debouncedSave],
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
    setSelectedCandidateId(null);
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
      lines.push(
        `Review the mapped connections for "${node.label}". Missing mapped edges do not establish a runtime failure.`,
      );
      if (node.filePath) lines.push(`File: ${node.filePath}`);
      if (isOrphan)
        lines.push(
          `- No incoming connection is mapped. Check existing routes and links from relevant pages (e.g. ${candidates.join(", ") || "the landing / dashboard"}).`,
        );
      if (isDeadEnd)
        lines.push(
          `- No outgoing connection is mapped. Check existing buttons, links, and redirects before proposing changes.`,
        );
      lines.push(
        `Distinguish confirmed behavior from assumptions and report what could not be verified. Only propose navigation changes when a missing link is confirmed and needed. Preserve the visual design.`,
      );
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
        if (stats.isOrphan) parts.push("no incoming connection mapped");
        if (stats.isDeadEnd) parts.push("no outgoing connection mapped");
        return `- "${d.label}"${d.filePath ? ` (${d.filePath})` : ""}: ${parts.join(" and ")}`;
      })
      .filter((x): x is string => x !== null);
    if (issues.length === 0) return;
    const msg = [
      `Review the mapped connections for these pages. Missing mapped edges do not establish a runtime failure:`,
      ...issues,
      ``,
      `Check existing routes, buttons, links, and redirects before proposing changes. Distinguish confirmed behavior from assumptions and report what could not be verified. Only propose navigation changes when a missing link is confirmed and needed. Preserve the visual design.`,
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
      <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border bg-card z-10">
        <div className="mr-2 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">Pages</h2>
            {hasNodes && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {nodes.length}
              </span>
            )}
          </div>
          <p className="hidden text-[10px] text-muted-foreground lg:block">
            Pages and connections in your map
          </p>
        </div>

        <div
          role="group"
          aria-label="Page map view"
          className="flex shrink-0 rounded-lg border border-border bg-muted p-0.5"
        >
          <button
            type="button"
            onClick={() => setView("contents")}
            aria-pressed={view === "contents"}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
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
            aria-pressed={view === "connections"}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
              view === "connections"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Network className="h-3 w-3" />
            Connections
          </button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              aria-label={`Platform: ${PLATFORMS.find((item) => item.key === platform)?.label}`}
            >
              {PLATFORMS.find((item) => item.key === platform)?.label}
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Platform</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={platform}
              onValueChange={(value) => setPlatform(value as Platform)}
            >
              {PLATFORMS.map(({ key, label, Icon }) => (
                <DropdownMenuRadioItem key={key} value={key}>
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                  {key !== "web" && " (unavailable)"}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {platform === "web" && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 text-xs"
              onClick={handleAddPage}
              disabled={!persistence.revision || isLoading || (isError && !hasNodes)}
            >
              <FilePlus className="h-3 w-3" />
              Add page
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 text-xs"
                  aria-label="Map actions"
                >
                  Map actions
                  <ChevronDown className="h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>Map actions</DropdownMenuLabel>
                <DropdownMenuItem
                  onSelect={handleReanalyze}
                  disabled={
                    !canAnalyze || analyzePageMap.isPending || isLoading || (isError && !hasNodes)
                  }
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {analyzePageMap.isPending ? "Refreshing map..." : "Refresh map"}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={handleAutoLayout}
                  disabled={!hasNodes || view !== "connections" || isLoading}
                >
                  <Layout className="h-3.5 w-3.5" />
                  Auto-layout
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void handleExport()}
                  disabled={!hasNodes || isLoading || isExporting}
                >
                  <Download className="h-3.5 w-3.5" />
                  {isExporting ? "Exporting map..." : "Export map PNG"}
                </DropdownMenuItem>
                {view === "connections" && hasNodes && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuLabel>Highlight pages</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={filter}
                      onValueChange={(value) => setFilter(value as typeof filter)}
                    >
                      <DropdownMenuRadioItem value="all">All pages</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="gaps">
                        Missing mapped connections
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="built">Unplanned pages</DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="planned">Planned pages</DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}

        {(persistence.dirty || persistence.busy === "save") && (
          <p role="status" className="basis-full text-[11px] text-muted-foreground">
            {persistence.busy === "save" ? "Saving map changes..." : "Unsaved map changes"}
          </p>
        )}

        {(isBuilding || isSyncingAfterEdit || analyzePageMap.isPending) && (
          <div
            role="status"
            className="flex basis-full items-center gap-1.5 text-[11px] text-muted-foreground"
          >
            <RefreshCw className="h-3 w-3 motion-safe:animate-spin" />
            {isSyncingAfterEdit || analyzePageMap.isPending
              ? "Refreshing map..."
              : "Build in progress"}
          </div>
        )}
      </div>

      {platform === "web" && view === "connections" && hasNodes && (
        <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-b border-border bg-muted/30 z-10">
          <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              {edges.length} mapped {edges.length === 1 ? "connection" : "connections"}. AI
              connections are inferred. Runtime navigation is not verified by this map.
            </p>
            {issuesCount > 0 && (
              <p>
                {issuesCount} {issuesCount === 1 ? "page has" : "pages have"} missing mapped
                connections. Missing mapped edges do not establish a runtime failure.
              </p>
            )}
          </div>
          {issuesCount > 0 && (
            <>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setFilter(filter === "gaps" ? "all" : "gaps")}
                aria-pressed={filter === "gaps"}
                className="h-7 px-2 text-[11px] text-muted-foreground"
              >
                {filter === "gaps" ? "Show all pages" : "Highlight map gaps"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={handleFixAllWiring}
                className="h-7 px-2 text-[11px] gap-1"
              >
                <Sparkles className="h-3 w-3" />
                Review connections with AI
              </Button>
            </>
          )}
        </div>
      )}

      {platform === "web" && isError && hasNodes && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-foreground"
        >
          Couldn't refresh this map. Showing the last loaded pages.
          <Button
            variant="ghost"
            size="sm"
            disabled={isFetching || !!persistence.busy}
            onClick={() => void handleLoadLatest()}
          >
            Retry
          </Button>
        </div>
      )}
      {platform === "web" &&
        (persistence.problem ||
          persistence.refreshCandidate ||
          analyzePageMap.isError ||
          putPageMap.isError ||
          exportError) && (
          <div
            role="alert"
            className="space-y-2 border-b border-border bg-muted/40 px-4 py-2 text-xs text-foreground"
          >
            {hasConflict && (
              <p>
                The map changed during this operation. Local edits are kept here. Refresh the map
                before retrying. Loading the latest map will not replace local edits without your
                choice.
              </p>
            )}
            {persistence.problem === "missing-revision" && (
              <p>
                This response has no valid map revision. Saving is paused; local edits are kept
                here. Load the latest map before saving. An older server may need an update.
              </p>
            )}
            {(persistence.problem === "analysis-error" ||
              (analyzePageMap.isError && !isPageMapConflict(analyzePageMap.error))) && (
              <p>Couldn't refresh the page map. Try Refresh map again.</p>
            )}
            {(persistence.problem === "save-error" ||
              (putPageMap.isError && !isPageMapConflict(putPageMap.error))) && (
              <p>Couldn't save map changes. Local edits may not be saved.</p>
            )}
            {persistence.problem === "refresh-error" && (
              <p>Couldn't load the latest map. Local edits are unchanged; try loading again.</p>
            )}
            {exportError && <p>Couldn't export the map. Try Export map PNG again.</p>}
            {(persistence.problem || analyzePageMap.isError || putPageMap.isError) && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!!persistence.busy}
                  onClick={() => void handleLoadLatest()}
                >
                  {persistence.busy === "refresh" ? "Loading latest map..." : "Load latest map"}
                </Button>
                {persistence.problem === "save-error" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!!persistence.busy}
                    onClick={() => coordinator.retrySave()}
                  >
                    Retry save
                  </Button>
                )}
              </div>
            )}
            {persistence.refreshCandidate && (
              <div className="space-y-2">
                <p>
                  The latest server map is ready. Replacing will discard the unsaved map edits shown
                  here. Keeping local edits leaves saving paused; no automatic merge is performed.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={handleReplaceLocal}>
                    Replace local edits with refreshed map
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => coordinator.keepLocal()}>
                    Keep local edits
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

      {platform === "web" && !isLoading && persistence.map && (
        <section
          aria-label="Mapped transition evidence"
          className="shrink-0 space-y-2 border-b border-border bg-muted/20 px-4 py-2"
        >
          <p className="text-[11px] text-muted-foreground">
            Page presence reflects source or manual mapping, not a verified running page or recorded
            thumbnail. Arrows describe mapped claims, not tested behavior. Editing this map does not
            change app navigation.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {view === "connections" && (
              <details className="rounded-md border border-border bg-card px-2 py-1">
                <summary className="cursor-pointer text-xs font-medium">
                  Mapped transitions ({edges.length})
                </summary>
                <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                  {edges.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No transitions mapped. Actual navigation remains unknown.
                    </p>
                  )}
                  {displayEdges.map((edge) => {
                    const data = edge.data as PageEdgeData | undefined;
                    const source = nodes.find((node) => node.id === edge.source);
                    const target = nodes.find((node) => node.id === edge.target);
                    return (
                      <button
                        key={edge.id}
                        type="button"
                        aria-label={"Inspect mapped transition " + edge.id}
                        onClick={() => handleInspectTransition(edge.id)}
                        className="block w-full rounded border border-border p-2 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                      >
                        <span className="block truncate">
                          {(source?.data as PageNodeData | undefined)?.label ?? edge.source}
                          {" -> "}
                          {(target?.data as PageNodeData | undefined)?.label ?? edge.target}
                        </span>
                        <span className="block truncate">
                          {transitionSummary(data?.transition)}
                        </span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {edge.id}:{" "}
                          {transitionEvidenceLabel(data?.transition, data?.transitionPending)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </details>
            )}
            <details className="rounded-md border border-border bg-card px-2 py-1">
              <summary className="cursor-pointer text-xs font-medium">
                Unresolved transitions ({unresolvedTransitions.length})
              </summary>
              <p className="mt-2 text-[11px] text-muted-foreground">
                Candidates lack a resolved graph endpoint. They are not drawn as verified
                navigation.
              </p>
              <div className="mt-2 max-h-40 space-y-1 overflow-y-auto">
                {unresolvedTransitions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No unresolved candidates recorded; this does not establish complete coverage.
                  </p>
                )}
                {unresolvedTransitions.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    aria-label={"Inspect unresolved transition " + candidate.id}
                    onClick={() => handleInspectCandidate(candidate.id)}
                    className="block w-full rounded border border-border p-2 text-left text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-primary"
                  >
                    <span className="block truncate">
                      {candidate.source ?? "Source page unknown"}:{" "}
                      {transitionSummary(candidate.transition)}
                    </span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {candidate.id}:{" "}
                      {transitionEvidenceLabel(
                        candidate.transition,
                        pendingEvidence.candidates.has(candidate.id),
                      )}
                    </span>
                  </button>
                ))}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-1 h-7 text-xs"
                disabled={!persistence.revision || unresolvedTransitions.length >= 1000}
                onClick={handleAddCandidate}
              >
                Add unresolved transition
              </Button>
            </details>
          </div>
        </section>
      )}

      {/* Canvas area */}
      <div className="flex-1 min-h-0 relative overflow-hidden bg-background" ref={canvasRef}>
        {platform !== "web" ? (
          <ComingSoonState platform={platform} />
        ) : isLoading ? (
          <LoadingState />
        ) : isError && !hasNodes ? (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
          >
            <Info className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium">Couldn't load the page map.</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              Your pages may still exist. Retry to load their map.
            </p>
            <Button
              variant="outline"
              onClick={() => void handleLoadLatest()}
              disabled={isFetching || !!persistence.busy}
            >
              Retry
            </Button>
          </div>
        ) : !hasNodes ? (
          <EmptyState
            onAnalyze={handleReanalyze}
            isAnalyzing={analyzePageMap.isPending}
            canAnalyze={canAnalyze}
            canAdd={!!persistence.revision}
            onAddPage={handleAddPage}
          />
        ) : view === "contents" ? (
          <PageContentsView
            nodes={nodes}
            freshNodeIds={freshNodeIds}
            previewRevision={dataUpdatedAt ?? persistence.revision ?? undefined}
            onOpenFile={handleFileOpen}
            onPrepareRedesign={(node) =>
              onSwitchToChat(pageRedesignPrompt(projectId, node, persistence.revision))
            }
            onOpenPreview={(route) => onSwitchToPreview(route)}
            onOpenDetails={(nodeId) => {
              setSelectedCandidateId(null);
              setSelectedEdgeId(null);
              setSelectedNodeId(nodeId);
              setView("connections");
            }}
          />
        ) : (
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStop={onNodeDragStop}
            onEdgesDelete={onEdgesDelete}
            onEdgeClick={onEdgeClick}
            onPaneClick={() => {
              setSelectedCandidateId(null);
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
        {platform === "web" && view === "connections" && !isLoading && (
          <>
            <div className="contents">
              <PageDetailPanel
                node={selectedEdgeId || selectedCandidateId ? null : selectedNodeState}
                onDraftStart={() => coordinator.stageDetails()}
                onInspectTransition={handleInspectTransition}
                incoming={selectedIncoming}
                outgoing={selectedOutgoing}
                availableTargets={availableTargets}
                isOrphan={false}
                isDeadEnd={false}
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
            </div>
            <EdgeDetailPanel
              key={
                (selectedCandidateId ? "candidate:" : "edge:") +
                (selectedCandidateId ?? selectedEdgeId ?? "none")
              }
              edge={selectedNodeId ? null : selectedEdgeState}
              onClose={() => {
                coordinator.finishDetails();
                setSelectedEdgeId(null);
                setSelectedCandidateId(null);
              }}
              onDraftStart={() => coordinator.stageDetails()}
              onDraftEnd={() => coordinator.finishDetails()}
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
  previewRevision,
  onOpenPreview,
  onOpenDetails,
  onOpenFile,
  onPrepareRedesign,
}: {
  nodes: Node[];
  freshNodeIds: Set<string>;
  previewRevision?: string | number;
  onOpenPreview: (route: string) => void;
  onOpenDetails: (nodeId: string) => void;
  onOpenFile: (filePath: string) => void;
  onPrepareRedesign: (page: PageNodeData & { id: string }) => void;
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
  const livePreviewIds = new Set(
    sortedNodes
      .filter((node) => {
        const data = node.data as PageNodeData;
        return (
          !!data.filePath &&
          pageRouteIsNavigable(pageRouteFromFilePath(data.filePath, data.notes), data.planned)
        );
      })
      .slice(0, PAGE_MAP_LIVE_PREVIEW_LIMIT)
      .map((node) => node.id),
  );

  return (
    <div className="h-full overflow-y-auto px-5 py-6 sm:px-7">
      <div className="mx-auto max-w-5xl">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">Your app at a glance</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Up to {PAGE_MAP_LIVE_PREVIEW_LIMIT} pages load lazy live iframes, not recorded
              thumbnails. Source-discovered pages are not verified running pages. Open Preview to
              inspect a page, or prepare a targeted redesign in the composer.
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
            const routeLabel = data.filePath ? route : "No file mapped yet";
            const cardStatus = pageCardStatus(data);
            const status = cardStatus === "Page built" ? "Mapped" : cardStatus;
            const navigable = !!data.filePath.trim() && pageRouteIsNavigable(route, data.planned);
            const isFresh = freshNodeIds.has(node.id);
            const statusClass =
              status === "Updating" || status === "New"
                ? "bg-primary/10 text-primary border-primary/20"
                : "bg-muted text-muted-foreground border-border";

            return (
              <article
                key={node.id}
                data-testid={`page-map-card-${node.id}`}
                className={cn(
                  "group min-w-0 overflow-hidden rounded-xl border border-border bg-card text-left shadow-sm transition-colors duration-200 hover:border-primary/40",
                  isFresh &&
                    "animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none",
                )}
                style={
                  isFresh
                    ? {
                        animationDelay: `${Math.min(index * 60, 300)}ms`,
                        animationFillMode: "both",
                      }
                    : undefined
                }
              >
                <button
                  type="button"
                  className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                  onClick={() => (navigable ? onOpenPreview(route) : onOpenDetails(node.id))}
                  aria-label={
                    navigable
                      ? `Open ${data.label} at ${route} in Preview`
                      : `View details for ${data.label}`
                  }
                >
                  <div className="h-40 border-b border-border sm:h-44">
                    {data.planned ? (
                      <span className="flex h-full items-center justify-center gap-2 bg-muted/30 text-xs text-muted-foreground">
                        <FilePlus className="h-4 w-4" />
                        Planned page - no live preview
                      </span>
                    ) : navigable ? (
                      <PageMapLivePreview
                        projectId={data.projectId}
                        route={route}
                        label={data.label}
                        enabled={livePreviewIds.has(node.id)}
                        revision={previewRevision}
                      />
                    ) : (
                      <span className="flex h-full items-center justify-center bg-muted/30 px-4 text-xs text-muted-foreground">
                        Preview needs a concrete app route
                      </span>
                    )}
                  </div>
                  <div className="flex items-start gap-3 p-4">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/50 text-muted-foreground">
                      <FileText className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <h4 className="truncate text-sm font-semibold text-foreground">
                            {data.label}
                          </h4>
                          <p
                            className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground"
                            title={routeLabel}
                          >
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
                <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label={`Page details: ${data.label}`}
                    onClick={() => onOpenDetails(node.id)}
                  >
                    Details
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    disabled={!!data.planned || !data.filePath}
                    aria-label={`Open file: ${data.label}`}
                    onClick={() => onOpenFile(data.filePath)}
                  >
                    Open file
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label={`Prepare ${data.planned ? "page" : "redesign"}: ${data.label}`}
                    onClick={() => onPrepareRedesign({ ...data, id: node.id })}
                  >
                    {data.planned ? "Prepare page" : "Prepare redesign"}
                  </Button>
                </div>
              </article>
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
  canAnalyze,
  canAdd,
  onAddPage,
}: {
  onAnalyze: () => void;
  isAnalyzing: boolean;
  canAnalyze: boolean;
  canAdd: boolean;
  onAddPage: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-center px-8">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 border border-primary/20 flex items-center justify-center">
        <MapPin className="h-8 w-8 text-primary/60" />
      </div>
      <div>
        <div className="text-base font-semibold text-foreground">No pages mapped yet</div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          An empty map does not mean your app has no pages. Analyze the app or add a planned page.
        </div>
      </div>
      <div className="flex flex-wrap justify-center items-center gap-3">
        <Button onClick={onAnalyze} disabled={isAnalyzing || !canAnalyze} className="gap-2">
          <RefreshCw className={cn("h-4 w-4", isAnalyzing && "animate-spin")} />
          {isAnalyzing ? "Analyzing app…" : "Analyze my app"}
        </Button>
        <Button variant="outline" onClick={onAddPage} disabled={!canAdd} className="gap-2">
          <FilePlus className="h-4 w-4" />
          Add a page
        </Button>
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div role="status" className="flex items-center justify-center h-full">
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
          {platform === "ios" ? "iOS" : "Android"} mapping is unavailable
        </div>
        <div className="text-sm text-muted-foreground mt-1 max-w-xs">
          Only Web mapping is currently supported. Switch to Web to view your pages.
        </div>
      </div>
    </div>
  );
}
