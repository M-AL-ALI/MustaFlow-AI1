import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-fetch", () => ({ authFetch }));
vi.mock("@/components/support-report-link", () => ({
  SupportErrorMessage: ({ message }: { message: string }) => <span>{message}</span>,
}));

import { PublishingHealthBanner } from "./publishing-health-banner";
import { DomainPurchaseWidget } from "./domain-purchase-widget";
import { RegistrarGuideSection } from "./dns-records-panel";

const receipt = {
  status: "passed",
  rootStatus: 200,
  routesChecked: 3,
  routesFailed: 0,
  failureSummary: null,
  createdAt: "2026-09-08T10:00:00Z",
};
const quote = {
  domain: "garden.example",
  tld: "example",
  available: true,
  price: 12.5,
  renewalPrice: 18,
  isPremium: false,
};
const searchResponse = { namecheapEnabled: true, results: [quote] };

function reply(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}
function deferred() {
  let resolve!: (value: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function mutations() {
  return authFetch.mock.calls.filter(([, init]) => init?.method && init.method !== "GET");
}
function searchDomains() {
  fireEvent.change(screen.getByRole("textbox", { name: "Domain name" }), {
    target: { value: "garden.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search domains" }));
}

beforeEach(() => {
  authFetch.mockReset();
  authFetch.mockImplementation(async (url: string) =>
    reply(url.includes("/health-checks") ? { latest: receipt } : searchResponse),
  );
});
afterEach(cleanup);

describe("Publishing health presentation", () => {
  it("defines build, deployment and verification separately and only reads status on mount", async () => {
    render(<PublishingHealthBanner projectId={4101} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading saved health status");
    expect(await screen.findByRole("heading", { name: "Last live check passed" })).toBeVisible();
    const definitions = within(screen.getByLabelText("Publishing status definitions"));
    expect(definitions.getByText("Building")).toBeVisible();
    expect(definitions.getByText("Deployed")).toBeVisible();
    expect(definitions.getByText("Live verified")).toBeVisible();
    expect(screen.getByText(/not tied to a deployment revision/)).toBeVisible();
    expect(screen.getByText("3 checked / 0 failed")).toBeVisible();
    expect(mutations()).toEqual([]);
  });

  it("shows no saved observation without claiming a failed or verified deployment", async () => {
    authFetch.mockResolvedValue(reply({ latest: null }));
    render(<PublishingHealthBanner projectId={4101} />);
    expect(await screen.findByRole("heading", { name: "No saved live check" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Last live check passed" }),
    ).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it.each(["http", "network", "malformed"])(
    "distinguishes %s loading failure from no history and retries with a GET",
    async (failure) => {
      let fail = true;
      authFetch.mockImplementation(async () => {
        if (!fail) return reply({ latest: receipt });
        if (failure === "network") throw new Error("Offline");
        return failure === "malformed" ? reply({}) : reply({}, 503);
      });
      render(<PublishingHealthBanner projectId={4101} />);
      expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded");
      expect(screen.queryByText("No saved live check")).not.toBeInTheDocument();
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry health status" }));
      expect(await screen.findByRole("heading", { name: "Last live check passed" })).toBeVisible();
      expect(mutations()).toEqual([]);
    },
  );

  it.each(["failed", "partial"])(
    "keeps a %s receipt separate from passed and preserves the errors handler",
    async (status) => {
      const onErrors = vi.fn();
      authFetch.mockResolvedValue(
        reply({
          latest: {
            ...receipt,
            status,
            routesFailed: 1,
            failureSummary: "One route did not respond",
          },
        }),
      );
      render(<PublishingHealthBanner projectId={4101} onShowProdErrors={onErrors} />);
      expect(await screen.findByText("One route did not respond")).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Last live check passed" }),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "View production errors" }));
      expect(onErrors).toHaveBeenCalledOnce();
    },
  );

  it("runs a check only after a click and keeps the prior observation on a rejected request", async () => {
    authFetch.mockImplementation(async (url: string) =>
      url.endsWith("/run") ? reply({}, 503) : reply({ latest: receipt }),
    );
    render(<PublishingHealthBanner projectId={4101} />);
    await screen.findByRole("heading", { name: "Last live check passed" });
    expect(mutations()).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Run live check" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("live check could not be confirmed");
    expect(screen.getByRole("heading", { name: "Last live check passed" })).toBeVisible();
    expect(mutations()).toEqual([["/api/projects/4101/health-checks/run", { method: "POST" }]]);
  });

  it("retains the saved timestamp when a requested check has not produced a new result", async () => {
    render(<PublishingHealthBanner projectId={4101} />);
    await screen.findByRole("heading", { name: "Last live check passed" });
    fireEvent.click(screen.getByRole("button", { name: "Run live check" }));
    expect(await screen.findByText(/A live check was requested/)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Run live check" })).toBeEnabled(),
    );
    expect(document.querySelector("time")).toHaveAttribute("datetime", receipt.createdAt);
  });

  it.each(["success", "failure"])(
    "ignores a previous project's late health %s",
    async (outcome) => {
      const old = deferred();
      authFetch.mockImplementation((url: string) =>
        url.includes("/4101/")
          ? old.promise
          : Promise.resolve(
              reply({
                latest: { ...receipt, status: "failed", failureSummary: "Bakery health failed" },
              }),
            ),
      );
      const view = render(<PublishingHealthBanner projectId={4101} />);
      view.rerender(<PublishingHealthBanner projectId={4102} />);
      await screen.findByText("Bakery health failed");
      await act(async () => {
        if (outcome === "success") old.resolve(reply({ latest: receipt }));
        else old.reject(new Error("Old failure"));
      });
      expect(screen.getByText("Bakery health failed")).toBeVisible();
      expect(
        screen.queryByRole("heading", { name: "Last live check passed" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );
});

describe("Domain quotes and explicit checkout", () => {
  it("shows returned registration and renewal amounts separately without a request on mount", async () => {
    render(<DomainPurchaseWidget projectId={4101} />);
    expect(authFetch).not.toHaveBeenCalled();
    searchDomains();
    const card = within(await screen.findByRole("article", { name: quote.domain }));
    expect(card.getByText("Registration quote")).toBeVisible();
    expect(card.getByText("$12.50")).toBeVisible();
    expect(card.getByText("Renewal quote")).toBeVisible();
    expect(card.getByText("$18.00")).toBeVisible();
    expect(screen.queryByText(/\/yr/)).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it.each(["http", "network", "malformed"])(
    "shows a retry for %s search errors without claiming no results",
    async (failure) => {
      let fail = true;
      authFetch.mockImplementation(async () => {
        if (!fail) return reply(searchResponse);
        if (failure === "network") throw new Error("Offline");
        return failure === "malformed"
          ? reply({ results: [{}], namecheapEnabled: true })
          : reply({}, 503);
      });
      render(<DomainPurchaseWidget projectId={4101} />);
      searchDomains();
      expect(await screen.findByRole("alert")).toHaveTextContent("Could not check availability");
      expect(screen.queryByText(/No domain results/)).not.toBeInTheDocument();
      fail = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry domain search" }));
      expect(await screen.findByRole("article", { name: quote.domain })).toBeVisible();
      expect(mutations()).toEqual([]);
    },
  );

  it.each([
    { available: null, price: 12.5, enabled: true, label: "Availability unconfirmed" },
    { available: false, price: 12.5, enabled: true, label: "Not available" },
    { available: true, price: null, enabled: true, label: "Not provided" },
    { available: true, price: 12.5, enabled: false, label: "Available at last search" },
  ])(
    "blocks checkout for an unconfirmed, unavailable, unquoted or disabled result: $label",
    async ({ available, price, enabled, label }) => {
      authFetch.mockResolvedValue(
        reply({ namecheapEnabled: enabled, results: [{ ...quote, available, price }] }),
      );
      render(<DomainPurchaseWidget projectId={4101} />);
      searchDomains();
      expect(await screen.findByText(label)).toBeVisible();
      expect(
        screen.getByRole("button", { name: `Review checkout for ${quote.domain}` }),
      ).toBeDisabled();
      expect(mutations()).toEqual([]);
    },
  );

  it("preserves a zero quote and explicitly identifies a missing renewal quote during review", async () => {
    authFetch.mockResolvedValue(
      reply({ ...searchResponse, results: [{ ...quote, price: 0, renewalPrice: null }] }),
    );
    render(<DomainPurchaseWidget projectId={4101} />);
    searchDomains();
    fireEvent.click(
      await screen.findByRole("button", { name: `Review checkout for ${quote.domain}` }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "Review domain checkout" }));
    expect(dialog.getByText("$0.00")).toBeVisible();
    expect(dialog.getByText(/No renewal quote was provided/)).toBeVisible();
    expect(dialog.getByText("Target project #4101")).toBeVisible();
    expect(mutations()).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });

  it("uses the existing checkout request only after confirmation and exposes a missing payment URL", async () => {
    const purchase = deferred();
    authFetch.mockImplementation((url: string) =>
      url === "/api/domains/purchase" ? purchase.promise : Promise.resolve(reply(searchResponse)),
    );
    render(<DomainPurchaseWidget projectId={4101} />);
    searchDomains();
    fireEvent.click(
      await screen.findByRole("button", { name: `Review checkout for ${quote.domain}` }),
    );
    const dialog = within(screen.getByRole("dialog"));
    expect(mutations()).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Continue to checkout" }));
    expect(mutations()).toHaveLength(1);
    const [url, init] = mutations()[0];
    expect(url).toBe("/api/domains/purchase");
    expect(JSON.parse(init.body)).toMatchObject({ hostname: quote.domain, projectId: 4101 });
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    await act(async () => {
      purchase.resolve(reply({}));
    });
    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "Checkout did not return a payment page",
    );
    expect(dialog.getByRole("button", { name: "Continue to checkout" })).toBeEnabled();
    expect(mutations()).toHaveLength(1);
  });

  it("drops an old project's delayed search and review when the target project changes", async () => {
    const old = deferred();
    authFetch.mockImplementationOnce(() => old.promise);
    const view = render(<DomainPurchaseWidget projectId={4101} />);
    searchDomains();
    view.rerender(<DomainPurchaseWidget projectId={4102} />);
    await act(async () => {
      old.resolve(reply(searchResponse));
    });
    expect(screen.getByRole("textbox", { name: "Domain name" })).toHaveValue("");
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
    searchDomains();
    fireEvent.click(
      await screen.findByRole("button", { name: `Review checkout for ${quote.domain}` }),
    );
    expect(within(screen.getByRole("dialog")).getByText("Target project #4102")).toBeVisible();
    view.rerender(<DomainPurchaseWidget projectId={4103} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mutations()).toEqual([]);
  });
});

it("explains registrar ownership separately and changes instructions without changing provider settings", () => {
  render(<RegistrarGuideSection />);
  expect(screen.getByText(/adding records does not transfer domain registration/)).toBeVisible();
  expect(screen.getByText(/renewal charges and renewal settings/)).toBeVisible();
  expect(screen.getByRole("button", { name: "GoDaddy" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Namecheap" }));
  expect(screen.getByRole("button", { name: "Namecheap" })).toHaveAttribute("aria-pressed", "true");
  expect(
    screen.getByRole("heading", { name: "Namecheap: add the required records" }),
  ).toBeVisible();
  expect(authFetch).not.toHaveBeenCalled();
});
