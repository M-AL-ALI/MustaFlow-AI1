// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { Connection, Edge, Node } from "@xyflow/react";
import type { PageMapData } from "@workspace/api-client-react";
import {
  createPageMapSaveCoordinator,
  PageMapTab,
  platformMapToFlow,
  serializePageMapPlatform,
} from "./page-map-tab";
import { EdgeDetailPanel, type PageMapEdgeState } from "./edge-detail-panel";
import { PageEdge } from "./page-edge";
import {
  copyPageMapTransition,
  createPageMapPendingEvidence,
  manualPageMapTransition,
  newPageMapTransitionId,
  parallelTransitionEdges,
  parallelTransitionPath,
  retainedCandidates,
  transitionBadgeLayout,
  transitionDraftError,
  transitionEvidenceLabel,
  transitionSummary,
  unknownPageMapTransition,
  type PageMapPublicEdge,
  type PageMapTransition,
} from "./page-map-transition-model";

const mocks = vi.hoisted(() => ({
  query: {
    data: undefined as unknown,
    isLoading: false,
    isFetching: false,
    isError: false,
    refetch: vi.fn(),
  },
  save: { mutate: vi.fn(), isPending: false, isError: false, error: undefined as unknown },
  analyze: { mutate: vi.fn(), isPending: false, isError: false, error: undefined as unknown },
  queryClient: { invalidateQueries: vi.fn() },
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetPageMap: () => mocks.query,
  usePutPageMap: () => mocks.save,
  useAnalyzePageMap: () => mocks.analyze,
  getGetPageMapQueryKey: (id: number) => ["page-map", id],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock("html2canvas", () => ({ default: vi.fn() }));
vi.mock("./blocks-panel", () => ({ BlocksPanel: () => null }));
// No preview/runtime/provider requests: only map callbacks are exercised.
vi.mock("./page-node", () => ({
  PageNode: () => null,
  PageMapLivePreview: () => <span>Simulated preview; no runtime evidence</span>,
}));
vi.mock("@xyflow/react", async () => {
  const { useState } = await import("react");
  const { createPortal } = await import("react-dom");
  return {
    EdgeLabelRenderer: ({ children }: { children: ReactNode }) =>
      createPortal(children, document.body),
    useNodesState: (initial: Node[]) => [...useState(initial), vi.fn()],
    useEdgesState: (initial: Edge[]) => [...useState(initial), vi.fn()],
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
    Controls: () => null,
    Background: () => null,
    MiniMap: () => null,
    BaseEdge: ({ id, path }: { id: string; path: string }) => (
      <path data-testid={"path-" + id} d={path} />
    ),
    getBezierPath: () => ["M 0 0 C 100 0 100 0 200 0", 100, 0],
    ReactFlow: ({
      nodes,
      edges,
      onConnect,
    }: {
      nodes: Node[];
      edges: Edge[];
      onConnect: (connection: Connection) => void;
    }) => (
      <div aria-label="Simulated connections canvas">
        {nodes.map((node) => (
          <button
            key={node.id}
            type="button"
            aria-label={"Inspect page " + node.id}
            onClick={() => (node.data.onNodeClick as (id: string) => void)(node.id)}
          >
            {node.data.label as string}
          </button>
        ))}
        {edges.map((edge) => (
          <button
            key={edge.id}
            type="button"
            aria-label={"Canvas transition " + edge.id}
            data-lane={String(edge.data?.parallelOffset)}
            onClick={() => (edge.data?.onInspect as (id: string) => void)?.(edge.id)}
          >
            {edge.id}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            onConnect({
              source: "start",
              target: "finish",
              sourceHandle: null,
              targetHandle: null,
            })
          }
        >
          Simulate another transition
        </button>
      </div>
    ),
  };
});

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const sourceTransition = (): PageMapTransition => ({
  version: 1,
  action: { kind: "click", label: "Continue" },
  control: { kind: "button", label: "Continue", locator: "[data-next]" },
  condition: { kind: "predicate", expression: "session exists", branch: "true" },
  outcome: { kind: "navigate", detail: "Open the next mapped page" },
  destination: { kind: "route", value: "/finish" },
  evidence: [
    {
      basis: "source",
      fields: ["action", "control", "condition", "outcome", "destination"],
      source: {
        filePath: "src/App.tsx",
        contentSha256: "c".repeat(64),
        startOffset: 12,
        endOffset: 86,
      },
    },
  ],
  unknowns: ["Runtime execution has not been observed"],
});
function page(id: string): PageMapData["web"]["nodes"][number] {
  return {
    id,
    label: id === "start" ? "Start" : "Finish",
    pageType: "other",
    filePath: "src/pages/" + id + ".tsx",
    notes: "Route: /" + id,
    isNew: false,
    hasError: false,
    aiGenerated: true,
    planned: false,
    position: { x: id === "start" ? 100 : 400, y: 100 },
  };
}
function edge(id = "edge-a", transition = sourceTransition()): PageMapPublicEdge {
  return {
    id,
    source: "start",
    target: "finish",
    connectionType: "nav",
    aiGenerated: true,
    transition,
  };
}
function graph(): PageMapData {
  return {
    web: {
      nodes: [page("start"), page("finish")],
      edges: [edge()],
      unresolvedTransitions: [{ id: "candidate-a", transition: unknownPageMapTransition() }],
    },
    ios: { nodes: [], edges: [] },
    android: { nodes: [], edges: [] },
  };
}
const snapshot = (pageMapData = graph(), revision = REV_A) => ({ pageMapData, revision });
type SaveRequest = Parameters<Parameters<typeof createPageMapSaveCoordinator>[0]["save"]>[0];
function savedCall(index = 0) {
  return mocks.save.mutate.mock.calls[index] as [
    SaveRequest,
    { onSuccess: (response: unknown) => void; onError: (error: unknown) => void },
  ];
}
function renderMap() {
  const callbacks = {
    onSwitchToPreview: vi.fn(),
    onSwitchToCode: vi.fn(),
    onSwitchToChat: vi.fn(),
  };
  const result = render(<PageMapTab projectId={901} isBuilding={false} {...callbacks} />);
  return {
    ...callbacks,
    rerender: (isBuilding = false) =>
      result.rerender(<PageMapTab projectId={901} isBuilding={isBuilding} {...callbacks} />),
  };
}
const connections = () => fireEvent.click(screen.getByRole("button", { name: "Connections" }));
function inspectCandidate(id = "candidate-a") {
  fireEvent.click(screen.getByText(/^Unresolved transitions \(/));
  fireEvent.click(screen.getByRole("button", { name: "Inspect unresolved transition " + id }));
}
const inspector = () =>
  within(
    screen.getByRole("complementary", { name: /^(Unresolved transition|Transition) details$/ }),
  );
const flush = () => act(() => vi.advanceTimersByTime(800));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.query.data = snapshot();
  mocks.query.isLoading = mocks.query.isFetching = mocks.query.isError = false;
  mocks.query.refetch.mockImplementation(async () => ({ data: mocks.query.data }));
  mocks.save.isPending = mocks.save.isError = false;
  mocks.analyze.isPending = mocks.analyze.isError = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Page Map transition public-contract roundtrip", () => {
  it("keeps optional legacy absence rather than inventing an unconditional transition", () => {
    const legacy = graph().web;
    delete legacy.edges[0].transition;
    delete legacy.unresolvedTransitions;
    const flow = platformMapToFlow(legacy, 901, false, vi.fn(), vi.fn());
    const saved = serializePageMapPlatform(flow.nodes, flow.edges, legacy);
    expect(saved.edges[0]).not.toHaveProperty("transition");
    expect(saved).not.toHaveProperty("unresolvedTransitions");
    expect(transitionSummary()).toContain("condition unknown");
    expect(transitionEvidenceLabel()).toBe("Unknown evidence");
  });

  it("retains every generated transition field and unresolved candidate through hydration and layout serialization", () => {
    const platform = graph().web;
    const flow = platformMapToFlow(platform, 901, false, vi.fn(), vi.fn());
    flow.nodes[0].position = { x: 222, y: 333 };
    const saved = serializePageMapPlatform(
      flow.nodes,
      parallelTransitionEdges(flow.edges, vi.fn()),
      platform,
    );
    expect(saved.edges).toEqual(platform.edges);
    expect(saved.unresolvedTransitions).toEqual(platform.unresolvedTransitions);
    expect(saved.nodes[0].position).toEqual({ x: 222, y: 333 });
    expect(saved.edges[0].transition).not.toBe(platform.edges[0].transition);
    expect(saved.edges[0]).not.toHaveProperty("parallelOffset");
    expect(saved.edges[0]).not.toHaveProperty("onInspect");
  });

  it("preserves explicit candidate deletion and prunes only a removed source page", () => {
    const platform = graph().web;
    platform.unresolvedTransitions!.push(
      { id: "retained", source: "start", transition: unknownPageMapTransition() },
      { id: "removed", source: "finish", transition: unknownPageMapTransition() },
    );
    const saved = retainedCandidates(platform, new Set(["start"]));
    expect(saved.unresolvedTransitions?.map((item) => item.id)).toEqual([
      "candidate-a",
      "retained",
    ]);
    expect(
      retainedCandidates({ nodes: [], edges: [], unresolvedTransitions: [] }, new Set()),
    ).toEqual({ unresolvedTransitions: [] });
  });

  it("makes edited presentation manual without mutating or minting authoritative evidence", () => {
    const original = sourceTransition();
    const manual = manualPageMapTransition(original);
    expect(manual.evidence).toEqual([
      {
        basis: "manual",
        fields: ["action", "control", "condition", "outcome", "destination"],
      },
    ]);
    expect(manual.evidence[0]).not.toHaveProperty("source");
    expect(original.evidence[0].basis).toBe("source");
    expect(transitionEvidenceLabel(original)).toBe("Historical source");
    expect(transitionEvidenceLabel(manual, true)).toBe("Manual; awaiting acknowledgement");
  });

  it.each([
    { kind: "route" as const, value: "//example.com" },
    { kind: "route" as const, value: "/bad route" },
    { kind: "external" as const, value: "javascript:alert(1)" },
    { kind: "external" as const, value: "https://user:password@example.com" },
  ])("refuses an invalid descriptive destination $value", (destination) => {
    expect(transitionDraftError({ ...unknownPageMapTransition(), destination })).not.toBeNull();
  });

  it("distinguishes inferred evidence and explicit unknowns without runtime claims", () => {
    const inferred = {
      ...sourceTransition(),
      evidence: [{ basis: "inferred" as const, fields: ["destination" as const] }],
    };
    expect(transitionEvidenceLabel(inferred)).toBe("Inferred");
    expect(transitionSummary(inferred)).toContain("session exists (true)");
    expect(copyPageMapTransition(inferred).unknowns).toEqual(inferred.unknowns);
  });
});

describe("parallel mapped transitions", () => {
  it.each([
    { name: "horizontal", targetX: 400, targetY: 0, count: 2, reciprocal: false },
    { name: "vertical", targetX: 0, targetY: 400, count: 2, reciprocal: false },
    { name: "reciprocal vertical", targetX: 0, targetY: 400, count: 3, reciprocal: true },
    { name: "multi-edge diagonal", targetX: 320, targetY: 400, count: 8, reciprocal: true },
  ])(
    "uses one non-overlapping label footprint for $name geometry",
    ({ targetX, targetY, count, reciprocal }) => {
      const inspect = vi.fn();
      const input: Edge[] = Array.from({ length: count }, (_, index) => ({
        id: "group-" + index,
        source: reciprocal && index % 2 ? "finish" : "start",
        target: reciprocal && index % 2 ? "start" : "finish",
        data: { connectionType: "nav", aiGenerated: true, transition: sourceTransition() },
      }));
      const grouped = parallelTransitionEdges(input, inspect);
      const geometry = grouped.map((item) => {
        const reverse = item.source === "finish";
        const data = item.data as NonNullable<Parameters<typeof PageEdge>[0]["data"]>;
        const sourceX = reverse ? targetX : 0;
        const sourceY = reverse ? targetY : 0;
        const endX = reverse ? 0 : targetX;
        const endY = reverse ? 0 : targetY;
        return {
          item,
          data,
          sourceX,
          sourceY,
          targetX: endX,
          targetY: endY,
          box: transitionBadgeLayout(
            sourceX,
            sourceY,
            endX,
            endY,
            data.parallelIndex,
            data.parallelCount,
          ),
        };
      });
      const visible = geometry.filter((item) => item.box.visible);
      expect(visible).toHaveLength(1);
      expect(visible[0].box).toEqual({
        x: targetX / 2 - 120,
        y: targetY / 2 - 22,
        width: 240,
        height: 44,
        visible: true,
      });
      expect(grouped.every((item) => item.data?.parallelCount === count)).toBe(true);
      render(
        <svg>
          {geometry.map((item) => {
            const props = {
              id: item.item.id,
              source: item.item.source,
              target: item.item.target,
              sourceX: item.sourceX,
              sourceY: item.sourceY,
              targetX: item.targetX,
              targetY: item.targetY,
              sourcePosition: "right",
              targetPosition: "left",
              data: item.data,
              selected: false,
            } as Parameters<typeof PageEdge>[0];
            return <PageEdge key={item.item.id} {...props} />;
          })}
        </svg>,
      );
      expect(screen.getAllByRole("img")).toHaveLength(count);
      expect(document.querySelectorAll("foreignObject")).toHaveLength(0);
      const summary = screen.getByLabelText("Choose among " + count + " mapped transitions");
      const positioned = summary.parentElement!.parentElement!;
      expect(positioned.style.width).toBe("240px");
      expect(positioned.style.transform).toBe(
        "translate(" + visible[0].box.x + "px, " + visible[0].box.y + "px)",
      );
      fireEvent.click(summary);
      const choices = within(screen.getByRole("group", { name: "Transitions sharing endpoints" }));
      for (const item of grouped) {
        fireEvent.click(
          choices.getByRole("button", { name: new RegExp("^Inspect transition " + item.id + ":") }),
        );
      }
      expect(inspect.mock.calls.map(([id]) => id)).toEqual(grouped.map((item) => item.id));
    },
  );

  it("keeps unique identities and separated paths for shared and reciprocal endpoints", () => {
    const ids = [newPageMapTransitionId(), newPageMapTransitionId()];
    expect(new Set(ids).size).toBe(2);
    const input: Edge[] = [
      { id: "a", source: "start", target: "finish" },
      { id: "b", source: "start", target: "finish" },
      { id: "c", source: "finish", target: "start" },
    ];
    const lanes = parallelTransitionEdges(input);
    expect(lanes.map((item) => item.data?.parallelIndex)).toEqual([1, 2, 3]);
    expect(lanes.every((item) => item.data?.parallelCount === 3)).toBe(true);
    expect(parallelTransitionPath(0, 0, 200, 0, -26)[0]).not.toBe(
      parallelTransitionPath(0, 0, 200, 0, 26)[0],
    );
    expect(input[0].data).toBeUndefined();
  });

  it("provides an accessible exact-ID inspect button on the real SVG edge", () => {
    const inspect = vi.fn();
    const props = {
      id: "edge-a",
      source: "start",
      target: "finish",
      sourceX: 0,
      sourceY: 0,
      targetX: 200,
      targetY: 0,
      sourcePosition: "right",
      targetPosition: "left",
      selected: false,
      data: {
        connectionType: "nav",
        aiGenerated: true,
        transition: sourceTransition(),
        parallelCount: 2,
        parallelIndex: 1,
        parallelOffset: -26,
        onInspect: inspect,
      },
    } as Parameters<typeof PageEdge>[0];
    render(
      <svg>
        <PageEdge {...props} />
      </svg>,
    );
    fireEvent.click(screen.getByRole("button", { name: /^Inspect transition edge-a:/ }));
    expect(inspect).toHaveBeenCalledExactlyOnceWith("edge-a");
    expect(
      within(screen.getByRole("button", { name: /^Inspect transition edge-a:/ })).getByText(
        /Historical source/,
      ),
    ).toBeVisible();
  });
});

describe("transition editor descriptive drafts", () => {
  function mount(transition?: PageMapTransition) {
    const edgeState: PageMapEdgeState = {
      id: "edge-a",
      sourceLabel: "Start",
      targetLabel: "Finish",
      connectionType: "nav",
      aiGenerated: true,
      transition,
    };
    const handlers = {
      onClose: vi.fn(),
      onSave: vi.fn(),
      onDelete: vi.fn(),
      onDraftStart: vi.fn(),
      onDraftEnd: vi.fn(),
    };
    render(<EdgeDetailPanel edge={edgeState} {...handlers} />);
    return handlers;
  }

  it("shows historical source references as read-only and switches changed fields to manual until saved", () => {
    const handlers = mount(sourceTransition());
    expect(screen.getByText(/not current-source freshness or runtime observation/)).toBeVisible();
    expect(screen.getByText(/SHA256/)).toHaveTextContent("src/App.tsx");
    fireEvent.change(screen.getByLabelText("Action label"), {
      target: { value: "Continue after sign-in" },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Manual draft; not saved");
    expect(screen.queryByText(/SHA256/)).toBeNull();
    expect(handlers.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save mapped transition" }));
    expect(handlers.onSave).toHaveBeenCalledWith(
      "edge-a",
      "nav",
      expect.objectContaining({
        action: { kind: "click", label: "Continue after sign-in" },
        evidence: [
          { basis: "manual", fields: ["action", "control", "condition", "outcome", "destination"] },
        ],
      }),
    );
    expect(handlers.onDraftStart).toHaveBeenCalled();
    expect(handlers.onDraftEnd).toHaveBeenCalled();
  });

  it("keeps legacy unknowns explicit and blocks an empty predicate rather than skipping validation", () => {
    mount();
    expect(screen.getByLabelText("Condition kind")).toHaveValue("unknown");
    fireEvent.change(screen.getByLabelText("Condition kind"), { target: { value: "predicate" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Describe the predicate");
    expect(screen.getByRole("button", { name: "Save mapped transition" })).toBeDisabled();
  });

  it("discards a draft and restores source presentation without saving", () => {
    const handlers = mount(sourceTransition());
    fireEvent.change(screen.getByLabelText("Control label"), {
      target: { value: "Different button" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Discard transition draft" }));
    expect(screen.getByLabelText("Control label")).toHaveValue("Continue");
    expect(screen.getByRole("status")).toHaveTextContent("Historical source");
    expect(handlers.onSave).not.toHaveBeenCalled();
    expect(handlers.onDraftEnd).toHaveBeenCalled();
  });
});

describe("Page Map workspace metadata integration", () => {
  it.each(["edge", "candidate"] as const)(
    "keeps %s evidence pending across Web/iOS/Web before dispatch and while awaiting its acknowledgement",
    (kind) => {
      renderMap();
      connections();
      const open = () =>
        kind === "edge"
          ? fireEvent.click(screen.getByRole("button", { name: "Canvas transition edge-a" }))
          : inspectCandidate();
      const switchAwayAndBack = () => {
        // Radix opens on Enter without awaiting fake-timer interaction delays.
        // Do not advance the 800ms save timer while switching platforms.
        fireEvent.keyDown(screen.getByRole("button", { name: "Platform: Web" }), { key: "Enter" });
        // Menu items include availability text; the platform trigger does not.
        fireEvent.click(screen.getByRole("menuitemradio", { name: "iOS (unavailable)" }));
        expect(screen.getByRole("button", { name: "Platform: iOS" })).toBeVisible();
        fireEvent.keyDown(screen.getByRole("button", { name: "Platform: iOS" }), { key: "Enter" });
        fireEvent.click(screen.getByRole("menuitemradio", { name: "Web" }));
        expect(screen.getByRole("button", { name: "Platform: Web" })).toBeVisible();
      };
      open();
      fireEvent.change(inspector().getByLabelText("Action label"), {
        target: { value: "Pending local action" },
      });
      fireEvent.click(inspector().getByRole("button", { name: "Save mapped transition" }));
      expect(inspector().getByRole("status")).toHaveTextContent("awaiting acknowledgement");
      switchAwayAndBack();
      open();
      expect(inspector().getByRole("status")).toHaveTextContent("awaiting acknowledgement");
      expect(mocks.save.mutate).not.toHaveBeenCalled();
      flush();
      expect(mocks.save.mutate).toHaveBeenCalledTimes(1);
      switchAwayAndBack();
      open();
      expect(inspector().getByRole("status")).toHaveTextContent("awaiting acknowledgement");
      const [request, operation] = savedCall();
      const acknowledged: PageMapData = {
        web: request.data.web,
        ios: request.data.ios,
        android: request.data.android,
      };
      mocks.query.data = snapshot(acknowledged, REV_B);
      act(() => operation.onSuccess(mocks.query.data));
      expect(inspector().getByRole("status")).not.toHaveTextContent("awaiting acknowledgement");
      expect(inspector().getByLabelText("Action label")).toHaveValue("Pending local action");
    },
  );

  it("allows parallel connects and retains existing evidence/candidates in the CAS payload", () => {
    const callbacks = renderMap();
    connections();
    fireEvent.click(screen.getByRole("button", { name: "Simulate another transition" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulate another transition" }));
    expect(screen.getAllByRole("button", { name: /^Canvas transition / })).toHaveLength(3);
    flush();
    const [request] = savedCall();
    expect(request.data.expectedRevision).toBe(REV_A);
    expect(request.data.web.edges).toHaveLength(3);
    expect(new Set(request.data.web.edges.map((item) => item.id)).size).toBe(3);
    expect(request.data.web.edges[0].transition?.evidence[0].basis).toBe("source");
    expect(
      request.data.web.edges
        .slice(1)
        .every((item) => item.transition?.evidence[0].basis === "manual"),
    ).toBe(true);
    expect(request.data.web.unresolvedTransitions).toEqual(graph().web.unresolvedTransitions);
    expect(callbacks.onSwitchToPreview).not.toHaveBeenCalled();
    expect(callbacks.onSwitchToCode).not.toHaveBeenCalled();
    expect(callbacks.onSwitchToChat).not.toHaveBeenCalled();
    expect(mocks.analyze.mutate).not.toHaveBeenCalled();
  });

  it("keeps a dirty edge form through build renders and a conflicting server update", () => {
    const result = renderMap();
    connections();
    fireEvent.click(screen.getByRole("button", { name: "Canvas transition edge-a" }));
    fireEvent.change(inspector().getByLabelText("Action label"), {
      target: { value: "Local action draft" },
    });
    const latest = graph();
    latest.web.edges[0].transition!.action.label = "Server action";
    mocks.query.data = snapshot(latest, REV_B);
    result.rerender(true);
    expect(inspector().getByLabelText("Action label")).toHaveValue("Local action draft");
    expect(screen.getByRole("alert")).toHaveTextContent("Local edits are kept here");
    fireEvent.click(inspector().getByRole("button", { name: "Save mapped transition" }));
    flush();
    expect(mocks.save.mutate).not.toHaveBeenCalled();
  });

  it("edits unresolved claims without inventing endpoints, then clears pending presentation only on acknowledgement", () => {
    const callbacks = renderMap();
    inspectCandidate();
    fireEvent.change(inspector().getByLabelText("Action label"), {
      target: { value: "Unknown button" },
    });
    fireEvent.click(inspector().getByRole("button", { name: "Save mapped transition" }));
    expect(inspector().getByRole("status")).toHaveTextContent("awaiting acknowledgement");
    flush();
    const [request, operation] = savedCall();
    expect(request.data.web.edges).toEqual(graph().web.edges);
    expect(request.data.web.unresolvedTransitions?.[0]).not.toHaveProperty("source");
    expect(request.data.web.unresolvedTransitions?.[0].transition.action.label).toBe(
      "Unknown button",
    );
    const { expectedRevision: _expectedRevision, ...acknowledgedMap } = request.data;
    mocks.query.data = snapshot(acknowledgedMap, REV_B);
    act(() => operation.onSuccess(mocks.query.data));
    expect(inspector().getByRole("status")).toHaveTextContent("Manual");
    expect(inspector().getByRole("status")).not.toHaveTextContent("awaiting acknowledgement");
    expect(callbacks.onSwitchToPreview).not.toHaveBeenCalled();
    expect(callbacks.onSwitchToChat).not.toHaveBeenCalled();
  });

  it("inspects and removes an unresolved candidate even when the graph has no pages", () => {
    const empty = graph();
    empty.web.nodes = [];
    empty.web.edges = [];
    mocks.query.data = snapshot(empty);
    renderMap();
    inspectCandidate();
    expect(inspector().getByText("Source page unknown")).toBeVisible();
    fireEvent.click(inspector().getByRole("button", { name: "Remove candidate from map" }));
    flush();
    expect(savedCall()[0].data.web.unresolvedTransitions).toEqual([]);
    expect(savedCall()[0].data.web.nodes).toEqual([]);
    expect(savedCall()[0].data.web.edges).toEqual([]);
  });

  it("allows repeated same-target wiring without a selector-only draft blocking autosave", () => {
    renderMap();
    connections();
    fireEvent.click(screen.getByRole("button", { name: "Inspect page start" }));
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(screen.getByLabelText("Target page for new mapped transition"), {
        target: { value: "finish" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Add transition" }));
    }
    flush();
    expect(savedCall()[0].data.web.edges).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /^Inspect transition / })).toHaveLength(3);
  });

  it("preserves page-field drafts while wiring and saves them explicitly", () => {
    const result = renderMap();
    connections();
    fireEvent.click(screen.getByRole("button", { name: "Inspect page start" }));
    fireEvent.change(screen.getByLabelText("Page name"), { target: { value: "Local page name" } });
    fireEvent.change(screen.getByLabelText("Target page for new mapped transition"), {
      target: { value: "finish" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add transition" }));
    result.rerender(true);
    expect(screen.getByLabelText("Page name")).toHaveValue("Local page name");
    flush();
    expect(mocks.save.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    flush();
    expect(savedCall()[0].data.web.nodes[0].label).toBe("Local page name");
    expect(savedCall()[0].data.web.edges).toHaveLength(2);
  });

  it("separates mapped source presence from preview and thumbnail verification", () => {
    renderMap();
    expect(screen.getByText(/Page presence reflects source or manual mapping/)).toHaveTextContent(
      "not a verified running page or recorded thumbnail",
    );
    expect(screen.getByText(/A mapped page is not a verified running page/)).toBeVisible();
  });
});

describe("transition drafts retain coordinator protections", () => {
  it("pauses dispatch for details and never rebases a conflicting metadata draft", () => {
    const save = vi.fn();
    const coordinator = createPageMapSaveCoordinator({
      projectId: 901,
      save,
      analyze: vi.fn(),
      changed: vi.fn(),
      refetch: async () => ({ data: snapshot(graph(), REV_B) }),
    });
    coordinator.receive(snapshot());
    coordinator.stageDetails();
    const changed = graph().web;
    changed.edges[0].transition = manualPageMapTransition(sourceTransition());
    coordinator.edit("web", changed);
    vi.advanceTimersByTime(800);
    expect(save).not.toHaveBeenCalled();
    coordinator.receive(snapshot(graph(), REV_B));
    coordinator.finishDetails();
    vi.advanceTimersByTime(800);
    expect(coordinator.getState().problem).toBe("conflict");
    expect(coordinator.getState().revision).toBe(REV_A);
    expect(coordinator.getState().map?.web.edges[0].transition?.evidence[0].basis).toBe("manual");
    expect(save).not.toHaveBeenCalled();
    coordinator.deactivate();
  });
});

describe("per-platform pending evidence acknowledgement identity", () => {
  it.each(["edges", "candidates"] as const)(
    "does not clear a newer %s edit on an older acknowledgement",
    (kind) => {
      const pending = createPageMapPendingEvidence();
      const original = graph();
      const first = graph();
      if (kind === "edges")
        first.web.edges[0].transition = manualPageMapTransition(sourceTransition());
      else
        first.web.unresolvedTransitions![0].transition =
          manualPageMapTransition(sourceTransition());
      pending.stage("web", original.web, first.web);
      const captured = pending.capture();
      const newer = JSON.parse(JSON.stringify(first)) as PageMapData;
      const transition =
        kind === "edges"
          ? newer.web.edges[0].transition!
          : newer.web.unresolvedTransitions![0].transition;
      transition.action.label = "Newer edit";
      pending.stage("web", first.web, newer.web);
      pending.acknowledge(captured, first, first);
      const id = kind === "edges" ? "edge-a" : "candidate-a";
      expect(pending.forPlatform("web")[kind].has(id)).toBe(true);
      const latest = pending.capture();
      pending.acknowledge(latest, newer, newer);
      expect(pending.forPlatform("web")[kind].has(id)).toBe(false);
    },
  );

  it.each(["edges", "candidates"] as const)(
    "requires matching %s claims and keeps same IDs isolated by platform",
    (kind) => {
      const pending = createPageMapPendingEvidence();
      const original = graph();
      original.ios = JSON.parse(JSON.stringify(original.web)) as PageMapData["ios"];
      const sent = JSON.parse(JSON.stringify(original)) as PageMapData;
      for (const platform of ["web", "ios"] as const) {
        if (kind === "edges")
          sent[platform].edges[0].transition = manualPageMapTransition(sourceTransition());
        else
          sent[platform].unresolvedTransitions![0].transition =
            manualPageMapTransition(sourceTransition());
        pending.stage(platform, original[platform], sent[platform]);
      }
      const received = JSON.parse(JSON.stringify(sent)) as PageMapData;
      const wrong =
        kind === "edges"
          ? received.ios.edges[0].transition!
          : received.ios.unresolvedTransitions![0].transition;
      wrong.action.label = "Not this submitted claim";
      pending.acknowledge(pending.capture(), sent, received);
      const id = kind === "edges" ? "edge-a" : "candidate-a";
      expect(pending.forPlatform("web")[kind].has(id)).toBe(false);
      expect(pending.forPlatform("ios")[kind].has(id)).toBe(true);
      const authoritative = JSON.parse(JSON.stringify(sent)) as PageMapData;
      const acknowledged =
        kind === "edges"
          ? authoritative.ios.edges[0].transition!
          : authoritative.ios.unresolvedTransitions![0].transition;
      acknowledged.evidence = sourceTransition().evidence;
      pending.acknowledge(pending.capture(), sent, authoritative);
      expect(pending.forPlatform("ios")[kind].has(id)).toBe(false);
    },
  );

  it("does not persist presentation metadata in a platform save", () => {
    const platform = graph().web;
    platform.edges.push(edge("edge-b"));
    const flow = platformMapToFlow(platform, 901, false, vi.fn(), vi.fn());
    const grouped = parallelTransitionEdges(
      flow.edges.map((item) => ({
        ...item,
        data: { ...item.data, transitionPending: true },
      })),
      vi.fn(),
    );
    const saved = serializePageMapPlatform(flow.nodes, grouped, platform);
    expect(saved.edges).toEqual(platform.edges);
    expect(JSON.stringify(saved)).not.toContain("parallelTransitions");
    expect(JSON.stringify(saved)).not.toContain("transitionPending");
  });
});
