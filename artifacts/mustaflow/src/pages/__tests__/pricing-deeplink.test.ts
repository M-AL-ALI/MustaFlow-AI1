import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";

const PAGES_SRC = join(__dirname, "..");

function readPage(relPath: string): string {
  return readFileSync(join(PAGES_SRC, relPath), "utf-8");
}

describe("pricing and ora-settings deep-link wiring", () => {
  it("pricing page reads tier param from URL search string", () => {
    const pricing = readPage("pricing.tsx");
    expect(pricing).toContain("useSearch");
    expect(pricing).toContain("tierParam");
    expect(pricing).toContain('new URLSearchParams(searchString).get("tier")');
    // Sets highlight state and scrolls to plan card
    expect(pricing).toContain("highlightTier");
    expect(pricing).toContain("plan-card-core");
    expect(pricing).toContain("plan-card-wave");
    expect(pricing).toContain("scrollIntoView");
  });

  it("plan cards have id attributes matching plan-card-{tier}", () => {
    const pricing = readPage("pricing.tsx");
    expect(pricing).toContain('id="plan-card-core"');
    expect(pricing).toContain('id="plan-card-wave"');
  });

  it("pricing sign-in redirect preserves tier param through the flow", () => {
    const pricing = readPage("pricing.tsx");
    // When unauthenticated, the redirect URL encodes the tier param
    expect(pricing).toContain("params.set(\"tier\", tier)");
    expect(pricing).toContain("/sign-up?redirect=");
    expect(pricing).toContain("encodeURIComponent");
  });

  it("checkout successUrl from pricing routes to ora-settings section=plan", () => {
    const pricing = readPage("pricing.tsx");
    expect(pricing).toContain(
      "successUrl: `${window.location.origin}/ora/settings?section=plan&subscribed=1`",
    );
    expect(pricing).not.toContain("successUrl: `${window.location.origin}/ora/settings?subscribed=1`");
  });

  it("ora-settings reads section param and passes targetSection to PlanLimitsSection", () => {
    const settings = readPage("ora-settings.tsx");
    expect(settings).toContain("useSearch");
    expect(settings).toContain("targetSection");
    expect(settings).toContain('get("section")');
    expect(settings).toContain("PlanLimitsSection targetSection={targetSection}");
  });

  it("PlanLimitsSection has ora-section-plan and ora-section-payment-method DOM ids", () => {
    const settings = readPage("ora-settings.tsx");
    expect(settings).toContain('id="ora-section-plan"');
    expect(settings).toContain('id="ora-section-payment-method"');
  });

  it("PlanLimitsSection scrolls to the mapped section id after data loads", () => {
    const settings = readPage("ora-settings.tsx");
    expect(settings).toContain("sectionIdMap");
    expect(settings).toContain('"ora-section-plan"');
    expect(settings).toContain('"ora-section-payment-method"');
    expect(settings).toContain("scrollIntoView");
    expect(settings).toContain("behavior: \"smooth\"");
  });

  it("checkout successUrl from ora-settings routes to section=plan", () => {
    const settings = readPage("ora-settings.tsx");
    expect(settings).toContain(
      "successUrl: `${window.location.origin}/ora/settings?section=plan&subscribed=1`",
    );
    // The old successUrl without section= must be gone
    expect(settings).not.toContain(
      "successUrl: `${window.location.origin}/ora/settings?subscribed=1`",
    );
  });
});
