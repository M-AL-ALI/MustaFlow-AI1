import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PAGES_SRC = join(__dirname, "..");

function readPage(relPath: string): string {
  return readFileSync(join(PAGES_SRC, relPath), "utf-8");
}

// The Ora plan cards are driven by the ORA_PLAN_FALLBACK array (mirrors the
// server's ORA_TIERS_META). Both billing.tsx and pricing.tsx ALSO describe the
// separate AI Builder product (credits-per-build, etc.) elsewhere on the page,
// so the "no Builder words" guard is scoped to the plan-card data block — never
// the whole file.
function oraFallbackBlock(src: string): string {
  const start = src.indexOf("ORA_PLAN_FALLBACK");
  expect(start).toBeGreaterThan(-1);
  // The array closer may be indented (billing.tsx declares it inside the
  // component) or at column 0 (pricing.tsx declares it at module scope).
  const match = src.slice(start).match(/\n\s*\];/);
  expect(match).not.toBeNull();
  const end = start + (match!.index ?? 0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

// Builder-only concepts that must never appear inside an Ora plan card.
const BUILDER_WORDS: RegExp[] = [
  /credit/i,
  /concurrent build/i,
  /build queue/i,
  /Built with MustaFlow/i,
  /\bConnectors\b/i,
];

function expectOraOnly(block: string) {
  for (const re of BUILDER_WORDS) {
    expect(block).not.toMatch(re);
  }
}

describe("billing and pricing plan card wiring", () => {
  it("keeps Billing fallback cards Ora-only with the unified $40 Deep Wave price", () => {
    const billing = readPage("billing.tsx");
    const block = oraFallbackBlock(billing);

    expect(block).toContain("30 Ora messages every 5 hours");
    expect(block).toContain("4 Ora images every 5 hours");
    expect(block).toContain("100 Ora messages every 3 hours");
    expect(block).toContain("15 Ora images every 3 hours");
    expect(block).toContain("280 Ora messages every 3 hours");
    expect(block).toContain("30 Ora images every 3 hours");

    // Deep Wave is unified at $40 (matches TIER_PRICE_USD.wave), never $65.
    expect(block).toContain("priceUsd: 40");
    expect(block).not.toContain("priceUsd: 65");
    expect(block).not.toContain("Ora messages / day");
    expect(block).not.toContain("Ora images / day");

    expectOraOnly(block);
  });

  it("renders the server oraTiers as the source of truth on Billing", () => {
    const billing = readPage("billing.tsx");
    expect(billing).toContain("subscription?.oraTiers");
  });

  it("keeps public pricing cards Ora-only, $40 Wave, fed by the public ora-plans endpoint", () => {
    const pricing = readPage("pricing.tsx");
    const block = oraFallbackBlock(pricing);

    expect(block).toContain("280 Ora messages every 3 hours");
    expect(block).toContain("30 Ora images every 3 hours");
    expect(block).toContain("priceUsd: 40");
    expect(block).not.toContain("priceUsd: 65");
    expectOraOnly(block);

    // Cards render server data; the $65 literal must be gone everywhere.
    expect(pricing).not.toContain("$65");
    expect(pricing).toContain("/api/billing/ora-plans");
    expect(pricing).toContain("waveTier.priceUsd");

    // Paid plans still route through subscription checkout.
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
