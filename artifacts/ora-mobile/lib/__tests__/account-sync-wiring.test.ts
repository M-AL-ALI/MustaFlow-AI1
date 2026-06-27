import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

describe("Mobile Settings — Account sync wiring", () => {
  const api = read("../api.ts");
  const settings = read("../../app/(home)/settings.tsx");

  it("exposes getAccountConsistency() pointing at the protected endpoint", () => {
    expect(api).toContain("export function getAccountConsistency()");
    expect(api).toContain('"/api/ora/account-consistency"');
    expect(api).toContain("OraAccountConsistency");
  });

  it("renders an Account sync section that runs the check", () => {
    expect(settings).toContain("getAccountConsistency");
    expect(settings).toContain('title="Account sync"');
    expect(settings).toContain("Check account sync");
  });

  it("renders the user fingerprint, plan, and per-user counts", () => {
    expect(settings).toContain("acctDiag.identity.userIdHash");
    expect(settings).toContain("acctDiag.identity.clerkUserIdLast4");
    expect(settings).toContain("acctDiag.billing.billingTier");
    expect(settings).toContain("acctDiag.chatSession.tier");
    expect(settings).toContain("acctDiag.counts.conversations");
    expect(settings).toContain("acctDiag.counts.projects");
    expect(settings).toContain("acctDiag.counts.userLevelMemories");
    expect(settings).toContain("acctDiag.counts.projectMemories");
    expect(settings).toContain("acctDiag.counts.assets");
    expect(settings).toContain("acctDiag.counts.supportTickets");
    expect(settings).toContain("acctDiag.api.host");
    expect(settings).toContain("acctDiag.api.environment");
  });

  it("shows red warnings for signed-in-no-token and billing/chat tier mismatch", () => {
    expect(settings).toContain("acctTokenWarn");
    expect(settings).toContain("acctTierMismatch");
    // Red warning color used elsewhere in this screen for failures.
    expect(settings).toContain('color: "#f87171"');
  });

  it("has NO Stripe / checkout / billing-portal path anywhere in mobile settings", () => {
    expect(settings).not.toMatch(/stripe/i);
    expect(settings).not.toMatch(/checkout/i);
    expect(settings).not.toMatch(/billing-portal|createCheckout|manageBilling/i);
  });
});
