import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capturedAttemptD from "./__fixtures__/pd1-card-dialog-attempt-d.json";
import { PlansSection } from "./plans";

const testState = vi.hoisted(() => ({
  confirmSetup: vi.fn(),
  createIntent: vi.fn(),
  getBillingState: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  switchPlan: vi.fn(),
  billingState: {
    card: null,
    cycle: null,
    org: null,
    plan: null,
    subscription: null,
  } as Record<string, unknown>,
}));

vi.mock("@stripe/stripe-js", () => ({
  loadStripe: vi.fn().mockResolvedValue({}),
}));

vi.mock("@stripe/react-stripe-js", () => ({
  AddressElement: () => <input aria-label="Full name" />,
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  PaymentElement: () => <div data-testid="stripe-payment-element" tabIndex={0} />,
  useElements: () => ({}),
  useStripe: () => ({ confirmSetup: testState.confirmSetup }),
}));

vi.mock("@/lib/api-fetch", () => ({
  authFetch: vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ publishableKey: "pk_test_pd1", stripeConfigured: true }),
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  createNabuflowSetupIntent: testState.createIntent,
  getGetNabuflowBillingStateQueryKey: () => ["nabuflow-billing-state"],
  getNabuflowBillingState: testState.getBillingState,
  useCancelNabuflowSubscription: () => ({ isPending: false, mutate: testState.cancel }),
  useListNabuflowPlans: () => ({
    data: {
      plans: [
        {
          id: "orbit",
          name: "Orbit",
          available: true,
          priceUsd: 20,
          includedMonthlyCredits: 1600,
          ladder: {
            proBuildsPerCycle: 3,
            deepBuildsPerCycle: 0,
            proDeepCombo: false,
          },
          rolloverCycles: 0,
          rolloverMaxCredits: 0,
          parallelBuildLimit: 1,
          overageUsdPerCredit: 0.015,
        },
        {
          id: "comet",
          name: "Comet",
          available: true,
          priceUsd: 50,
          includedMonthlyCredits: 4000,
          ladder: {
            proBuildsPerCycle: null,
            deepBuildsPerCycle: 10,
            proDeepCombo: false,
          },
          rolloverCycles: 1,
          rolloverMaxCredits: 4000,
          parallelBuildLimit: 3,
          overageUsdPerCredit: 0.013,
        },
      ],
    },
    isLoading: false,
  }),
  useResumeNabuflowSubscription: () => ({ isPending: false, mutate: vi.fn() }),
  useSubscribeNabuflowPlan: () => ({ isPending: false, mutate: testState.subscribe }),
  useSwitchNabuflowPlan: () => ({ isPending: false, mutate: testState.switchPlan }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("./shared", () => ({
  useNabuflowState: () => ({
    data: testState.billingState,
  }),
}));

vi.mock("./org", () => ({
  OrgSetupDialog: () => null,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function renderPlans() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <PlansSection />
    </QueryClientProvider>,
  );
}

async function openOrbitCardDialog(user = userEvent.setup()) {
  renderPlans();
  await user.click(screen.getByTestId("plan-cta-orbit"));
  await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
  return user;
}

beforeEach(() => {
  testState.confirmSetup.mockReset();
  testState.createIntent.mockReset().mockResolvedValue({
    clientSecret: "seti_pd1_secret_test",
    setupIntentId: "seti_pd1",
  });
  testState.getBillingState.mockReset().mockResolvedValue({ card: { last4: "4242" } });
  testState.cancel.mockReset();
  testState.subscribe.mockReset();
  testState.switchPlan.mockReset();
  testState.billingState = {
    card: null,
    cycle: null,
    org: null,
    plan: null,
    subscription: null,
  };
  document.body.style.removeProperty("pointer-events");
});

afterEach(() => {
  cleanup();
  document.body.style.removeProperty("pointer-events");
});

describe("Plans card setup dialog — captured staging pointer race", () => {
  it("keeps the page-level dialog open when the captured pointerdown/click target is documentElement", async () => {
    await openOrbitCardDialog();

    expect(capturedAttemptD.confirmFired).toBe(false);
    expect(document.body.style.getPropertyValue("pointer-events")).toBe("auto");
    expect(document.body.style.getPropertyPriority("pointer-events")).toBe("important");

    for (const event of capturedAttemptD.events) {
      if (event.type === "pointerdown") fireEvent.pointerDown(document.documentElement);
      if (event.type === "window-focus") window.dispatchEvent(new FocusEvent("focus"));
      if (event.type === "click") fireEvent.click(document.documentElement);
    }

    expect(screen.getByTestId("card-setup-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("billing-plans")).toBeInTheDocument();
    expect(testState.confirmSetup).not.toHaveBeenCalled();
  });

  it("submits with Enter and closes only after the successful save", async () => {
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    const user = await openOrbitCardDialog();

    await user.click(screen.getByLabelText("Full name"));
    await user.keyboard("{Enter}");

    await waitFor(() => expect(testState.confirmSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("card-setup-dialog")).not.toBeInTheDocument());
  });

  it("delivers a mouse click to the submit button and closes only after success", async () => {
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    const user = await openOrbitCardDialog();

    await user.click(screen.getByTestId("card-setup-submit"));

    await waitFor(() => expect(testState.confirmSetup).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId("card-setup-dialog")).not.toBeInTheDocument());
  });

  it("keeps Stripe failures inline and leaves the dialog open", async () => {
    testState.confirmSetup.mockResolvedValue({ error: { message: "Your card was declined." } });
    const user = await openOrbitCardDialog();

    await user.click(screen.getByTestId("card-setup-submit"));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your card was declined.");
    expect(screen.getByTestId("card-setup-dialog")).toBeInTheDocument();
  });

  it("allows explicit Cancel to close and restores the prior body pointer style", async () => {
    document.body.style.setProperty("pointer-events", "inherit");
    const user = await openOrbitCardDialog();
    expect(document.body.style.getPropertyValue("pointer-events")).toBe("auto");

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("card-setup-dialog")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.body.style.getPropertyValue("pointer-events")).toBe("inherit"),
    );
  });

  it("ignores close requests while submitting and while finishing", async () => {
    const confirm = deferred<{ setupIntent: { status: "succeeded" } }>();
    const state = deferred<{ card: { last4: string } }>();
    testState.confirmSetup.mockReturnValue(confirm.promise);
    testState.getBillingState.mockReturnValue(state.promise);
    const user = await openOrbitCardDialog();

    await user.click(screen.getByTestId("card-setup-submit"));
    await waitFor(() => expect(testState.confirmSetup).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("card-setup-dialog")).toBeInTheDocument();

    await act(async () => confirm.resolve({ setupIntent: { status: "succeeded" } }));
    expect(await screen.findByText(/Saving your card/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.getByTestId("card-setup-dialog")).toBeInTheDocument();

    await act(async () => state.resolve({ card: { last4: "4242" } }));
    await waitFor(() => expect(screen.queryByTestId("card-setup-dialog")).not.toBeInTheDocument());
  });
});

describe("Plans deferred downgrade state", () => {
  it("shows zero due now and the lower recurring price at period end", async () => {
    testState.billingState = {
      card: { last4: "4242" },
      cycle: { includedCredits: 4000 },
      org: null,
      plan: { id: "comet", name: "Comet", priceUsd: 50 },
      subscription: { status: "active", cancelAtPeriodEnd: false },
    };
    testState.switchPlan.mockImplementationOnce(
      (_input: unknown, options: { onSuccess: (value: Record<string, unknown>) => void }) =>
        options.onSuccess({
          preview: {
            currentPlanId: "comet",
            targetPlanId: "orbit",
            amountDueCents: 0,
            nextCycleAmountCents: 2000,
            nextCycleStartsAt: "2026-10-01T17:24:22.000Z",
            currency: "usd",
            periodEnd: "2026-10-01T17:24:22.000Z",
            lines: [],
          },
        }),
    );
    const user = userEvent.setup();
    renderPlans();

    await user.click(screen.getByTestId("plan-cta-orbit"));

    expect(screen.getByTestId("proration-total")).toHaveTextContent("$0");
    expect(screen.getByTestId("next-cycle-charge")).toHaveTextContent(
      "Then $20/mo starting Oct 1, 2026",
    );
    expect(screen.getByTestId("proration-confirm")).toHaveTextContent("Schedule downgrade");
    expect(
      screen.getByText(/Downgrades keep your current plan until the cycle ends/),
    ).toBeVisible();
  });

  it("shows the current plan and its scheduled lower-tier change together", () => {
    testState.billingState = {
      card: { last4: "4242" },
      cycle: { includedCredits: 4000 },
      org: null,
      plan: { id: "comet", name: "Comet", priceUsd: 50 },
      subscription: {
        status: "active",
        cancelAtPeriodEnd: false,
        pendingPlanId: "orbit",
        pendingEffectiveAt: "2026-10-01T17:24:22.000Z",
      },
    };

    renderPlans();

    expect(screen.getByTestId("pending-plan-note")).toHaveTextContent(
      /Switching to Orbit on Oct 1, 2026.*Comet entitlements stay active until then/,
    );
    expect(screen.getByTestId("plan-cta-orbit")).toBeDisabled();
    expect(screen.getByTestId("plan-cta-orbit")).toHaveTextContent("Orbit scheduled");
  });
});

describe("Plans cancellation confirmation", () => {
  it("keeps the page-level dialog open and renders the backend failure inline", async () => {
    testState.billingState = {
      card: { last4: "4242" },
      cycle: { includedCredits: 1600 },
      org: null,
      plan: { id: "orbit", name: "Orbit", priceUsd: 20 },
      subscription: {
        status: "active",
        cancelAtPeriodEnd: false,
        currentCycleEnd: "2026-11-01T00:00:00.000Z",
      },
    };
    const backendMessage =
      "The subscription is managed by a NabuFlow schedule. Please refresh and try again.";
    testState.cancel.mockImplementationOnce(
      (_input: unknown, options: { onError: (error: unknown) => void }) =>
        options.onError({ data: { error: backendMessage } }),
    );
    const user = userEvent.setup();
    renderPlans();

    await user.click(screen.getByTestId("plan-cancel-link"));
    await user.click(screen.getByTestId("plan-cancel-confirm"));

    expect(testState.cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alertdialog", { name: "Cancel your plan?" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(backendMessage);
  });
});
