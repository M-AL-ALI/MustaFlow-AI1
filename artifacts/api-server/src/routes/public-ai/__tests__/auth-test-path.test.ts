import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request } from "express";

// ─── Mocks ───────────────────────────────────────────────────────────────────
// resolveAuthedOraUser imports ../auth (which imports @workspace/db) and
// @clerk/express. Mock both so the unit under test is hermetic and never opens a
// real DB connection or requires Clerk middleware.

// Shared mock state. Declared via vi.hoisted so it is initialised before the
// hoisted vi.mock factories below reference it.
const mockState = vi.hoisted(() => ({
  getAuthMock: vi.fn(),
  isBillingPrivilegedMock: vi.fn(),
  subscriptionRows: [] as Array<{ tier: string | null; status: string }>,
}));
const { getAuthMock, isBillingPrivilegedMock } = mockState;
function setSubscriptionRows(rows: Array<{ tier: string | null; status: string }>): void {
  mockState.subscriptionRows = rows;
}

vi.mock("@clerk/express", () => ({
  getAuth: (...args: unknown[]) => mockState.getAuthMock(...args),
}));

vi.mock("../../../lib/billing-privileges", () => ({
  BILLING_PRIVILEGE_ORA_TIER: "core",
  isBillingPrivileged: (...args: unknown[]) => mockState.isBillingPrivilegedMock(...args),
}));

// Chainable db.select().from().where() stub whose resolved rows are controlled
// per-test via setSubscriptionRows().
vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve(mockState.subscriptionRows),
      }),
    }),
  },
  userSubscriptionsTable: { userId: "userId", tier: "tier", status: "status" },
  projectsTable: {},
  orgMembersTable: {},
}));

import {
  resolveAuthedOraUser,
  evictTierCache,
  PAID_TIERS,
} from "../../../lib/public-ai/authed-user";

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers } as unknown as Request;
}

describe("resolveAuthedOraUser — test-only authenticated path", () => {
  beforeEach(() => {
    getAuthMock.mockReset();
    isBillingPrivilegedMock.mockReset();
    isBillingPrivilegedMock.mockResolvedValue(false);
    setSubscriptionRows([]);
    // The 60s in-memory tier cache in authed-user.ts survives across tests in
    // the same file; evict the user IDs this suite exercises so each test
    // resolves the tier fresh from the mocked subscription rows.
    evictTierCache("e2e-test-user");
    evictTierCache("clerk-user");
    evictTierCache("owner-user");
    // Default: getAuth throws as it would without clerkMiddleware mounted.
    getAuthMock.mockImplementation(() => {
      throw new Error("clerkMiddleware not mounted");
    });
    process.env.NODE_ENV = "test";
  });

  afterEach(() => {
    delete process.env.E2E_TEST_ENABLED;
    delete process.env.NODE_ENV;
  });

  it("PAID_TIERS contains the paid tiers and excludes free", () => {
    expect(PAID_TIERS.has("core")).toBe(true);
    expect(PAID_TIERS.has("wave")).toBe(true);
    expect(PAID_TIERS.has("free")).toBe(false);
  });

  it("guard ON + test user + paid tier header → paid user (no DB lookup)", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    const result = await resolveAuthedOraUser(
      makeReq({ "x-e2e-test-user": "e2e-test-user", "x-e2e-test-tier": "core" }),
    );
    expect(result).toEqual({ userId: "e2e-test-user", tier: "core", isPaid: true });
  });

  it("guard ON + test user + free tier header → non-paid user", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    const result = await resolveAuthedOraUser(
      makeReq({ "x-e2e-test-user": "e2e-test-user", "x-e2e-test-tier": "free" }),
    );
    expect(result).toEqual({ userId: "e2e-test-user", tier: "free", isPaid: false });
  });

  it("guard ON + test user, no tier header → falls back to subscription lookup", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    setSubscriptionRows([{ tier: "wave", status: "active" }]);
    const result = await resolveAuthedOraUser(makeReq({ "x-e2e-test-user": "e2e-test-user" }));
    expect(result).toEqual({ userId: "e2e-test-user", tier: "wave", isPaid: true });
  });

  it("guard ON + test user, inactive subscription → defaults to free", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    setSubscriptionRows([{ tier: "core", status: "canceled" }]);
    const result = await resolveAuthedOraUser(makeReq({ "x-e2e-test-user": "e2e-test-user" }));
    expect(result).toEqual({ userId: "e2e-test-user", tier: "free", isPaid: false });
  });

  it("guard ON + test user + invalid tier header → ignores header, uses lookup", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    setSubscriptionRows([{ tier: "core", status: "trialing" }]);
    const result = await resolveAuthedOraUser(
      makeReq({ "x-e2e-test-user": "e2e-test-user", "x-e2e-test-tier": "enterprise" }),
    );
    expect(result).toEqual({ userId: "e2e-test-user", tier: "core", isPaid: true });
  });

  it("guard OFF (E2E_TEST_ENABLED unset) → header ignored, anonymous when no Clerk session", async () => {
    // E2E_TEST_ENABLED not set → test path inactive; getAuth throws → null.
    const result = await resolveAuthedOraUser(
      makeReq({ "x-e2e-test-user": "e2e-test-user", "x-e2e-test-tier": "core" }),
    );
    expect(result).toBeNull();
  });

  it("guard FORCED production → header ignored even with E2E_TEST_ENABLED=true", async () => {
    process.env.NODE_ENV = "production";
    process.env.E2E_TEST_ENABLED = "true";
    const result = await resolveAuthedOraUser(
      makeReq({ "x-e2e-test-user": "e2e-test-user", "x-e2e-test-tier": "core" }),
    );
    expect(result).toBeNull();
  });

  it("guard ON, no test-user header → falls through to Clerk session", async () => {
    process.env.E2E_TEST_ENABLED = "true";
    getAuthMock.mockReturnValue({ userId: "clerk-user" });
    setSubscriptionRows([{ tier: "wave", status: "active" }]);
    const result = await resolveAuthedOraUser(makeReq({}));
    expect(result).toEqual({ userId: "clerk-user", tier: "wave", isPaid: true });
  });

  it("real Clerk session, no subscription row → free tier", async () => {
    getAuthMock.mockReturnValue({ userId: "clerk-user" });
    setSubscriptionRows([]);
    const result = await resolveAuthedOraUser(makeReq({}));
    expect(result).toEqual({ userId: "clerk-user", tier: "free", isPaid: false });
  });

  it("real Clerk session, superuser without paid subscription resolves to Core tier", async () => {
    getAuthMock.mockReturnValue({ userId: "owner-user" });
    isBillingPrivilegedMock.mockResolvedValue(true);
    setSubscriptionRows([]);
    const result = await resolveAuthedOraUser(makeReq({}));
    expect(result).toEqual({ userId: "owner-user", tier: "core", isPaid: true });
  });

  it("real Clerk session, superuser with explicit Wave subscription keeps Wave tier", async () => {
    getAuthMock.mockReturnValue({ userId: "owner-user" });
    isBillingPrivilegedMock.mockResolvedValue(true);
    setSubscriptionRows([{ tier: "wave", status: "active" }]);
    const result = await resolveAuthedOraUser(makeReq({}));
    expect(result).toEqual({ userId: "owner-user", tier: "wave", isPaid: true });
  });
});
