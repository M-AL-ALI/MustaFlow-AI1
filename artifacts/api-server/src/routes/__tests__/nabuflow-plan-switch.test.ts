import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const where = vi.fn(async () => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return {
    db: { update },
    update,
    set,
    where,
    getSubscription: vi.fn(),
    ensureCycle: vi.fn(),
    handleSubscriptionEvent: vi.fn(),
    switchStripePlan: vi.fn(),
  };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.db };
});

vi.mock("../../lib/nabuflow-billing", () => ({
  creditsEnforcementEnabled: vi.fn(() => true),
  ensureCurrentNabuflowCycle: h.ensureCycle,
  getNabuflowSpendCapCents: vi.fn(),
  getNabuflowSubscription: h.getSubscription,
  handleNabuflowSubscriptionEvent: h.handleSubscriptionEvent,
  isChargeableNabuflowStatus: vi.fn(() => true),
  isNabuflowBillingExempt: vi.fn(() => false),
  resolveNabuflowBuildGate: vi.fn(),
}));

vi.mock("../../lib/nabuflow-stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nabuflow-stripe")>();
  return {
    ...actual,
    previewNabuflowPlanSwitch: vi.fn(),
    switchNabuflowStripePlan: h.switchStripePlan,
  };
});

vi.mock("../billing", () => ({ ensureStripeCustomer: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { default: router } = await import("../nabuflow-billing");
const { NabuflowStripeError } = await import("../../lib/nabuflow-stripe");

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.userId = "u_upgrade";
    next();
  });
  instance.use(router);
  return instance;
}

const orbitSub = {
  id: 1,
  userId: "u_upgrade",
  planId: "orbit",
  stripeSubscriptionId: "sub_upgrade",
  stripeCustomerId: "cus_upgrade",
  stripeItemId: "si_upgrade",
  status: "active",
};

describe("POST /billing/nabuflow/switch charge-before-grant ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ensureCycle.mockResolvedValue({ id: 41 });
    h.handleSubscriptionEvent.mockResolvedValue(undefined);
  });

  it("persists the paid switch, then grants credits and updates the cycle plan", async () => {
    const paidStripeSubscription = { id: "sub_upgrade", status: "active" };
    h.getSubscription
      .mockResolvedValueOnce(orbitSub)
      .mockResolvedValueOnce({ ...orbitSub, planId: "comet" });
    h.switchStripePlan.mockResolvedValue(paidStripeSubscription);

    const response = await request(app())
      .post("/billing/nabuflow/switch")
      .send({ planId: "comet", confirm: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      planId: "comet",
      upgradedCreditsGranted: 2400,
    });
    expect(h.handleSubscriptionEvent).toHaveBeenCalledWith(
      "customer.subscription.updated",
      paidStripeSubscription,
    );
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        planId: "comet",
        includedCredits: expect.anything(),
        updatedAt: expect.anything(),
      }),
    );
    expect(h.switchStripePlan.mock.invocationCallOrder[0]).toBeLessThan(
      h.handleSubscriptionEvent.mock.invocationCallOrder[0],
    );
    expect(h.handleSubscriptionEvent.mock.invocationCallOrder[0]).toBeLessThan(
      h.set.mock.invocationCallOrder[0],
    );
  });

  it("grants no subscription or cycle entitlement when the immediate charge declines", async () => {
    h.getSubscription.mockResolvedValueOnce(orbitSub);
    h.switchStripePlan.mockRejectedValue(
      new NabuflowStripeError("Your card was declined.", "payment_failed"),
    );

    const response = await request(app())
      .post("/billing/nabuflow/switch")
      .send({ planId: "comet", confirm: true });

    expect(response.status).toBe(402);
    expect(response.body).toEqual({
      error: "Your card was declined.",
      code: "payment_failed",
    });
    expect(h.handleSubscriptionEvent).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });
});
