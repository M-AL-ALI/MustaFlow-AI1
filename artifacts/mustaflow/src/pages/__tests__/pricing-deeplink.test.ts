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
    expect(pricing).toContain('params.set("tier", tier)');
    expect(pricing).toContain("/sign-up?redirect=");
    expect(pricing).toContain("encodeURIComponent");
  });

  it("checkout successUrl from pricing routes to ora-settings section=plan", () => {
    const pricing = readPage("pricing.tsx");
    expect(pricing).toContain(
      "successUrl: `${window.location.origin}/ora/settings?section=plan&subscribed=1`",
    );
    expect(pricing).not.toContain(
      "successUrl: `${window.location.origin}/ora/settings?subscribed=1`",
    );
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
    // Staged-scroll retries use "smooth" for long-distance jumps and "auto"
    // for short corrective re-scrolls.
    expect(settings).toContain('behavior: d >= 1000 ? "smooth" : "auto"');
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

describe("source=mobile banner wiring", () => {
  const BANNER_SRC = join(__dirname, "../../components/mobile-app-banner.tsx");

  function readBanner(): string {
    return readFileSync(BANNER_SRC, "utf-8");
  }

  it("MobileAppBanner reads source param from URL and gates on source === mobile", () => {
    const banner = readBanner();
    expect(banner).toContain("useSearch");
    expect(banner).toContain('get("source")');
    expect(banner).toContain('"mobile"');
  });

  it("MobileAppBanner is dismissible via local state", () => {
    const banner = readBanner();
    expect(banner).toContain("dismissed");
    expect(banner).toContain("setDismissed");
  });

  it("MobileAppBanner shows the correct copy", () => {
    const banner = readBanner();
    expect(banner).toContain("Opened from the Ora app");
    expect(banner).toContain("tap Done when finished");
  });

  it("pricing page imports and renders MobileAppBanner", () => {
    const pricing = readPage("pricing.tsx");
    expect(pricing).toContain("MobileAppBanner");
    expect(pricing).toContain("mobile-app-banner");
    expect(pricing).toContain("<MobileAppBanner");
  });

  it("ora-settings page imports and renders MobileAppBanner", () => {
    const settings = readPage("ora-settings.tsx");
    expect(settings).toContain("MobileAppBanner");
    expect(settings).toContain("mobile-app-banner");
    expect(settings).toContain("<MobileAppBanner");
  });

  it("MobileAppBanner returns null when source param is absent", () => {
    const banner = readBanner();
    // Guards: source !== "mobile" || dismissed → early return null
    expect(banner).toContain('source !== "mobile"');
    expect(banner).toContain("return null");
  });
});
