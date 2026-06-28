import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

// Builder-only concepts that must never appear in the Ora mobile plan cards.
const BUILDER_WORDS: RegExp[] = [
  /credit/i,
  /concurrent build/i,
  /build queue/i,
  /Built with MustaFlow/i,
  /\bConnectors\b/i,
];

describe("Ora Mobile — plan/billing parity", () => {
  const settings = read("../../app/(home)/settings.tsx");
  const types = read("../types.ts");

  it("defines the Ora-only OraTierMeta type and wires oraTiers onto BillingSubscription", () => {
    expect(types).toContain("export interface OraTierMeta");
    expect(types).toContain("oraTiers?: OraTierMeta[]");
  });

  it("renders plan cards from the server oraTiers (single source of truth)", () => {
    expect(settings).toContain("OraTierMeta");
    expect(settings).toContain("subscription?.oraTiers");
    expect(settings).toContain("tiers: OraTierMeta[]");
    expect(settings).toContain("tier.features.map");
  });

  it("uses an Ora-only subtitle (messages/images/window), not Builder credits", () => {
    // PlanFeatureCards subtitle: "{messages} messages · {images} images / {window}h"
    const start = settings.indexOf("function PlanFeatureCards");
    expect(start).toBeGreaterThan(-1);
    const block = settings.slice(start, start + 4000);

    expect(block).toContain("messages ·");
    expect(block).toContain("images /");
    expect(block).toContain("tier.windowHours");
    for (const re of BUILDER_WORDS) {
      expect(block).not.toMatch(re);
    }
  });

  it("contains no Stripe checkout / portal / payment-method wiring (mobile is payment-free)", () => {
    expect(settings).not.toMatch(/checkout/i);
    expect(settings).not.toContain("payment-method");
    expect(settings).not.toContain("/portal");
    expect(settings).not.toMatch(/stripe/i);
  });
});
