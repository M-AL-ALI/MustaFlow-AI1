import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Node } from "@xyflow/react";
import type { PageMapData } from "@workspace/api-client-react";
import { createPageMapSaveCoordinator, PageMapTab } from "./page-map-tab";

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
  exportCanvas: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetPageMap: () => mocks.query,
  usePutPageMap: () => mocks.save,
  useAnalyzePageMap: () => mocks.analyze,
  getGetPageMapQueryKey: (id: number) => ["page-map", id],
}));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => mocks.queryClient }));
vi.mock("html2canvas", () => ({ default: mocks.exportCanvas }));
vi.mock("./page-detail-panel", async () => {
  const { PageMapPreviewAction } = await import("./page-map-preview-action");
  return {
    PageDetailPanel: ({
      node,
      isOrphan,
      isDeadEnd,
      projectId,
      onOpenPreview,
    }: {
      node: {
        id: string;
        label: string;
        filePath: string;
        notes: string;
        planned?: boolean;
      } | null;
      isOrphan: boolean;
      isDeadEnd: boolean;
      projectId: number;
      onOpenPreview: (route: string) => void;
    }) =>
      node ? (
        <div data-testid="page-details" data-runtime-failure={isOrphan || isDeadEnd}>
          {node.label}
          <PageMapPreviewAction projectId={projectId} node={node} onOpenPreview={onOpenPreview} />
        </div>
      ) : null,
  };
});
vi.mock("./edge-detail-panel", () => ({ EdgeDetailPanel: () => null }));
vi.mock("./blocks-panel", () => ({ BlocksPanel: () => null }));
vi.mock("@xyflow/react", async () => {
  const { useState } = await import("react");
  return {
    useNodesState: (initial: Node[]) => [...useState(initial), vi.fn()],
    useEdgesState: (initial: unknown[]) => [...useState(initial), vi.fn()],
    addEdge: vi.fn(),
    MarkerType: { ArrowClosed: "arrowclosed" },
    Position: { Left: "left", Right: "right" },
    Handle: () => null,
    Controls: () => null,
    Background: () => null,
    MiniMap: () => null,
    ReactFlow: ({ nodes }: { nodes: Node[] }) => (
      <div aria-label="Connections canvas">
        {nodes.map((node) => (
          <button
            key={node.id}
            data-testid={`flow-${node.id}`}
            data-dimmed={String(node.data.dimmed)}
            onClick={() => (node.data.onNodeClick as (id: string) => void)(node.id)}
          >
            {node.data.label as string}
          </button>
        ))}
      </div>
    ),
  };
});

const page = (id = "account", planned = false) => ({
  id,
  label: planned ? "Planned page" : "Account",
  pageType: "settings",
  filePath: planned ? "" : "src/pages/Account.tsx",
  notes: planned ? "" : "Route: /account/profile",
  isNew: false,
  hasError: false,
  aiGenerated: true,
  planned,
  position: { x: 100, y: 100 },
});

function renderMap(sync?: { isSyncingAfterEdit: boolean; onSyncCleared: () => void }) {
  const callbacks = {
    onSwitchToPreview: vi.fn(),
    onSwitchToCode: vi.fn(),
    onSwitchToChat: vi.fn(),
  };
  const result = render(<PageMapTab projectId={901} isBuilding={false} {...callbacks} {...sync} />);
  return {
    ...callbacks,
    rerender: () =>
      result.rerender(<PageMapTab projectId={901} isBuilding={false} {...callbacks} {...sync} />),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.data = {
    revision: "a".repeat(64),
    pageMapData: {
      ios: { nodes: [], edges: [] },
      android: { nodes: [], edges: [] },
      web: { nodes: [page()], edges: [] },
    },
  };
  mocks.query.refetch.mockImplementation(async () => ({
    data: mocks.query.data,
    isError: mocks.query.isError,
  }));
  mocks.query.isLoading = false;
  mocks.query.isFetching = false;
  mocks.query.isError = false;
  mocks.save.isError = false;
  mocks.save.isPending = false;
  mocks.save.error = undefined;
  mocks.analyze.isError = false;
  mocks.analyze.error = undefined;
  mocks.analyze.isPending = false;
  mocks.exportCanvas.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Page Map truthful states and toolbar", () => {
  it("opens a dynamic gallery page through details using an explicit example without a map write", () => {
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: { nodes: [{ ...page(), notes: "Route: /notes/:id" }], edges: [] },
      },
    };
    const callbacks = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "View details for Account" }));
    expect(screen.getByRole("button", { name: "Open in Preview" })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Example id" }), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(callbacks.onSwitchToPreview).toHaveBeenCalledExactlyOnceWith("/notes/42");
    expect(callbacks.onSwitchToChat).not.toHaveBeenCalled();
    expect(mocks.save.mutate).not.toHaveBeenCalled();
    expect(mocks.analyze.mutate).not.toHaveBeenCalled();
    expect(document.querySelector("iframe")).toBeNull();
  });
  it("renders a bounded set of opaque, lazy live frames in Contents", () => {
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: {
          nodes: Array.from({ length: 7 }, (_, index) => ({
            ...page(`page-${index}`),
            label: `Page ${index}`,
            notes: `Route: /page-${index}`,
          })),
          edges: [],
        },
      },
    };
    renderMap();
    const frames = document.querySelectorAll("iframe");
    expect(frames).toHaveLength(4);
    for (const frame of frames) {
      expect(frame).toHaveAttribute("loading", "lazy");
      expect(frame).toHaveAttribute("sandbox", "allow-scripts");
      expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    }
    expect(screen.getAllByText("Live iframe")).toHaveLength(4);
    expect(screen.getByText(/not recorded thumbnails/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Page 6 at /page-6 in Preview" })).toBeEnabled();
  });

  it("prepares an explicit target and opens the exact source file from Contents", () => {
    const callbacks = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Open file: Account" }));
    expect(callbacks.onSwitchToCode).toHaveBeenCalledWith("src/pages/Account.tsx");
    fireEvent.click(screen.getByRole("button", { name: "Prepare redesign: Account" }));
    const draft = callbacks.onSwitchToChat.mock.calls[0][0] as string;
    expect(draft).toContain('"projectId": 901');
    expect(draft).toContain('"nodeId": "account"');
    expect(draft).toContain('"filePath": "src/pages/Account.tsx"');
    expect(draft).toContain('"route": "/account/profile"');
    expect(draft).toContain("Requested changes (describe before sending):");
    expect(mocks.save.mutate).not.toHaveBeenCalled();
    expect(mocks.analyze.mutate).not.toHaveBeenCalled();
  });

  it("updates an already-mounted clean map after the project query changes", () => {
    const result = renderMap();
    mocks.query.data = snapshot(REV_B, "Updated by agent");
    result.rerender();
    expect(
      screen.getByRole("button", { name: "Open Updated by agent at /account/profile in Preview" }),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.save.mutate).not.toHaveBeenCalled();
  });

  it("reconsiders a query snapshot that arrived while a save was in flight", () => {
    const result = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    mocks.query.data = snapshot(REV_C, "New server page");
    result.rerender();
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    act(() => mocks.save.mutate.mock.calls[0][1].onSuccess(snapshot(REV_B, "Saved page")));
    expect(screen.getByTestId("flow-account")).toHaveTextContent("New server page");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.save.mutate).toHaveBeenCalledTimes(1);
  });

  it("shows mapped status and preserves the route from notes", () => {
    const callbacks = renderMap();
    expect(screen.getByText("Mapped")).toBeVisible();
    expect(screen.queryByText("Page built")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open Account at /account/profile in Preview" }),
    );
    expect(callbacks.onSwitchToPreview).toHaveBeenCalledWith("/account/profile");
    expect(mocks.save.mutate).not.toHaveBeenCalled();
  });

  it("reviews missing map edges without assuming broken runtime navigation", () => {
    const callbacks = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getByRole("button", { name: "Connections" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText(/Runtime navigation is not verified by this map/)).toBeVisible();
    expect(
      screen.getByText(/Missing mapped edges do not establish a runtime failure/),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review connections with AI" }));
    const prompt = callbacks.onSwitchToChat.mock.calls[0][0] as string;
    expect(prompt).toContain("no incoming connection mapped");
    expect(prompt).toContain("Check existing routes");
    expect(prompt).toContain("report what could not be verified");
    expect(prompt).not.toMatch(/NO incoming links|fully connected|fix the navigation/i);
    fireEvent.click(screen.getByTestId("flow-account"));
    expect(screen.getByTestId("page-details")).toHaveAttribute("data-runtime-failure", "false");
  });

  it("opens the shared actions menu from the keyboard and refreshes the map", async () => {
    const user = userEvent.setup();
    renderMap();
    screen.getByRole("button", { name: "Map actions" }).focus();
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("menuitem", { name: "Refresh map" }));
    expect(mocks.analyze.mutate).toHaveBeenCalledWith(
      { id: 901, params: { platform: "web" } },
      expect.any(Object),
    );
  });

  it("keeps planned pages out of the missing-map-connections filter", async () => {
    const user = userEvent.setup();
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: { nodes: [page(), page("planned", true)], edges: [] },
      },
    };
    renderMap();
    await user.click(screen.getByRole("button", { name: "Connections" }));
    expect(screen.getByText(/1 page has missing mapped connections/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Map actions" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Missing mapped connections" }));
    expect(screen.getByTestId("flow-account")).toHaveAttribute("data-dimmed", "false");
    expect(screen.getByTestId("flow-planned")).toHaveAttribute("data-dimmed", "true");
  });

  it("distinguishes a failed initial load from an empty map and offers retry", () => {
    mocks.query.data = undefined;
    mocks.query.isError = true;
    renderMap();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load the page map.");
    expect(screen.queryByText("No pages mapped yet")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.query.refetch).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Add page" })).toBeDisabled();
  });

  it("retains cached pages with a stale-map explanation after a refresh fails", () => {
    mocks.query.isError = true;
    renderMap();
    expect(screen.getByRole("alert")).toHaveTextContent("Showing the last loaded pages.");
    expect(screen.getByTestId("page-map-card-account")).toBeVisible();
  });

  it("opens a newly planned page's details from the empty contents view", () => {
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: { nodes: [], edges: [] },
      },
    };
    renderMap();
    expect(screen.getByText("No pages mapped yet")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Add a page" }));
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    expect(mocks.save.mutate).toHaveBeenCalledTimes(1);
  });

  it("falls back to details when a mapped node has no file", () => {
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: { nodes: [{ ...page(), filePath: "", notes: "" }], edges: [] },
      },
    };
    const callbacks = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "View details for Account" }));
    expect(callbacks.onSwitchToPreview).not.toHaveBeenCalled();
    expect(screen.getByTestId("page-details")).toBeVisible();
  });

  it("surfaces analysis and save failures without inventing success", () => {
    mocks.analyze.isError = true;
    mocks.save.isError = true;
    renderMap();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't refresh the page map.");
    expect(screen.getByRole("alert")).toHaveTextContent("Local edits may not be saved.");
  });

  it("reports an export failure", async () => {
    const user = userEvent.setup();
    mocks.exportCanvas.mockRejectedValue(new Error("Canvas unavailable"));
    renderMap();
    await user.click(screen.getByRole("button", { name: "Map actions" }));
    await user.click(screen.getByRole("menuitem", { name: "Export map PNG" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't export the map.");
  });

  it("shows unavailable platforms without retaining a web detail panel", async () => {
    const user = userEvent.setup();
    renderMap();
    await user.click(screen.getByRole("button", { name: "Connections" }));
    await user.click(screen.getByTestId("flow-account"));
    await user.click(screen.getByRole("button", { name: "Platform: Web" }));
    await user.click(screen.getByRole("menuitemradio", { name: "iOS (unavailable)" }));
    expect(screen.getByText("iOS mapping is unavailable")).toBeVisible();
    expect(screen.queryByTestId("page-details")).toBeNull();
  });

  it("preserves unsaved local pages when a 409 is followed by a server snapshot", () => {
    const result = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    mocks.save.isError = true;
    mocks.save.error = { status: 409 };
    mocks.query.data = {
      revision: "a".repeat(64),
      pageMapData: {
        ios: { nodes: [], edges: [] },
        android: { nodes: [], edges: [] },
        web: { nodes: [page()], edges: [] },
      },
    };
    result.rerender();
    expect(screen.getByRole("alert")).toHaveTextContent("The map changed during this operation.");
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh the map before retrying");
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    expect(mocks.save.mutate).toHaveBeenCalledTimes(1);
  });

  it("recognizes response-status conflicts from analysis", () => {
    mocks.analyze.isError = true;
    mocks.analyze.error = { response: { status: 409 } };
    renderMap();
    expect(screen.getByRole("alert")).toHaveTextContent("Local edits are kept here.");
    expect(screen.getByTestId("page-map-card-account")).toBeVisible();
  });

  it("does not announce sync completion after a failed read or analysis conflict", () => {
    const onSyncCleared = vi.fn();
    mocks.query.isFetching = true;
    const result = renderMap({ isSyncingAfterEdit: true, onSyncCleared });
    mocks.query.isFetching = false;
    mocks.query.isError = true;
    result.rerender();
    expect(onSyncCleared).not.toHaveBeenCalled();
    mocks.query.isError = false;
    mocks.analyze.isError = true;
    mocks.analyze.error = { status: 409 };
    result.rerender();
    expect(onSyncCleared).not.toHaveBeenCalled();
  });
  it("blocks saves for legacy responses without a revision while retaining their pages", () => {
    mocks.query.data = { pageMapData: mapData() };
    renderMap();
    expect(screen.getByTestId("page-map-card-account")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("no valid map revision");
    expect(screen.getByRole("button", { name: "Add page" })).toBeDisabled();
    expect(mocks.save.mutate).not.toHaveBeenCalled();
  });

  it("pairs Add page with the loaded revision and requires a choice before discarding a conflict", async () => {
    renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    expect(mocks.save.mutate.mock.calls[0][0].data.expectedRevision).toBe(REV_A);
    act(() => mocks.save.mutate.mock.calls[0][1].onError({ status: 409 }));
    mocks.query.refetch.mockResolvedValue({ data: snapshot(REV_B, "Server page"), isError: false });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load latest map" }));
    });
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    fireEvent.click(screen.getByRole("button", { name: "Keep local edits" }));
    expect(screen.getByTestId("page-details")).toHaveTextContent("New Page");
    expect(
      screen.queryByRole("button", { name: "Replace local edits with refreshed map" }),
    ).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load latest map" }));
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace local edits with refreshed map" }));
    expect(screen.queryByTestId("page-details")).toBeNull();
    expect(screen.getByTestId("flow-account")).toHaveTextContent("Server page");
    fireEvent.click(screen.getByRole("button", { name: "Add page" }));
    expect(mocks.save.mutate.mock.calls[1][0].data.expectedRevision).toBe(REV_B);
  });

  it("does not clear sync for a legacy response without a revision", () => {
    const onSyncCleared = vi.fn();
    mocks.query.isFetching = true;
    const result = renderMap({ isSyncingAfterEdit: true, onSyncCleared });
    mocks.query.isFetching = false;
    mocks.query.data = { pageMapData: mapData() };
    result.rerender();
    expect(onSyncCleared).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Saving is paused");
  });
});

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const REV_C = "c".repeat(64);

function mapData(label = "Account"): PageMapData {
  return {
    web: { nodes: [{ ...page(), pageType: "settings", label }], edges: [] },
    ios: { nodes: [], edges: [] },
    android: { nodes: [], edges: [] },
  };
}

function snapshot(revision = REV_A, label = "Account") {
  return { revision, pageMapData: mapData(label) };
}

function persistenceHarness(projectId = 901) {
  type Dependencies = Parameters<typeof createPageMapSaveCoordinator>[0];
  const save = vi.fn<Dependencies["save"]>();
  const analyze = vi.fn<Dependencies["analyze"]>();
  const refetch = vi.fn<Dependencies["refetch"]>().mockResolvedValue({
    data: snapshot(REV_B, "Server page"),
    isError: false,
  });
  const changed = vi.fn<Dependencies["changed"]>();
  const coordinator = createPageMapSaveCoordinator({ projectId, save, analyze, refetch, changed });
  return { coordinator, save, analyze, refetch, changed };
}

describe("Page Map revision save coordinator", () => {
  beforeEach(() => vi.useFakeTimers());

  it.each([undefined, null, 42, "invalid", "A".repeat(64), "a".repeat(63)])(
    "does not write with missing or malformed revision %s",
    (revision) => {
      const { coordinator, save, analyze } = persistenceHarness();
      coordinator.receive({ pageMapData: mapData(), revision });
      coordinator.edit("web", mapData("Local draft").web, true);
      coordinator.analyze("web");
      vi.advanceTimersByTime(1000);
      expect(save).not.toHaveBeenCalled();
      expect(analyze).not.toHaveBeenCalled();
      expect(coordinator.getState()).toMatchObject({
        revision: null,
        dirty: true,
        problem: "missing-revision",
      });
      expect(coordinator.getState().map?.web.nodes[0].label).toBe("Local draft");
    },
  );

  it("protects unsaved detail-panel fields from automatic server replacement", async () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.stageDetails();
    coordinator.receive(snapshot(REV_B, "Other editor"));
    vi.advanceTimersByTime(1000);
    expect(coordinator.getState()).toMatchObject({
      revision: REV_A,
      dirty: true,
      problem: "conflict",
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Account");
    expect(save).not.toHaveBeenCalled();
    await coordinator.refresh();
    expect(coordinator.getState().refreshCandidate?.revision).toBe(REV_B);
    expect(coordinator.hasDetailsDraft()).toBe(true);
    coordinator.replaceWithRefreshed();
    expect(coordinator.hasDetailsDraft()).toBe(false);
    expect(coordinator.getState()).toMatchObject({ revision: REV_B, dirty: false, problem: null });
  });

  it("clones each payload/revision pair and serializes newer edits against the successful revision", () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    const first = mapData("First draft").web;
    coordinator.edit("web", first, true);
    first.nodes[0].label = "Mutated outside the coordinator";
    coordinator.receive(snapshot(REV_C, "Unordered poll"));
    coordinator.edit("web", mapData("Second draft").web);
    vi.advanceTimersByTime(800);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][0]).toMatchObject({
      id: 901,
      data: { expectedRevision: REV_A, web: { nodes: [{ label: "First draft" }] } },
    });
    save.mock.calls[0][1].success(snapshot(REV_B, "First draft"));
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Second draft");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].data.expectedRevision).toBe(REV_B);
    expect(save.mock.calls[1][0].data.web.nodes[0].label).toBe("Second draft");
    expect(save.mock.calls[1][0].data.ios).toEqual({ nodes: [], edges: [] });
    save.mock.calls[1][1].success(snapshot(REV_C, "Second draft"));
    expect(coordinator.getState()).toMatchObject({ revision: REV_C, dirty: false, busy: null });
  });

  it("ignores superseded polls and never silently rebases onto an unfamiliar revision", () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.edit("web", mapData("Saved draft").web, true);
    save.mock.calls[0][1].success(snapshot(REV_B, "Saved draft"));
    coordinator.receive(snapshot(REV_A, "Stale page"));
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Saved draft");
    coordinator.edit("web", mapData("Unsaved draft").web);
    coordinator.receive(snapshot(REV_C, "Other editor"));
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({
      revision: REV_B,
      dirty: true,
      problem: "conflict",
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Unsaved draft");
  });

  it("automatically adopts a clean server update and ignores its superseded snapshot", () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.receive(snapshot(REV_B, "New page from agent"));
    expect(coordinator.getState()).toMatchObject({
      revision: REV_B,
      dirty: false,
      problem: null,
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("New page from agent");
    coordinator.receive(snapshot(REV_A, "Old cached page"));
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("New page from agent");
    coordinator.edit("web", mapData("Local edit").web, true);
    expect(save.mock.calls[0][0].data.expectedRevision).toBe(REV_B);
  });

  it.each([{ status: 409 }, { response: { status: 409 } }])(
    "halts queued saves on conflict and retains edits until refreshed replacement is chosen",
    async (error) => {
      const { coordinator, save } = persistenceHarness();
      coordinator.receive(snapshot());
      coordinator.edit("web", mapData("First draft").web, true);
      coordinator.edit("web", mapData("Retained draft").web);
      save.mock.calls[0][1].failure(error);
      coordinator.receive(snapshot(REV_B, "Poll"));
      vi.advanceTimersByTime(1000);
      expect(save).toHaveBeenCalledTimes(1);
      await coordinator.refresh();
      expect(coordinator.getState()).toMatchObject({
        revision: REV_A,
        dirty: true,
        problem: "conflict",
      });
      expect(coordinator.getState().map?.web.nodes[0].label).toBe("Retained draft");
      expect(coordinator.getState().refreshCandidate?.revision).toBe(REV_B);
      coordinator.keepLocal();
      expect(coordinator.getState().refreshCandidate).toBeNull();
      expect(coordinator.getState().map?.web.nodes[0].label).toBe("Retained draft");
      await coordinator.refresh();
      coordinator.replaceWithRefreshed();
      expect(coordinator.getState()).toMatchObject({
        revision: REV_B,
        dirty: false,
        problem: null,
      });
      expect(coordinator.getState().map?.web.nodes[0].label).toBe("Server page");
      coordinator.edit("web", mapData("Reviewed change").web, true);
      expect(save.mock.calls[1][0].data.expectedRevision).toBe(REV_B);
    },
  );

  it("preserves edits made during a fresh read and invalidates a replacement choice after another edit", async () => {
    const { coordinator, refetch, save } = persistenceHarness();
    coordinator.receive(snapshot());
    let resolve!: (result: { data: ReturnType<typeof snapshot> }) => void;
    refetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const refreshing = coordinator.refresh();
    coordinator.edit("web", mapData("Typed during refresh").web);
    resolve({ data: snapshot(REV_B, "Server page") });
    await refreshing;
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Typed during refresh");
    expect(coordinator.getState().refreshCandidate?.revision).toBe(REV_B);
    coordinator.edit("web", mapData("Typed after refresh").web);
    coordinator.replaceWithRefreshed();
    expect(coordinator.getState().refreshCandidate).toBeNull();
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Typed after refresh");
    vi.advanceTimersByTime(1000);
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps drafts and stops the queue when a save acknowledgement lacks a valid revision", () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.edit("web", mapData("Sent draft").web, true);
    coordinator.edit("web", mapData("Newer draft").web);
    save.mock.calls[0][1].success({ pageMapData: mapData("Sent draft") });
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({
      revision: REV_A,
      dirty: true,
      problem: "missing-revision",
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Newer draft");
  });

  it("analyzes without a client revision and uses the acknowledged result for the next save", () => {
    const { coordinator, analyze, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.analyze("web");
    expect(analyze.mock.calls[0][0]).toEqual({ id: 901, params: { platform: "web" } });
    analyze.mock.calls[0][1].success(snapshot(REV_B, "Analyzed page"));
    expect(coordinator.getState()).toMatchObject({ revision: REV_B, dirty: false, problem: null });
    coordinator.edit("web", mapData("Later edit").web, true);
    expect(save.mock.calls[0][0].data.expectedRevision).toBe(REV_B);
  });

  it("does not overwrite or automatically save edits made while analysis is pending", () => {
    const { coordinator, analyze, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.analyze("web");
    coordinator.edit("web", mapData("Typed during analysis").web);
    analyze.mock.calls[0][1].success(snapshot(REV_B, "Analyzed page"));
    vi.advanceTimersByTime(1000);
    expect(coordinator.getState()).toMatchObject({
      revision: REV_B,
      dirty: true,
      problem: "conflict",
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Typed during analysis");
    expect(save).not.toHaveBeenCalled();
  });

  it("keeps analysis conflicts explicit and permits retrying a non-conflict analysis failure", () => {
    const { coordinator, analyze } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.analyze("web");
    analyze.mock.calls[0][1].failure({ status: 500 });
    coordinator.analyze("web");
    expect(analyze).toHaveBeenCalledTimes(2);
    analyze.mock.calls[1][1].failure({ status: 409 });
    coordinator.analyze("web");
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({
      revision: REV_A,
      dirty: false,
      problem: "conflict",
    });
  });

  it("retries ordinary save failures only on request, with the last acknowledged revision", () => {
    const { coordinator, save } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.edit("web", mapData("Draft").web, true);
    save.mock.calls[0][1].failure({ status: 400 });
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(coordinator.getState().problem).toBe("save-error");
    coordinator.retrySave();
    expect(save.mock.calls[1][0].data.expectedRevision).toBe(REV_A);
    expect(save.mock.calls[1][0].data.web.nodes[0].label).toBe("Draft");
  });

  it("does not discard edits or accept cached data from a failed fresh read", async () => {
    const { coordinator, refetch } = persistenceHarness();
    coordinator.receive(snapshot());
    coordinator.edit("web", mapData("Draft").web);
    refetch.mockResolvedValue({ data: snapshot(REV_B), isError: true });
    await coordinator.refresh();
    expect(coordinator.getState()).toMatchObject({
      revision: REV_A,
      dirty: true,
      problem: "refresh-error",
      refreshCandidate: null,
    });
    expect(coordinator.getState().map?.web.nodes[0].label).toBe("Draft");
  });

  it("isolates project sessions and ignores late acknowledgements after deactivation", () => {
    const first = persistenceHarness(901);
    first.coordinator.receive(snapshot());
    first.coordinator.edit("web", mapData("First project").web, true);
    first.coordinator.edit("web", mapData("Queued edit").web);
    first.coordinator.deactivate();
    first.changed.mockClear();
    first.save.mock.calls[0][1].success(snapshot(REV_B));
    vi.advanceTimersByTime(1000);
    expect(first.save).toHaveBeenCalledTimes(1);
    expect(first.changed).not.toHaveBeenCalled();
    const second = persistenceHarness(902);
    second.coordinator.receive(snapshot(REV_C));
    second.coordinator.edit("web", mapData("Second project").web, true);
    expect(second.save.mock.calls[0][0]).toMatchObject({
      id: 902,
      data: { expectedRevision: REV_C },
    });
  });
});
