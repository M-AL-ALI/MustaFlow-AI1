// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { KnowledgeEntry } from "@workspace/api-client-react";
import { HistoryTab, type HistoryRetryTask } from "./history-tab";

const mocks = vi.hoisted(() => ({
  entries: [] as KnowledgeEntry[],
  authFetch: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/api-fetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@workspace/api-client-react", () => ({
  useListKnowledge: () => ({ data: mocks.entries, isLoading: false, isFetching: false }),
  getListKnowledgeQueryKey: (params: unknown) => ["knowledge", params],
  useUpdateKnowledge: () => ({ mutate: mocks.mutate, isPending: false }),
}));
vi.mock("./agent-trace-panel", () => ({ AgentTracePanel: () => null }));

const taskId = 7731;
const projectId = 61;
const fullRequest =
  "Build a project dashboard with owner-scoped recovery, structured failure details, " +
  "mandatory source-contract checks, and a safe unknown-state display. Keep these final instructions.";
const shortTitle = `Build failed: "${fullRequest.slice(0, 60)}"`;
let queryClient: QueryClient;

function mountHistory(tasks: HistoryRetryTask[], onRetry = vi.fn()) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <HistoryTab projectId={projectId} tasks={tasks} onRetry={onRetry} />
    </QueryClientProvider>,
  );
  return onRetry;
}

async function expandEntry() {
  const expand = await screen.findByRole("button", { name: `Expand history entry: ${shortTitle}` });
  fireEvent.click(expand);
  expect(expand.getAttribute("aria-expanded")).toBe("true");
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.authFetch.mockResolvedValue({ ok: true, json: async () => ({ isAdmin: false }) });
  mocks.entries = [
    {
      id: 7701,
      projectId,
      title: shortTitle,
      content: "Source contract validation failed. The previous live version remains active.",
      type: "build",
      severity: "error",
      relatedTaskId: taskId,
      createdAt: new Date().toISOString(),
      archivedAt: null,
      category: "build",
      scope: "project",
      approvedForReuse: false,
      isPublic: false,
      thumbsUp: 0,
      thumbsDown: 0,
      usageCount: 0,
      reinforcedCount: 0,
    },
  ];
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
});

describe("History retry review", () => {
  it.each(["missing link", "empty history"])(
    "shows task-backed recovery independently of %s",
    async (kind) => {
      mocks.entries =
        kind === "empty history" ? [] : [{ ...mocks.entries[0], relatedTaskId: null }];
      const onRetry = mountHistory([
        {
          id: 321,
          projectId,
          prompt: fullRequest,
          status: "failed",
          appliedAt: null,
          discardedAt: null,
          stagingSnapshot: Array.from({ length: 16 }, (_, i) => ({
            path: "src/file" + i + ".ts",
            content: "export {};",
          })),
        },
      ]);
      const review = await screen.findByRole("button", { name: "Review build #321 in composer" });
      expect(screen.getByText("16 saved files")).toBeTruthy();
      fireEvent.change(screen.getByPlaceholderText(/Search history/), {
        target: { value: "not in history" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Publishes" }));
      expect(onRetry).not.toHaveBeenCalled();
      fireEvent.click(review);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(fullRequest, 321);
      expect(mocks.mutate).not.toHaveBeenCalled();
    },
  );

  it("only hands the full request and task ID to the composer after an explicit click", async () => {
    const onRetry = mountHistory([
      { id: taskId, projectId, prompt: fullRequest, report: { userRequest: "Older report text" } },
    ]);
    await expandEntry();
    expect(screen.getByText(fullRequest)).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
    expect(screen.getByText(/Review in the composer before sending/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Retry Build" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(fullRequest, taskId);
    // History can prepare a draft, but cannot submit a build or a snapshot.
    expect(mocks.mutate).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.authFetch).toHaveBeenCalledTimes(1));
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/admin/me");
  });

  it("uses the full report userRequest when the task prompt is unavailable", async () => {
    const onRetry = mountHistory([
      { id: taskId, projectId, prompt: "  ", report: { userRequest: fullRequest } },
    ]);
    await expandEntry();
    fireEvent.click(screen.getByRole("button", { name: "Retry Build" }));
    expect(onRetry).toHaveBeenCalledWith(fullRequest, taskId);
  });

  it.each([
    { name: "missing task", tasks: [] },
    { name: "missing full request", tasks: [{ id: taskId, projectId, prompt: "", report: {} }] },
    { name: "foreign project", tasks: [{ id: taskId, projectId: 62, prompt: fullRequest }] },
    {
      name: "invalid report request",
      tasks: [{ id: taskId, projectId, report: { userRequest: 42 } }],
    },
  ])("rejects $name instead of silently retrying the shortened title", async ({ tasks }) => {
    const onRetry = mountHistory(tasks);
    await expandEntry();
    expect(screen.getByRole("alert").textContent).toMatch(/Unable to load the full request/);
    expect(screen.getByRole("alert").textContent).toMatch(
      /Refresh History or open the task in chat/,
    );
    const retry = screen.getByRole("button", { name: "Retry Build" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("rejects invalid task identifiers even when a matching source row exists", async () => {
    mocks.entries[0] = { ...mocks.entries[0], relatedTaskId: -1 };
    const onRetry = mountHistory([{ id: -1, projectId, prompt: fullRequest }]);
    await expandEntry();
    const retry = screen.getByRole("button", { name: "Retry Build" }) as HTMLButtonElement;
    expect(retry.disabled).toBe(true);
    fireEvent.click(retry);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("labels expand and menu controls without making either a retry action", async () => {
    const onRetry = mountHistory([{ id: taskId, projectId, prompt: fullRequest }]);
    const menu = await screen.findByRole("button", {
      name: `History entry actions: ${shortTitle}`,
    });
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    await expandEntry();
    expect(onRetry).not.toHaveBeenCalled();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
