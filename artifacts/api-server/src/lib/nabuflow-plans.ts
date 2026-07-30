// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Builder plan family — config as data (Task #1516).
//
// Orbit $20 / Comet $50 / Nova $100 (+ Constellation enterprise placeholder).
// This module is the SINGLE source of truth for every NabuFlow plan number:
// price, included monthly credits, rollover policy, parallel-build limit,
// queue priority, spend-cap default/max, overage rate and the engine-mode
// access ladder. Nothing is hard-coded at call sites — changing any number
// here is a one-line change.
//
// COMPLETELY separate from Ora's free/core/wave tiers (user_subscriptions):
// NabuFlow has NO free tier. Only the owner allow-list (BUILDER_ALLOWLIST) and
// superusers bypass billing.
//
// Credit calibration (margin protection): builds charge exactly what
// `creditCostFor` in ai-providers.ts returns today — Pro 475 (760 on Anthropic),
// Pro+Deep 850, Power 160/290, Eco 34/60, Lite 13. Included buckets are sized so
// the bucket's dollar value at the plan's own overage rate stays below the plan
// price (Orbit 1,600 cr × $0.015 = $24 marginal value on a $20 plan with only 3
// Pro builds; Comet 4,000 × $0.013 = $52; Nova 8,000 × $0.012 = $96) — margin
// comes from typical partial utilisation plus the ladder caps, while overage is
// billed at or above the marginal rate from the first credit.
// ─────────────────────────────────────────────────────────────────────────────

export const NABUFLOW_PLAN_IDS = ["orbit", "comet", "nova", "constellation"] as const;

/**
 * Per-engine-mode credit costs for NabuFlow builds.
 * Single source of truth — returned by GET /billing/nabuflow/plans so the
 * pricing page never hard-codes these values.
 */
export const NABUFLOW_BUILD_MODE_COSTS = [
  { mode: "Lite", credits: 1, desc: "Fast, lightweight builds" },
  { mode: "Eco", credits: 2, desc: "Balanced quality and speed" },
  { mode: "Power", credits: 5, desc: "High-quality multi-file builds" },
  { mode: "Pro", credits: 10, desc: "Maximum quality, extended context" },
] as const;

export type NabuflowBuildModeCost = (typeof NABUFLOW_BUILD_MODE_COSTS)[number];
export type NabuflowPlanId = (typeof NABUFLOW_PLAN_IDS)[number];

/** Engine-mode access ladder — `null` means unlimited. */
export interface NabuflowModeLadder {
  /** Max Pro-mode builds per cycle (`null` = unlimited, 0 = none). */
  proBuildsPerCycle: number | null;
  /** Max Deep-reasoning builds per cycle (`null` = unlimited, 0 = none). */
  deepBuildsPerCycle: number | null;
  /** Whether Pro mode + Deep reasoning may be combined (Nova exclusive). */
  proDeepCombo: boolean;
}

export interface NabuflowPlanConfig {
  id: NabuflowPlanId;
  name: string;
  /** Monthly price in USD. `null` = custom pricing (Constellation). */
  priceUsd: number | null;
  /** Credits granted at the start of every cycle (before rollover). */
  includedMonthlyCredits: number;
  /** How many cycles unused included credits survive (0 = none, 1 = one cycle). */
  rolloverCycles: number;
  /** Cap on credits carried into a cycle (defaults to one month's allotment). */
  rolloverMaxCredits: number;
  /** Concurrent builds allowed (config only — enforced by queue infrastructure). */
  parallelBuildLimit: number;
  /** Larger = drained first (config only — consumed by queue infrastructure). */
  queuePriority: number;
  /** Pay-as-you-go price per credit once the included bucket is exhausted. */
  overageUsdPerCredit: number;
  /** Default monthly pay-as-you-go spend cap (USD). */
  defaultSpendCapUsd: number;
  /** Maximum the user may raise their spend cap to (USD). */
  maxSpendCapUsd: number;
  ladder: NabuflowModeLadder;
  /** Env var holding the Stripe price id override (env-scoped test/live). */
  stripePriceIdEnv: string;
  /** Stable Stripe lookup_key used to find/create the price when no env is set. */
  stripeLookupKey: string;
  /** Constellation stub is not yet purchasable. */
  available: boolean;
  features: string[];
}

export const NABUFLOW_PLANS: Record<NabuflowPlanId, NabuflowPlanConfig> = {
  orbit: {
    id: "orbit",
    name: "Orbit",
    priceUsd: 20,
    includedMonthlyCredits: 1600,
    rolloverCycles: 0,
    rolloverMaxCredits: 0,
    parallelBuildLimit: 1,
    queuePriority: 1,
    overageUsdPerCredit: 0.015,
    defaultSpendCapUsd: 25,
    maxSpendCapUsd: 100,
    ladder: { proBuildsPerCycle: 3, deepBuildsPerCycle: 0, proDeepCombo: false },
    stripePriceIdEnv: "NABUFLOW_ORBIT_PRICE_ID",
    stripeLookupKey: "nabuflow_orbit_monthly",
    available: true,
    features: [
      "1,600 build credits / month",
      "Lite, Eco & Power engine modes",
      "3 Pro builds per cycle",
      "Pay-as-you-go overage at $0.015/credit",
      "1 concurrent build",
    ],
  },
  comet: {
    id: "comet",
    name: "Comet",
    priceUsd: 50,
    includedMonthlyCredits: 4000,
    rolloverCycles: 1,
    rolloverMaxCredits: 4000,
    parallelBuildLimit: 3,
    queuePriority: 2,
    overageUsdPerCredit: 0.013,
    defaultSpendCapUsd: 60,
    maxSpendCapUsd: 250,
    ladder: { proBuildsPerCycle: null, deepBuildsPerCycle: 10, proDeepCombo: false },
    stripePriceIdEnv: "NABUFLOW_COMET_PRICE_ID",
    stripeLookupKey: "nabuflow_comet_monthly",
    available: true,
    features: [
      "4,000 build credits / month",
      "Unlimited Pro builds",
      "10 Deep-reasoning builds per cycle",
      "Unused credits roll over one cycle",
      "Pay-as-you-go overage at $0.013/credit",
      "3 concurrent builds",
    ],
  },
  nova: {
    id: "nova",
    name: "Nova",
    priceUsd: 100,
    includedMonthlyCredits: 8000,
    rolloverCycles: 1,
    rolloverMaxCredits: 8000,
    parallelBuildLimit: 6,
    queuePriority: 3,
    overageUsdPerCredit: 0.012,
    defaultSpendCapUsd: 120,
    maxSpendCapUsd: 500,
    ladder: { proBuildsPerCycle: null, deepBuildsPerCycle: null, proDeepCombo: true },
    stripePriceIdEnv: "NABUFLOW_NOVA_PRICE_ID",
    stripeLookupKey: "nabuflow_nova_monthly",
    available: true,
    features: [
      "8,000 build credits / month",
      "Unlimited Pro & Deep-reasoning builds",
      "Pro + Deep combo (Nova exclusive)",
      "Unused credits roll over one cycle",
      "Pay-as-you-go overage at $0.012/credit",
      "6 concurrent builds",
    ],
  },
  // Enterprise placeholder — company registration, bulk credit pools and PO
  // invoicing land in a separate task. Kept here so the plans config already
  // has room for it; `available: false` keeps it out of every purchase path.
  constellation: {
    id: "constellation",
    name: "Constellation",
    priceUsd: null,
    includedMonthlyCredits: 0,
    rolloverCycles: 1,
    rolloverMaxCredits: 0,
    parallelBuildLimit: 12,
    queuePriority: 4,
    overageUsdPerCredit: 0.01,
    defaultSpendCapUsd: 1000,
    maxSpendCapUsd: 10000,
    ladder: { proBuildsPerCycle: null, deepBuildsPerCycle: null, proDeepCombo: true },
    stripePriceIdEnv: "NABUFLOW_CONSTELLATION_PRICE_ID",
    stripeLookupKey: "nabuflow_constellation_monthly",
    available: false,
    features: ["Enterprise — contact us"],
  },
};

// ── Constellation enterprise bulk-credit pricing ─────────────────────────────
// Volume-discounted vs self-serve: every tier undercuts the cheapest
// self-serve rate (Nova overage, $0.010/credit). Bulk pools are prepaid
// one-time purchases billed to the company entity; the pool never expires.
export interface NabuflowBulkTier {
  /** Minimum credits purchased to qualify for this rate. */
  minCredits: number;
  /** Volume-discounted price per credit (USD). */
  usdPerCredit: number;
  label: string;
}

/** Ascending tiers — the best rate whose minimum the purchase meets applies. */
export const NABUFLOW_ORG_BULK_TIERS: readonly NabuflowBulkTier[] = [
  { minCredits: 25_000, usdPerCredit: 0.009, label: "25,000+ credits" },
  { minCredits: 100_000, usdPerCredit: 0.008, label: "100,000+ credits" },
  { minCredits: 500_000, usdPerCredit: 0.007, label: "500,000+ credits" },
] as const;

/** Smallest bulk purchase Constellation accepts (the first tier's minimum). */
export const NABUFLOW_ORG_MIN_PURCHASE_CREDITS = NABUFLOW_ORG_BULK_TIERS[0].minCredits;

/**
 * Pool draws are valued at the Constellation per-credit rate for spend-cap
 * accounting (org-wide cap and per-seat sub-caps are USD caps, like the
 * self-serve spend cap). Purchases are priced at the discounted tier rate.
 */
export function nabuflowOrgDrawRateUsdPerCredit(): number {
  return NABUFLOW_PLANS.constellation.overageUsdPerCredit;
}

/** USD-cent value of `credits` drawn from a pool (cap accounting, not billing). */
export function nabuflowOrgDrawValueCents(credits: number): number {
  if (credits <= 0) return 0;
  return Math.round(credits * nabuflowOrgDrawRateUsdPerCredit() * 100);
}

/** The bulk tier a purchase of `credits` qualifies for, or null below the minimum. */
export function nabuflowBulkTierFor(credits: number): NabuflowBulkTier | null {
  let match: NabuflowBulkTier | null = null;
  for (const tier of NABUFLOW_ORG_BULK_TIERS) {
    if (credits >= tier.minCredits) match = tier;
  }
  return match;
}

/** Invoice total in USD cents for a bulk purchase (null below the minimum). */
export function nabuflowBulkPurchaseCents(credits: number): number | null {
  const tier = nabuflowBulkTierFor(credits);
  if (!tier) return null;
  return Math.round(credits * tier.usdPerCredit * 100);
}

/** Dunning guardrails: Stripe retries, we notify, new builds pause after grace. */
export const NABUFLOW_DUNNING = {
  /** invoice.payment_failed attempts before we hard-pause regardless of grace. */
  maxAttempts: 3,
  /** Days after the first failed charge before NEW builds are paused. */
  graceDays: 7,
} as const;

/** Usage-warning thresholds (percent) for both the credit bucket and spend cap. */
export const NABUFLOW_WARNING_THRESHOLDS = [50, 80, 100] as const;

export function getNabuflowPlan(planId: string | null | undefined): NabuflowPlanConfig | null {
  if (!planId) return null;
  const plan = NABUFLOW_PLANS[planId as NabuflowPlanId];
  return plan ?? null;
}

/** Plans a user can actually subscribe to (excludes the Constellation stub). */
export function purchasableNabuflowPlans(): NabuflowPlanConfig[] {
  return NABUFLOW_PLAN_IDS.map((id) => NABUFLOW_PLANS[id]).filter((p) => p.available);
}

/** Overage cents for `credits` at the plan's rate (rounded like the Stripe item). */
export function nabuflowOverageCents(plan: NabuflowPlanConfig, credits: number): number {
  if (credits <= 0) return 0;
  return Math.round(credits * plan.overageUsdPerCredit * 100);
}

/** Effective spend cap in cents: user setting clamped to [0, plan max], else default. */
export function nabuflowEffectiveSpendCapCents(
  plan: NabuflowPlanConfig,
  userCapCents: number | null | undefined,
): number {
  const maxCents = Math.round(plan.maxSpendCapUsd * 100);
  if (userCapCents === null || userCapCents === undefined) {
    return Math.min(Math.round(plan.defaultSpendCapUsd * 100), maxCents);
  }
  return Math.max(0, Math.min(userCapCents, maxCents));
}

/** The next tier up that lifts the given limitation, for upgrade hints. */
export function nabuflowUpgradeTarget(
  planId: NabuflowPlanId,
  reason: "pro" | "deep" | "combo" | "credits",
): NabuflowPlanId | null {
  if (planId === "nova" || planId === "constellation") return null;
  if (reason === "combo") return "nova";
  if (planId === "orbit") return reason === "deep" ? "comet" : "comet";
  if (planId === "comet") return "nova";
  return null;
}

/** Stripe price id override from env (env-scoped: test id in dev, live id in prod). */
export function nabuflowPriceIdFromEnv(plan: NabuflowPlanConfig): string | undefined {
  const v = process.env[plan.stripePriceIdEnv];
  return v && v.trim() ? v.trim() : undefined;
}
