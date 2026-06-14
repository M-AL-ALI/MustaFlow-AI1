import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROUTES_SRC = join(__dirname, "..");
const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_SRC, filename), "utf-8");
}

function readRepo(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf-8");
}

describe("billing subscription checkout wiring", () => {
  it("exposes current Ora plan limits and prices in subscription metadata", () => {
    const billing = readRoute("billing.ts");

    expect(billing).toContain("30 Ora messages every 5 hours");
    expect(billing).toContain("4 Ora images every 5 hours");
    expect(billing).toContain("100 Ora messages every 3 hours");
    expect(billing).toContain("15 Ora images every 3 hours");
    expect(billing).toContain("280 Ora messages every 3 hours");
    expect(billing).toContain("30 Ora images every 3 hours");
    expect(billing).not.toContain("3 AI images / month");
    expect(billing).not.toContain("12 AI images / month");
  });

  it("creates Stripe subscriptions with a saved default payment method for renewals", () => {
    const billing = readRoute("billing.ts");
    const subscribeStart = billing.indexOf('router.post("/billing/subscribe"');
    const checkoutStart = billing.indexOf("stripe.checkout.sessions.create", subscribeStart);
    const subscribeEnd = billing.indexOf(
      'router.post("/billing/cancel-subscription"',
      checkoutStart,
    );
    const subscribeBlock = billing.slice(checkoutStart, subscribeEnd);

    expect(subscribeBlock).toContain('mode: "subscription"');
    expect(subscribeBlock).toContain('payment_method_collection: "always"');
    expect(subscribeBlock).toContain("saved_payment_method_options");
    expect(subscribeBlock).toContain('payment_method_save: "enabled"');
    expect(subscribeBlock).toContain("subscription_data");
    expect(subscribeBlock).toContain("metadata: { userId, tier: tier as string }");
  });

  it("saves payment methods on the plan checkout route used by the UI", () => {
    const billing = readRoute("billing.ts");
    const routeStart = billing.indexOf('router.post("/billing/subscription/checkout"');
    const routeEnd = billing.indexOf('router.post("/billing/subscription/portal"', routeStart);
    const routeBlock = billing.slice(routeStart, routeEnd);

    expect(routeBlock).toContain('mode: "subscription"');
    expect(routeBlock).toContain('payment_method_collection: "always"');
    expect(routeBlock).toContain("saved_payment_method_options");
    expect(routeBlock).toContain('payment_method_save: "enabled"');
    expect(routeBlock).toContain("subscription_data");
  });

  it("keeps paid features active on successful renewal and downgrades only after failed retries", () => {
    const billing = readRoute("billing.ts");

    expect(billing).toContain('case "invoice.paid"');
    expect(billing).toContain("await handleInvoicePaid");
    expect(billing).toContain("maybeGrantMonthlyCredits(sub.userId, subscriptionId");
    expect(billing).toContain('status: "active"');
    expect(billing).toContain('case "invoice.payment_failed"');
    expect(billing).toContain("attemptCount >= 3");
    expect(billing).toContain('tier: "free"');
    expect(billing).toContain('status: "grace_period"');
  });

  it("includes a safe Stripe billing verifier for real test-mode smoke checks", () => {
    const pkg = readRepo("scripts/package.json");
    const verifier = readRepo("scripts/src/verify-stripe-billing.ts");

    expect(pkg).toContain('"verify:stripe-billing": "tsx ./src/verify-stripe-billing.ts"');
    expect(verifier).toContain("STRIPE_CORE_PRICE_ID");
    expect(verifier).toContain("STRIPE_WAVE_PRICE_ID");
    expect(verifier).toContain("amountCents: 2_000");
    expect(verifier).toContain("amountCents: 6_500");
    expect(verifier).toContain('payment_method_collection: "always"');
    expect(verifier).toContain('payment_method_save: "enabled"');
    expect(verifier).toContain("This script never prints secret values.");
  });
});
