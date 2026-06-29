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
    // New design uses BigUsageCard components to show remaining messages / images
    expect(settings).toContain("function BigUsageCard(");
    // BigUsageCard is rendered for both quota types
    expect(settings).toContain('BigUsageCard label');
    // Renewal date comes from subscription via renewalLabel helper
    expect(settings).toContain("function renewalLabel(");
    expect(settings).toContain("renewalLabel(subscription");
    // Payment method info is fetched and displayed (read-only, no checkout)
    expect(settings).toContain("getPaymentMethod");
    expect(settings).toContain("paymentMethod.hasPaymentMethod");
    expect(settings).toContain("paymentMethod.last4");
  });

  it("uses Ora-only usage copy (messages/images) and routes billing to website via WebBrowser", () => {
    // Shows remaining message and image counts
    expect(settings).toContain('"Messages"');
    expect(settings).toContain('"Images"');
    // Plan/payment management opens the website in a browser — no inline checkout
    expect(settings).toContain("WebBrowser");
    expect(settings).toContain("openBrowserAsync");
    expect(settings).toContain("WEBSITE_SETTINGS_URL");
    // No Builder-specific wording in any plan copy
    for (const re of BUILDER_WORDS) {
      expect(settings).not.toMatch(re);
    }
  });

  it("contains no Stripe checkout / portal / hyphenated payment-method wiring (billing is website-only)", () => {
    expect(settings).not.toMatch(/checkout/i);
    // camelCase paymentMethod is fine; hyphenated payment-method means a URL or import string
    expect(settings).not.toContain("payment-method");
    expect(settings).not.toContain("/portal");
    expect(settings).not.toMatch(/stripe/i);
  });
});
