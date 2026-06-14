import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const ROUTES_SRC = join(__dirname, "..");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_SRC, filename), "utf-8");
}

describe("billing subscription checkout wiring", () => {
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
});
