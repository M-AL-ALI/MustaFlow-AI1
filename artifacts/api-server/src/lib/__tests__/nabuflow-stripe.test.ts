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

import { readFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const dbUpdateWhere = vi.fn(() => Promise.resolve(undefined));
  const dbUpdateSet = vi.fn(() => ({ where: dbUpdateWhere }));
  const mockDb = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
    update: vi.fn(() => ({ set: dbUpdateSet })),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };
  const getStripeClientMock = vi.fn();
  return { mockDb, dbUpdateSet, dbUpdateWhere, getStripeClientMock };
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
  cancelNabuflowStripeSubscription,
  cancelPendingNabuflowPlanDowngrade,
  resumeNabuflowStripeSubscription,
  scheduleNabuflowPlanDowngrade,
  switchNabuflowStripePlan,
  createNabuflowStripeSubscription,
  resolveNabuflowPriceId,
  createNabuflowOverageInvoiceItem,
  NabuflowStripeError,
  _clearNabuflowPriceCache,
} from "../nabuflow-stripe";
import { NABUFLOW_PLANS } from "../nabuflow-plans";

const rerun9ScheduleCreateFailure = JSON.parse(
  readFileSync(
    new URL("./fixtures/pd1-rerun9-subscription-schedule-create-400.json", import.meta.url),
    "utf8",
  ),
) as {
  request: { body: { from_subscription: string; metadata: Record<string, string> } };
  response: { status: number; body: { error: { message: string; type: string } } };
};

const rerun9ScheduleUpdateIdempotencyFailure = JSON.parse(
  readFileSync(
    new URL(
      "./fixtures/pd1-rerun9-subscription-schedule-update-idempotency-400.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  firstAttempt: { scheduleId: string; updateRequestId: string; endpoint: string };
  secondAttempt: {
    scheduleId: string;
    updateRequestId: string;
    endpoint: string;
    idempotencyKey: string;
    response: { status: number; body: { error: { message: string; type: string } } };
  };
  cleanup: { requestId: string; endpoint: string; status: number };
};

const rerun9CancelManagedScheduleFailure = JSON.parse(
  readFileSync(
    new URL("./fixtures/pd1-rerun9-subscription-cancel-managed-schedule-400.json", import.meta.url),
    "utf8",
  ),
) as {
  sourceSha256: { screenshot: string; dom: string };
  request: { id: string; endpoint: string; body: { cancel_at_period_end: string } };
  subscription: { id: string; schedule: string; livemode: boolean };
  schedule: {
    id: string;
    status: string;
    metadata: { surface: string; purpose: string; userId: string };
  };
  response: { status: number; body: { error: { message: string; type: string } } };
};

const stripeStub = {
  invoices: { createPreview: vi.fn() },
  subscriptions: { create: vi.fn(), retrieve: vi.fn(), update: vi.fn() },
  subscriptionSchedules: {
    create: vi.fn(),
    retrieve: vi.fn(),
    update: vi.fn(),
    release: vi.fn(),
  },
  customers: { retrieve: vi.fn(), update: vi.fn() },
  paymentMethods: { retrieve: vi.fn() },
  prices: { list: vi.fn(), create: vi.fn() },
  products: { create: vi.fn() },
  invoiceItems: { create: vi.fn() },
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
    currentCycleStart: new Date("2026-08-01T00:00:00.000Z"),
    currentCycleEnd: new Date("2026-09-01T00:00:00.000Z"),
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
  h.mockDb.update.mockClear();
  h.dbUpdateSet.mockClear();
  h.dbUpdateWhere.mockClear();
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
      amount_due: 6234,
      currency: "usd",
      period_end: periodEndSec,
      lines: {
        data: [
          {
            description: "Unused time on NabuFlow Orbit",
            amount: -500,
            parent: {
              subscription_item_details: { subscription_item: "si_nf_1", proration: true },
            },
          },
          {
            description: "Remaining time on NabuFlow Comet",
            amount: 1734,
            parent: {
              subscription_item_details: { subscription_item: "si_nf_1", proration: true },
            },
          },
          {
            description: "1 x NabuFlow Comet ($50.00 / month)",
            amount: 5000,
            parent: {
              subscription_item_details: { subscription_item: "si_nf_1", proration: false },
            },
          },
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
      nextCycleAmountCents: 5000,
      nextCycleStartsAt: new Date(periodEndSec * 1000).toISOString(),
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

  it("previews a downgrade as zero due now without asking Stripe for an invoice", async () => {
    const preview = await previewNabuflowPlanSwitch(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit);

    expect(preview).toEqual({
      currentPlanId: "comet",
      targetPlanId: "orbit",
      amountDueCents: 0,
      nextCycleAmountCents: 2000,
      nextCycleStartsAt: "2026-09-01T00:00:00.000Z",
      currency: "usd",
      periodEnd: "2026-09-01T00:00:00.000Z",
      lines: [],
    });
    expect(stripeStub.invoices.createPreview).not.toHaveBeenCalled();
    expect(stripeStub.prices.list).not.toHaveBeenCalled();
  });
});

describe("deferred plan downgrades", () => {
  beforeEach(() => {
    process.env[NABUFLOW_PLANS.orbit.stripePriceIdEnv] = "price_orbit_env";
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: "sub_nf_1",
      schedule: null,
      items: {
        data: [
          {
            id: "si_nf_1",
            price: { id: "price_comet_env" },
            quantity: 1,
            current_period_start: 1_785_542_400,
            current_period_end: 1_788_220_800,
          },
        ],
      },
    });
    stripeStub.subscriptionSchedules.create.mockResolvedValue({
      id: "sub_sched_1",
      status: "active",
      metadata: null,
      current_phase: { start_date: 1_785_542_400, end_date: 1_788_220_800 },
    });
    stripeStub.subscriptionSchedules.update.mockResolvedValue({ id: "sub_sched_1" });
  });

  it("schedules the lower price at period end with no proration or immediate invoice", async () => {
    const scheduled = await scheduleNabuflowPlanDowngrade(
      sub({ planId: "comet" }),
      NABUFLOW_PLANS.orbit,
    );

    expect(scheduled).toEqual({
      scheduleId: "sub_sched_1",
      effectiveAt: new Date(1_788_220_800 * 1000),
    });
    expect(stripeStub.subscriptionSchedules.create).toHaveBeenCalledWith(
      { from_subscription: "sub_nf_1" },
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(
          /^nabuflow-downgrade-schedule:1:1788220800:[0-9a-f-]{36}$/,
        ),
      }),
    );
    const [createParams] = stripeStub.subscriptionSchedules.create.mock.calls[0]!;
    expect(createParams).not.toHaveProperty("metadata");
    expect(rerun9ScheduleCreateFailure).toMatchObject({
      response: {
        status: 400,
        body: {
          error: {
            message: "You cannot set `metadata` if `from_subscription` is set.",
            type: "invalid_request_error",
          },
        },
      },
    });
    expect(rerun9ScheduleCreateFailure.request.body).toHaveProperty("from_subscription");
    expect(rerun9ScheduleCreateFailure.request.body).toHaveProperty("metadata");
    expect(stripeStub.subscriptionSchedules.update).toHaveBeenCalledWith(
      "sub_sched_1",
      expect.objectContaining({
        end_behavior: "release",
        proration_behavior: "none",
        phases: [
          expect.objectContaining({
            end_date: 1_788_220_800,
            items: [{ price: "price_comet_env", quantity: 1 }],
            proration_behavior: "none",
          }),
          expect.objectContaining({
            start_date: 1_788_220_800,
            items: [{ price: "price_orbit_env", quantity: 1 }],
            proration_behavior: "none",
          }),
        ],
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
    expect(stripeStub.subscriptions.update).not.toHaveBeenCalled();
    expect(stripeStub.invoices.createPreview).not.toHaveBeenCalled();
  });

  it("releases a schedule created by this attempt when its update fails, then rethrows", async () => {
    const updateError = new Error("phase update failed");
    stripeStub.subscriptionSchedules.update.mockRejectedValueOnce(updateError);
    stripeStub.subscriptionSchedules.release.mockResolvedValueOnce({ id: "sub_sched_1" });

    await expect(
      scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit),
    ).rejects.toBe(updateError);

    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledWith(
      "sub_sched_1",
      { preserve_cancel_date: true },
      expect.objectContaining({
        idempotencyKey: "nabuflow-downgrade-cleanup:1:sub_sched_1",
      }),
    );
  });

  it("uses a fresh create idempotency key after a failed attempt is cleaned up", async () => {
    stripeStub.subscriptionSchedules.update.mockRejectedValue(new Error("phase update failed"));
    stripeStub.subscriptionSchedules.release.mockResolvedValue({ id: "sub_sched_1" });

    await expect(
      scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit),
    ).rejects.toThrow("phase update failed");
    await expect(
      scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit),
    ).rejects.toThrow("phase update failed");

    const createKeys = stripeStub.subscriptionSchedules.create.mock.calls.map(
      ([, options]) => options.idempotencyKey,
    );
    expect(createKeys).toHaveLength(2);
    expect(createKeys[0]).not.toBe(createKeys[1]);
  });

  it("scopes the update key to the replacement schedule after an upgrade releases the first", async () => {
    const firstScheduleId = rerun9ScheduleUpdateIdempotencyFailure.firstAttempt.scheduleId;
    const secondScheduleId = rerun9ScheduleUpdateIdempotencyFailure.secondAttempt.scheduleId;
    const liveItems = {
      data: [
        {
          id: "si_nf_1",
          price: { id: "price_comet_env" },
          quantity: 1,
          current_period_start: 1_785_542_400,
          current_period_end: 1_788_220_800,
        },
      ],
    };

    stripeStub.subscriptions.retrieve
      .mockResolvedValueOnce({ id: "sub_nf_1", schedule: null, items: liveItems })
      .mockResolvedValueOnce({
        id: "sub_nf_1",
        schedule: {
          id: firstScheduleId,
          status: "active",
          metadata: {
            surface: "nabuflow",
            purpose: "nabuflow_deferred_downgrade",
            userId: "u_switch",
          },
        },
        items: liveItems,
      })
      .mockResolvedValueOnce({ id: "sub_nf_1", schedule: null, items: liveItems });
    stripeStub.subscriptionSchedules.create
      .mockResolvedValueOnce({
        id: firstScheduleId,
        status: "active",
        metadata: null,
        current_phase: { start_date: 1_785_542_400, end_date: 1_788_220_800 },
      })
      .mockResolvedValueOnce({
        id: secondScheduleId,
        status: "active",
        metadata: null,
        current_phase: { start_date: 1_785_542_400, end_date: 1_788_220_800 },
      });
    const scheduleByUpdateKey = new Map<string, string>();
    stripeStub.subscriptionSchedules.update.mockImplementation(
      async (scheduleId: string, _params: unknown, options: { idempotencyKey: string }) => {
        const originalScheduleId = scheduleByUpdateKey.get(options.idempotencyKey);
        if (originalScheduleId && originalScheduleId !== scheduleId) {
          throw Object.assign(
            new Error(
              rerun9ScheduleUpdateIdempotencyFailure.secondAttempt.response.body.error.message,
            ),
            {
              type: rerun9ScheduleUpdateIdempotencyFailure.secondAttempt.response.body.error.type,
            },
          );
        }
        scheduleByUpdateKey.set(options.idempotencyKey, scheduleId);
        return { id: scheduleId };
      },
    );
    stripeStub.subscriptionSchedules.release.mockResolvedValueOnce({ id: firstScheduleId });

    await scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit);
    await cancelPendingNabuflowPlanDowngrade(sub({ planId: "comet", pendingPlanId: "orbit" }));
    await scheduleNabuflowPlanDowngrade(sub({ planId: "nova" }), NABUFLOW_PLANS.orbit);

    const updateKeys = stripeStub.subscriptionSchedules.update.mock.calls.map(
      ([scheduleId, , options]) => ({ scheduleId, key: options.idempotencyKey }),
    );
    expect(rerun9ScheduleUpdateIdempotencyFailure).toMatchObject({
      secondAttempt: {
        updateRequestId: "req_TVIxkrJGHHdM1Q",
        response: { status: 400, body: { error: { type: "idempotency_error" } } },
      },
      cleanup: { status: 200 },
    });
    expect(updateKeys).toEqual([
      {
        scheduleId: firstScheduleId,
        key: `nabuflow-downgrade:1:${firstScheduleId}:orbit:1788220800`,
      },
      {
        scheduleId: secondScheduleId,
        key: `nabuflow-downgrade:1:${secondScheduleId}:orbit:1788220800`,
      },
    ]);
    expect(updateKeys[0]!.key).not.toBe(updateKeys[1]!.key);
    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledTimes(1);
    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledWith(
      firstScheduleId,
      { preserve_cancel_date: true },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });

  it("replaces an existing owned downgrade schedule instead of creating another", async () => {
    stripeStub.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_nf_1",
      schedule: "sub_sched_existing",
      items: {
        data: [
          {
            id: "si_nf_1",
            price: { id: "price_comet_env" },
            quantity: 1,
            current_period_start: 1_785_542_400,
            current_period_end: 1_788_220_800,
          },
        ],
      },
    });
    stripeStub.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: "sub_sched_existing",
      status: "active",
      metadata: {
        surface: "nabuflow",
        purpose: "nabuflow_deferred_downgrade",
        userId: "u_switch",
      },
      current_phase: { start_date: 1_785_542_400, end_date: 1_788_220_800 },
    });

    await scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit);

    expect(stripeStub.subscriptionSchedules.create).not.toHaveBeenCalled();
    expect(stripeStub.subscriptionSchedules.update).toHaveBeenCalledTimes(1);
  });

  it("never releases a pre-existing attached schedule when its update fails", async () => {
    stripeStub.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_nf_1",
      schedule: "sub_sched_existing",
      items: {
        data: [
          {
            id: "si_nf_1",
            price: { id: "price_comet_env" },
            quantity: 1,
            current_period_start: 1_785_542_400,
            current_period_end: 1_788_220_800,
          },
        ],
      },
    });
    stripeStub.subscriptionSchedules.retrieve.mockResolvedValueOnce({
      id: "sub_sched_existing",
      status: "active",
      metadata: {
        surface: "nabuflow",
        purpose: "nabuflow_deferred_downgrade",
        userId: "u_switch",
      },
      current_phase: { start_date: 1_785_542_400, end_date: 1_788_220_800 },
    });
    stripeStub.subscriptionSchedules.update.mockRejectedValueOnce(new Error("phase update failed"));

    await expect(
      scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit),
    ).rejects.toThrow("phase update failed");

    expect(stripeStub.subscriptionSchedules.release).not.toHaveBeenCalled();
  });

  it("fails closed rather than replacing an unrelated Stripe schedule", async () => {
    stripeStub.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_nf_1",
      schedule: {
        id: "sub_sched_other",
        status: "active",
        metadata: { purpose: "someone_else" },
      },
      items: {
        data: [
          {
            id: "si_nf_1",
            price: { id: "price_comet_env" },
            quantity: 1,
            current_period_start: 1_785_542_400,
            current_period_end: 1_788_220_800,
          },
        ],
      },
    });

    await expect(
      scheduleNabuflowPlanDowngrade(sub({ planId: "comet" }), NABUFLOW_PLANS.orbit),
    ).rejects.toMatchObject({ code: "stripe_error" });
    expect(stripeStub.subscriptionSchedules.update).not.toHaveBeenCalled();
  });

  it("releases an ID-verified owned schedule before a superseding upgrade", async () => {
    stripeStub.subscriptions.retrieve.mockResolvedValueOnce({
      id: "sub_nf_1",
      schedule: {
        id: "sub_sched_owned",
        status: "active",
        metadata: {
          surface: "nabuflow",
          purpose: "nabuflow_deferred_downgrade",
          userId: "u_switch",
        },
      },
      items: { data: [] },
    });
    stripeStub.subscriptionSchedules.release.mockResolvedValue({ id: "sub_sched_owned" });

    await cancelPendingNabuflowPlanDowngrade(sub({ planId: "comet", pendingPlanId: "orbit" }));

    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledWith(
      "sub_sched_owned",
      { preserve_cancel_date: true },
      expect.objectContaining({ idempotencyKey: expect.any(String) }),
    );
  });
});

describe("cancel/resume attached schedule guard", () => {
  const ownedSchedule = {
    id: rerun9CancelManagedScheduleFailure.schedule.id,
    status: rerun9CancelManagedScheduleFailure.schedule.status,
    metadata: rerun9CancelManagedScheduleFailure.schedule.metadata,
  };

  beforeEach(() => {
    stripeStub.subscriptionSchedules.release.mockResolvedValue({ id: ownedSchedule.id });
    stripeStub.subscriptions.update.mockResolvedValue({
      id: rerun9CancelManagedScheduleFailure.subscription.id,
    });
  });

  it("replays Item 8(d): releases the landed owned schedule before canceling", async () => {
    const landed = sub({
      id: 10,
      userId: ownedSchedule.metadata.userId,
      planId: "orbit",
      pendingPlanId: null,
      pendingEffectiveAt: null,
      stripeSubscriptionId: rerun9CancelManagedScheduleFailure.subscription.id,
    });
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: landed.stripeSubscriptionId,
      schedule: ownedSchedule.id,
    });
    stripeStub.subscriptionSchedules.retrieve.mockResolvedValue(ownedSchedule);

    await cancelNabuflowStripeSubscription(landed);

    expect(rerun9CancelManagedScheduleFailure).toMatchObject({
      sourceSha256: {
        screenshot: "266098debb0c90f48bf456e9f45e5812a9bc256136e413bde65cf1476574d556",
        dom: "e2cfe83472d219098215dadbbe5e242c691e40a13b5231cbb4492e4c9ffee800",
      },
      request: { id: "req_JJYIjjdDIb61sJ", body: { cancel_at_period_end: "true" } },
      response: { status: 400, body: { error: { type: "invalid_request_error" } } },
      subscription: { livemode: false },
    });
    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledWith(
      ownedSchedule.id,
      { preserve_cancel_date: true },
      { idempotencyKey: `nabuflow-downgrade-release:10:${ownedSchedule.id}` },
    );
    expect(stripeStub.subscriptions.update).toHaveBeenCalledWith(landed.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    expect(stripeStub.subscriptionSchedules.release.mock.invocationCallOrder[0]).toBeLessThan(
      stripeStub.subscriptions.update.mock.invocationCallOrder[0]!,
    );
  });

  it("releases an attached owned schedule before resuming", async () => {
    const landed = sub({
      id: 11,
      userId: ownedSchedule.metadata.userId,
      planId: "orbit",
      pendingPlanId: null,
      stripeSubscriptionId: rerun9CancelManagedScheduleFailure.subscription.id,
      cancelAtPeriodEnd: true,
    });
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: landed.stripeSubscriptionId,
      schedule: ownedSchedule,
    });

    await resumeNabuflowStripeSubscription(landed);

    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledWith(
      ownedSchedule.id,
      { preserve_cancel_date: true },
      { idempotencyKey: `nabuflow-downgrade-release:11:${ownedSchedule.id}` },
    );
    expect(stripeStub.subscriptions.update).toHaveBeenCalledWith(landed.stripeSubscriptionId, {
      cancel_at_period_end: false,
    });
  });

  it("fails closed for a foreign schedule without releasing or updating", async () => {
    const current = sub({ id: 12, planId: "orbit" });
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: current.stripeSubscriptionId,
      schedule: {
        id: "sub_sched_foreign",
        status: "active",
        metadata: { surface: "other", purpose: "someone_else", userId: current.userId },
      },
    });

    await expect(cancelNabuflowStripeSubscription(current)).rejects.toMatchObject({
      code: "stripe_error",
    });
    expect(stripeStub.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(stripeStub.subscriptions.update).not.toHaveBeenCalled();
    expect(h.mockDb.update).not.toHaveBeenCalled();
  });

  it("keeps the plain cancel path unchanged when no schedule is attached", async () => {
    const current = sub({ id: 13, planId: "orbit" });
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: current.stripeSubscriptionId,
      schedule: null,
    });

    await cancelNabuflowStripeSubscription(current);

    expect(stripeStub.subscriptionSchedules.retrieve).not.toHaveBeenCalled();
    expect(stripeStub.subscriptionSchedules.release).not.toHaveBeenCalled();
    expect(stripeStub.subscriptions.update).toHaveBeenCalledWith(current.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  });

  it("preserves pending downgrade cleanup before canceling", async () => {
    const pending = sub({
      id: 14,
      userId: ownedSchedule.metadata.userId,
      planId: "comet",
      pendingPlanId: "orbit",
      pendingEffectiveAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    stripeStub.subscriptions.retrieve.mockResolvedValue({
      id: pending.stripeSubscriptionId,
      schedule: ownedSchedule,
    });

    await cancelNabuflowStripeSubscription(pending);

    expect(stripeStub.subscriptionSchedules.release).toHaveBeenCalledTimes(1);
    expect(h.dbUpdateSet).toHaveBeenCalledWith(
      expect.objectContaining({ pendingPlanId: null, pendingEffectiveAt: null }),
    );
    expect(stripeStub.subscriptions.update).toHaveBeenCalledWith(pending.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
  });
});

describe("switchNabuflowStripePlan", () => {
  beforeEach(() => {
    process.env[NABUFLOW_PLANS.comet.stripePriceIdEnv] = "price_comet_env";
  });

  it("immediately invoices the upgrade proration with error-if-incomplete payment semantics", async () => {
    const paidSubscription = {
      id: "sub_nf_1",
      status: "active",
      latest_invoice: { id: "in_upgrade", status: "paid" },
    };
    stripeStub.subscriptions.update.mockResolvedValue(paidSubscription);

    await expect(switchNabuflowStripePlan(sub(), NABUFLOW_PLANS.comet)).resolves.toBe(
      paidSubscription,
    );

    expect(stripeStub.subscriptions.update).toHaveBeenCalledWith("sub_nf_1", {
      items: [{ id: "si_nf_1", price: "price_comet_env" }],
      proration_behavior: "always_invoice",
      payment_behavior: "error_if_incomplete",
      metadata: { surface: "nabuflow", plan: "comet", userId: "u_switch" },
    });
  });

  it("turns an immediate upgrade-invoice decline into a calm payment_failed error", async () => {
    stripeStub.subscriptions.update.mockRejectedValue(new Error("Your card was declined."));

    await expect(switchNabuflowStripePlan(sub(), NABUFLOW_PLANS.comet)).rejects.toMatchObject({
      code: "payment_failed",
    });
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
    const id = await resolveNabuflowPriceId(stripeStub as never, NABUFLOW_PLANS.nova);
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

describe("createNabuflowOverageInvoiceItem", () => {
  it("uses the usage event as Stripe's idempotency key", async () => {
    stripeStub.invoiceItems.create.mockResolvedValue({ id: "ii_bw1" });

    await expect(
      createNabuflowOverageInvoiceItem({
        customerId: "cus_shared_1",
        subscriptionId: "sub_nf_1",
        amountCents: 128,
        credits: 10,
        planId: "orbit",
        userId: "u_bw1",
        eventId: 456,
      }),
    ).resolves.toBe("ii_bw1");

    expect(stripeStub.invoiceItems.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 128,
        metadata: expect.objectContaining({ usageEventId: "456" }),
      }),
      { idempotencyKey: "nabuflow-overage-event-456" },
    );
  });
});
