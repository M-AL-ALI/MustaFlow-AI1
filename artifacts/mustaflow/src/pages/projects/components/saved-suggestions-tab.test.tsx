import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectSuggestion } from "@workspace/api-client-react";
import { SavedSuggestionsTab } from "./saved-suggestions-tab";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  accept: vi.fn(),
  dismiss: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  getListSuggestionsQueryKey: (projectId: number) => ["suggestions", projectId],
  useListSuggestions: api.list,
  useAcceptSuggestion: () => ({ mutate: api.accept, isPending: false }),
  useDismissSuggestion: () => ({ mutate: api.dismiss, isPending: false }),
  useSaveSuggestion: () => ({ mutate: api.save, isPending: false }),
}));

const fallbackSuggestion: ProjectSuggestion = {
  id: 501,
  projectId: 45,
  taskId: 901,
  title: "Review the latest task",
  description: "Check the latest task against the current project before another change.",
  category: "improvement",
  prompt:
    "Review the most recent build task against the current project files. Make one focused improvement only if project evidence supports it.",
  status: "pending",
  createdAt: "2026-07-29T12:00:00.000Z",
};

describe("SavedSuggestionsTab", () => {
  beforeEach(() => {
    api.list.mockReturnValue({
      data: [fallbackSuggestion],
      isLoading: false,
    });
  });

  it("renders a production-shaped post-build fallback row in the Ideas tab", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SavedSuggestionsTab projectId={45} />
      </QueryClientProvider>,
    );

    expect(screen.getByText("New ideas")).toBeVisible();
    expect(screen.getByText("Review the latest task")).toBeVisible();
    expect(
      screen.getByText("Check the latest task against the current project before another change."),
    ).toBeVisible();
    expect(screen.getByText("Build now")).toBeVisible();
  });
});
