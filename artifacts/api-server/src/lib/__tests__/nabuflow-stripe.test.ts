/**
 * NabuFlow Stripe integration unit tests (Task #1516).
 *
 * Covers the Stripe-facing invariants with a stubbed client (no network):
 *   - proration preview for mid-cycle plan switches: correct createPreview
 *     call (create_prorations, target price on the existing item) and correct
 *     mapping back to the structured preview — and it is READ-ONLY,
 *   - the hard card gate at subscribe time (no default PM → calm error, no
 *     subscription created),
 *   - `surface: nabuflow` namespacing on subscriptions and lazily-created
 *     products/prices (Ora's products are never touched),
 *   - env-scoped price-id override resolving before any Stripe lookup,
 *   - non-purchasable plans (Constellation stub) refusing self-serve signup.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const mockDb = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    update: () => ({ set: () => ({ where: () => Promise.resolve(undefined) }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };
  const getStripeClientMock = vi.fn();
  return { mockDb, getStripeClientMock };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.mockDb };
});

vi.mock("../stripeClient", () => ({
  getUncachableStripeClient: h.getStripeClientMock,
  stripeAvailable: () => true,
}));

vi.mock("../logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import type { NabuflowSubscription } from "@workspace/db";
import {
  previewNabuflowPlanSwitch,
  createNabuflowStripeSubscription,
  resolveNabuflowPriceId,
  NabuflowStripeError,
  _clearNabuflowPriceCache,
} from "../nabuflow-stripe";
import { NABUFLOW_PLANS } from "../nabuflow-plans";

const stripeStub = {
  invoices: { createPreview: vi.fn() },
  subscriptions: { create: vi.fn(), update: vi.fn() },
  customers: { retrieve: vi.fn(), update: vi.fn() },
  paymentMethods: { retrieve: vi.fn() },
  prices: { list: vi.fn(), create: vi.fn() },
  products: { create: vi.fn() },
};

const PRICE_ENV_KEYS = [
  NABUFLOW_PLANS.orbit.stripePriceIdEnv,
  NABUFLOW_PLANS.comet.stripePriceIdEnv,
  NABUFLOW_PLANS.nova.stripePriceIdEnv,
];
let savedEnv: Record<string, string | undefined>;

const sub = (over: Partial<NabuflowSubscription> = {}): NabuflowSubscription =>
  ({
    id: 1,
    userId: "u_switch",
    planId: "orbit",
    stripeSubscriptionId: "sub_nf_1",
    stripeCustomerId: "cus_shared_1",
    stripeItemId: "si_nf_1",
    status: "active",
    ...over,
  }) as unknown as NabuflowSubscription;

beforeEach(() => {
  savedEnv = {};
  for (const k of PRICE_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  _clearNabuflowPriceCache();
  for (const group of Object.values(stripeStub)) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  h.getStripeClientMock.mockResolvedValue(stripeStub);
});

afterEach(() => {
  for (const k of PRICE_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Proration preview ───────────────────────────────────────────────────────
describe("previewNabuflowPlanSwitch", () => {
  it("asks Stripe for a create_prorations preview on the existing item and maps it back", async () => {
    process.env[NABUFLOW_PLANS.comet.stripePriceIdEnv] = "price_comet_env";
    const periodEndSec = 1_786_492_800; // 2026-08-12T00:00:00Z
    stripeStub.invoices.createPreview.mockResolvedValue({
      amount_due: 1234,
      currency: "usd",
      period_end: periodEndSec,
      lines: {
        data: [
          { description: "Unused time on NabuFlow Orbit", amount: -500 },
          { description: "Remaining time on NabuFlow Comet", amount: 1734 },
        ],
      },
    });

    const preview = await previewNabuflowPlanSwitch(sub(), NABUFLOW_PLANS.comet);

    expect(stripeStub.invoices.createPreview).toHaveBeenCalledWith({
      customer: "cus_shared_1",
      subscription: "sub_nf_1",
      subscription_details: {
        items: [{ id: "si_nf_1", price: "price_comet_env" }],
        proration_behavior: "create_prorations",
      },
    });
    expect(preview).toEqual({
      currentPlanId: "orbit",
      targetPlanId: "comet",
      amountDueCents: 1234,
      currency: "usd",
      periodEnd: new Date(periodEndSec * 1000).toISOString(),
      lines: [
        { description: "Unused time on NabuFlow Orbit", amountCents: -500 },
        { description: "Remaining time on NabuFlow Comet", amountCents: 1734 },
      ],
    });
    // Read-only: a preview must never mutate the subscription.
    expect(stripeStub.subscriptions.update).not.toHaveBeenCalled();
  });

  it("refuses to preview without a live Stripe subscription/item", async () => {
    process.env[NABUFLOW_PLANS.comet.stripePriceIdEnv] = "price_comet_env";
    await expect(
      previewNabuflowPlanSwitch(sub({ stripeItemId: null }), NABUFLOW_PLANS.comet),
    ).rejects.toMatchObject({ code: "no_subscription" });
    expect(stripeStub.invoices.createPreview).not.toHaveBeenCalled();
  });
});

// ─── Hard card gate + namespacing at subscribe ───────────────────────────────
describe("createNabuflowStripeSubscription", () => {
  beforeEach(() => {
    process.env[NABUFLOW_PLANS.orbit.stripePriceIdEnv] = "price_orbit_env";
  });

  it("blocks subscribing with no default payment method — no subscription is created", async () => {
    stripeStub.customers.retrieve.mockResolvedValue({
      id: "cus_shared_1",
      invoice_settings: { default_payment_method: null },
    });

    await expect(
      createNabuflowStripeSubscription({
        customerId: "cus_shared_1",
        userId: "u_new",
        plan: NABUFLOW_PLANS.orbit,
      }),
    ).rejects.toMatchObject({ code: "no_payment_method" });
    expect(stripeStub.subscriptions.create).not.toHaveBeenCalled();
  });

  it("creates the subscription namespaced with surface:nabuflow and error_if_incomplete", async () => {
    stripeStub.customers.retrieve.mockResolvedValue({
      id: "cus_shared_1",
      invoice_settings: { default_payment_method: "pm_1" },
    });
    stripeStub.paymentMethods.retrieve.mockResolvedValue({ id: "pm_1" });
    stripeStub.subscriptions.create.mockResolvedValue({ id: "sub_created" });

    await createNabuflowStripeSubscription({
      customerId: "cus_shared_1",
      userId: "u_new",
      plan: NABUFLOW_PLANS.orbit,
    });

    expect(stripeStub.subscriptions.create).toHaveBeenCalledWith({
      customer: "cus_shared_1",
      items: [{ price: "price_orbit_env" }],
      payment_behavior: "error_if_incomplete",
      collection_method: "charge_automatically",
      metadata: { surface: "nabuflow", plan: "orbit", userId: "u_new" },
    });
  });

  it("turns a declined immediate charge into a calm payment_failed error", async () => {
    stripeStub.customers.retrieve.mockResolvedValue({
      id: "cus_shared_1",
      invoice_settings: { default_payment_method: "pm_1" },
    });
    stripeStub.paymentMethods.retrieve.mockResolvedValue({ id: "pm_1" });
    stripeStub.subscriptions.create.mockRejectedValue(new Error("Your card was declined."));

    await expect(
      createNabuflowStripeSubscription({
        customerId: "cus_shared_1",
        userId: "u_new",
        plan: NABUFLOW_PLANS.orbit,
      }),
    ).rejects.toMatchObject({ code: "payment_failed" });
  });
});

// ─── Price resolution ────────────────────────────────────────────────────────
describe("resolveNabuflowPriceId", () => {
  it("prefers the env-scoped price id (test vs live) over any Stripe lookup", async () => {
    process.env[NABUFLOW_PLANS.nova.stripePriceIdEnv] = "price_nova_env";
    const id = await resolveNabuflowPriceId(
      stripeStub as never,
      NABUFLOW_PLANS.nova,
    );
    expect(id).toBe("price_nova_env");
    expect(stripeStub.prices.list).not.toHaveBeenCalled();
  });

  it("lazily creates a namespaced product+price when none exists", async () => {
    stripeStub.prices.list.mockResolvedValue({ data: [] });
    stripeStub.products.create.mockResolvedValue({ id: "prod_nf_orbit" });
    stripeStub.prices.create.mockResolvedValue({ id: "price_nf_orbit" });

    const id = await resolveNabuflowPriceId(stripeStub as never, NABUFLOW_PLANS.orbit);

    expect(id).toBe("price_nf_orbit");
    expect(stripeStub.products.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { surface: "nabuflow", plan: "orbit" } }),
    );
    expect(stripeStub.prices.create).toHaveBeenCalledWith(
      expect.objectContaining({
        product: "prod_nf_orbit",
        unit_amount: 2000,
        recurring: { interval: "month" },
        lookup_key: NABUFLOW_PLANS.orbit.stripeLookupKey,
        metadata: { surface: "nabuflow", plan: "orbit" },
      }),
    );
  });

  it("refuses self-serve signup for the Constellation stub", async () => {
    await expect(
      resolveNabuflowPriceId(stripeStub as never, NABUFLOW_PLANS.constellation),
    ).rejects.toBeInstanceOf(NabuflowStripeError);
    await expect(
      resolveNabuflowPriceId(stripeStub as never, NABUFLOW_PLANS.constellation),
    ).rejects.toMatchObject({ code: "plan_unavailable" });
  });
});
