import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({ user: null, isLoaded: true }),
  useClerkActions: () => ({ openUserProfile: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetUserCredits: vi.fn(),
  useListCreditTransactions: vi.fn(),
  getBillingCheckoutSession: vi.fn(),
  useGetMyPreferences: () => ({ isPending: false, data: { voiceLang: null } }),
  useUpdateMyPreferences: () => ({ mutateAsync: vi.fn() }),
  getGetMyPreferencesQueryKey: () => ["/api/me/preferences"],
}));

import SettingsPage from "../settings";

afterEach(cleanup);

describe("Settings workspace guidance", () => {
  it("explains separate project collections and the existing workspace switcher", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SettingsPage />
      </QueryClientProvider>,
    );

    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Organize your projects in separate workspaces. Use the workspace switcher in the navigation to choose a workspace or create a new one. Each workspace shows its own projects.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/a single workspace for all projects/i)).toBeNull();
  });
});
