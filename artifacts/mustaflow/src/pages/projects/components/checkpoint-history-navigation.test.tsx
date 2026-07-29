import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportCard } from "../[id]";
import { ChatHistory } from "./chat-history";
import { CheckpointsTab } from "./checkpoints-tab";
import { PersistedRunReplay } from "./inline-run-group";
import { useCheckpointHistoryNavigation } from "./use-checkpoint-history-navigation";

const restoreCheckpoint = vi.fn();
const taskEventsApi = vi.hoisted(() => ({
  useListTaskEvents: vi.fn(() => ({ data: [] })),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetProjectQueryKey: (projectId: number) => ["project", projectId],
  getListCheckpointsQueryKey: (projectId: number) => ["checkpoints", projectId],
  getListMessagesQueryKey: (projectId: number) => ["messages", projectId],
  getListProjectFilesQueryKey: (projectId: number) => ["files", projectId],
  getListTaskEventsQueryKey: (projectId: number, taskId: number) => [
    "task-events",
    projectId,
    taskId,
  ],
  getListTasksQueryKey: (projectId: number) => ["tasks", projectId],
  getListTestRunsQueryKey: (projectId: number) => ["test-runs", projectId],
  getListVersionsQueryKey: (projectId: number) => ["versions", projectId],
  useListCheckpoints: () => ({
    data: [
      {
        id: 68,
        projectId: 44,
        label: "Build completed",
        note: "Added the requested subtitle.",
        changelogEntry: "Updated the home page subtitle.",
        createdAt: "2026-07-29T12:42:00.000Z",
        filesCount: 12,
        hasDbSnapshot: false,
        dbProvider: null,
        dbSnapshotSizeBytes: null,
        triggerMessageId: 901,
        triggerMessagePreview: "Change the subtitle.",
      },
    ],
    isLoading: false,
  }),
  useRestoreCheckpoint: () => ({
    mutate: restoreCheckpoint,
    isPending: false,
  }),
  useCancelTask: () => ({ mutate: vi.fn(), isPending: false }),
  useListProjectFiles: () => ({ data: [] }),
  useListTaskEvents: taskEventsApi.useListTaskEvents,
  useListTasks: () => ({ data: [] }),
  useListTestRuns: () => ({ data: [] }),
  useRerunTaskTests: () => ({ mutate: vi.fn(), isPending: false }),
}));

function NavigationHarness({ reportRevision = 0 }: { reportRevision?: number }) {
  const [queryClient] = useState(() => new QueryClient());
  const [activeTab, setActiveTab] = useState<"preview" | "checkpoints">("preview");
  const [checkpointFocusId, setCheckpointFocusId] = useState<number | null>(null);
  const [moreTabsExpanded, setMoreTabsExpanded] = useState(false);
  const [advancedDataEnabled, setAdvancedDataEnabled] = useState(false);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(true);
  const { openCheckpointHistory, completeCheckpointHistoryNavigation } =
    useCheckpointHistoryNavigation({
      activeTab,
      setActiveTab,
      setAdvancedDataEnabled,
      setCheckpointFocusId,
      setMoreTabsExpanded,
      setChatDrawerOpen,
      isMobileLayout: true,
    });

  return (
    <QueryClientProvider client={queryClient}>
      <div data-testid="active-workspace-tab">{activeTab}</div>
      <div data-testid="advanced-tabs-enabled">
        {String(moreTabsExpanded && advancedDataEnabled)}
      </div>
      <div data-testid="chat-drawer-open">{String(chatDrawerOpen)}</div>
      <PersistedRunReplay projectId={44} taskId={144} />
      <ReportCard
        key={reportRevision}
        report={{
          userRequest: "Change the subtitle.",
          filesCreated: ["src/App.tsx"],
          filesChanged: [],
          filesRemoved: [],
          filesUnchanged: [],
          previewUpdated: true,
          warnings: [],
          versionId: 68,
        }}
        onOpenCheckpoint={openCheckpointHistory}
      />
      {activeTab === "checkpoints" && moreTabsExpanded && (
        <CheckpointsTab
          projectId={44}
          focusCheckpointId={checkpointFocusId}
          onFocusedCheckpoint={completeCheckpointHistoryNavigation}
        />
      )}
    </QueryClientProvider>
  );
}

function FullHistoryNavigationHarness() {
  const [queryClient] = useState(() => new QueryClient());
  const [activeTab, setActiveTab] = useState<"preview" | "checkpoints">("preview");
  const [checkpointFocusId, setCheckpointFocusId] = useState<number | null>(null);
  const [moreTabsExpanded, setMoreTabsExpanded] = useState(false);
  const [, setAdvancedDataEnabled] = useState(false);
  const [, setChatDrawerOpen] = useState(true);
  const { openCheckpointHistory, completeCheckpointHistoryNavigation } =
    useCheckpointHistoryNavigation({
      activeTab,
      setActiveTab,
      setAdvancedDataEnabled,
      setCheckpointFocusId,
      setMoreTabsExpanded,
      setChatDrawerOpen,
      isMobileLayout: false,
    });

  return (
    <QueryClientProvider client={queryClient}>
      <div data-testid="active-workspace-tab">{activeTab}</div>
      <ChatHistory
        messages={[
          {
            id: 902,
            role: "assistant",
            content: "Updated the subtitle.",
            agentMode: "power",
            planMode: false,
            createdAt: "2026-07-29T12:42:00.000Z",
            plan: {
              kind: "report",
              taskId: 144,
              report: {
                userRequest: "Change the subtitle.",
                filesCreated: ["src/App.tsx"],
                filesChanged: [],
                filesRemoved: [],
                filesUnchanged: [],
                previewUpdated: true,
                warnings: [],
                versionId: 68,
              },
            },
          },
        ]}
        isLoading={false}
        projectId={44}
        onOpenCheckpoint={openCheckpointHistory}
        onClose={vi.fn()}
      />
      {activeTab === "checkpoints" && moreTabsExpanded && (
        <CheckpointsTab
          projectId={44}
          focusCheckpointId={checkpointFocusId}
          onFocusedCheckpoint={completeCheckpointHistoryNavigation}
        />
      )}
    </QueryClientProvider>
  );
}

describe("inline checkpoint history navigation", () => {
  beforeEach(() => {
    restoreCheckpoint.mockClear();
    taskEventsApi.useListTaskEvents.mockClear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("opens the real Version History surface and focuses the clicked checkpoint", async () => {
    const user = userEvent.setup();
    render(<NavigationHarness />);

    await user.click(screen.getByTestId("inline-build-checkpoint"));

    expect(screen.getByTestId("active-workspace-tab")).toHaveTextContent("checkpoints");
    expect(screen.getByTestId("advanced-tabs-enabled")).toHaveTextContent("true");
    expect(screen.getByTestId("chat-drawer-open")).toHaveTextContent("false");
    expect(screen.getByRole("heading", { name: "Go back without losing work" })).toBeVisible();

    const focusedCheckpoint = document.querySelector<HTMLElement>('[data-checkpoint-id="68"]');
    expect(focusedCheckpoint).toHaveAttribute("data-focused", "true");
    expect(focusedCheckpoint).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(document.activeElement).toBe(focusedCheckpoint));
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });
  });

  it("does not lose the live checkpoint action when the completed report is replaced by a refetch", async () => {
    const { rerender } = render(<NavigationHarness reportRevision={0} />);
    const initialAction = screen.getByTestId("inline-build-checkpoint");

    fireEvent.pointerDown(initialAction, { button: 0 });
    rerender(<NavigationHarness reportRevision={1} />);
    fireEvent.pointerUp(screen.getByTestId("inline-build-checkpoint"), { button: 0 });

    expect(taskEventsApi.useListTaskEvents).toHaveBeenCalledWith(
      44,
      144,
      expect.objectContaining({
        query: expect.objectContaining({ refetchOnMount: "always" }),
      }),
    );
    expect(screen.getByTestId("active-workspace-tab")).toHaveTextContent("checkpoints");
    expect(screen.getByRole("heading", { name: "Go back without losing work" })).toBeVisible();
  });

  it("keeps the focused checkpoint restore action wired to the existing restore mutation", async () => {
    const user = userEvent.setup();
    render(<NavigationHarness />);

    await user.click(screen.getByTestId("inline-build-checkpoint"));
    const focusedCheckpoint = document.querySelector<HTMLElement>('[data-checkpoint-id="68"]');
    expect(focusedCheckpoint).not.toBeNull();

    await user.click(within(focusedCheckpoint!).getByRole("button", { name: "Restore" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText("Restore this version?")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Restore" }));

    expect(restoreCheckpoint).toHaveBeenCalledWith({ id: 44, checkpointId: 68 });
  });

  it("uses the same restore action from Full History and opens the focused checkpoint", async () => {
    const user = userEvent.setup();
    render(<FullHistoryNavigationHarness />);

    await user.click(screen.getByRole("button", { name: "Build details" }));
    expect(screen.queryByText("Checkpoint saved — roll back any time")).not.toBeInTheDocument();

    const action = screen.getByTestId("inline-build-checkpoint");
    expect(action).toHaveAccessibleName("Checkpoint saved — restore any time #68");
    await user.click(action);

    expect(screen.getByTestId("active-workspace-tab")).toHaveTextContent("checkpoints");
    const focusedCheckpoint = document.querySelector<HTMLElement>('[data-checkpoint-id="68"]');
    expect(focusedCheckpoint).toHaveAttribute("aria-current", "true");
    await waitFor(() => expect(document.activeElement).toBe(focusedCheckpoint));
  });
});
