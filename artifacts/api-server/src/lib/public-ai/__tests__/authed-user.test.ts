/**
 * Unit tests for resolveTierForUser and evictTierCache (authed-user.ts).
 *
 * Covers:
 *   • Free tier returned when no subscription row exists.
 *   • Paid tier returned for active subscription.
 *   • Cache hit — DB is queried only once within the 60-second TTL.
 *   • evictTierCache forces a fresh DB lookup on the next call.
 *   • grace_period status is treated as an active paid tier.
 *   • Non-active statuses (canceled) fall back to free.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Hoisted: intercepts the dynamic import inside resolveTierForUser.
const dbWhereMock = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: dbWhereMock,
      }),
    }),
  },
  userSubscriptionsTable: {
    userId: Symbol("userId"),
    tier: Symbol("tier"),
    status: Symbol("status"),
  },
}));

// drizzle-orm eq is called on the (mocked) userSubscriptionsTable columns.
// Return a dummy object so it doesn't throw when the column value is a Symbol.
vi.mock("drizzle-orm", () => ({
  eq: vi.fn(() => ({})),
}));

// isBillingPrivileged check — default false so most tests exercise the subscription path.
const isBillingPrivilegedMock = vi.hoisted(() => vi.fn());

vi.mock("../../billing-privileges", () => ({
  isBillingPrivileged: isBillingPrivilegedMock,
  BILLING_PRIVILEGE_ORA_TIER: "wave",
}));

import { resolveTierForUser, evictTierCache } from "../authed-user";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  // resetAllMocks clears call history AND the once-queue (clearAllMocks only
  // clears history, leaving unconsumed mockResolvedValueOnce entries to leak
  // into the next test when a call is skipped via a cache hit).
  vi.resetAllMocks();
  isBillingPrivilegedMock.mockResolvedValue(false);
  // Evict any cached result so each test starts from a clean state.
  evictTierCache("user-1");
  evictTierCache("user-2");
  evictTierCache("superuser");
});

describe("resolveTierForUser — free tier default", () => {
  it("returns free tier when no subscription row is found", async () => {
    dbWhereMock.mockResolvedValue([]);
    const result = await resolveTierForUser("user-1");
    expect(result.userId).toBe("user-1");
    expect(result.tier).toBe("free");
    expect(result.isPaid).toBe(false);
  });

  it("returns free when DB throws (table unavailable env)", async () => {
    dbWhereMock.mockRejectedValue(new Error("relation does not exist"));
    const result = await resolveTierForUser("user-1");
    expect(result.tier).toBe("free");
    expect(result.isPaid).toBe(false);
  });
});

describe("resolveTierForUser — paid tier", () => {
  it("returns core tier and isPaid:true for an active core subscription", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "core", status: "active" }]);
    const result = await resolveTierForUser("user-1");
    expect(result.tier).toBe("core");
    expect(result.isPaid).toBe(true);
  });

  it("returns wave tier for an active wave subscription", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "wave", status: "active" }]);
    const result = await resolveTierForUser("user-1");
    expect(result.tier).toBe("wave");
    expect(result.isPaid).toBe(true);
  });

  it("treats grace_period status as active (paid tier still valid)", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "core", status: "grace_period" }]);
    const result = await resolveTierForUser("user-1");
    expect(result.tier).toBe("core");
    expect(result.isPaid).toBe(true);
  });

  it("falls back to free when subscription status is canceled", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "core", status: "canceled" }]);
    const result = await resolveTierForUser("user-1");
    expect(result.tier).toBe("free");
    expect(result.isPaid).toBe(false);
  });
});

describe("tier cache — TTL caching within 60 s", () => {
  it("caches the result and does not hit DB on the second call", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "core", status: "active" }]);

    await resolveTierForUser("user-1");
    await resolveTierForUser("user-1"); // should be served from cache

    // DB should only have been queried once.
    expect(dbWhereMock).toHaveBeenCalledTimes(1);
  });

  it("returns the cached value even if the underlying DB response would differ", async () => {
    dbWhereMock
      .mockResolvedValueOnce([{ tier: "core", status: "active" }])
      .mockResolvedValueOnce([{ tier: "free", status: "canceled" }]);

    const first = await resolveTierForUser("user-1");
    const second = await resolveTierForUser("user-1"); // cache hit

    expect(first.tier).toBe("core");
    expect(second.tier).toBe("core"); // still core from cache
    expect(dbWhereMock).toHaveBeenCalledTimes(1);
  });

  it("serves independent caches per userId", async () => {
    dbWhereMock
      .mockResolvedValueOnce([{ tier: "core", status: "active" }])
      .mockResolvedValueOnce([{ tier: "wave", status: "active" }]);

    const u1 = await resolveTierForUser("user-1");
    const u2 = await resolveTierForUser("user-2");

    expect(u1.tier).toBe("core");
    expect(u2.tier).toBe("wave");
    expect(dbWhereMock).toHaveBeenCalledTimes(2);
  });
});

describe("evictTierCache — forced fresh lookup", () => {
  it("forces a new DB query after eviction even within the TTL window", async () => {
    dbWhereMock
      .mockResolvedValueOnce([{ tier: "core", status: "active" }])
      .mockResolvedValueOnce([{ tier: "free", status: "canceled" }]);

    await resolveTierForUser("user-1"); // caches "core"
    evictTierCache("user-1");
    const fresh = await resolveTierForUser("user-1"); // fresh DB lookup

    expect(dbWhereMock).toHaveBeenCalledTimes(2);
    expect(fresh.tier).toBe("free");
  });

  it("evicting a non-existent key is a no-op (does not throw)", () => {
    expect(() => evictTierCache("unknown-user")).not.toThrow();
  });

  it("only evicts the specified userId, not others", async () => {
    dbWhereMock
      .mockResolvedValueOnce([{ tier: "core", status: "active" }])
      .mockResolvedValueOnce([{ tier: "wave", status: "active" }])
      .mockResolvedValueOnce([{ tier: "free", status: "canceled" }]);

    await resolveTierForUser("user-1"); // cache user-1 = core
    await resolveTierForUser("user-2"); // cache user-2 = wave

    evictTierCache("user-1"); // only evicts user-1

    await resolveTierForUser("user-1"); // fresh → free (3rd DB call)
    const user2Again = await resolveTierForUser("user-2"); // cache hit — no 4th call

    expect(dbWhereMock).toHaveBeenCalledTimes(3);
    expect(user2Again.tier).toBe("wave"); // still cached
  });
});

describe("isBillingPrivileged fallback", () => {
  it("returns wave tier for a superuser regardless of subscription", async () => {
    dbWhereMock.mockResolvedValue([]);
    isBillingPrivilegedMock.mockResolvedValueOnce(true);

    const result = await resolveTierForUser("superuser");
    expect(result.tier).toBe("wave");
    expect(result.isPaid).toBe(true);
  });

  it("does not call isBillingPrivileged when a paid subscription already exists", async () => {
    dbWhereMock.mockResolvedValue([{ tier: "core", status: "active" }]);

    await resolveTierForUser("user-1");

    // isBillingPrivileged should NOT have been called — the paid sub short-circuits.
    expect(isBillingPrivilegedMock).not.toHaveBeenCalled();
  });
});
