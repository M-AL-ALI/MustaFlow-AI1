import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlansSection } from "./plans";

const mocks = vi.hoisted(() => ({
  state: vi.fn(),
  plans: vi.fn(),
  switchPlan: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  toast: vi.fn(),
  invalidate: vi.fn(),
  refetchState: vi.fn(),
  refetchPlans: vi.fn(),
  accountId: "account-A" as string | null,
}));

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: !!mocks.accountId,
    user: mocks.accountId ? { id: mocks.accountId } : null,
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  getGetNabuflowBillingStateQueryKey: () => ["billing-state"],
  useListNabuflowPlans: () => mocks.plans(),
  useSwitchNabuflowPlan: () => ({ mutate: mocks.switchPlan, isPending: false }),
  useSubscribeNabuflowPlan: () => ({ mutate: mocks.subscribe, isPending: false }),
  useCancelNabuflowSubscription: () => ({ mutate: mocks.cancel, isPending: false }),
  useResumeNabuflowSubscription: () => ({ mutate: mocks.resume, isPending: false }),
}));
vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return { ...actual, useNabuflowState: () => mocks.state() };
});
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/billing/card-setup-dialog", () => ({ CardSetupDialog: () => null }));
vi.mock("./org", () => ({ OrgSetupDialog: () => null }));
vi.mock("@/components/support-report-link", () => ({
  SupportErrorMessage: ({ message }: { message: string }) => <span>{message}</span>,
}));
vi.mock("wouter", () => ({
  useSearch: () => "",
  Link: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

function plan(id: string, name: string, priceUsd: number) {
  return {
    id,
    name,
    priceUsd,
    available: true,
    includedMonthlyCredits: 100,
    rolloverCycles: 0,
    rolloverMaxCredits: 0,
    parallelBuildLimit: 1,
    overageUsdPerCredit: 0.01,
    ladder: { proBuildsPerCycle: 10, deepBuildsPerCycle: 0, proDeepCombo: false },
  };
}

const current = plan("orbit", "Orbit", 20);
const target = plan("nova", "Nova", 40);
const estimate = {
  currentPlanId: current.id,
  targetPlanId: target.id,
  amountDueCents: 0,
  nextCycleAmountCents: 4000,
  currency: "usd",
  lines: [],
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountId = "account-A";
  vi.stubGlobal("Clerk", {
    loaded: true,
    get user() {
      return mocks.accountId ? { id: mocks.accountId } : null;
    },
    addListener: () => () => {},
  });
  mocks.state.mockReturnValue({
    data: {
      plan: current,
      subscription: { status: "active", cancelAtPeriodEnd: false },
      card: { last4: "4242" },
    },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetchState,
  });
  mocks.plans.mockReturnValue({
    data: { plans: [current, target] },
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: mocks.refetchPlans,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("billing plan review states", () => {
  it("waits for subscription state before offering a paid plan", () => {
    mocks.state.mockReturnValue({ data: undefined, isLoading: true });
    render(<PlansSection />);
    expect(screen.getByRole("status").textContent).toContain("Loading plans");
    expect(screen.queryByRole("button", { name: /subscribe|review upgrade/i })).toBeNull();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("retries failed reads without showing an empty plan list", () => {
    mocks.state.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: mocks.refetchState,
    });
    render(<PlansSection />);
    expect(screen.getByRole("alert").textContent).toContain("could not load");
    fireEvent.click(screen.getByRole("button", { name: "Retry plans" }));
    expect(mocks.refetchState).toHaveBeenCalledOnce();
    expect(mocks.refetchPlans).toHaveBeenCalledOnce();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("distinguishes a successfully loaded empty catalog from a read error", () => {
    mocks.plans.mockReturnValue({
      data: { plans: [] },
      isLoading: false,
      refetch: mocks.refetchPlans,
    });
    render(<PlansSection />);
    expect(screen.getByText("No plans available")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps confirmation disabled for an incomplete estimate and supports retry", () => {
    mocks.switchPlan.mockImplementation((_request, callbacks) =>
      callbacks.onSuccess({ preview: { ...estimate, nextCycleAmountCents: undefined } }),
    );
    render(<PlansSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review upgrade to Nova" }));
    expect(screen.getByRole("alert").textContent).toContain("complete estimate");
    expect(
      (screen.getByRole("button", { name: "Confirm switch" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    mocks.switchPlan.mockImplementation((_request, callbacks) =>
      callbacks.onSuccess({ preview: estimate }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry estimate" }));
    expect(screen.getByText("Estimated due on confirmation")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Confirm switch" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(mocks.switchPlan.mock.calls.every(([request]) => request.data.confirm === false)).toBe(
      true,
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("offers retry after a failed estimate without changing the current plan", () => {
    mocks.switchPlan.mockImplementation((_request, callbacks) =>
      callbacks.onError({ data: { error: "Estimate temporarily unavailable" } }),
    );
    render(<PlansSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review upgrade to Nova" }));
    expect(screen.getByRole("alert").textContent).toContain("Estimate temporarily unavailable");
    expect(screen.getByRole("button", { name: "Retry estimate" })).toBeTruthy();
    expect(mocks.invalidate).not.toHaveBeenCalled();
  });

  it("uses the confirmation response, not a zero estimate, to describe effective timing", () => {
    mocks.switchPlan.mockImplementation((request, callbacks) => {
      callbacks.onSuccess(
        request.data.confirm ? { upgradedCreditsGranted: 0 } : { preview: estimate },
      );
    });
    render(<PlansSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review upgrade to Nova" }));
    expect(mocks.toast).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm switch" }));
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Switched to Nova",
        description: "The server confirmed your plan change. Refreshing plan details.",
      }),
    );
    expect(mocks.invalidate).toHaveBeenCalledOnce();
  });

  it("labels negative previews as estimates and lets the user leave without confirmation", () => {
    mocks.switchPlan.mockImplementation((_request, callbacks) =>
      callbacks.onSuccess({ preview: { ...estimate, amountDueCents: -500, currency: "eur" } }),
    );
    render(<PlansSection />);
    fireEvent.click(screen.getByRole("button", { name: "Review upgrade to Nova" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Estimated credit adjustment")).toBeTruthy();
    expect(within(dialog).getByTestId("proration-total").textContent).toContain("EUR");
    expect(within(dialog).getByTestId("proration-total").textContent).toContain("-");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mocks.switchPlan).toHaveBeenCalledOnce();
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
