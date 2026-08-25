import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeTab } from "./knowledge-tab";

const mocks = vi.hoisted(() => ({
  authFetch: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock("@/lib/api-fetch", () => ({ authFetch: mocks.authFetch }));
vi.mock("@/lib/clerk-safe", () => ({ useClerkUser: () => ({ user: { id: "user-1" } }) }));
vi.mock("@workspace/api-client-react", () => ({
  getListKnowledgeQueryKey: (params: unknown) => ["knowledge", params],
  useListKnowledge: () => ({ data: [], isLoading: false }),
  useUpdateKnowledge: () => ({ mutate: mocks.mutate, isPending: false }),
  useCreateKnowledge: () => ({ mutate: mocks.mutate, isPending: false }),
  usePromoteKnowledgeToGlobal: () => ({ mutate: mocks.mutate, isPending: false }),
}));

function renderTab() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <KnowledgeTab projectId={52} />
    </QueryClientProvider>,
  );
}

describe("KnowledgeTab memory health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows a plain correction path when saved context is stale", async () => {
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        semantics: "zero-project-memory-reconciliation-summary-v2",
        status: "review-needed",
        observedAt: "2026-08-25T23:00:00.000Z",
        counts: { confirmed: 3, stale: 1, unverifiable: 2 },
        coverage: { complete: true, rowLimit: 500, limitedSurfaces: [] },
      }),
    });

    renderTab();

    expect(
      await screen.findByText(
        "Some saved context no longer matches the app. Zero is withholding it; edit or archive the affected entries below, then check again.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Memory health")).toBeVisible();
    expect(screen.getByText("3 current · 1 needs review · 2 not verifiable")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check again" })).toBeVisible();
    expect(mocks.authFetch).toHaveBeenCalledWith("/api/knowledge/reconciliation?projectId=52");
  });

  it("does not claim memory is current when the governed read fails", async () => {
    mocks.authFetch.mockResolvedValue({ ok: false });

    renderTab();

    expect(
      await screen.findByText(
        "Some saved context could not be verified. Zero will rely on the current app instead of uncertain summaries.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Saved app context matches the project evidence the platform can verify."),
    ).toBeNull();
  });

  it("explains when the bounded check cannot cover every saved record", async () => {
    mocks.authFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        semantics: "zero-project-memory-reconciliation-summary-v2",
        status: "limited",
        observedAt: "2026-08-25T23:00:00.000Z",
        counts: { confirmed: 500, stale: 0, unverifiable: 0 },
        coverage: {
          complete: false,
          rowLimit: 500,
          limitedSurfaces: ["chat-messages"],
        },
      }),
    });

    renderTab();

    expect(
      await screen.findByText(
        "This project has more saved context than one safe check can cover. Zero will rely on the current app instead of treating a partial check as complete.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Saved app context matches the project evidence the platform can verify."),
    ).toBeNull();
  });
});
