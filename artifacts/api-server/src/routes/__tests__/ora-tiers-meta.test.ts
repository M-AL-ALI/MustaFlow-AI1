/**
 * ORA_TIERS_META parity tests.
 *
 * ORA_TIERS_META is the single source of truth for the Ora-only plan cards
 * rendered on the website (billing.tsx, pricing.tsx) and the mobile app
 * (settings.tsx). This guards two invariants:
 *
 *   1. Prices/limits are derived from the canonical @workspace/db constants —
 *      most importantly Deep Wave at $40 (TIER_PRICE_USD.wave), never $65.
 *   2. The cards stay Ora-only: no AI Builder concepts (credits, concurrent
 *      builds, build queue, "Built with MustaFlow" badge, Builder connectors).
 */

import { describe, expect, it } from "vitest";
import {
  TIER_PRICE_USD,
  TIER_ORA_MESSAGE_LIMIT,
  TIER_ORA_IMAGE_LIMIT,
  TIER_ORA_WINDOW_HOURS,
  TIER_ORA_REALTIME_LIMIT_SECONDS,
} from "@workspace/db";
import { ORA_TIERS_META } from "../billing";

const BUILDER_WORDS: RegExp[] = [
  /credit/i,
  /concurrent build/i,
  /build queue/i,
  /Built with MustaFlow/i,
  /\bConnectors\b/i,
];

describe("ORA_TIERS_META", () => {
  it("exposes exactly the free, core, and wave Ora tiers", () => {
    expect(ORA_TIERS_META.map((t) => t.id)).toEqual(["free", "core", "wave"]);
  });

  it("derives prices from the canonical constants — Deep Wave is $40, never $65", () => {
    for (const tier of ORA_TIERS_META) {
      expect(tier.priceUsd).toBe(TIER_PRICE_USD[tier.id]);
    }
    const wave = ORA_TIERS_META.find((t) => t.id === "wave");
    expect(wave?.priceUsd).toBe(40);
    expect(ORA_TIERS_META.some((t) => t.priceUsd === 65)).toBe(false);
  });

  it("derives message/image/window/voice limits from the canonical constants", () => {
    for (const tier of ORA_TIERS_META) {
      expect(tier.messageLimit).toBe(TIER_ORA_MESSAGE_LIMIT[tier.id]);
      expect(tier.imageLimit).toBe(TIER_ORA_IMAGE_LIMIT[tier.id]);
      expect(tier.windowHours).toBe(TIER_ORA_WINDOW_HOURS[tier.id]);
      expect(tier.voiceMinutes).toBe(Math.round(TIER_ORA_REALTIME_LIMIT_SECONDS[tier.id] / 60));
    }
  });

  it("gates Deep Thinking to paid tiers only", () => {
    expect(ORA_TIERS_META.find((t) => t.id === "free")?.deepThinking).toBe(false);
    expect(ORA_TIERS_META.find((t) => t.id === "core")?.deepThinking).toBe(true);
    expect(ORA_TIERS_META.find((t) => t.id === "wave")?.deepThinking).toBe(true);
  });

  it("keeps every tier's features Ora-only (zero Builder concepts)", () => {
    for (const tier of ORA_TIERS_META) {
      expect(tier.features.length).toBeGreaterThan(0);
      for (const feature of tier.features) {
        for (const re of BUILDER_WORDS) {
          expect(feature).not.toMatch(re);
        }
      }
      // Each tier advertises its Ora message + image allowance.
      expect(tier.features.some((f) => /Ora messages every/.test(f))).toBe(true);
      expect(tier.features.some((f) => /Ora images every/.test(f))).toBe(true);
    }
  });
});
