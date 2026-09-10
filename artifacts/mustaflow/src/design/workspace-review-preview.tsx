import { useCallback, useMemo, useRef, useState, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
} from "@xyflow/react";
import { FlaskConical, ListTree, Monitor, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  PreviewActionsMenu,
  PreviewRoutesMenu,
  PreviewStatusSummary,
} from "@/pages/projects/components/preview-toolbar-controls";
import { ProvisioningProgress } from "@/pages/projects/components/provisioning-progress";
import { PageNode, type PageNodeData } from "@/pages/projects/components/page-node";
import { PageEdge, type PageEdgeData } from "@/pages/projects/components/page-edge";
import {
  parallelTransitionEdges,
  unknownPageMapTransition,
  manualPageMapTransition,
} from "@/pages/projects/components/page-map-transition-model";
import { pagePreviewUrl } from "@/pages/projects/components/page-map-card-model";
import { cn } from "@/lib/utils";
import "@/index.css";

if (!import.meta.env.DEV) {
  throw new Error("Workspace component review is available in development only.");
}

// Invalid on purpose: actual PageNode cards must take their no-iframe fallback.
// This guard fails closed if the shared preview URL contract ever changes.
const LAB_PROJECT_ID = 0;
if (pagePreviewUrl(LAB_PROJECT_ID, "/review/overview") !== null) {
  throw new Error("Workspace review cannot mount while project preview URLs are enabled.");
}

type Scenario = "success" | "loading" | "failure" | "runtime-paused";
type PreviewFixture = Omit<ComponentProps<typeof PreviewStatusSummary>, "hasRuntime" | "hasFiles">;
type SetupFixture = Pick<
  ComponentProps<typeof ProvisioningProgress>,
  "status" | "step" | "error" | "estimatedSecondsRemaining" | "elapsedSeconds"
>;
type ScenarioDefinition = {
  label: string;
  description: string;
  preview: PreviewFixture;
  setup: SetupFixture;
};

const SCENARIOS: Record<Scenario, ScenarioDefinition> = {
  success: {
    label: "Success",
    description:
      "Illustrative published state, running runtime, and ready environment. No app was built or published by this lab.",
    preview: {
      projectStatus: "published",
      runtimeStatus: "running",
      serverPreviewLive: true,
      webContainerLive: false,
      agenticPreviewUnavailable: false,
    },
    setup: {
      status: "ready",
      step: null,
      error: null,
      estimatedSecondsRemaining: null,
      elapsedSeconds: 0,
    },
  },
  loading: {
    label: "Loading",
    description:
      "Illustrative work in progress. Observation is disabled and setup stays pending until you choose another state.",
    preview: {
      projectStatus: "building",
      runtimeStatus: "starting",
      serverPreviewLive: false,
      webContainerLive: false,
      agenticPreviewUnavailable: true,
    },
    setup: {
      status: "provisioning",
      step: "create_container",
      error: null,
      estimatedSecondsRemaining: null,
      elapsedSeconds: 25,
    },
  },
  failure: {
    label: "Failure",
    description:
      "Illustrative build and setup failures coexist with a running runtime. Recovery callbacks keep these failure fixtures visible.",
    preview: {
      projectStatus: "failed",
      runtimeStatus: "running",
      serverPreviewLive: true,
      webContainerLive: false,
      agenticPreviewUnavailable: false,
    },
    setup: {
      status: "error",
      step: null,
      error: "Illustrative setup failure: the example database connection did not complete.",
      estimatedSecondsRemaining: null,
      elapsedSeconds: 0,
    },
  },
  "runtime-paused": {
    label: "Runtime paused",
    description:
      "Illustrative hibernation with a retained build failure and separate browser-preview state. No runtime or browser sandbox is started.",
    preview: {
      projectStatus: "failed",
      runtimeStatus: "hibernated",
      serverPreviewLive: false,
      webContainerLive: true,
      agenticPreviewUnavailable: false,
    },
    setup: {
      status: "hibernated",
      step: null,
      error: null,
      estimatedSecondsRemaining: null,
      elapsedSeconds: 0,
    },
  },
};

const ROUTES: ComponentProps<typeof PreviewRoutesMenu>["routes"] = [
  { kind: "web", path: "/review/overview", label: "/review/overview" },
  { kind: "web", path: "/review/customers", label: "/review/customers" },
  { kind: "expo", path: "/review/native-example", label: "/review/native-example", fileId: 0 },
];

type LabNode = Node<PageNodeData, "pageNode">;
type LabEdge = Edge<PageEdgeData, "pageEdge">;
const NODE_TYPES = { pageNode: PageNode };
const EDGE_TYPES = { pageEdge: PageEdge };

function initialNodes(scenario: Scenario): LabNode[] {
  const base: PageNodeData = {
    label: "Overview",
    pageType: "landing",
    filePath: "src/pages/Overview.tsx",
    notes: "Route: /review/overview",
    projectId: LAB_PROJECT_ID,
    isNew: scenario === "success",
    hasError: scenario === "failure" || scenario === "runtime-paused",
    aiGenerated: false,
    isBuilding: scenario === "loading",
    incoming: 0,
    outgoing: 2,
  };
  return [
    { id: "lab-overview", type: "pageNode", position: { x: 40, y: 140 }, data: base },
    {
      id: "lab-customers",
      type: "pageNode",
      position: { x: 370, y: 20 },
      data: {
        ...base,
        label: "Customers",
        pageType: "list",
        filePath: "src/pages/Customers.tsx",
        notes: "Route: /review/customers",
        isNew: false,
        hasError: false,
        incoming: 1,
        outgoing: 0,
        isDeadEnd: true,
      },
    },
    {
      id: "lab-settings",
      type: "pageNode",
      position: { x: 370, y: 300 },
      data: {
        ...base,
        label: "Planned settings",
        pageType: "settings",
        filePath: "",
        notes: "Illustrative planned page; no source file exists.",
        planned: true,
        aiGenerated: true,
        isNew: false,
        hasError: false,
        isBuilding: false,
        incoming: 1,
        outgoing: 0,
      },
    },
  ];
}

function initialEdges(): LabEdge[] {
  const markerEnd = {
    type: MarkerType.ArrowClosed,
    width: 14,
    height: 14,
    color: "hsl(var(--muted-foreground))",
  };
  return [
    {
      id: "lab-mapped",
      source: "lab-overview",
      target: "lab-customers",
      type: "pageEdge",
      markerEnd,
      data: { connectionType: "nav", aiGenerated: false },
      ariaLabel: "Illustrative mapped connection from Overview to Customers; runtime not verified",
    },
    {
      id: "lab-inferred",
      source: "lab-overview",
      target: "lab-settings",
      type: "pageEdge",
      markerEnd,
      data: { connectionType: "redirect", aiGenerated: true },
      ariaLabel:
        "Illustrative inferred connection from Overview to Planned settings; runtime not verified",
    },
  ];
}

function PageMapFixture({
  scenario,
  report,
}: {
  scenario: Scenario;
  report: (message: string) => void;
}) {
  const [nodes, setNodes, onNodesChange] = useNodesState<LabNode>(initialNodes(scenario));
  const [edges, setEdges, onEdgesChange] = useEdgesState<LabEdge>(initialEdges());
  const [selection, setSelection] = useState("No fixture selected.");
  const [parallel, setParallel] = useState(false);
  const inspectTransition = useCallback(
    (id: string) => {
      setSelection("Illustrative transition selected: " + id);
      report("Simulated transition selection: " + id + ". No app navigation was changed.");
    },
    [report],
  );
  const displayEdges = useMemo(
    () => parallelTransitionEdges(edges, inspectTransition) as LabEdge[],
    [edges, inspectTransition],
  );

  function toggleParallel() {
    const next = !parallel;
    setParallel(next);
    const nextNodes = initialNodes(scenario);
    if (next) {
      nextNodes[0].position = { x: 40, y: 40 };
      nextNodes[0].data = { ...nextNodes[0].data, incoming: 1, outgoing: 3 };
      nextNodes[1].position = { x: 248, y: 440 };
      nextNodes[1].data = { ...nextNodes[1].data, incoming: 2, outgoing: 1, isDeadEnd: false };
      nextNodes[2].position = { x: 600, y: 120 };
    }
    setNodes(nextNodes);
    const nextEdges = initialEdges();
    if (next) {
      const connection = (label: string, destination: string) =>
        manualPageMapTransition({
          ...unknownPageMapTransition(),
          action: { kind: "click", label },
          control: { kind: "button", label },
          outcome: { kind: "navigate" },
          destination: { kind: "route", value: destination },
          unknowns: ["Illustrative metadata only; no real navigation or save request."],
        });
      nextEdges[0].data = {
        ...nextEdges[0].data,
        connectionType: "nav",
        aiGenerated: false,
        transition: connection("Continue", "/review/customers"),
        transitionPending: true,
      };
      nextEdges.push(
        {
          ...nextEdges[0],
          id: "lab-mapped-alternative",
          data: {
            connectionType: "nav",
            aiGenerated: false,
            transition: connection("Open customers", "/review/customers"),
          },
        },
        {
          ...nextEdges[0],
          id: "lab-mapped-return",
          source: "lab-customers",
          target: "lab-overview",
          data: {
            connectionType: "nav",
            aiGenerated: false,
            transition: connection("Back to overview", "/review/overview"),
          },
        },
      );
    }
    setEdges(nextEdges);
    setSelection("No fixture selected.");
    report(
      next
        ? "Three simulated transitions share one expandable label. Use Fit View after changing the layout."
        : "Default illustrative map restored.",
    );
  }

  const openDetails = useCallback(
    (id: string) => {
      setNodes((current) => current.map((node) => ({ ...node, selected: node.id === id })));
      setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
      setSelection("Illustrative card selected: " + id);
      report("Simulated page-details callback for " + id + ". No project details were requested.");
    },
    [report, setNodes, setEdges],
  );

  const displayNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          onNodeClick: openDetails,
          onPreviewClick: (filePath: string, route?: string) => {
            report(
              "Simulated preview callback: " +
                (route ?? filePath) +
                ". No navigation or preview request.",
            );
          },
        },
      })),
    [nodes, openDetails, report],
  );

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 px-5 pb-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-pressed={parallel}
          onClick={toggleParallel}
        >
          {parallel ? "Show default connections" : "Review parallel connections"}
        </Button>
        <span className="text-xs text-muted-foreground">
          Local simulation only; use Fit View after switching.
        </span>
      </div>
      <div
        className="h-[480px] min-w-0 border-y border-border bg-background"
        data-testid="review-page-map-canvas"
      >
        <ReactFlow<LabNode, LabEdge>
          nodes={displayNodes}
          edges={displayEdges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          nodesConnectable={false}
          nodesFocusable
          edgesFocusable
          deleteKeyCode={null}
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.35}
          maxZoom={1.5}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_event, node) => openDetails(node.id)}
          onNodeDragStop={(_event, node) =>
            report(
              "Simulated map layout change for " +
                node.id +
                ". Position is local and was not saved.",
            )
          }
          onEdgeClick={(_event, edge) => {
            const provenance = edge.data?.aiGenerated ? "inferred" : "mapped";
            setSelection("Illustrative " + provenance + " edge selected: " + edge.id);
            report(
              "Simulated edge selection: " +
                provenance +
                " connection. No runtime verification occurred.",
            );
          }}
          onPaneClick={() => {
            setNodes((current) => current.map((node) => ({ ...node, selected: false })));
            setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
            setSelection("No fixture selected.");
          }}
        >
          <Background color="hsl(var(--border))" gap={24} size={1} />
          <Controls
            showInteractive={false}
            className="!rounded-lg !border !border-border !bg-card !shadow-sm"
          />
        </ReactFlow>
      </div>
      <p className="px-5 py-3 text-xs text-muted-foreground" data-testid="review-map-selection">
        {selection}
      </p>
    </>
  );
}

function WorkspaceReview() {
  const [scenario, setScenario] = useState<Scenario>("success");
  const [currentPath, setCurrentPath] = useState(ROUTES[0].path);
  const [routesOpen, setRoutesOpen] = useState(false);
  const [referenceActive, setReferenceActive] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [mapGeneration, setMapGeneration] = useState(0);
  const sequence = useRef(0);
  const [events, setEvents] = useState<Array<{ id: number; message: string }>>([]);
  const fixture = SCENARIOS[scenario];

  const report = useCallback((message: string) => {
    const entry = { id: ++sequence.current, message };
    setEvents((current) => [entry, ...current].slice(0, 8));
  }, []);

  function resetInteractions() {
    setCurrentPath(ROUTES[0].path);
    setRoutesOpen(false);
    setReferenceActive(false);
    setFocusMode(false);
    setRetrying(false);
    setMapGeneration((value) => value + 1);
    setEvents([]);
    report("Simulated interactions reset. The selected illustrative scenario is unchanged.");
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <aside className="fixed inset-y-0 left-0 hidden w-16 flex-col items-center gap-5 border-r border-border bg-card py-6 lg:flex">
        <FlaskConical className="h-5 w-5 text-primary" aria-hidden="true" />
        <nav aria-label="Review sections" className="mt-8 flex flex-col gap-3">
          <a
            href="#preview-controls"
            aria-label="Preview component review"
            className="rounded-lg p-3 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <Monitor className="h-4 w-4" aria-hidden="true" />
          </a>
          <a
            href="#page-map"
            aria-label="Page Map component review"
            className="rounded-lg p-3 text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <ListTree className="h-4 w-4" aria-hidden="true" />
          </a>
        </nav>
      </aside>

      <div className="lg:pl-16">
        <header className="border-b border-border bg-card px-5 py-5 sm:px-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                NabuFlow / DEV lab
              </p>
              <h1 className="text-xl font-semibold tracking-tight">Workspace component review</h1>
            </div>
            <span className="rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-[11px] font-medium text-primary">
              Illustrative data only
            </span>
          </div>
          <p className="mt-3 max-w-3xl text-xs leading-relaxed text-muted-foreground">
            Actual reusable components with simulated callbacks. This is lab component evidence, not
            live acceptance. No project, agent, capture, billing, or provider operation is
            connected.
          </p>
        </header>

        <main
          className={cn("mx-auto max-w-6xl space-y-5 px-4 py-6 sm:px-8", focusMode && "max-w-none")}
        >
          <section
            aria-label="Illustrative scenario controls"
            className="rounded-xl border border-border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <label htmlFor="review-scenario" className="text-xs font-medium">
                Illustrative state
              </label>
              <select
                id="review-scenario"
                value={scenario}
                className="h-9 rounded-lg border border-border bg-background px-3 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                onChange={(event) => {
                  const next = event.target.value as Scenario;
                  setScenario(next);
                  setRetrying(false);
                  setRoutesOpen(false);
                  report(
                    "Illustrative state selected: " +
                      SCENARIOS[next].label +
                      ". These values are fixtures, not observed service status.",
                  );
                }}
              >
                {(Object.keys(SCENARIOS) as Scenario[]).map((key) => (
                  <option key={key} value={key}>
                    {SCENARIOS[key].label}
                  </option>
                ))}
              </select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto gap-2"
                onClick={resetInteractions}
              >
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Reset interactions
              </Button>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
              {fixture.description}
            </p>
          </section>

          <section
            id="preview-controls"
            aria-labelledby="preview-heading"
            className="scroll-mt-4 rounded-xl border border-border bg-card"
          >
            <div className="border-b border-border px-5 py-4">
              <h2 id="preview-heading" className="text-sm font-semibold">
                Preview controls
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                Actual toolbar menus and status summary. Every handler below is simulated.
              </p>
            </div>
            <div
              className="flex flex-wrap items-center gap-3 border-b border-border px-5 py-4"
              data-testid="review-preview-toolbar"
            >
              <PreviewRoutesMenu
                routes={ROUTES}
                currentPath={currentPath}
                open={routesOpen}
                onOpenChange={setRoutesOpen}
                onNavigate={(path) => {
                  setCurrentPath(path);
                  report(
                    "Simulated route handler: " +
                      path +
                      ". Only the local fixture path changed; no browser navigation or request.",
                  );
                }}
                onOpenFile={(id) =>
                  report(
                    "Simulated source-file handler for illustrative file ID " +
                      id +
                      ". No editor or project request.",
                  )
                }
              />
              <PreviewActionsMenu
                referenceActive={referenceActive}
                onAddReference={() => {
                  setReferenceActive(true);
                  report(
                    "Simulated reference selection. The menu state changed; no image was read, uploaded, or rendered.",
                  );
                }}
                observing={scenario === "loading"}
                onObserve={() =>
                  report(
                    "Simulated observation callback. No screenshot, agent call, or capture request.",
                  )
                }
                onSelectRegion={() =>
                  report("Simulated region callback. No page content was selected or captured.")
                }
                onRefreshRuntime={() =>
                  report(
                    "Simulated runtime refresh. Fixture status is unchanged; no provider check was made.",
                  )
                }
                onRestartBrowserPreview={
                  scenario === "failure"
                    ? () =>
                        report(
                          "Simulated browser-preview retry. Existing failure fixtures remain visible; no sandbox was started.",
                        )
                    : undefined
                }
                focusMode={focusMode}
                onToggleFocusMode={() => {
                  setFocusMode((value) => !value);
                  report(
                    "Simulated focus toggle. Only the local review width and checkbox change.",
                  );
                }}
              />
              <div className="min-w-0 sm:ml-auto">
                <PreviewStatusSummary {...fixture.preview} hasRuntime hasFiles />
              </div>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-6 px-5 py-5">
              <div className="min-w-0 space-y-2 text-xs text-muted-foreground">
                <p>
                  Simulated route:{" "}
                  <code className="break-all text-foreground" data-testid="review-current-route">
                    {currentPath}
                  </code>
                </p>
                <p>
                  Reference menu state:{" "}
                  {referenceActive ? "illustrative reference selected" : "none selected"}
                </p>
                <p>No preview app, iframe, or screenshot is rendered in this section.</p>
              </div>
              <div className="space-y-3" data-testid="review-provisioning-fixture">
                <p className="text-[11px] font-medium text-muted-foreground">
                  Actual provisioning component / illustrative state
                </p>
                <ProvisioningProgress
                  key={scenario + ":" + mapGeneration}
                  {...fixture.setup}
                  retrying={retrying}
                  onRetry={() => {
                    setRetrying(true);
                    report(
                      "Simulated setup retry. Only the pending button state changed; no success is inferred. Reset interactions to clear it.",
                    );
                  }}
                  onLogsClick={() =>
                    report(
                      "Simulated environment-logs callback. No logs were fetched; this interaction appears in the local feedback below.",
                    )
                  }
                />
              </div>
            </div>
          </section>

          <section
            id="page-map"
            aria-labelledby="map-heading"
            className="scroll-mt-4 overflow-hidden rounded-xl border border-border bg-card"
          >
            <div className="space-y-2 px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="map-heading" className="text-sm font-semibold">
                  Page Map cards and connections
                </h2>
                <span className="text-[11px] text-muted-foreground">
                  Actual PageNode + PageEdge / ReactFlow provider
                </span>
              </div>
              <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                Illustrative pages and mapped/inferred edges. Drag a card, open its details, or
                select an edge for local feedback. Missing map connections are not runtime failures.
              </p>
              <p className="max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
                Invalid project ID 0 keeps the actual cards in their preview-unavailable fallback.
                No project previews or screenshots are requested. Tab reaches card controls; Enter
                or Space activates them. Canvas controls support zoom and fit.
              </p>
            </div>
            <ReactFlowProvider key={scenario + ":" + mapGeneration}>
              <PageMapFixture scenario={scenario} report={report} />
            </ReactFlowProvider>
          </section>

          <section
            aria-labelledby="feedback-heading"
            className="rounded-xl border border-border bg-card px-5 py-4"
          >
            <h2 id="feedback-heading" className="text-sm font-semibold">
              Local interaction feedback
            </h2>
            <p
              role="status"
              aria-atomic="true"
              className="mt-2 text-xs leading-relaxed text-muted-foreground"
              data-testid="review-interaction-feedback"
            >
              {events[0]?.message ??
                "Choose a fixture state or use a component. All callbacks are simulated and remain in memory."}
            </p>
            {events.length > 1 && (
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer rounded py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  Recent simulated interactions
                </summary>
                <ol className="mt-2 space-y-2 pl-5">
                  {events.slice(1).map((entry) => (
                    <li key={entry.id} className="list-decimal leading-relaxed">
                      {entry.message}
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </section>
          <p className="pb-3 text-[11px] text-muted-foreground">
            Development-only component evidence. Browser review and type validation are performed
            separately by the parent.
          </p>
        </main>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Workspace review root is missing.");
createRoot(root).render(<WorkspaceReview />);
