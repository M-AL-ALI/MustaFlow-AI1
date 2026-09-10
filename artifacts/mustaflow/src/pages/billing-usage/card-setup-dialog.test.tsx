import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import capturedAttemptD from "./__fixtures__/pd1-card-dialog-attempt-d.json";
import { PlansSection } from "./plans";
import { CardSetupDialog } from "@/components/billing/card-setup-dialog";

const testState = vi.hoisted(() => ({
  confirmSetup: vi.fn(),
  createIntent: vi.fn(),
  getBillingState: vi.fn(),
  cancel: vi.fn(),
  subscribe: vi.fn(),
  switchPlan: vi.fn(),
  accountId: "account-A" as string | null,
  requests: [] as Array<{ url: string; signal?: AbortSignal | null }>,
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

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: !!testState.accountId,
    user: testState.accountId ? { id: testState.accountId } : null,
  }),
}));

vi.mock("@/lib/api-fetch", () => ({
  authFetch: vi.fn(async (url: string, init: RequestInit = {}, beforeRequest?: () => void) => {
    beforeRequest?.();
    await Promise.resolve();
    beforeRequest?.();
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    testState.requests.push({ url, signal: init.signal });
    const data = url.endsWith("/setup-intent")
      ? await testState.createIntent()
      : url.endsWith("/state")
        ? await testState.getBillingState()
        : { publishableKey: "pk_test_pd1", stripeConfigured: true };
    return { ok: true, status: 200, json: async () => data };
  }),
}));

vi.mock("@workspace/api-client-react", () => ({
  createNabuflowSetupIntent: testState.createIntent,
  getCreateNabuflowSetupIntentUrl: () => "/api/billing/nabuflow/setup-intent",
  getGetNabuflowBillingStateUrl: () => "/api/billing/nabuflow/state",
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

vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return {
    ...actual,
    useNabuflowState: () => ({ data: testState.billingState }),
  };
});

vi.mock("./org", () => ({
  OrgSetupDialog: () => null,
}));

type AccountListener = (resources: { user: { id: string } | null }) => void;
const accountListeners = new Set<AccountListener>();
const clerk = {
  loaded: true,
  get user() {
    return testState.accountId ? { id: testState.accountId } : null;
  },
  addListener(listener: AccountListener) {
    accountListeners.add(listener);
    listener({ user: clerk.user });
    return () => {
      accountListeners.delete(listener);
    };
  },
};

function switchAccount(id: string | null) {
  testState.accountId = id;
  for (const listener of [...accountListeners]) listener({ user: clerk.user });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  testState.accountId = "account-A";
  testState.requests = [];
  vi.stubGlobal("Clerk", clerk);
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

afterEach(async () => {
  cleanup();
  await Promise.resolve();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  accountListeners.clear();
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

    expect(screen.getByTestId("proration-total")).toHaveTextContent("USD 0.00");
    expect(screen.getByTestId("next-cycle-charge")).toHaveTextContent(
      "Next-cycle estimate: USD 20.00/month starting Oct 1, 2026",
    );
    expect(screen.getByTestId("proration-confirm")).toHaveTextContent("Schedule downgrade");
    expect(
      screen.getByText(/Your current plan, credits and engine access continue until renewal/),
    ).toBeVisible();
  });

  it("separates upgrade due-now and renewal amounts and discloses unbilled usage", async () => {
    testState.billingState = {
      card: { last4: "4242" },
      cycle: { includedCredits: 1600 },
      org: null,
      plan: { id: "orbit", name: "Orbit", priceUsd: 20 },
      subscription: { status: "active", cancelAtPeriodEnd: false },
    };
    testState.switchPlan.mockImplementationOnce(
      (_input: unknown, options: { onSuccess: (value: Record<string, unknown>) => void }) =>
        options.onSuccess({
          preview: {
            currentPlanId: "orbit",
            targetPlanId: "comet",
            amountDueCents: 2996,
            nextCycleAmountCents: 5000,
            nextCycleStartsAt: "2026-10-01T17:24:22.000Z",
            currency: "usd",
            periodEnd: "2026-10-01T17:24:22.000Z",
            lines: [],
          },
        }),
    );
    const user = userEvent.setup();
    renderPlans();

    await user.click(screen.getByTestId("plan-cta-comet"));

    expect(screen.getByTestId("proration-total")).toHaveTextContent("USD 29.96");
    expect(screen.getByTestId("next-cycle-charge")).toHaveTextContent(
      "Next-cycle estimate: USD 50.00/month starting Oct 1, 2026",
    );
    expect(screen.getByText(/Unbilled usage can change the final invoice amount/)).toBeVisible();
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
      /Switching to Orbit on Oct 1, 2026.*Comet plan, credits and engine access stay active until then.*no charge, refund or credit note now.*upgrading before renewal cancels this change/i,
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
    expect(screen.getByRole("alertdialog", { name: "Cancel your plan?" })).toHaveTextContent(
      "There are no partial-cycle refunds",
    );
  });
});

describe("card setup account and open lifetimes", () => {
  it.each(["account", "close", "unmount", "round-trip"] as const)(
    "discards deferred setup intent after %s",
    async (departure) => {
      const intent = deferred<{ clientSecret: string; setupIntentId: string }>();
      testState.createIntent.mockReturnValue(intent.promise);
      const onSaved = vi.fn();
      const props = { open: true, onClose: vi.fn(), onSaved };
      const view = render(<CardSetupDialog {...props} />);
      await waitFor(() => expect(testState.createIntent).toHaveBeenCalledOnce());
      if (departure === "close") view.rerender(<CardSetupDialog {...props} open={false} />);
      else if (departure === "unmount") view.unmount();
      else
        act(() => {
          switchAccount("account-B");
          if (departure === "round-trip") switchAccount("account-A");
        });
      await act(async () =>
        intent.resolve({ clientSecret: "old-secret", setupIntentId: "old-intent" }),
      );
      expect(screen.queryByTestId("card-setup-submit")).toBeNull();
      expect(testState.createIntent).toHaveBeenCalledOnce();
      expect(testState.confirmSetup).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(
        testState.requests.find((request) => request.url.endsWith("/setup-intent"))?.signal
          ?.aborted,
      ).toBe(true);
    },
  );

  it.each(["snapshot", "close", "unmount", "round-trip"] as const)(
    "does not poll or save a deferred Stripe confirmation after %s",
    async (departure) => {
      document.body.style.setProperty("pointer-events", "inherit", "important");
      const confirm = deferred<{ setupIntent: { status: "succeeded" } }>();
      testState.confirmSetup.mockReturnValue(confirm.promise);
      const onSaved = vi.fn();
      const props = { open: true, onClose: vi.fn(), onSaved };
      const view = render(<CardSetupDialog {...props} />);
      await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
      fireEvent.click(screen.getByTestId("card-setup-submit"));
      if (departure === "close") view.rerender(<CardSetupDialog {...props} open={false} />);
      else if (departure === "unmount") view.unmount();
      else if (departure === "snapshot") testState.accountId = "account-B";
      else
        act(() => {
          switchAccount("account-B");
          switchAccount("account-A");
        });
      await act(async () => confirm.resolve({ setupIntent: { status: "succeeded" } }));
      expect(testState.getBillingState).not.toHaveBeenCalled();
      expect(onSaved).not.toHaveBeenCalled();
      expect(screen.queryByTestId("card-setup-dialog")).toBeNull();
      await waitFor(() =>
        expect(document.body.style.getPropertyValue("pointer-events")).toBe("inherit"),
      );
      expect(document.body.style.getPropertyPriority("pointer-events")).toBe("important");
    },
  );

  it.each(["account", "close", "unmount", "round-trip"] as const)(
    "ignores deferred billing polling after %s",
    async (departure) => {
      const billing = deferred<{ card: { last4: string } }>();
      testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
      testState.getBillingState.mockReturnValue(billing.promise);
      const onSaved = vi.fn();
      const props = { open: true, onClose: vi.fn(), onSaved };
      const view = render(<CardSetupDialog {...props} />);
      await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
      fireEvent.click(screen.getByTestId("card-setup-submit"));
      await waitFor(() => expect(testState.getBillingState).toHaveBeenCalledOnce());
      if (departure === "close") view.rerender(<CardSetupDialog {...props} open={false} />);
      else if (departure === "unmount") view.unmount();
      else
        act(() => {
          switchAccount("account-B");
          if (departure === "round-trip") switchAccount("account-A");
        });
      await act(async () => billing.resolve({ card: { last4: "4242" } }));
      expect(onSaved).not.toHaveBeenCalled();
      expect(testState.getBillingState).toHaveBeenCalledOnce();
      expect(
        testState.requests.find((request) => request.url.endsWith("/state"))?.signal?.aborted,
      ).toBe(true);
    },
  );

  it("checks the SDK snapshot before keyboard/form submission", async () => {
    render(<CardSetupDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    const form = screen.getByTestId("card-setup-submit").closest("form")!;
    testState.accountId = "account-B";
    fireEvent.submit(form);
    expect(testState.confirmSetup).not.toHaveBeenCalled();
    expect(testState.getBillingState).not.toHaveBeenCalled();
  });

  it("suppresses a stale Stripe rejection", async () => {
    const confirm = deferred<unknown>();
    testState.confirmSetup.mockReturnValue(confirm.promise);
    render(<CardSetupDialog open onClose={vi.fn()} onSaved={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("card-setup-submit"));
    act(() => switchAccount("account-B"));
    await act(async () => confirm.reject(new Error("Old confirmation failed")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(testState.getBillingState).not.toHaveBeenCalled();
  });

  it("preserves custom callbacks and unchanged-account grace completion exactly once", async () => {
    const createIntent = vi
      .fn()
      .mockResolvedValue({ clientSecret: "company-secret", setupIntentId: "company-intent" });
    const verifySaved = vi.fn().mockResolvedValue(false);
    const onSaved = vi.fn();
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    render(
      <CardSetupDialog
        open
        onClose={vi.fn()}
        onSaved={onSaved}
        createIntent={createIntent}
        verifySaved={verifySaved}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByTestId("card-setup-submit"));
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(createIntent).toHaveBeenCalledOnce();
    expect(testState.createIntent).not.toHaveBeenCalled();
    expect(testState.getBillingState).not.toHaveBeenCalled();
    expect(verifySaved).toHaveBeenCalledTimes(10);
    expect(onSaved).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it("stops custom verification and its timer on unmount", async () => {
    const verifySaved = vi.fn().mockResolvedValue(false);
    const onSaved = vi.fn();
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    const view = render(
      <CardSetupDialog open onClose={vi.fn()} onSaved={onSaved} verifySaved={verifySaved} />,
    );
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByTestId("card-setup-submit"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(verifySaved).toHaveBeenCalledOnce();
    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(verifySaved).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("ignores a deferred custom verifier after A -> B -> A", async () => {
    const verification = deferred<boolean>();
    const verifySaved = vi.fn().mockReturnValue(verification.promise);
    const onSaved = vi.fn();
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    render(<CardSetupDialog open onClose={vi.fn()} onSaved={onSaved} verifySaved={verifySaved} />);
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    fireEvent.click(screen.getByTestId("card-setup-submit"));
    await waitFor(() => expect(verifySaved).toHaveBeenCalledOnce());
    act(() => {
      switchAccount("account-B");
      switchAccount("account-A");
    });
    await act(async () => verification.resolve(true));
    expect(onSaved).not.toHaveBeenCalled();
    expect(testState.getBillingState).not.toHaveBeenCalled();
  });

  it("finishes an unchanged account's saved card and subscribes once", async () => {
    testState.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
    const user = await openOrbitCardDialog();
    await user.click(screen.getByLabelText("Full name"));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(testState.subscribe).toHaveBeenCalledOnce());
    expect(testState.subscribe.mock.calls[0][0]).toEqual({ data: { planId: "orbit" } });
  });
});
