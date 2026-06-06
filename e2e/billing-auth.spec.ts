/**
 * Logged-in billing surface — browser e2e spec.
 *
 * The billing routes sit BEHIND the auth wall, so attachUser() runs and honours
 * the same x-e2e-test-user bypass used elsewhere — but ONLY when
 * isE2ETestAuthEnabled() is true (NODE_ENV !== "production" AND
 * E2E_TEST_ENABLED === "true"). This proves the authenticated billing read
 * surface (credits, subscription, packages, transactions) responds correctly
 * for a logged-in user, and that the auth wall rejects anonymous callers.
 *
 * What this proves:
 *   • An authenticated user (x-e2e-test-user) gets their credit balance,
 *     subscription tier, credit packages, and transaction history.
 *   • New users are provisioned with a sane starting balance + free tier.
 *   • Anonymous callers (no bypass header) are rejected by the auth wall (401).
 *
 * Preconditions:
 *   • API server running at E2E_BASE_URL (default http://localhost:80)
 *   • E2E_TEST_ENABLED=true on the API server (else the suite auto-skips)
 *
 * Run:
 *   npx playwright test e2e/billing-auth.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";
const E2E_TEST_USER = `e2e-billing-${Date.now()}`;

interface CreditsResponse {
  userId?: string;
  balance?: number;
}
interface SubscriptionResponse {
  tier?: string;
  status?: string;
}
interface PackagesResponse {
  stripeConfigured?: boolean;
  packages?: Array<{ id: string; credits: number; priceUsd: number }>;
}
interface TransactionsResponse {
  transactions?: unknown[];
}

async function authedContext(playwright: {
  request: { newContext: (o: unknown) => Promise<APIRequestContext> };
}): Promise<APIRequestContext> {
  return playwright.request.newContext({
    extraHTTPHeaders: { "x-e2e-test-user": E2E_TEST_USER },
  });
}

test.describe("Logged-in billing surface", () => {
  // Probe once: if the bypass isn't enabled on the server, the credits endpoint
  // 401s even with the header. Skip the whole suite rather than fail.
  test.beforeAll(async ({ playwright }) => {
    const request = await authedContext(playwright);
    const res = await request.get(`${BASE_URL}/api/billing/credits`);
    await request.dispose();
    test.skip(
      res.status() === 401,
      "E2E auth bypass not enabled on the server (set E2E_TEST_ENABLED=true).",
    );
  });

  test("returns the user's credit balance", async ({ playwright }) => {
    const request = await authedContext(playwright);
    const res = await request.get(`${BASE_URL}/api/billing/credits`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as CreditsResponse;
    expect(body.userId).toBe(E2E_TEST_USER);
    expect(typeof body.balance).toBe("number");
    expect(body.balance).toBeGreaterThanOrEqual(0);
    await request.dispose();
  });

  test("returns the current subscription tier + status", async ({ playwright }) => {
    const request = await authedContext(playwright);
    const res = await request.get(`${BASE_URL}/api/billing/subscription`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as SubscriptionResponse;
    // A brand-new user defaults to the free tier.
    expect(body.tier).toBe("free");
    expect(typeof body.status).toBe("string");
    await request.dispose();
  });

  test("lists credit packages with prices", async ({ playwright }) => {
    const request = await authedContext(playwright);
    const res = await request.get(`${BASE_URL}/api/billing/packages`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as PackagesResponse;
    expect(Array.isArray(body.packages)).toBe(true);
    expect(body.packages!.length).toBeGreaterThan(0);
    for (const pkg of body.packages!) {
      expect(typeof pkg.id).toBe("string");
      expect(pkg.credits).toBeGreaterThan(0);
      expect(pkg.priceUsd).toBeGreaterThan(0);
    }
    await request.dispose();
  });

  test("returns transaction history as an array", async ({ playwright }) => {
    const request = await authedContext(playwright);
    const res = await request.get(`${BASE_URL}/api/billing/transactions`);
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as TransactionsResponse;
    expect(Array.isArray(body.transactions)).toBe(true);
    await request.dispose();
  });

  test("rejects anonymous callers at the auth wall", async ({ playwright }) => {
    // No x-e2e-test-user header → must be rejected by attachUser.
    const request = await playwright.request.newContext();
    const res = await request.get(`${BASE_URL}/api/billing/credits`);
    expect(res.status()).toBe(401);
    await request.dispose();
  });
});
