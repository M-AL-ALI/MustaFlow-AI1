import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CheckpointsTab } from "./checkpoints-tab";
import { InlineBuildResults } from "./inline-build-results";
import { useCheckpointHistoryNavigation } from "./use-checkpoint-history-navigation";

const restoreCheckpoint = vi.fn();

vi.mock("@workspace/api-client-react", () => ({
  getGetProjectQueryKey: (projectId: number) => ["project", projectId],
  getListCheckpointsQueryKey: (projectId: number) => ["checkpoints", projectId],
  getListMessagesQueryKey: (projectId: number) => ["messages", projectId],
  getListProjectFilesQueryKey: (projectId: number) => ["files", projectId],
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
}));

function NavigationHarness() {
  const [queryClient] = useState(() => new QueryClient());
  const [activeTab, setActiveTab] = useState<"preview" | "checkpoints">("preview");
  const [checkpointFocusId, setCheckpointFocusId] = useState<number | null>(null);
  const [moreTabsExpanded, setMoreTabsExpanded] = useState(false);
  const [advancedDataEnabled, setAdvancedDataEnabled] = useState(false);
  const [chatDrawerOpen, setChatDrawerOpen] = useState(true);
  const openCheckpointHistory = useCheckpointHistoryNavigation({
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
      <InlineBuildResults
        report={{
          filesCreated: ["src/App.tsx"],
          filesChanged: [],
          filesRemoved: [],
          filesUnchanged: [],
          versionId: 68,
        }}
        onViewHistory={() => openCheckpointHistory(68)}
      />
      {activeTab === "checkpoints" && moreTabsExpanded && (
        <CheckpointsTab projectId={44} focusCheckpointId={checkpointFocusId} />
      )}
    </QueryClientProvider>
  );
}

describe("inline checkpoint history navigation", () => {
  beforeEach(() => {
    restoreCheckpoint.mockClear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false }),
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
});
