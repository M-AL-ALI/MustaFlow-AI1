import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlansSection } from "./plans";
import { billingStateQueryKey, useNabuflowState } from "./shared";
import {
  billingAccountRequest,
  useBillingAccount,
  useBillingAccountLifetime,
} from "@/lib/billing-account-lifetime";

type Operation = "subscribe" | "switchPlan" | "cancel" | "resume";
type MutationOptions = {
  request?: { signal?: AbortSignal };
  mutation: { mutationFn: (input?: { data: Record<string, unknown> }) => Promise<unknown> };
};
type CardProps = { open: boolean; onSaved: () => void; onClose: () => void };
const mocks = vi.hoisted(() => ({
  accountId: "account-A" as string | null,
  loaded: true,
  liveQueries: false,
  state: vi.fn(),
  subscribe: vi.fn(),
  switchPlan: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  toast: vi.fn(),
  token: vi.fn(),
  fetch: vi.fn(),
  options: {} as Record<Operation, MutationOptions>,
  cards: [] as CardProps[],
}));

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: mocks.loaded,
    isSignedIn: !!mocks.accountId,
    user: mocks.accountId ? { id: mocks.accountId } : null,
  }),
}));
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    getAuthToken: () => mocks.token(),
    getGetNabuflowBillingStateQueryKey: () => ["billing-state"],
    useListNabuflowPlans: () => ({ data: { plans: [orbit, nova] }, isLoading: false }),
    useSubscribeNabuflowPlan: (options: MutationOptions) => {
      mocks.options.subscribe = options;
      return { mutate: mocks.subscribe, isPending: false };
    },
    useSwitchNabuflowPlan: (options: MutationOptions) => {
      mocks.options.switchPlan = options;
      return { mutate: mocks.switchPlan, isPending: false };
    },
    useCancelNabuflowSubscription: (options: MutationOptions) => {
      mocks.options.cancel = options;
      return { mutate: mocks.cancel, isPending: false };
    },
    useResumeNabuflowSubscription: (options: MutationOptions) => {
      mocks.options.resume = options;
      return { mutate: mocks.resume, isPending: false };
    },
  };
});
vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return {
    ...actual,
    useNabuflowState: () => (mocks.liveQueries ? actual.useNabuflowState() : mocks.state()),
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/components/billing/card-setup-dialog", () => ({
  CardSetupDialog: (props: CardProps) => {
    mocks.cards.push(props);
    return props.open ? <div data-testid="account-card-dialog" /> : null;
  },
}));
vi.mock("./org", () => ({ OrgSetupDialog: () => null }));
vi.mock("@/components/support-report-link", () => ({
  SupportErrorMessage: ({ message }: { message: string }) => <span>{message}</span>,
}));
vi.mock("wouter", () => ({
  useSearch: () => "",
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

type Listener = (resources: { user: { id: string } | null }) => void;
const listeners = new Set<Listener>();
const clerk = {
  get loaded() {
    return mocks.loaded;
  },
  get user() {
    return mocks.accountId ? { id: mocks.accountId } : null;
  },
  addListener(listener: Listener) {
    listeners.add(listener);
    listener({ user: clerk.user });
    return () => {
      listeners.delete(listener);
    };
  },
};
function publishAccount(id: string | null) {
  mocks.accountId = id;
  for (const listener of [...listeners]) listener({ user: clerk.user });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as Response;
}
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
const orbit = plan("orbit", "Orbit", 20);
const nova = plan("nova", "Nova", 40);
const estimate = {
  currentPlanId: "orbit",
  targetPlanId: "nova",
  amountDueCents: 2000,
  nextCycleAmountCents: 4000,
  currency: "usd",
  lines: [],
};
function setState(active = false, cancelAtPeriodEnd = false, card = false) {
  mocks.state.mockReturnValue({
    data: {
      plan: active ? orbit : null,
      subscription: active ? { status: "active", cancelAtPeriodEnd } : null,
      card: card ? { last4: "4242" } : null,
    },
    isLoading: false,
    isError: false,
  });
}
function renderPlans() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  return {
    ...render(
      <QueryClientProvider client={client}>
        <PlansSection />
      </QueryClientProvider>,
    ),
    client,
    invalidate,
  };
}
function openCard() {
  fireEvent.click(screen.getByTestId("plan-cta-nova"));
  return mocks.cards[mocks.cards.length - 1];
}
function useLifetime() {
  return useBillingAccountLifetime(useBillingAccount());
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountId = "account-A";
  mocks.loaded = true;
  mocks.liveQueries = false;
  mocks.cards = [];
  mocks.token.mockResolvedValue(null);
  mocks.fetch.mockResolvedValue(response({ ok: true }));
  vi.stubGlobal("Clerk", clerk);
  vi.stubGlobal("fetch", mocks.fetch);
  setState();
});
afterEach(() => {
  cleanup();
  listeners.clear();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("billing account presentation and queued callbacks", () => {
  it("drops card selection on departure and accepts only a new account's selection", () => {
    const { invalidate } = renderPlans();
    const oldCard = openCard();
    act(() => publishAccount("account-B"));
    expect(screen.queryByTestId("account-card-dialog")).toBeNull();
    act(() => {
      oldCard.onSaved();
      oldCard.onClose();
    });
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();

    const currentCard = openCard();
    act(() => currentCard.onSaved());
    expect(mocks.subscribe).toHaveBeenCalledOnce();
    expect(mocks.subscribe.mock.calls[0][0]).toEqual({ data: { planId: "nova" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingStateQueryKey("account-B") });
    act(() => currentCard.onSaved());
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("permanently rejects an old selection after batched A -> B -> A", () => {
    renderPlans();
    const oldCard = openCard();
    act(() => {
      publishAccount("account-B");
      publishAccount("account-A");
    });
    act(() => oldCard.onSaved());
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect(screen.queryByTestId("account-card-dialog")).toBeNull();
    const currentCard = openCard();
    act(() => currentCard.onSaved());
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("checks the synchronous SDK snapshot before onSaved, without waiting for a render", () => {
    renderPlans();
    const oldCard = openCard();
    mocks.accountId = "account-B";
    act(() => oldCard.onSaved());
    expect(mocks.subscribe).not.toHaveBeenCalled();
    act(() => publishAccount("account-A"));
    act(() => oldCard.onSaved());
    expect(mocks.subscribe).not.toHaveBeenCalled();
    const freshCard = openCard();
    act(() => freshCard.onSaved());
    expect(mocks.subscribe).toHaveBeenCalledOnce();
  });

  it("rejects card callbacks queued before close, reopen, or unmount", () => {
    const view = renderPlans();
    const closedCard = openCard();
    act(() => closedCard.onClose());
    const reopenedCard = openCard();
    act(() => closedCard.onSaved());
    expect(mocks.subscribe).not.toHaveBeenCalled();
    view.unmount();
    act(() => reopenedCard.onSaved());
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });

  it("drops pending and ready proration dialogs across account changes", () => {
    setState(true);
    renderPlans();
    fireEvent.click(screen.getByTestId("plan-cta-nova"));
    const pending = mocks.switchPlan.mock.calls[0][1];
    act(() => publishAccount("account-B"));
    act(() => {
      pending.onSuccess({ preview: estimate });
      pending.onError(new Error("stale"));
    });
    expect(screen.queryByTestId("proration-dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("plan-cta-nova"));
    act(() => mocks.switchPlan.mock.calls[1][1].onSuccess({ preview: estimate }));
    expect(screen.getByTestId("proration-confirm")).toBeEnabled();
    act(() => {
      publishAccount("account-A");
      publishAccount("account-B");
    });
    expect(screen.queryByTestId("proration-dialog")).toBeNull();
  });

  it("blocks confirmation when Clerk changes before its listener is delivered", () => {
    setState(true);
    mocks.switchPlan.mockImplementation((_input, callbacks) =>
      callbacks.onSuccess({ preview: estimate }),
    );
    renderPlans();
    fireEvent.click(screen.getByTestId("plan-cta-nova"));
    mocks.accountId = "account-B";
    fireEvent.click(screen.getByTestId("proration-confirm"));
    expect(mocks.switchPlan).toHaveBeenCalledOnce();
  });

  it.each(["subscribe", "switchPlan", "cancel", "resume"] as const)(
    "ignores queued %s success, error, and settlement after departure",
    (operation) => {
      setState(operation !== "subscribe", operation === "resume", true);
      const { invalidate } = renderPlans();
      if (operation === "subscribe") fireEvent.click(screen.getByTestId("plan-cta-nova"));
      if (operation === "switchPlan") {
        fireEvent.click(screen.getByTestId("plan-cta-nova"));
        act(() => mocks.switchPlan.mock.calls[0][1].onSuccess({ preview: estimate }));
        fireEvent.click(screen.getByTestId("proration-confirm"));
      }
      if (operation === "cancel") {
        fireEvent.click(screen.getByTestId("plan-cancel-link"));
        fireEvent.click(screen.getByTestId("plan-cancel-confirm"));
      }
      if (operation === "resume") fireEvent.click(screen.getByTestId("plan-resume-btn"));
      const calls = mocks[operation].mock.calls;
      const callbacks = calls[calls.length - 1][1];
      act(() => {
        publishAccount("account-B");
        publishAccount("account-A");
      });
      act(() => {
        callbacks.onSuccess?.({});
        callbacks.onError?.({ data: { error: "Old account error" } });
        callbacks.onSettled?.();
      });
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(invalidate).not.toHaveBeenCalled();
      expect(screen.queryByText("Old account error")).toBeNull();
      expect(screen.queryByRole("alertdialog")).toBeNull();
    },
  );

  it("keeps unchanged-account subscribe success and error presentation", () => {
    setState(false, false, true);
    const { invalidate } = renderPlans();
    fireEvent.click(screen.getByTestId("plan-cta-nova"));
    const callbacks = mocks.subscribe.mock.calls[0][1];
    act(() => callbacks.onError({ data: { error: "Payment unavailable" } }));
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Couldn't start the plan" }),
    );
    act(() => {
      callbacks.onSuccess({});
      callbacks.onSettled();
    });
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Nova subscription request accepted" }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: billingStateQueryKey("account-A") });
  });
});

describe("billing request and query ownership", () => {
  it.each([
    ["subscribe", { planId: "nova" }],
    ["switchPlan", { planId: "nova", confirm: false }],
    ["switchPlan", { planId: "nova", confirm: true }],
    ["cancel", undefined],
    ["resume", undefined],
  ] as const)("guards queued %s dispatch and supplies an abort signal", async (operation, data) => {
    renderPlans();
    const options = mocks.options[operation];
    expect(options.request?.signal).toBeInstanceOf(AbortSignal);
    mocks.accountId = "account-B";
    await act(async () => {
      await expect(options.mutation.mutationFn(data ? { data } : undefined)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(options.request?.signal?.aborted).toBe(true);
  });

  it("prevents dispatch across a token await even before the Clerk listener runs", async () => {
    const token = deferred<string | null>();
    mocks.token.mockReturnValue(token.promise);
    const { result } = renderHook(useLifetime);
    const lifetime = result.current!;
    const request = billingAccountRequest(lifetime, "/api/billing/nabuflow/subscribe", {
      method: "POST",
    });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(mocks.token).toHaveBeenCalledOnce());
    mocks.accountId = "account-B";
    await act(async () => {
      token.resolve(null);
      await rejected;
    });
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(lifetime.signal.aborted).toBe(true);
  });

  it("keeps cookie fallback with a real unchanged Clerk account and a null bearer", async () => {
    const { result } = renderHook(useLifetime);
    await expect(
      billingAccountRequest(result.current, "/api/billing/nabuflow/state"),
    ).resolves.toEqual({ ok: true });
    const init = mocks.fetch.mock.calls[0][1] as RequestInit;
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
    expect(init.signal?.aborted).toBe(false);
  });

  it("rejects a late response body after departure and permanently invalidates the old lifetime", async () => {
    const body = deferred<unknown>();
    mocks.fetch.mockResolvedValue({ ok: true, status: 200, json: () => body.promise });
    const { result } = renderHook(useLifetime);
    const oldLifetime = result.current!;
    const request = billingAccountRequest(oldLifetime, "/api/billing/nabuflow/state");
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
    act(() => {
      publishAccount("account-B");
      publishAccount("account-A");
    });
    await act(async () => {
      body.resolve({ card: { last4: "4242" } });
      await rejected;
    });
    expect(oldLifetime.isCurrent()).toBe(false);
    expect(result.current?.isCurrent()).toBe(true);
  });

  it("aborts an unmounted request and cancels its grace wait", async () => {
    const { result, unmount } = renderHook(useLifetime);
    const lifetime = result.current!;
    const waiting = lifetime.wait(15_000);
    unmount();
    await expect(waiting).resolves.toBe(false);
    await expect(
      billingAccountRequest(lifetime, "/api/billing/nabuflow/state"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("does not render account A's cache or legacy shared cache while B loads", async () => {
    mocks.liveQueries = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(billingStateQueryKey("account-A"), { plan: orbit });
    client.setQueryData(["billing-state"], { plan: orbit });
    const incoming = deferred<Response>();
    mocks.fetch.mockReturnValue(incoming.promise);
    function StateProbe() {
      const { data } = useNabuflowState();
      return <p data-testid="account-plan">{data?.plan?.name ?? "loading"}</p>;
    }
    render(
      <QueryClientProvider client={client}>
        <StateProbe />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId("account-plan")).toHaveTextContent("Orbit");
    act(() => publishAccount("account-B"));
    expect(screen.getByTestId("account-plan")).toHaveTextContent("loading");
    await act(async () => incoming.resolve(response({ plan: nova })));
    await waitFor(() => expect(screen.getByTestId("account-plan")).toHaveTextContent("Nova"));
    expect(client.getQueryData(billingStateQueryKey("account-A"))).toEqual({ plan: orbit });
  });

  it("fails closed with a missing or unloaded Clerk principal", () => {
    vi.stubGlobal("Clerk", undefined);
    const view = renderPlans();
    expect(screen.queryByTestId("plan-cta-nova")).toBeNull();
    view.unmount();
    vi.stubGlobal("Clerk", clerk);
    mocks.loaded = false;
    renderPlans();
    expect(screen.queryByTestId("plan-cta-nova")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves the existing DEV-only E2E principal and excludes it in production", async () => {
    vi.stubGlobal("Clerk", undefined);
    vi.stubGlobal("__E2E_TEST_USER__", "existing-e2e-account");
    vi.stubEnv("DEV", true);
    const dev = renderHook(useLifetime);
    await expect(
      billingAccountRequest(dev.result.current, "/api/billing/nabuflow/state"),
    ).resolves.toEqual({ ok: true });
    dev.unmount();
    vi.stubEnv("DEV", false);
    const production = renderHook(useLifetime);
    expect(production.result.current?.isCurrent()).toBe(false);
    await expect(
      billingAccountRequest(production.result.current, "/api/billing/nabuflow/state"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });
});
