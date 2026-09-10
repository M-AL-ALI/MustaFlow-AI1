import { describe, expect, it } from "vitest";
import {
  billingMeterPercent,
  formatBillingAmount,
  planChangeKind,
  prorationAmountLabel,
  reviewableProration,
} from "./presentation";

const preview = {
  currentPlanId: "current",
  targetPlanId: "target",
  amountDueCents: 0,
  nextCycleAmountCents: 2000,
  currency: "usd",
  lines: [{ description: "Adjustment", amountCents: -500 }],
};

describe("billing display accuracy", () => {
  it.each([null, undefined, NaN, Infinity])(
    "does not display missing or invalid money as zero: %s",
    (value) => {
      expect(formatBillingAmount(value)).toBe("Unavailable");
    },
  );

  it("retains the currency and the sign of a real adjustment", () => {
    expect(formatBillingAmount(0, "USD")).toContain("USD");
    expect(formatBillingAmount(0)).not.toBe("Unavailable");
    expect(formatBillingAmount(-500, "EUR")).toContain("EUR");
    expect(formatBillingAmount(-500, "EUR")).toContain("-");
    expect(formatBillingAmount(100, "invalid")).toBe("Unavailable");
  });

  it("never describes an unconfirmed preview as money already applied", () => {
    expect(prorationAmountLabel(-500)).toBe("Estimated credit adjustment");
    expect(prorationAmountLabel(0)).toBe("Estimated due on confirmation");
    expect(prorationAmountLabel(500)).toBe("Estimated due on confirmation");
  });

  it("compares only available server prices", () => {
    expect(planChangeKind(20, 40)).toBe("upgrade");
    expect(planChangeKind(40, 20)).toBe("downgrade");
    expect(planChangeKind(20, 20)).toBe("switch");
    expect(planChangeKind(null, 20)).toBe("switch");
    expect(planChangeKind(20, undefined)).toBe("switch");
    expect(planChangeKind(NaN, 20)).toBe("switch");
  });

  it.each([
    [-5, 100, 0],
    [25, 100, 25],
    [140, 100, 100],
    [0, 0, 0],
    [5, 0, 100],
    [Infinity, 100, 0],
  ])("clamps meter width for used=%s and total=%s", (used, total, expected) => {
    expect(billingMeterPercent(used, total)).toBe(expected);
  });

  it("accepts a complete zero-due estimate without inferring its effective date", () => {
    expect(reviewableProration(preview, "target")).toMatchObject({
      amountDueCents: 0,
      targetPlanId: "target",
    });
  });

  it.each([
    null,
    { ...preview, targetPlanId: "different" },
    { ...preview, amountDueCents: NaN },
    { ...preview, nextCycleAmountCents: undefined },
    { ...preview, currency: undefined },
    { ...preview, lines: [{ amountCents: Infinity }] },
    { ...preview, lines: [{}] },
  ])("rejects incomplete or mismatched previews: %j", (value) => {
    expect(reviewableProration(value, "target")).toBeNull();
  });
});
