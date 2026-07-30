/**
 * NabuFlow ↔ Ora webhook ISOLATION tests (Task #1516).
 *
 * Both plan families share one Stripe Customer per account, so routing is the
 * safety-critical piece: a NabuFlow event reaching Ora's handlers would grant
 * Ora monthly credits off a NabuFlow renewal (and vice versa).
 *
 * Covers, in both directions:
 *   - customer.subscription.* routed by metadata.surface === "nabuflow",
 *   - invoice.paid / invoice.payment_failed routed via isNabuflowInvoiceEvent
 *     (metadata-first, local-row fallback),
 *   - payment_method.attached/detached + setup_intent.succeeded → NabuFlow
 *     card-state handlers (webhook-driven, never client calls),
 *   - idempotency: duplicate events never reach NabuFlow handlers,
 *   - handler failure → 500 willRetry + event marked failed (Stripe retries).
 *
 * Same in-memory db stub approach as billing-webhooks.test.ts. The NabuFlow
 * lib is mocked with importOriginal so EVERY export stays defined for any
 * static importer in ../billing's chain; only the webhook-facing handlers are
 * replaced with spies.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock state (hoisted so the vi.mock factories can reach it) ──────────
const h = vi.hoisted(() => {
  const state = {
    claimResult: [{ eventId: "evt_test" }] as Array<{ eventId: string }>,
    selectResult: [] as unknown[],
  };

  const insertReturning = vi.fn(() => Promise.resolve(state.claimResult));
  const updateWhere = vi.fn(() => Promise.resolve(undefined));
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  const makeWhereResult = () => {
    const arr = state.selectResult;
    const thenable = Promise.resolve(arr) as Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
      orderBy: () => { limit: () => Promise<unknown[]> };
    };
    thenable.limit = () => Promise.resolve(arr);
    thenable.orderBy = () => ({ limit: () => Promise.resolve(arr) });
    return thenable;
  };

  const mockDb = {
    select: () => ({ from: () => ({ where: () => makeWhereResult() }) }),
    insert: () => ({
      values: () => ({
        onConflictDoUpdate: () => ({ returning: insertReturning }),
        onConflictDoNothing: () => ({ returning: () => Promise.resolve([]) }),
      }),
    }),
    update: () => ({ set: updateSet }),
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(mockDb),
  };

  const getStripeClientMock = vi.fn();

  const nf = {
    handleNabuflowSubscriptionEvent: vi.fn(async () => undefined),
    handleNabuflowInvoicePaid: vi.fn(async () => undefined),
    handleNabuflowInvoicePaymentFailed: vi.fn(async () => undefined),
    handleNabuflowPaymentMethodAttached: vi.fn(async () => undefined),
    handleNabuflowPaymentMethodDetached: vi.fn(async () => undefined),
    handleNabuflowSetupIntentSucceeded: vi.fn(async () => undefined),
    isNabuflowInvoiceEvent: vi.fn(async () => false),
  };

  return { state, mockDb, insertReturning, updateSet, updateWhere, getStripeClientMock, nf };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.mockDb };
});

vi.mock("../../lib/stripeClient", () => ({
  getUncachableStripeClient: h.getStripeClientMock,
  stripeAvailable: () => true,
  getStripePublishableKey: () => undefined,
  invalidateStripeCredentialCache: () => {},
}));

vi.mock("../../lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Async factory + importOriginal: ../billing reaches this module through BOTH
// static imports (via its route-module chain) and per-event dynamic import(),
// so every real export must remain defined (vitest-dynamic-import-mock-gap).
vi.mock("../../lib/nabuflow-billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/nabuflow-billing")>();
  return { ...actual, ...h.nf };
});

import { handleStripeWebhook } from "../billing";

const stripeStub = {
  webhooks: { constructEvent: vi.fn() },
  subscriptions: { retrieve: vi.fn(), update: vi.fn() },
  paymentIntents: { retrieve: vi.fn() },
};

type FakeRes = {
  statusCode: number;
  body: unknown;
  status: (c: number) => FakeRes;
  json: (b: unknown) => FakeRes;
};

function makeRes(): FakeRes {
  const res = { statusCode: 200, body: undefined } as FakeRes;
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  return res;
}

function makeReq(body: unknown) {
  const rawBody = Buffer.from(JSON.stringify(body));
  return {
    headers: { "stripe-signature": "test-sig" } as Record<string, string>,
    body,
    rawBody,
  } as unknown as Parameters<typeof handleStripeWebhook>[0];
}

function invoke(body: unknown, res: FakeRes) {
  return handleStripeWebhook(
    makeReq(body),
    res as unknown as Parameters<typeof handleStripeWebhook>[1],
  );
}

beforeEach(() => {
  h.state.claimResult = [{ eventId: "evt_test" }];
  h.state.selectResult = [];
  h.insertReturning.mockClear();
  h.updateSet.mockClear();
  h.updateWhere.mockClear();
  h.getStripeClientMock.mockReset();
  h.getStripeClientMock.mockResolvedValue(stripeStub);
  stripeStub.webhooks.constructEvent.mockImplementation((rawBody: Buffer) =>
    JSON.parse(rawBody.toString()),
  );
  for (const fn of Object.values(h.nf)) fn.mockClear();
  h.nf.isNabuflowInvoiceEvent.mockResolvedValue(false);
});

// ─── Subscription lifecycle routing ──────────────────────────────────────────
describe("subscription event routing (shared Stripe Customer)", () => {
  const nabuflowSub = {
    id: "sub_nf_1",
    status: "active",
    metadata: { surface: "nabuflow", userId: "u1", plan: "comet" },
    items: { data: [{ id: "si_1" }] },
  };

  it("routes metadata.surface=nabuflow events to the NabuFlow handler ONLY", async () => {
    const res = makeRes();
    await invoke(
      { id: "evt_nf_sub", type: "customer.subscription.updated", data: { object: nabuflowSub } },
      res,
    );

    expect(h.nf.handleNabuflowSubscriptionEvent).toHaveBeenCalledTimes(1);
    expect(h.nf.handleNabuflowSubscriptionEvent).toHaveBeenCalledWith(
      "customer.subscription.updated",
      nabuflowSub,
    );
    expect(res.body).toMatchObject({ ok: true, surface: "nabuflow", processed: true });
    // Exactly ONE db update ran: the idempotency succeeded-mark. Ora's
    // user_subscriptions sync never executed for this event.
    expect(h.updateSet).toHaveBeenCalledTimes(1);
  });

  it("leaves Ora/workspace subscription events on the legacy path (no NabuFlow call)", async () => {
    h.state.selectResult = [{ id: 5, workspaceId: 5 }];
    const res = makeRes();
    await invoke(
      {
        id: "evt_ora_sub",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_ora_1", metadata: { workspaceId: "5" } } },
      },
      res,
    );

    expect(h.nf.handleNabuflowSubscriptionEvent).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, processed: true });
  });

  it("never lets a duplicate delivery reach the NabuFlow handler (idempotency)", async () => {
    h.state.claimResult = [];
    const res = makeRes();
    await invoke(
      { id: "evt_nf_dup", type: "customer.subscription.updated", data: { object: nabuflowSub } },
      res,
    );

    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(h.nf.handleNabuflowSubscriptionEvent).not.toHaveBeenCalled();
  });

  it("marks the event failed and returns 500 willRetry when the NabuFlow sync throws", async () => {
    h.nf.handleNabuflowSubscriptionEvent.mockRejectedValueOnce(new Error("db boom"));
    const res = makeRes();
    await invoke(
      { id: "evt_nf_fail", type: "customer.subscription.updated", data: { object: nabuflowSub } },
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ willRetry: true });
    // The failed-mark update must run so Stripe's retry can reclaim the row.
    expect(h.updateSet).toHaveBeenCalled();
  });
});

// ─── Invoice routing ─────────────────────────────────────────────────────────
describe("invoice event routing", () => {
  const invoice = { id: "in_1", subscription: "sub_nf_1", attempt_count: 1 };

  it("invoice.paid for a NabuFlow subscription goes to the NabuFlow handler only", async () => {
    h.nf.isNabuflowInvoiceEvent.mockResolvedValue(true);
    const res = makeRes();
    await invoke({ id: "evt_inv_nf", type: "invoice.paid", data: { object: invoice } }, res);

    expect(h.nf.isNabuflowInvoiceEvent).toHaveBeenCalledWith(invoice);
    expect(h.nf.handleNabuflowInvoicePaid).toHaveBeenCalledWith(invoice);
    expect(res.body).toMatchObject({ ok: true, type: "invoice.paid" });
  });

  it("invoice.paid for an Ora subscription never reaches NabuFlow handlers", async () => {
    h.nf.isNabuflowInvoiceEvent.mockResolvedValue(false);
    const res = makeRes();
    await invoke({ id: "evt_inv_ora", type: "invoice.paid", data: { object: invoice } }, res);

    expect(h.nf.handleNabuflowInvoicePaid).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, type: "invoice.paid" });
  });

  it("invoice.payment_failed routes to NabuFlow dunning when linked", async () => {
    h.nf.isNabuflowInvoiceEvent.mockResolvedValue(true);
    const res = makeRes();
    await invoke(
      { id: "evt_invf_nf", type: "invoice.payment_failed", data: { object: invoice } },
      res,
    );

    expect(h.nf.handleNabuflowInvoicePaymentFailed).toHaveBeenCalledWith(invoice);
    expect(res.body).toMatchObject({ ok: true, type: "invoice.payment_failed" });
  });

  it("invoice.payment_failed for Ora skips NabuFlow dunning", async () => {
    h.nf.isNabuflowInvoiceEvent.mockResolvedValue(false);
    const res = makeRes();
    await invoke(
      { id: "evt_invf_ora", type: "invoice.payment_failed", data: { object: invoice } },
      res,
    );

    expect(h.nf.handleNabuflowInvoicePaymentFailed).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({ ok: true, type: "invoice.payment_failed" });
  });

  it("returns 500 willRetry when the NabuFlow invoice handler throws", async () => {
    h.nf.isNabuflowInvoiceEvent.mockResolvedValue(true);
    h.nf.handleNabuflowInvoicePaid.mockRejectedValueOnce(new Error("grant failed"));
    const res = makeRes();
    await invoke({ id: "evt_inv_boom", type: "invoice.paid", data: { object: invoice } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ willRetry: true });
  });
});

// ─── Card-on-file state is webhook-driven ────────────────────────────────────
describe("payment method + setup intent routing", () => {
  it("payment_method.attached reaches the NabuFlow card handler", async () => {
    const pm = { id: "pm_1", customer: "cus_1", card: { brand: "visa", last4: "4242" } };
    const res = makeRes();
    await invoke({ id: "evt_pm_att", type: "payment_method.attached", data: { object: pm } }, res);

    expect(h.nf.handleNabuflowPaymentMethodAttached).toHaveBeenCalledWith(pm);
    expect(res.body).toMatchObject({ ok: true, type: "payment_method.attached" });
  });

  it("payment_method.detached reaches the NabuFlow card handler", async () => {
    const pm = { id: "pm_1", customer: "cus_1" };
    const res = makeRes();
    await invoke({ id: "evt_pm_det", type: "payment_method.detached", data: { object: pm } }, res);

    expect(h.nf.handleNabuflowPaymentMethodDetached).toHaveBeenCalledWith(pm);
  });

  it("setup_intent.succeeded reaches the NabuFlow card handler", async () => {
    const si = { id: "seti_1", customer: "cus_1", payment_method: "pm_9" };
    const res = makeRes();
    await invoke({ id: "evt_si_ok", type: "setup_intent.succeeded", data: { object: si } }, res);

    expect(h.nf.handleNabuflowSetupIntentSucceeded).toHaveBeenCalledWith(si);
    expect(res.body).toMatchObject({ ok: true, type: "setup_intent.succeeded" });
  });
});
