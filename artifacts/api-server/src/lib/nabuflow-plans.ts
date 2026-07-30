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
// `creditCostFor` in ai-providers.ts returns today — Pro 10 (16 on Anthropic),
// Pro+Deep 13, Power 5/7, Eco 2/3, Lite 1. Included buckets are sized so the
// bucket's dollar value at the plan's own overage rate stays below the plan
// price (Orbit 1,800 cr × $0.012 = $21.60 marginal value on a $20 plan with
// only 3 Pro builds; Comet 4,800 × $0.011 = $52.80; Nova 10,500 × $0.010 =
// $105) — margin comes from typical partial utilisation plus the ladder caps,
// while overage is billed at or above the marginal rate from the first credit.
// ─────────────────────────────────────────────────────────────────────────────

export const NABUFLOW_PLAN_IDS = ["orbit", "comet", "nova", "constellation"] as const;
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
    includedMonthlyCredits: 1800,
    rolloverCycles: 0,
    rolloverMaxCredits: 0,
    parallelBuildLimit: 1,
    queuePriority: 1,
    overageUsdPerCredit: 0.012,
    defaultSpendCapUsd: 25,
    maxSpendCapUsd: 100,
    ladder: { proBuildsPerCycle: 3, deepBuildsPerCycle: 0, proDeepCombo: false },
    stripePriceIdEnv: "NABUFLOW_ORBIT_PRICE_ID",
    stripeLookupKey: "nabuflow_orbit_monthly",
    available: true,
    features: [
      "1,800 build credits / month",
      "Lite, Eco & Power engine modes",
      "3 Pro builds per cycle",
      "Pay-as-you-go overage at $0.012/credit",
      "1 concurrent build",
    ],
  },
  comet: {
    id: "comet",
    name: "Comet",
    priceUsd: 50,
    includedMonthlyCredits: 4800,
    rolloverCycles: 1,
    rolloverMaxCredits: 4800,
    parallelBuildLimit: 3,
    queuePriority: 2,
    overageUsdPerCredit: 0.011,
    defaultSpendCapUsd: 60,
    maxSpendCapUsd: 250,
    ladder: { proBuildsPerCycle: null, deepBuildsPerCycle: 10, proDeepCombo: false },
    stripePriceIdEnv: "NABUFLOW_COMET_PRICE_ID",
    stripeLookupKey: "nabuflow_comet_monthly",
    available: true,
    features: [
      "4,800 build credits / month",
      "Unlimited Pro builds",
      "10 Deep-reasoning builds per cycle",
      "Unused credits roll over one cycle",
      "Pay-as-you-go overage at $0.011/credit",
      "3 concurrent builds",
    ],
  },
  nova: {
    id: "nova",
    name: "Nova",
    priceUsd: 100,
    includedMonthlyCredits: 10500,
    rolloverCycles: 1,
    rolloverMaxCredits: 10500,
    parallelBuildLimit: 6,
    queuePriority: 3,
    overageUsdPerCredit: 0.01,
    defaultSpendCapUsd: 120,
    maxSpendCapUsd: 500,
    ladder: { proBuildsPerCycle: null, deepBuildsPerCycle: null, proDeepCombo: true },
    stripePriceIdEnv: "NABUFLOW_NOVA_PRICE_ID",
    stripeLookupKey: "nabuflow_nova_monthly",
    available: true,
    features: [
      "10,500 build credits / month",
      "Unlimited Pro & Deep-reasoning builds",
      "Pro + Deep combo (Nova exclusive)",
      "Unused credits roll over one cycle",
      "Pay-as-you-go overage at $0.010/credit",
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
