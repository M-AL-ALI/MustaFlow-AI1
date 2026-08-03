import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OverviewSection } from "./overview";

vi.mock("@workspace/api-client-react", () => ({
  useListNabuflowBillingNotifications: () => ({ data: { notifications: [] } }),
  useListNabuflowPlans: () => ({ data: { plans: [] } }),
}));

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({ user: null }),
}));

vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return {
    ...actual,
    useNabuflowState: () => ({
      data: {
        card: null,
        cycle: null,
        enforcementEnabled: true,
        exempt: false,
        org: null,
        plan: null,
        spendCap: null,
        subscription: null,
      },
      isLoading: false,
      isError: false,
      blockedReason: null,
      refetch: vi.fn(),
    }),
  };
});

describe("legacy credit-pack cleanup", () => {
  it("does not render a legacy credit-pack link from Billing & Usage", () => {
    render(<OverviewSection />);

    expect(screen.queryByRole("link", { name: /credit packs/i })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="/billing/legacy"]')).toBeNull();
  });
});
