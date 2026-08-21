import { readFileSync } from "fs";
import { join } from "path";
import {
  BILLING_CARD_DECLINED_ERROR,
  BILLING_CARD_EXPIRED_ERROR,
  BILLING_INSUFFICIENT_FUNDS_ERROR,
  BILLING_USER_ERROR_FALLBACK,
  billingProviderErrorMessage,
} from "@workspace/ora-contracts";
import { describe, expect, it } from "vitest";

const ROUTES_DIR = join(__dirname, "..");
const WEB_SRC = join(__dirname, "..", "..", "..", "..", "mustaflow", "src");

function readRoute(filename: string): string {
  return readFileSync(join(ROUTES_DIR, filename), "utf-8");
}

function routeBlock(source: string, route: string, nextRoute?: string): string {
  const start = source.indexOf(`router.post("${route}"`);
  const end = nextRoute ? source.indexOf(`router.post("${nextRoute}"`, start + 1) : source.length;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

function occurrences(source: string, token: string): number {
  return source.split(token).length - 1;
}

describe("billing error sanitisation", () => {
  it("maps only known-safe Stripe decline reasons to fixed user sentences", () => {
    expect(billingProviderErrorMessage({ code: "card_declined" })).toBe(
      BILLING_CARD_DECLINED_ERROR,
    );
    expect(
      billingProviderErrorMessage({
        code: "card_declined",
        decline_code: "insufficient_funds",
      }),
    ).toBe(BILLING_INSUFFICIENT_FUNDS_ERROR);
    expect(billingProviderErrorMessage({ code: "expired_card" })).toBe(BILLING_CARD_EXPIRED_ERROR);
    expect(billingProviderErrorMessage(new Error("Your card was declined."))).toBe(
      BILLING_CARD_DECLINED_ERROR,
    );
    expect(billingProviderErrorMessage(new Error("Your card has insufficient funds."))).toBe(
      BILLING_INSUFFICIENT_FUNDS_ERROR,
    );
    expect(billingProviderErrorMessage(new Error("Your card has expired."))).toBe(
      BILLING_CARD_EXPIRED_ERROR,
    );
  });

  it("does not return identifiers, stack-like text, or over-length provider messages", () => {
    const customerId = ["cus", "customer_example"].join("_");
    const objectId = ["pi", "payment_example"].join("_");
    const hostileMessages = [
      `Your card was declined. Customer ${customerId}; payment ${objectId}`,
      "StripeRequestError: stack at billing.ts:42",
      `Provider detail: ${"x".repeat(500)}`,
    ];

    for (const message of hostileMessages) {
      const visible = billingProviderErrorMessage(new Error(message));
      expect(visible).toBe(BILLING_USER_ERROR_FALLBACK);
      expect(visible).not.toContain(customerId);
      expect(visible).not.toContain(objectId);
      expect(visible).not.toContain("stack");
    }
  });

  it("sanitises every commissioned server boundary", () => {
    const billing = readRoute("billing.ts");
    const billingTargets = [
      ["/billing/cancel-subscription", "/billing/portal", 1],
      ["/billing/portal", "/billing/payment-method/setup", 1],
      ["/billing/payment-method/setup", "/billing/checkout", 1],
      ["/billing/checkout", "/billing/subscription/checkout", 1],
      ["/billing/subscription/checkout", "/billing/subscription/portal", 2],
      ["/billing/subscription/portal", undefined, 1],
    ] as const;

    for (const [route, nextRoute, expectedCalls] of billingTargets) {
      const block = routeBlock(billing, route, nextRoute);
      expect(occurrences(block, "billingProviderErrorMessage(err)")).toBe(expectedCalls);
      expect(block).not.toMatch(/(?:Stripe|Payment)(?: API)? error: \$\{msg\}/u);
    }

    const domains = readRoute("purchased-domains.ts");
    const domainTargets = [
      ["/domains/purchase", "/domains/purchase/confirm"],
      ["/domains/purchase/confirm", "/domains/transfer-in"],
      ["/domains/transfer-in", "/domains/transfer-in/confirm"],
      ["/domains/transfer-in/confirm", "/domains/purchased/:id/renew"],
      ["/domains/purchased/:id/renew", "/domains/purchased/:id/renew/confirm"],
    ] as const;

    for (const [route, nextRoute] of domainTargets) {
      const block = routeBlock(domains, route, nextRoute);
      expect(occurrences(block, "billingProviderErrorMessage(err)")).toBe(1);
      expect(block).not.toMatch(/(?:Stripe|Payment)(?: API)? error: \$\{msg\}/u);
    }
  });

  it("routes every commissioned client sink through the shared selector", () => {
    const clientFiles = [
      ["pages/billing.tsx", 6],
      ["components/buy-credits-sheet.tsx", 1],
      ["pages/pricing.tsx", 1],
      ["pages/ora-settings.tsx", 3],
    ] as const;

    for (const [filename, expectedCalls] of clientFiles) {
      const source = readFileSync(join(WEB_SRC, filename), "utf-8");
      expect(occurrences(source, "selectBillingFailureError(")).toBe(expectedCalls);
    }

    const domains = readFileSync(join(WEB_SRC, "pages", "account", "domains.tsx"), "utf-8");
    expect(occurrences(domains, "billingErrorMessage(")).toBe(6);
  });
});
