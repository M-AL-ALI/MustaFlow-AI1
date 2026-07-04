import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

// Builder-only concepts that must never appear in the Ora mobile plan cards.
// Note: /credit/i is intentionally a word-boundary match so the CreditCard icon name is allowed.
const BUILDER_WORDS: RegExp[] = [
  /\bcredits?\b/i,
  /concurrent build/i,
  /build queue/i,
  /Built with MustaFlow/i,
  /\bConnectors\b/i,
];

describe("Ora Mobile — plan/billing parity", () => {
  const settings = read("../../app/(home)/settings.tsx");
  const types = read("../types.ts");

  it("types.ts defines the Ora-only OraTierMeta type", () => {
    expect(types).toContain("export interface OraTierMeta");
  });

  it("renders BigUsageCard for message and image quotas (website-parity plan display)", () => {
    expect(settings).toContain("function BigUsageCard(");
    expect(settings).toContain('label="Messages"');
    expect(settings).toContain('label="Images"');
    expect(settings).toContain("function renewalLabel(");
    expect(settings).toContain("renewalLabel(subscription");
    expect(settings).toContain("getPaymentMethod");
    expect(settings).toContain("paymentMethod.hasPaymentMethod");
    expect(settings).toContain("paymentMethod.last4");
  });

  it("uses Ora-only usage copy (messages/images) and routes billing to website via WebBrowser", () => {
    expect(settings).toContain('"Messages"');
    expect(settings).toContain('"Images"');
    expect(settings).toContain("WebBrowser");
    expect(settings).toContain("openBrowserAsync");
    // WEBSITE_SETTINGS_URL is still used for account (email/password) buttons
    expect(settings).toContain("WEBSITE_SETTINGS_URL");
    for (const re of BUILDER_WORDS) {
      expect(settings).not.toMatch(re);
    }
  });

  it("defines all 5 deep-link URL constants for specific billing destinations", () => {
    expect(settings).toContain("ORA_PRICING_CORE_URL");
    expect(settings).toContain("ORA_PRICING_WAVE_URL");
    expect(settings).toContain("ORA_PLAN_MANAGE_URL");
    expect(settings).toContain("ORA_PAYMENT_METHOD_URL");
    expect(settings).toContain("ORA_BILLING_URL");
  });

  it("deep-link constants point to the correct website paths with source=mobile", () => {
    expect(settings).toContain("/pricing?tier=core&source=mobile");
    expect(settings).toContain("/pricing?tier=wave&source=mobile");
    expect(settings).toContain("/ora/settings?section=plan&source=mobile");
    expect(settings).toContain("/ora/settings?section=payment-method&source=mobile");
    expect(settings).toContain("/ora/settings?section=billing&source=mobile");
  });

  it("each billing button uses the correct deep-link constant (not generic WEBSITE_SETTINGS_URL)", () => {
    expect(settings).toContain("openBrowserAsync(ORA_PRICING_CORE_URL)");
    expect(settings).toContain("openBrowserAsync(ORA_PRICING_WAVE_URL)");
    expect(settings).toContain("openBrowserAsync(ORA_PLAN_MANAGE_URL)");
    expect(settings).toContain("openBrowserAsync(ORA_PAYMENT_METHOD_URL)");
    expect(settings).toContain("openBrowserAsync(ORA_BILLING_URL)");
  });

  it("contains no Stripe checkout / portal / inline billing wiring (billing is website-only)", () => {
    expect(settings).not.toMatch(/checkout/i);
    expect(settings).not.toContain("/portal");
    expect(settings).not.toMatch(/stripe/i);
    // No direct API call for payment-method setup (that's website-only)
    expect(settings).not.toContain("/api/billing/payment-method");
  });
});
