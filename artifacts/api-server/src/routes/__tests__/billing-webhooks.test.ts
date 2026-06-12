/**
 * Stripe webhook regression tests for routes/billing.ts.
 *
 * Covers the webhook *envelope* logic that gates every event:
 *   - extractSubscriptionPeriod: reads the per-item period (newer Stripe API)
 *     and falls back to the legacy top-level fields — the historical source of
 *     "Invalid Date" webhook 500s.
 *   - handleStripeWebhook: stripe-client unavailability (503 so Stripe retries),
 *     malformed payloads (400), status-based idempotency (duplicate skip), the
 *     success path (event marked succeeded), and handler failure (marked failed
 *     + 500 willRetry, row never deleted).
 *
 * @workspace/db opens a real Pool at import, so — like ora-usage.test.ts — we
 * import ONLY the schema index and swap in an in-memory `db` stub. Stripe and
 * the logger are mocked so no network/IO happens.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ── Shared mock state (hoisted so the vi.mock factories can reach it) ──────────
const h = vi.hoisted(() => {
  const state = {
    // Result of the idempotency-claim INSERT ... ON CONFLICT ... RETURNING.
    // Non-empty => we own the event; empty => duplicate, skip.
    claimResult: [{ eventId: "evt_test" }] as Array<{ eventId: string }>,
    // Rows returned by any SELECT chain.
    selectResult: [] as unknown[],
    // When true, the SELECT chain throws — used to drive a handler failure.
    selectThrows: false,
  };

  const insertReturning = vi.fn(() => Promise.resolve(state.claimResult));
  const updateWhere = vi.fn(() => Promise.resolve(undefined));
  const updateSet = vi.fn(() => ({ where: updateWhere }));

  // SELECT chain that supports `.where()` awaited directly AND `.where().limit()`
  // / `.where().orderBy().limit()` by returning a thenable with both methods.
  const makeWhereResult = () => {
    if (state.selectThrows) throw new Error("db boom");
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

  return { state, mockDb, insertReturning, updateSet, updateWhere, getStripeClientMock };
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

import { extractSubscriptionPeriod, handleStripeWebhook } from "../billing";

// Minimal Stripe stub — enough surface for the webhook envelope.
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

// Invoke the handler with a fake req/res, casting the lightweight FakeRes to the
// Express Response shape the handler expects (it only ever calls .status/.json).
function invoke(body: unknown, res: FakeRes) {
  return handleStripeWebhook(
    makeReq(body),
    res as unknown as Parameters<typeof handleStripeWebhook>[1],
  );
}

beforeEach(() => {
  h.state.claimResult = [{ eventId: "evt_test" }];
  h.state.selectResult = [];
  h.state.selectThrows = false;
  h.insertReturning.mockClear();
  h.updateSet.mockClear();
  h.updateWhere.mockClear();
  h.getStripeClientMock.mockReset();
  h.getStripeClientMock.mockResolvedValue(stripeStub);
  // constructEvent: decode the rawBody so the handler sees the same event object
  // the test passed into invoke(), bypassing real signature verification.
  stripeStub.webhooks.constructEvent.mockImplementation((rawBody: Buffer) =>
    JSON.parse(rawBody.toString()),
  );
});

// ─── extractSubscriptionPeriod ───────────────────────────────────────────────
describe("extractSubscriptionPeriod", () => {
  const startSec = 1_700_000_000; // 2023-11-14T22:13:20Z
  const endSec = 1_702_592_000;

  it("reads the per-item period (newer Stripe API shape)", () => {
    const { start, end } = extractSubscriptionPeriod({
      items: { data: [{ current_period_start: startSec, current_period_end: endSec }] },
    });
    expect(start).toEqual(new Date(startSec * 1000));
    expect(end).toEqual(new Date(endSec * 1000));
  });

  it("falls back to legacy top-level fields when no item period present", () => {
    const { start, end } = extractSubscriptionPeriod({
      current_period_start: startSec,
      current_period_end: endSec,
    });
    expect(start).toEqual(new Date(startSec * 1000));
    expect(end).toEqual(new Date(endSec * 1000));
  });

  it("prefers the item period over the top-level period", () => {
    const { start } = extractSubscriptionPeriod({
      current_period_start: startSec,
      items: { data: [{ current_period_start: startSec + 999 }] },
    });
    expect(start).toEqual(new Date((startSec + 999) * 1000));
  });

  it("returns null boundaries when no usable value exists", () => {
    expect(extractSubscriptionPeriod({})).toEqual({ start: null, end: null });
    expect(extractSubscriptionPeriod({ items: { data: [] } })).toEqual({
      start: null,
      end: null,
    });
  });
});

// ─── handleStripeWebhook envelope ────────────────────────────────────────────
describe("handleStripeWebhook", () => {
  it("returns 503 (retryable) when the Stripe client is unavailable", async () => {
    h.getStripeClientMock.mockResolvedValue(null);
    const res = makeRes();
    await invoke({ id: "evt_1", type: "invoice.paid" }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ willRetry: true });
    expect(h.insertReturning).not.toHaveBeenCalled();
  });

  it("rejects a malformed event with 400 before claiming it", async () => {
    const res = makeRes();
    await invoke({ foo: "bar" }, res);
    expect(res.statusCode).toBe(400);
    expect(h.insertReturning).not.toHaveBeenCalled();
  });

  it("skips a duplicate event (idempotency claim returns no row)", async () => {
    h.state.claimResult = [];
    const res = makeRes();
    await invoke({ id: "evt_dup", type: "customer.created" }, res);
    expect(res.body).toMatchObject({ ok: true, duplicate: true });
    expect(h.insertReturning).toHaveBeenCalledTimes(1);
    // No status-transition update should run for a skipped duplicate.
    expect(h.updateSet).not.toHaveBeenCalled();
  });

  it("marks an unhandled event type succeeded and acks ok", async () => {
    const res = makeRes();
    await invoke({ id: "evt_unh", type: "customer.created" }, res);
    expect(res.body).toMatchObject({ ok: true, type: "customer.created" });
    // Exactly the succeeded-mark update.
    expect(h.updateSet).toHaveBeenCalledTimes(1);
  });

  it("routes subscription lifecycle events and marks them processed", async () => {
    h.state.selectResult = [{ id: 5, workspaceId: 5 }];
    const res = makeRes();
    await invoke(
      {
        id: "evt_sub",
        type: "customer.subscription.deleted",
        data: { object: { id: "sub_1", metadata: { workspaceId: "5" } } },
      },
      res,
    );
    expect(res.body).toMatchObject({ ok: true, processed: true });
    expect(h.updateSet).toHaveBeenCalled();
  });

  it("marks the event failed and returns 500 (retryable) when a handler throws", async () => {
    h.state.selectThrows = true;
    const res = makeRes();
    await invoke({ id: "evt_fail", type: "invoice.paid" }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toMatchObject({ willRetry: true });
    // The failed-mark update must run so Stripe's retry can reclaim the row.
    expect(h.updateSet).toHaveBeenCalled();
  });
});
