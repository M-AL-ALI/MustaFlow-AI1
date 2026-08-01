import express from "express";
import { readFileSync } from "node:fs";
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
    resolveGate: vi.fn(),
    ensureCycle: vi.fn(),
    handleSubscriptionEvent: vi.fn(),
    cancelPendingDowngrade: vi.fn(),
    scheduleDowngrade: vi.fn(),
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
  resolveNabuflowBuildGate: h.resolveGate,
}));

vi.mock("../../lib/nabuflow-org", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nabuflow-org")>();
  return {
    ...actual,
    getNabuflowOrgSeatContext: vi.fn(async () => null),
  };
});

vi.mock("../../lib/nabuflow-stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nabuflow-stripe")>();
  return {
    ...actual,
    cancelPendingNabuflowPlanDowngrade: h.cancelPendingDowngrade,
    previewNabuflowPlanSwitch: vi.fn(),
    scheduleNabuflowPlanDowngrade: h.scheduleDowngrade,
    switchNabuflowStripePlan: h.switchStripePlan,
  };
});

vi.mock("../billing", () => ({ ensureStripeCustomer: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { default: router } = await import("../nabuflow-billing");
const { NabuflowStripeError } = await import("../../lib/nabuflow-stripe");
const rerun8Item8 = JSON.parse(
  readFileSync(
    new URL(
      "../../../../../docs/evidence/pd15/rerun8-item8-immediate-downgrade.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  subscription: { beforePlanId: string; currentCycleEnd: string };
};

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

const cometSub = {
  ...orbitSub,
  planId: rerun8Item8.subscription.beforePlanId,
  currentCycleStart: new Date("2026-08-01T00:00:00.000Z"),
  currentCycleEnd: new Date(rerun8Item8.subscription.currentCycleEnd),
};

describe("POST /billing/nabuflow/switch charge-before-grant ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.ensureCycle.mockResolvedValue({ id: 41 });
    h.handleSubscriptionEvent.mockResolvedValue(undefined);
    h.resolveGate.mockResolvedValue({ allowed: true });
    h.cancelPendingDowngrade.mockResolvedValue(undefined);
    h.scheduleDowngrade.mockResolvedValue({
      scheduleId: "sub_sched_1",
      effectiveAt: new Date(rerun8Item8.subscription.currentCycleEnd),
    });
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

  it("schedules a downgrade while leaving the current plan and cycle entitlements untouched", async () => {
    h.getSubscription.mockResolvedValueOnce(cometSub);

    const response = await request(app())
      .post("/billing/nabuflow/switch")
      .send({ planId: "orbit", confirm: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      planId: "comet",
      pendingPlanId: "orbit",
      pendingEffectiveAt: rerun8Item8.subscription.currentCycleEnd,
      upgradedCreditsGranted: 0,
    });
    expect(h.scheduleDowngrade).toHaveBeenCalledWith(
      cometSub,
      expect.objectContaining({ id: "orbit" }),
    );
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingPlanId: "orbit",
        pendingEffectiveAt: new Date(rerun8Item8.subscription.currentCycleEnd),
      }),
    );
    expect(h.switchStripePlan).not.toHaveBeenCalled();
    expect(h.handleSubscriptionEvent).not.toHaveBeenCalled();
    expect(h.ensureCycle).not.toHaveBeenCalled();
  });

  it("cancels a pending downgrade before running the unchanged immediate-upgrade path", async () => {
    const pendingComet = { ...cometSub, pendingPlanId: "orbit", pendingEffectiveAt: new Date() };
    const paidStripeSubscription = { id: "sub_upgrade", status: "active" };
    h.getSubscription
      .mockResolvedValueOnce(pendingComet)
      .mockResolvedValueOnce({ ...pendingComet, planId: "nova", pendingPlanId: null });
    h.switchStripePlan.mockResolvedValueOnce(paidStripeSubscription);

    const response = await request(app())
      .post("/billing/nabuflow/switch")
      .send({ planId: "nova", confirm: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, planId: "nova" });
    expect(h.cancelPendingDowngrade).toHaveBeenCalledWith(pendingComet);
    expect(h.cancelPendingDowngrade.mock.invocationCallOrder[0]).toBeLessThan(
      h.switchStripePlan.mock.invocationCallOrder[0],
    );
    expect(h.set).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanId: null, pendingEffectiveAt: null }),
    );
  });

  it("keeps the current Comet plan and Deep allowance in the state endpoint while Orbit is pending", async () => {
    h.getSubscription.mockResolvedValueOnce({
      ...cometSub,
      pendingPlanId: "orbit",
      pendingEffectiveAt: new Date(rerun8Item8.subscription.currentCycleEnd),
      defaultPaymentMethodId: "pm_test",
      cardBrand: "visa",
      cardLast4: "4242",
      cardExpMonth: 12,
      cardExpYear: 2030,
      dunningStatus: "none",
      dunningGraceUntil: null,
      cancelAtPeriodEnd: false,
    });
    h.ensureCycle.mockResolvedValueOnce({
      id: 41,
      includedCredits: 4000,
      rolloverCredits: 0,
      usedIncludedCredits: 0,
      overageCredits: 0,
      overageUsdCents: 0,
      proBuildsUsed: 0,
      deepBuildsUsed: 0,
    });

    const response = await request(app()).get("/billing/nabuflow/state");

    expect(response.status).toBe(200);
    expect(response.body.plan.id).toBe("comet");
    expect(response.body.subscription).toMatchObject({
      pendingPlanId: "orbit",
      pendingEffectiveAt: rerun8Item8.subscription.currentCycleEnd,
    });
    expect(response.body.cycle.remainingDeepBuilds).toBe(10);
  });
});
