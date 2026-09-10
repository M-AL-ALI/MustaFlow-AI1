import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCreateNabuflowOrgSetupIntentUrl,
  getGetNabuflowOrgQueryKey,
  getGetNabuflowOrgUrl,
  getRegisterNabuflowOrgUrl,
  setAuthTokenGetter,
} from "@workspace/api-client-react";
import { OrgSection, OrgSetupDialog } from "./org";
import { billingStateQueryKey } from "./shared";

const mocks = vi.hoisted(() => ({
  accountId: "account-A" as string | null,
  token: vi.fn(),
  fetch: vi.fn(),
  confirmSetup: vi.fn(),
  toast: vi.fn(),
  navigate: vi.fn(),
  org: {} as Record<string, unknown>,
}));

// Keep the generated registration mutation, authFetch, token getter and account
// lifetime real. Only unrelated read hooks and external services are fixtures.
vi.mock("@workspace/api-client-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/api-client-react")>();
  return {
    ...actual,
    useGetNabuflowOrg: () => ({ data: mocks.org, isLoading: false }),
    useGetNabuflowOrgPricing: () => ({ data: undefined, isLoading: false }),
  };
});
vi.mock("./shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./shared")>();
  return { ...actual, useNabuflowState: () => ({ data: { org: null } }) };
});
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: !!mocks.accountId,
    user: mocks.accountId ? { id: mocks.accountId } : null,
  }),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("wouter", () => ({ useLocation: () => ["/billing/plans", mocks.navigate] }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe: async () => ({}) }));
vi.mock("@stripe/react-stripe-js", () => ({
  AddressElement: () => <input aria-label="Company card billing name" />,
  PaymentElement: () => <div data-testid="company-payment-element" />,
  Elements: ({ children }: { children: ReactNode }) => <>{children}</>,
  useElements: () => ({}),
  useStripe: () => ({ confirmSetup: mocks.confirmSetup }),
}));

type Listener = (resources: { user: { id: string } | null }) => void;
const listeners = new Set<Listener>();
const clerk = {
  loaded: true,
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
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => data } as Response;
}
function defaultResponse(input: string, init: RequestInit = {}): Response {
  if (input === "/api/billing/packages")
    return response({ publishableKey: "pk_test_company_fixture" });
  if (input === getCreateNabuflowOrgSetupIntentUrl()) {
    return response({
      clientSecret: "seti_company_fixture_secret",
      setupIntentId: "seti_company_fixture",
    });
  }
  if (input === getRegisterNabuflowOrgUrl() && init.method === "POST") {
    return response({ org: mocks.org.org }, 201);
  }
  if (input === getGetNabuflowOrgUrl()) {
    return response({ ...mocks.org, card: { brand: "visa", last4: "4242" } });
  }
  throw new Error("Unexpected mocked billing endpoint: " + input);
}
function requests(url: string, method: string) {
  return mocks.fetch.mock.calls.filter(
    ([input, init]) => input === url && ((init as RequestInit).method ?? "GET") === method,
  );
}
async function settleAsyncWork() {
  // Drain token/response continuations before asserting that no dispatch occurred.
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}
function renderWithClient(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrap = (child: ReactNode) => (
    <QueryClientProvider client={client}>{child}</QueryClientProvider>
  );
  const view = render(wrap(node));
  return { ...view, client, invalidate, replace: (child: ReactNode) => view.rerender(wrap(child)) };
}
function renderSetup(open = true) {
  const onClose = vi.fn();
  const view = renderWithClient(<OrgSetupDialog open={open} onClose={onClose} />);
  return {
    ...view,
    onClose,
    setOpen: (next: boolean) => view.replace(<OrgSetupDialog open={next} onClose={onClose} />),
  };
}
const form = {
  companyName: "  Example Company  ",
  billingContactEmail: "billing@example.test",
  addressLine1: "10 Example Street",
  city: "Example City",
  postalCode: "10000",
  country: "us",
};
function fillRegistration() {
  for (const [key, value] of Object.entries(form)) {
    fireEvent.change(screen.getByTestId("org-field-" + key), { target: { value } });
  }
}
function submitRegistration() {
  fireEvent.click(screen.getByTestId("org-register-submit"));
}
type Departure = "snapshot" | "switch" | "round-trip" | "reopen" | "unmount";
function departRegistration(view: ReturnType<typeof renderSetup>, departure: Departure) {
  if (departure === "snapshot") mocks.accountId = "account-B";
  else if (departure === "switch") act(() => publishAccount("account-B"));
  else if (departure === "round-trip")
    act(() => {
      publishAccount("account-B");
      publishAccount("account-A");
    });
  else if (departure === "reopen") {
    view.setOpen(false);
    view.setOpen(true);
  } else view.unmount();
}
async function releaseToken(token: ReturnType<typeof deferred<string | null>>, rejection: boolean) {
  await act(async () => {
    if (rejection) token.reject(new Error("Token refresh failed"));
    else token.resolve(null);
  });
  await settleAsyncWork();
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.accountId = "account-A";
  mocks.org = {
    role: "billing_admin",
    org: {
      id: "org-A",
      companyName: "Example Company",
      status: "active",
      billingContactName: "Example Contact",
      billingContactEmail: "billing@example.test",
      addressLine1: "10 Example Street",
      addressLine2: null,
      city: "Example City",
      region: null,
      postalCode: "10000",
      country: "US",
      taxId: null,
      poReference: null,
      invoiceTermsEnabled: false,
      termsNetDays: 30,
      poolCredits: 5000,
    },
    month: {
      resetsAt: "2026-10-01T00:00:00Z",
      drawnUsdCents: 0,
      capUsdCents: 10000,
      seatCapUsdCents: null,
      seatDrawnUsdCents: 0,
    },
    card: null,
    seats: [],
    purchases: [],
    ledger: [],
  };
  mocks.token.mockResolvedValue(null);
  setAuthTokenGetter(mocks.token);
  mocks.fetch.mockImplementation(async (input: string, init?: RequestInit) =>
    defaultResponse(input, init),
  );
  mocks.confirmSetup.mockResolvedValue({ setupIntent: { status: "succeeded" } });
  vi.stubGlobal("Clerk", clerk);
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(async () => {
  cleanup();
  await settleAsyncWork();
  setAuthTokenGetter(null);
  listeners.clear();
  vi.unstubAllGlobals();
  document.body.style.removeProperty("pointer-events");
});

describe("organization registration dispatch lifetime", () => {
  const cases = (["snapshot", "switch", "round-trip", "reopen", "unmount"] as const).flatMap(
    (departure) => [false, true].map((rejection) => ({ departure, rejection })),
  );

  it.each(cases)(
    "blocks pending token dispatch after $departure (rejected token: $rejection)",
    async ({ departure, rejection }) => {
      const token = deferred<string | null>();
      mocks.token.mockReturnValue(token.promise);
      const view = renderSetup();
      expect(mocks.fetch).not.toHaveBeenCalled();
      fillRegistration();
      submitRegistration();
      await waitFor(() => expect(mocks.token).toHaveBeenCalledOnce());
      departRegistration(view, departure);
      if (departure === "reopen") {
        expect(screen.getByTestId("org-field-companyName")).toHaveValue("");
        expect(screen.getByTestId("org-register-submit")).toBeDisabled();
      }
      await releaseToken(token, rejection);
      await waitFor(() => expect(view.client.isMutating()).toBe(0));
      expect(requests(getRegisterNabuflowOrgUrl(), "POST")).toHaveLength(0);
      expect(view.onClose).not.toHaveBeenCalled();
      expect(view.invalidate).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();

      if (departure === "reopen") {
        mocks.token.mockResolvedValue(null);
        fillRegistration();
        submitRegistration();
        await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
        expect(requests(getRegisterNabuflowOrgUrl(), "POST")).toHaveLength(1);
      }
    },
  );

  it.each([
    { departure: "round-trip", status: 201 },
    { departure: "reopen", status: 400 },
    { departure: "unmount", status: 201 },
    { departure: "snapshot", status: 400 },
  ] as const)(
    "drops late registration JSON after $departure (status $status)",
    async ({ departure, status }) => {
      const body = deferred<unknown>();
      const json = vi.fn(() => body.promise);
      mocks.fetch.mockResolvedValue({ ok: status === 201, status, json });
      const view = renderSetup();
      fillRegistration();
      submitRegistration();
      await waitFor(() => expect(json).toHaveBeenCalledOnce());
      departRegistration(view, departure);
      await act(async () =>
        body.resolve(status === 201 ? { org: mocks.org.org } : { error: "Old company error" }),
      );
      await settleAsyncWork();
      await waitFor(() => expect(view.client.isMutating()).toBe(0));
      expect(view.onClose).not.toHaveBeenCalled();
      expect(view.invalidate).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect((mocks.fetch.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
    },
  );

  it("checks the current SDK snapshot before the registration handler starts work", async () => {
    renderSetup();
    fillRegistration();
    mocks.accountId = "account-B";
    submitRegistration();
    await settleAsyncWork();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("preserves validation, error presentation, retry, payload and unchanged-account completion", async () => {
    const view = renderSetup();
    expect(screen.getByTestId("org-register-submit")).toBeDisabled();
    fillRegistration();
    mocks.fetch.mockResolvedValueOnce(response({ error: "Company details need review" }, 400));
    submitRegistration();
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't set up the organization",
          description: "Company details need review",
        }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId("org-register-submit")).toBeEnabled());
    expect(screen.getByTestId("org-field-companyName")).toHaveValue(form.companyName);
    expect(view.onClose).not.toHaveBeenCalled();
    submitRegistration();
    await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce());
    expect(mocks.navigate).toHaveBeenCalledWith("/billing/org");
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Organization created" }),
    );
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: billingStateQueryKey("account-A") });
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: getGetNabuflowOrgQueryKey() });
    const calls = requests(getRegisterNabuflowOrgUrl(), "POST");
    expect(calls).toHaveLength(2);
    const init = calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({
      ...form,
      companyName: "Example Company",
      country: "US",
    });
    expect(init.credentials).toBe("include");
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  it("resets a cancelled form and never registers merely by mounting or reopening", async () => {
    const view = renderSetup(false);
    expect(screen.queryByTestId("org-setup-dialog")).toBeNull();
    view.setOpen(true);
    fillRegistration();
    fireEvent.click(
      within(screen.getByTestId("org-setup-dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(view.onClose).toHaveBeenCalledOnce();
    view.setOpen(false);
    view.setOpen(true);
    expect(screen.getByTestId("org-field-companyName")).toHaveValue("");
    await settleAsyncWork();
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("actual company-card callback transport", () => {
  const setupCases = (["snapshot", "round-trip", "close-reopen", "unmount"] as const).flatMap(
    (departure) => [false, true].map((rejection) => ({ departure, rejection })),
  );

  it.each(setupCases)(
    "blocks old setupIntent dispatch after $departure (rejected token: $rejection)",
    async ({ departure, rejection }) => {
      const token = deferred<string | null>();
      mocks.token.mockReturnValue(token.promise);
      const view = renderWithClient(<OrgSection />);
      expect(mocks.fetch).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId("org-card-manage"));
      await waitFor(() => expect(mocks.token).toHaveBeenCalledTimes(2));
      if (departure === "snapshot") mocks.accountId = "account-B";
      else if (departure === "round-trip")
        act(() => {
          publishAccount("account-B");
          publishAccount("account-A");
        });
      else if (departure === "unmount") view.unmount();
      else {
        fireEvent.click(
          within(screen.getByTestId("card-setup-dialog")).getByRole("button", { name: "Close" }),
        );
        mocks.token.mockResolvedValue(null);
        fireEvent.click(screen.getByTestId("org-card-manage"));
        await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
      }
      await releaseToken(token, rejection);
      expect(requests(getCreateNabuflowOrgSetupIntentUrl(), "POST")).toHaveLength(
        departure === "close-reopen" ? 1 : 0,
      );
      expect(requests(getGetNabuflowOrgUrl(), "GET")).toHaveLength(0);
      expect(mocks.confirmSetup).not.toHaveBeenCalled();
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(view.invalidate).not.toHaveBeenCalled();
    },
  );

  const verifyCases = (["snapshot", "round-trip", "unmount"] as const).flatMap((departure) =>
    [false, true].map((rejection) => ({ departure, rejection })),
  );

  it.each(verifyCases)(
    "blocks verifier dispatch after $departure (rejected token: $rejection)",
    async ({ departure, rejection }) => {
      const view = renderWithClient(<OrgSection />);
      fireEvent.click(screen.getByTestId("org-card-manage"));
      await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
      const token = deferred<string | null>();
      mocks.token.mockClear().mockReturnValue(token.promise);
      fireEvent.click(screen.getByTestId("card-setup-submit"));
      await waitFor(() => expect(mocks.token).toHaveBeenCalledOnce());
      if (departure === "snapshot") mocks.accountId = "account-B";
      else if (departure === "unmount") view.unmount();
      else
        act(() => {
          publishAccount("account-B");
          publishAccount("account-A");
        });
      await releaseToken(token, rejection);
      expect(requests(getGetNabuflowOrgUrl(), "GET")).toHaveLength(0);
      expect(mocks.toast).not.toHaveBeenCalled();
      expect(view.invalidate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { stage: "setup", departure: "round-trip" },
    { stage: "setup", departure: "unmount" },
    { stage: "verify", departure: "round-trip" },
    { stage: "verify", departure: "unmount" },
  ] as const)("drops late company $stage JSON after $departure", async ({ stage, departure }) => {
    const body = deferred<unknown>();
    const json = vi.fn(() => body.promise);
    mocks.fetch.mockImplementation(async (input: string, init: RequestInit = {}) => {
      const target =
        stage === "setup"
          ? input === getCreateNabuflowOrgSetupIntentUrl()
          : input === getGetNabuflowOrgUrl() && (init.method ?? "GET") === "GET";
      return target ? { ok: true, status: 200, json } : defaultResponse(input, init);
    });
    const view = renderWithClient(<OrgSection />);
    fireEvent.click(screen.getByTestId("org-card-manage"));
    if (stage === "verify") {
      await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
      fireEvent.click(screen.getByTestId("card-setup-submit"));
    }
    await waitFor(() => expect(json).toHaveBeenCalledOnce());
    if (departure === "unmount") view.unmount();
    else
      act(() => {
        publishAccount("account-B");
        publishAccount("account-A");
      });
    await act(async () =>
      body.resolve(
        stage === "setup"
          ? { clientSecret: "old_company_secret", setupIntentId: "old_company_intent" }
          : { ...mocks.org, card: { last4: "4242" } },
      ),
    );
    await settleAsyncWork();
    expect(screen.queryByTestId("card-setup-dialog")).toBeNull();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
  });

  it("preserves unchanged-account company setup, verification and onSaved", async () => {
    const view = renderWithClient(<OrgSection />);
    fireEvent.click(screen.getByTestId("org-card-manage"));
    await waitFor(() => expect(screen.getByTestId("card-setup-submit")).toBeEnabled());
    fireEvent.submit(screen.getByTestId("card-setup-submit").closest("form")!);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({ title: "Company card saved" }));
    expect(screen.queryByTestId("card-setup-dialog")).toBeNull();
    expect(mocks.confirmSetup).toHaveBeenCalledOnce();
    expect(requests(getCreateNabuflowOrgSetupIntentUrl(), "POST")).toHaveLength(1);
    expect(requests(getGetNabuflowOrgUrl(), "GET")).toHaveLength(1);
    expect(view.invalidate).toHaveBeenCalledWith({ queryKey: getGetNabuflowOrgQueryKey() });
    for (const [, request] of mocks.fetch.mock.calls) {
      expect(request.credentials).toBe("include");
      expect(new Headers(request.headers).has("authorization")).toBe(false);
    }
  });

  it("keeps an unchanged-account company setup error visible without onSaved", async () => {
    mocks.fetch.mockImplementation(async (input: string, init?: RequestInit) =>
      input === getCreateNabuflowOrgSetupIntentUrl()
        ? response({ error: "Company card setup unavailable" }, 503)
        : defaultResponse(input, init),
    );
    const view = renderWithClient(<OrgSection />);
    fireEvent.click(screen.getByTestId("org-card-manage"));
    expect(
      await screen.findByText("Couldn't start the card setup. Please try again."),
    ).toBeVisible();
    expect(mocks.confirmSetup).not.toHaveBeenCalled();
    expect(view.invalidate).not.toHaveBeenCalled();
  });
});
