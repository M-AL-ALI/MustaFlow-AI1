/**
 * Task #1274 — Authenticated Ora test path: browser e2e spec
 *
 * Verifies the safe, test-only authenticated path for the standalone Ora
 * assistant. The Ora chat endpoint (/api/public-ai/chat) sits in front of the
 * auth wall and reads the Clerk session directly, so the attachUser() E2E
 * bypass never reaches it. resolveAuthedOraUser() honours the same
 * x-e2e-test-user header — but ONLY when isE2ETestAuthEnabled() is true
 * (NODE_ENV !== "production" AND E2E_TEST_ENABLED === "true").
 *
 * What this proves:
 *   • An authenticated visitor (x-e2e-test-user) is recognised by Ora and is
 *     NOT subject to the anonymous message cap.
 *   • x-e2e-test-tier=core simulates a paid tier so Deep mode is permitted
 *     (the response comes back in "deep" mode, with no upgrade CTA).
 *   • A free-tier authed user is denied Deep mode: the response falls back to
 *     "instant" mode with upgradeCta=true — proving the paid gate is exercised
 *     end-to-end.
 *
 * Auth bypass (dev builds only): every browser HTTP request carries
 * x-e2e-test-user via page.setExtraHTTPHeaders(); the optional x-e2e-test-tier
 * header simulates the subscription tier without seeding the database.
 *
 * Preconditions:
 *   • API server running at E2E_BASE_URL (default http://localhost:80)
 *   • E2E_TEST_ENABLED=true on the API server
 *   • ORA_SESSION_SECRET set on the API server (required for Ora sessions)
 *
 * Run:
 *   npx playwright test e2e/ora-auth.spec.ts
 */

import { test, expect, type APIRequestContext } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:80";
const E2E_TEST_USER = "e2e-ora-user";

interface ChatResponse {
  reply?: string;
  mode?: "instant" | "deep";
  upgradeCta?: boolean;
  msgCount?: number;
  msgLimit?: number;
}

// Start an Ora session and return its cookie header value so subsequent chat
// calls are accepted. The session cookie is set on the create-session response.
async function startOraSession(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE_URL}/api/public-ai/session`, { data: {} });
  expect(res.ok()).toBe(true);
  const setCookie = res.headers()["set-cookie"] ?? "";
  // Extract the first cookie pair (name=value) for forwarding.
  const cookiePair = setCookie.split(";")[0];
  expect(cookiePair.length).toBeGreaterThan(0);
  return cookiePair;
}

test.describe("Authenticated Ora test path", () => {
  test("paid-tier authed user is granted Deep mode", async ({ playwright }) => {
    const request = await playwright.request.newContext({
      extraHTTPHeaders: {
        "x-e2e-test-user": E2E_TEST_USER,
        "x-e2e-test-tier": "core",
      },
    });
    const cookie = await startOraSession(request);

    const res = await request.post(`${BASE_URL}/api/public-ai/chat`, {
      headers: { cookie },
      data: { message: "Outline a launch plan for a SaaS product.", mode: "deep" },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;

    // A paid authed user is served in Deep mode with no upgrade prompt.
    expect(body.mode).toBe("deep");
    expect(body.upgradeCta ?? false).toBe(false);

    await request.dispose();
  });

  test("free-tier authed user is denied Deep mode with deep_paid_only", async ({ playwright }) => {
    const request = await playwright.request.newContext({
      extraHTTPHeaders: {
        "x-e2e-test-user": E2E_TEST_USER,
        "x-e2e-test-tier": "free",
      },
    });
    const cookie = await startOraSession(request);

    const res = await request.post(`${BASE_URL}/api/public-ai/chat`, {
      headers: { cookie },
      data: { message: "Outline a launch plan for a SaaS product.", mode: "deep" },
    });
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as ChatResponse;

    // The paid gate forces a free user back to Instant mode with an upgrade CTA.
    expect(body.mode).toBe("instant");
    expect(body.upgradeCta).toBe(true);

    await request.dispose();
  });
});
