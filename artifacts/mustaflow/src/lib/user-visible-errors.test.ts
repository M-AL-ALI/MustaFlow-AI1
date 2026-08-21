import {
  BILLING_CARD_DECLINED_ERROR,
  BILLING_CARD_EXPIRED_ERROR,
  BILLING_INSUFFICIENT_FUNDS_ERROR,
  BILLING_USER_ERROR_FALLBACK,
} from "@workspace/ora-contracts";
import { describe, expect, it } from "vitest";
import { selectBillingFailureError } from "./user-visible-errors";

describe("billing user-visible errors", () => {
  it.each([
    BILLING_CARD_DECLINED_ERROR,
    BILLING_INSUFFICIENT_FUNDS_ERROR,
    BILLING_CARD_EXPIRED_ERROR,
  ])("keeps the fixed useful billing sentence: %s", (message) => {
    expect(selectBillingFailureError({ error: message })).toBe(message);
  });

  it("refuses raw provider identifiers and technical detail", () => {
    const customerId = ["cus", "customer_example"].join("_");
    const objectId = ["pi", "payment_example"].join("_");
    const raw = `Stripe API error: customer ${customerId}, payment ${objectId}, stack at billing.ts:42`;

    const visible = selectBillingFailureError({ error: raw });

    expect(visible).toBe(BILLING_USER_ERROR_FALLBACK);
    expect(visible).not.toContain(customerId);
    expect(visible).not.toContain(objectId);
    expect(visible).not.toContain("stack");
  });

  it("refuses over-length and unknown server text", () => {
    expect(selectBillingFailureError({ error: "x".repeat(241) })).toBe(BILLING_USER_ERROR_FALLBACK);
    expect(selectBillingFailureError({ error: "A provider-specific failure" })).toBe(
      BILLING_USER_ERROR_FALLBACK,
    );
  });
});
