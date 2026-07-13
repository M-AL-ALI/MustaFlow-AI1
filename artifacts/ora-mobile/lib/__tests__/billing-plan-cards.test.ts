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

describe("Ora Mobile — plan/billing display (Apple 3.1.1 compliant)", () => {
  const settings = read("../../app/(home)/settings.tsx");
  const types = read("../types.ts");
  const api = read("../api.ts");

  it("types.ts defines the Ora-only OraTierMeta type", () => {
    expect(types).toContain("export interface OraTierMeta");
  });

  it("still renders read-only current plan + usage cards", () => {
    expect(settings).toContain("function BigUsageCard(");
    expect(settings).toContain('label="Messages"');
    expect(settings).toContain('label="Images"');
    expect(settings).toContain("function renewalLabel(");
    expect(settings).toContain("renewalLabel(subscription");
  });

  it("shows an informational About plans section (no prices, no purchase actions)", () => {
    expect(settings).toContain("About plans");
    expect(settings).toContain("Core Pack");
    expect(settings).toContain("Deep Wave");
    expect(settings).toContain("Plan changes are managed on the MustaFlow website.");
  });

  it("exposes NO in-app purchase / upgrade / billing UI (Apple 3.1.1)", () => {
    // No purchase or plan-management deep-link constants
    expect(settings).not.toContain("ORA_PRICING_CORE_URL");
    expect(settings).not.toContain("ORA_PRICING_WAVE_URL");
    expect(settings).not.toContain("ORA_PLAN_MANAGE_URL");
    expect(settings).not.toContain("ORA_PAYMENT_METHOD_URL");
    expect(settings).not.toContain("ORA_BILLING_URL");
    // No purchase call-to-action copy or pricing links
    expect(settings).not.toMatch(/Upgrade to/i);
    expect(settings).not.toContain("/pricing?");
    expect(settings).not.toMatch(/Manage billing/i);
    expect(settings).not.toMatch(/Add payment method/i);
    // No payment-method state or UI remains
    expect(settings).not.toContain("paymentMethod");
    expect(settings).not.toContain("getPaymentMethod");
    expect(settings).not.toContain("PaymentMethodInfo");
    expect(settings).not.toMatch(/payment method/i);
  });

  it("keeps account (email/password) website links but no Builder concepts", () => {
    // WEBSITE_SETTINGS_URL is still used for account email/password buttons only
    expect(settings).toContain("WEBSITE_SETTINGS_URL");
    for (const re of BUILDER_WORDS) {
      expect(settings).not.toMatch(re);
    }
  });

  it("provides an in-app account deletion path (Apple 5.1.1(v))", () => {
    expect(settings).toContain("deleteAccount");
    expect(settings).toContain("Delete account");
    // api.ts wires DELETE /api/me and requires auth
    expect(api).toContain("export function deleteAccount(");
    expect(api).toContain('jsonRequest<DeleteAccountResult>("/api/me", { method: "DELETE" })');
    expect(api).toContain('path === "/api/me"');
  });

  it("contains no Stripe checkout / portal / inline billing wiring", () => {
    expect(settings).not.toMatch(/checkout/i);
    expect(settings).not.toContain("/portal");
    expect(settings).not.toMatch(/stripe/i);
    expect(settings).not.toContain("/api/billing/payment-method");
  });
});
