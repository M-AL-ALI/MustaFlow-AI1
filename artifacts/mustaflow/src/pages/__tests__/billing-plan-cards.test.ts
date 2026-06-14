import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PAGES_SRC = join(__dirname, "..");

function readPage(relPath: string): string {
  return readFileSync(join(PAGES_SRC, relPath), "utf-8");
}

describe("billing and pricing plan card wiring", () => {
  it("keeps Billing fallback cards aligned with Ora rolling-window limits and backend prices", () => {
    const billing = readPage("billing.tsx");

    expect(billing).toContain("30 Ora messages every 5 hours");
    expect(billing).toContain("4 Ora images every 5 hours");
    expect(billing).toContain("100 Ora messages every 3 hours");
    expect(billing).toContain("15 Ora images every 3 hours");
    expect(billing).toContain("280 Ora messages every 3 hours");
    expect(billing).toContain("30 Ora images every 3 hours");
    expect(billing).toContain("priceUsd: 65");
    expect(billing).not.toContain("Ora messages / day");
    expect(billing).not.toContain("Ora images / day");
    expect(billing).not.toContain("priceUsd: 40");
  });

  it("keeps public pricing cards aligned with Billing and routes paid plans through subscription checkout", () => {
    const pricing = readPage("pricing.tsx");

    expect(pricing).toContain("$65");
    expect(pricing).not.toContain("$40");
    expect(pricing).toContain("280 Ora messages every 3 hours");
    expect(pricing).toContain("30 Ora images every 3 hours");
    expect(pricing).toContain("/api/billing/subscription/checkout");
    expect(pricing).toContain("successUrl: `${window.location.origin}/ora/settings?subscribed=1`");
  });

  it("keeps Ora Settings wired to checkout, portal, and payment method setup", () => {
    const settings = readPage("ora-settings.tsx");

    expect(settings).toContain("/api/billing/subscription/checkout");
    expect(settings).toContain("/api/billing/payment-method");
    expect(settings).toContain("/api/billing/payment-method/setup");
    expect(settings).toContain("/api/billing/portal");
  });
});
