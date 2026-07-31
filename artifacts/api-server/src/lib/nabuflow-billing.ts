// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Builder billing core (Task #1516).
//
// Single server-side authority for:
//   • the canBuild gate — plan ∧ card-on-file ∧ under spend cap ∧ not
//     dunning-paused ∧ engine-mode ladder (Pro/Deep counters) — with
//     BILLING_EXEMPT_ALLOWLIST / superuser full bypass,
//   • cycle accounting — included credits drawn first (honoring rollover),
//     then metered pay-as-you-go overage recorded for Stripe invoicing,
//   • Pro/Deep metered counters (atomic with the charge),
//   • 50/80/100% warnings for both the credit bucket and the spend cap,
//   • dunning state driven by Stripe webhooks (retry → notify → pause).
//
// COMPLETELY separate from Ora's plan state: this module never reads or
// writes `user_subscriptions`, Ora quotas, or Ora Stripe products.
//
// Charge amounts are exactly what `creditCostFor` produced — the ladder
// controls ACCESS only; no charge point or price changes here.
// ─────────────────────────────────────────────────────────────────────────────

import { and, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import {
  db,
  nabuflowSubscriptionsTable,
  nabuflowBillingSettingsTable,
  nabuflowBillingCyclesTable,
  nabuflowUsageEventsTable,
  notificationsTable,
  type NabuflowSubscription,
  type NabuflowBillingCycle,
  type NabuflowUsageEvent,
} from "@workspace/db";
import {
  NABUFLOW_DUNNING,
  NABUFLOW_PLANS,
  NABUFLOW_WARNING_THRESHOLDS,
  getNabuflowPlan,
  nabuflowEffectiveSpendCapCents,
  nabuflowOrgDrawValueCents,
  nabuflowOverageCents,
  nabuflowUpgradeTarget,
  type NabuflowPlanConfig,
  type NabuflowPlanId,
} from "./nabuflow-plans";
import { isSuperuser } from "./superusers";
import { getClerkUserById } from "./clerk-users";
import { logger } from "./logger";
import { enqueueBillingSettlement } from "./billing-settlement-outbox";
import {
  getNabuflowOrgSeatContext,
  buildNabuflowOrgGateInfo,
  chargeNabuflowOrgPool,
  refundNabuflowOrgPool,
  type NabuflowOrgGateInfo,
} from "./nabuflow-org";

// ─────────────────────────────────────────────────────────────────────────────
// Enforcement + bypass
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Live read of the CREDITS_ENFORCEMENT kill switch. The legacy wallet path in
 * credits.ts keeps its boot-time constant; the gate reads live so tests (and
 * the eventual production flip) don't need a process restart.
 */
export function creditsEnforcementEnabled(): boolean {
  return process.env.CREDITS_ENFORCEMENT === "true";
}

const IS_PRODUCTION = process.env.REPLIT_DEPLOYMENT === "1";

/**
 * Test-only override hook. NEVER active in production: the flag is ignored
 * whenever REPLIT_DEPLOYMENT === "1", so no E2E/test bypass can activate there.
 */
export function nabuflowTestBypassActive(): boolean {
  if (IS_PRODUCTION) return false;
  return process.env.NABUFLOW_BILLING_TEST_BYPASS === "true";
}

// Billing-exemption cache: userId → { exempt, expiresAt } (5 min TTL).
const allowlistCache = new Map<string, { exempt: boolean; expiresAt: number }>();
const ALLOWLIST_CACHE_TTL_MS = 5 * 60_000;

/** Test helper — clears the allowlist exemption cache. */
export function _clearNabuflowAllowlistCache(): void {
  allowlistCache.clear();
}

/**
 * Parse the billing-only exemption list. An unset BILLING_EXEMPT_ALLOWLIST
 * falls back to BUILDER_ALLOWLIST for deployment compatibility. An explicitly
 * empty value exempts nobody. Any malformed entry disables all exemptions so
 * configuration mistakes fail closed.
 */
export function parseBillingExemptAllowlist(
  raw: string | undefined = process.env.BILLING_EXEMPT_ALLOWLIST,
  fallbackRaw: string | undefined = process.env.BUILDER_ALLOWLIST,
): Set<string> {
  const source = raw === undefined ? fallbackRaw : raw;
  if (!source?.trim()) return new Set();

  const entries = source.split(",").map((email) => email.trim().toLowerCase());
  const validEmail = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;
  if (entries.some((email) => !email || !validEmail.test(email))) {
    logger.error(
      { source: raw === undefined ? "BUILDER_ALLOWLIST fallback" : "BILLING_EXEMPT_ALLOWLIST" },
      "Invalid billing exemption allowlist; exemptions disabled",
    );
    return new Set();
  }
  return new Set(entries);
}

/**
 * True when the user's email is on BILLING_EXEMPT_ALLOWLIST (or, only while
 * that variable is unset, the backward-compatible BUILDER_ALLOWLIST fallback).
 *
 * Deliberately does NOT honor BUILDER_OPEN_TO_ALL — opening builder ACCESS to
 * everyone must not exempt everyone from BILLING.
 */
export async function isBuilderAllowlistExempt(userId: string): Promise<boolean> {
  const allowlist = parseBillingExemptAllowlist();
  if (allowlist.size === 0) return false;

  const cached = allowlistCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.exempt;

  let exempt: boolean;
  try {
    const email = (await getClerkUserById(userId))?.email;
    exempt = !!email && allowlist.has(email.trim().toLowerCase());
  } catch {
    exempt = false; // degrade closed — a lookup failure must not grant free builds
  }
  allowlistCache.set(userId, { exempt, expiresAt: Date.now() + ALLOWLIST_CACHE_TTL_MS });
  return exempt;
}

/** Superuser OR explicit billing exemption allowlist — full billing bypass. */
export async function isNabuflowBillingExempt(userId: string): Promise<boolean> {
  if (await isSuperuser(userId)) return true;
  return isBuilderAllowlistExempt(userId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription + cycle state
// ─────────────────────────────────────────────────────────────────────────────

/** Statuses under which the user is billed through NabuFlow cycle accounting. */
const CHARGEABLE_STATUSES = new Set(["active", "trialing", "past_due"]);

export function isChargeableNabuflowStatus(status: string | null | undefined): boolean {
  return !!status && CHARGEABLE_STATUSES.has(status);
}

export async function getNabuflowSubscription(
  userId: string,
): Promise<NabuflowSubscription | null> {
  const [row] = await db
    .select()
    .from(nabuflowSubscriptionsTable)
    .where(eq(nabuflowSubscriptionsTable.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function findNabuflowSubscriptionByStripeId(
  stripeSubscriptionId: string,
): Promise<NabuflowSubscription | null> {
  const [row] = await db
    .select()
    .from(nabuflowSubscriptionsTable)
    .where(eq(nabuflowSubscriptionsTable.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return row ?? null;
}

export async function findNabuflowSubscriptionByCustomerId(
  stripeCustomerId: string,
): Promise<NabuflowSubscription | null> {
  const [row] = await db
    .select()
    .from(nabuflowSubscriptionsTable)
    .where(eq(nabuflowSubscriptionsTable.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row ?? null;
}

/**
 * Idempotently create (or re-link) the local subscription row for a user.
 * First-time subscribers have NO local row when the first Stripe event — or
 * the subscribe route's direct sync — arrives, and webhook delivery order is
 * not guaranteed, so subscription AND invoice handlers must be able to
 * materialize the row from the subscription's `surface: nabuflow` metadata.
 * Race-safe via the unique userId constraint: concurrent events collapse to
 * one row and the loser just re-links the Stripe ids. Status stays at the
 * schema default ("incomplete"); every caller immediately syncs the real
 * status afterwards.
 */
export async function materializeNabuflowSubscriptionRow(opts: {
  userId: string;
  planId: NabuflowPlanId;
  stripeSubscriptionId: string;
  stripeCustomerId?: string | null;
}): Promise<NabuflowSubscription | null> {
  const [row] = await db
    .insert(nabuflowSubscriptionsTable)
    .values({
      userId: opts.userId,
      planId: opts.planId,
      stripeSubscriptionId: opts.stripeSubscriptionId,
      ...(opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {}),
    })
    .onConflictDoUpdate({
      target: nabuflowSubscriptionsTable.userId,
      set: {
        stripeSubscriptionId: opts.stripeSubscriptionId,
        ...(opts.stripeCustomerId ? { stripeCustomerId: opts.stripeCustomerId } : {}),
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row ?? (await getNabuflowSubscription(opts.userId));
}

/**
 * True when charges for this user must flow through NabuFlow cycle accounting
 * (used by legacy wallet-balance preflights to step aside).
 */
export async function nabuflowChargeActive(userId: string): Promise<boolean> {
  if (!creditsEnforcementEnabled()) return false;
  // Enterprise seats always bill to the org pool (even while suspended: a
  // reserved build that started must still drain from the pool, honestly).
  if (await getNabuflowOrgSeatContext(userId)) return true;
  const sub = await getNabuflowSubscription(userId);
  return !!sub && isChargeableNabuflowStatus(sub.status) && !!getNabuflowPlan(sub.planId);
}

/** Effective spend cap in cents for the user's plan (user setting clamped). */
export async function getNabuflowSpendCapCents(
  userId: string,
  plan: NabuflowPlanConfig,
): Promise<number> {
  const [settings] = await db
    .select()
    .from(nabuflowBillingSettingsTable)
    .where(eq(nabuflowBillingSettingsTable.userId, userId))
    .limit(1);
  return nabuflowEffectiveSpendCapCents(plan, settings?.spendCapUsdCents ?? null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure cycle math (unit-tested directly)
// ─────────────────────────────────────────────────────────────────────────────

/** Split a charge into included-bucket and overage portions. */
export function splitNabuflowCharge(
  remainingIncluded: number,
  cost: number,
): { included: number; overage: number } {
  const included = Math.max(Math.min(cost, Math.max(remainingIncluded, 0)), 0);
  return { included, overage: cost - included };
}

/**
 * Credits carried into the NEXT cycle from a finished one. Unused *included*
 * credits only (metered Pro/Deep builds never roll over), capped at the plan's
 * rolloverMaxCredits, surviving exactly one cycle (Orbit: none).
 */
export function computeNabuflowRollover(
  plan: NabuflowPlanConfig,
  prevIncludedCredits: number,
  prevUsedIncludedCredits: number,
): number {
  if (plan.rolloverCycles <= 0) return 0;
  const unused = Math.max(prevIncludedCredits - prevUsedIncludedCredits, 0);
  return Math.min(unused, plan.rolloverMaxCredits);
}

/**
 * Advance a cycle anchor until it contains `now` — the lazy local complement
 * to webhook-driven renewal (and the engine behind simulated-rollover tests).
 * Metered counters reset by construction (each cycle is a fresh row); the
 * returned rolloverCredits chains through any skipped (idle) cycles.
 */
export function simulateNabuflowCycleAdvance(
  plan: NabuflowPlanConfig,
  prev: {
    cycleStart: Date;
    cycleEnd: Date;
    includedCredits: number;
    usedIncludedCredits: number;
  },
  now: Date,
): { cycleStart: Date; cycleEnd: Date; rolloverCredits: number } {
  const periodMs = Math.max(prev.cycleEnd.getTime() - prev.cycleStart.getTime(), 24 * 60 * 60_000);
  let rollover = computeNabuflowRollover(plan, prev.includedCredits, prev.usedIncludedCredits);
  let start = prev.cycleEnd;
  let end = new Date(start.getTime() + periodMs);

  while (now.getTime() >= end.getTime()) {
    // A skipped cycle was fully idle: its whole bucket went unused.
    rollover = computeNabuflowRollover(plan, plan.includedMonthlyCredits + rollover, 0);
    start = end;
    end = new Date(start.getTime() + periodMs);
  }

  return { cycleStart: start, cycleEnd: end, rolloverCredits: rollover };
}

/** Highest warning threshold (0|50|80|100) reached by used/total. */
export function usageThresholdLevel(used: number, total: number): number {
  if (total <= 0) return 0;
  const pct = (used / total) * 100;
  let level = 0;
  for (const t of NABUFLOW_WARNING_THRESHOLDS) {
    if (pct >= t) level = t;
  }
  return level;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate — pure evaluator + DB-backed resolver
// ─────────────────────────────────────────────────────────────────────────────

export type NabuflowGateSource =
  | "pipeline"
  | "background"
  | "queue"
  | "eas"
  | "architect"
  | "resume";

export interface NabuflowGateRequest {
  /** lite | eco | power | pro — omit for mode-less work (e.g. EAS builds). */
  engineMode?: string | null;
  deepReasoning?: boolean;
  /** Exact creditCostFor output for the build about to start. */
  projectedCredits?: number;
  source?: NabuflowGateSource;
  /**
   * True when this build's charge/counters were already reserved at enqueue.
   * Skips ladder + spend-cap so the drain-time re-check can never block the
   * very task that consumed the last slot (plan/card/pause still enforced).
   */
  skipUsageChecks?: boolean;
}

export type NabuflowGateErrorCode =
  | "no_plan"
  | "subscription_inactive"
  | "no_payment_method"
  | "card_expired"
  | "billing_paused"
  | "mode_not_available"
  | "combo_not_available"
  | "mode_limit_reached"
  | "spend_cap_reached"
  // Enterprise (Constellation) org-seat blocks — honest states, calm copy.
  | "org_suspended"
  | "org_pool_exhausted"
  | "org_spend_cap_reached"
  | "org_seat_cap_reached";

export interface NabuflowGateError {
  code: NabuflowGateErrorCode;
  message: string;
  planId: string | null;
  remainingProBuilds?: number | null;
  remainingDeepBuilds?: number | null;
  /** ISO date when metered counters / the bucket reset (cycle end). */
  resetsAt?: string | null;
  upgradeTarget?: string | null;
}

export type NabuflowGateBypass = "superuser" | "allowlist" | "enforcement_disabled" | "test";

export type NabuflowGateDecision =
  | { allowed: true; bypass: NabuflowGateBypass | null }
  | { allowed: false; error: NabuflowGateError };

export interface NabuflowGateState {
  plan: NabuflowPlanConfig | null;
  subscription: Pick<
    NabuflowSubscription,
    | "status"
    | "planId"
    | "dunningStatus"
    | "dunningGraceUntil"
    | "defaultPaymentMethodId"
    | "cardExpMonth"
    | "cardExpYear"
    | "currentCycleEnd"
  > | null;
  cycle: Pick<
    NabuflowBillingCycle,
    | "includedCredits"
    | "usedIncludedCredits"
    | "overageUsdCents"
    | "proBuildsUsed"
    | "deepBuildsUsed"
  > | null;
  spendCapUsdCents: number;
  /**
   * Present when the account is a seat of a Constellation enterprise org —
   * the org lane REPLACES the personal plan rules (prepaid pool, no card
   * requirement; org cap + optional seat sub-cap instead of the personal cap).
   */
  org?: NabuflowOrgGateInfo | null;
}

function cardExpired(
  expMonth: number | null | undefined,
  expYear: number | null | undefined,
  now: Date,
): boolean {
  if (!expMonth || !expYear) return false; // unknown expiry — PM presence rules
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return expYear < y || (expYear === y && expMonth < m);
}

function remainingOf(limit: number | null, used: number): number | null {
  if (limit === null) return null;
  return Math.max(limit - used, 0);
}

/**
 * Pure canBuild evaluation — every rule of the NabuFlow gate in one place.
 * Bypass (superuser/allowlist/enforcement-off) is handled by the resolver.
 */
export function evaluateNabuflowGate(
  state: NabuflowGateState,
  request: NabuflowGateRequest,
  now: Date = new Date(),
): NabuflowGateDecision {
  const { plan, subscription: sub, cycle } = state;
  const resetsAt = sub?.currentCycleEnd ? sub.currentCycleEnd.toISOString() : null;

  const block = (error: NabuflowGateError): NabuflowGateDecision => ({ allowed: false, error });

  // ── Enterprise org seats (Constellation) ──────────────────────────────────
  // The org lane replaces personal-plan rules: the pool is PREPAID (no card
  // requirement, no dunning), mode access follows the Constellation ladder,
  // and spending is bounded by the org-wide monthly cap plus the optional
  // per-seat sub-cap. Blocks are pre-start only — in-flight builds are never
  // killed, which is also why the pool may go slightly negative.
  if (state.org) {
    const org = state.org;
    const orgResetsAt = org.monthResetsAt.toISOString();
    const resetDay = orgResetsAt.slice(0, 10);

    if (org.status !== "active") {
      return block({
        code: "org_suspended",
        message: `${org.companyName}'s NabuFlow billing is suspended. Ask your billing admin to get things back up.`,
        planId: "constellation",
      });
    }

    // Reserved-at-enqueue builds re-checked at drain: plan/status verified,
    // usage checks already consumed at reserve time (mirrors personal lane).
    if (request.skipUsageChecks) return { allowed: true, bypass: null };

    // Engine-mode availability follows the Constellation ladder config (all
    // modes + Pro+Deep combo today; config stays authoritative).
    const orgLadder = NABUFLOW_PLANS.constellation.ladder;
    const mode = request.engineMode ?? null;
    const deep = !!request.deepReasoning;
    if (deep && orgLadder.deepBuildsPerCycle === 0) {
      return block({
        code: "mode_not_available",
        message: "Deep reasoning isn't enabled for your organization's plan.",
        planId: "constellation",
      });
    }
    if (mode === "pro" && deep && !orgLadder.proDeepCombo) {
      return block({
        code: "combo_not_available",
        message: "Pro + Deep together isn't enabled for your organization's plan.",
        planId: "constellation",
      });
    }

    const projected = Math.max(request.projectedCredits ?? 0, 0);
    const projectedValueCents = nabuflowOrgDrawValueCents(projected);

    // Shared pool must cover the build (honest block; admins top up).
    if (org.poolCredits < projected || (projected === 0 && org.poolCredits <= 0)) {
      return block({
        code: "org_pool_exhausted",
        message: `${org.companyName}'s shared credit pool ${org.poolCredits <= 0 ? "is empty" : "can't cover this build"}. Ask your billing admin to top up the pool.`,
        planId: "constellation",
      });
    }

    // Org-wide monthly spend cap (draw value at the Constellation rate).
    if (projectedValueCents > 0 && org.monthDrawnUsdCents + projectedValueCents > org.capUsdCents) {
      return block({
        code: "org_spend_cap_reached",
        message: `This build would take ${org.companyName} past its monthly spend cap. Your billing admin can raise it, or it resets on ${resetDay}.`,
        planId: "constellation",
        resetsAt: orgResetsAt,
      });
    }

    // Optional per-seat sub-cap.
    if (
      org.seatCapUsdCents !== null &&
      projectedValueCents > 0 &&
      org.seatMonthDrawnUsdCents + projectedValueCents > org.seatCapUsdCents
    ) {
      return block({
        code: "org_seat_cap_reached",
        message: `This build would exceed your seat's monthly limit at ${org.companyName}. Ask your billing admin to raise it, or it resets on ${resetDay}.`,
        planId: "constellation",
        resetsAt: orgResetsAt,
      });
    }

    return { allowed: true, bypass: null };
  }

  if (!sub || !plan) {
    return block({
      code: "no_plan",
      message:
        "NabuFlow builds require an active plan. Choose Orbit, Comet, or Nova to keep building.",
      planId: null,
      upgradeTarget: "orbit",
    });
  }

  if (!isChargeableNabuflowStatus(sub.status)) {
    return block({
      code: "subscription_inactive",
      message: "Your NabuFlow subscription isn't active. Reactivate a plan to keep building.",
      planId: sub.planId,
      upgradeTarget: sub.planId,
    });
  }

  // Hard card-on-file requirement.
  if (!sub.defaultPaymentMethodId) {
    return block({
      code: "no_payment_method",
      message: "Add a payment method to keep building. NabuFlow plans require a card on file.",
      planId: sub.planId,
    });
  }
  if (cardExpired(sub.cardExpMonth, sub.cardExpYear, now)) {
    return block({
      code: "card_expired",
      message: "Your card on file has expired. Update your payment method to keep building.",
      planId: sub.planId,
    });
  }

  // Dunning: paused outright, or retrying past the grace window.
  const gracePassed =
    sub.dunningStatus === "retrying" &&
    !!sub.dunningGraceUntil &&
    now.getTime() > sub.dunningGraceUntil.getTime();
  if (sub.dunningStatus === "paused" || gracePassed) {
    return block({
      code: "billing_paused",
      message:
        "New builds are paused because a payment didn't go through. Update your payment method to resume building.",
      planId: sub.planId,
    });
  }

  if (request.skipUsageChecks) return { allowed: true, bypass: null };

  const mode = request.engineMode ?? null;
  const deep = !!request.deepReasoning;
  const ladder = plan.ladder;
  const proUsed = cycle?.proBuildsUsed ?? 0;
  const deepUsed = cycle?.deepBuildsUsed ?? 0;
  const remainingPro = remainingOf(ladder.proBuildsPerCycle, proUsed);
  const remainingDeep = remainingOf(ladder.deepBuildsPerCycle, deepUsed);

  if (mode || deep) {
    // Deep reasoning entitlement (Orbit: none at all).
    if (deep && ladder.deepBuildsPerCycle === 0) {
      return block({
        code: "mode_not_available",
        message: `Deep reasoning isn't available on ${plan.name}. Upgrade to unlock Deep builds.`,
        planId: plan.id,
        remainingProBuilds: remainingPro,
        remainingDeepBuilds: 0,
        resetsAt,
        upgradeTarget: nabuflowUpgradeTarget(plan.id, "deep"),
      });
    }

    // Pro + Deep combo is Nova-exclusive.
    if (mode === "pro" && deep && !ladder.proDeepCombo) {
      return block({
        code: "combo_not_available",
        message: "Pro + Deep together is a Nova exclusive. Upgrade to Nova to combine them.",
        planId: plan.id,
        remainingProBuilds: remainingPro,
        remainingDeepBuilds: remainingDeep,
        resetsAt,
        upgradeTarget: nabuflowUpgradeTarget(plan.id, "combo"),
      });
    }

    // Metered Pro-build counter.
    if (
      mode === "pro" &&
      ladder.proBuildsPerCycle !== null &&
      proUsed >= ladder.proBuildsPerCycle
    ) {
      return block({
        code: "mode_limit_reached",
        message: `You've used all ${ladder.proBuildsPerCycle} Pro builds for this cycle. They reset ${resetsAt ? `on ${resetsAt.slice(0, 10)}` : "next cycle"}, or upgrade for unlimited Pro builds.`,
        planId: plan.id,
        remainingProBuilds: 0,
        remainingDeepBuilds: remainingDeep,
        resetsAt,
        upgradeTarget: nabuflowUpgradeTarget(plan.id, "pro"),
      });
    }

    // Metered Deep-build counter.
    if (deep && ladder.deepBuildsPerCycle !== null && deepUsed >= ladder.deepBuildsPerCycle) {
      return block({
        code: "mode_limit_reached",
        message: `You've used all ${ladder.deepBuildsPerCycle} Deep builds for this cycle. They reset ${resetsAt ? `on ${resetsAt.slice(0, 10)}` : "next cycle"}, or upgrade for unlimited Deep builds.`,
        planId: plan.id,
        remainingProBuilds: remainingPro,
        remainingDeepBuilds: 0,
        resetsAt,
        upgradeTarget: nabuflowUpgradeTarget(plan.id, "deep"),
      });
    }
  }

  // Spend cap — projected OVERAGE dollars only; builds fully covered by the
  // included bucket never count against the cap. Enforced at build start only
  // (in-flight builds are never killed).
  const projected = Math.max(request.projectedCredits ?? 0, 0);
  if (projected > 0 && cycle) {
    const remainingIncluded = Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0);
    const { overage } = splitNabuflowCharge(remainingIncluded, projected);
    if (overage > 0) {
      const projectedCents = nabuflowOverageCents(plan, overage);
      if (cycle.overageUsdCents + projectedCents > state.spendCapUsdCents) {
        return block({
          code: "spend_cap_reached",
          message:
            "This build's projected cost would go over your monthly spend cap. Raise the cap in billing settings or wait for the next cycle.",
          planId: plan.id,
          remainingProBuilds: remainingPro,
          remainingDeepBuilds: remainingDeep,
          resetsAt,
        });
      }
    }
  }

  return { allowed: true, bypass: null };
}

/**
 * Full canBuild gate: bypass checks, then live plan/cycle state, then the pure
 * evaluator. This is THE resolver — every build entry point calls it.
 */
export async function resolveNabuflowBuildGate(
  userId: string,
  request: NabuflowGateRequest = {},
): Promise<NabuflowGateDecision> {
  if (!creditsEnforcementEnabled()) return { allowed: true, bypass: "enforcement_disabled" };
  if (nabuflowTestBypassActive()) return { allowed: true, bypass: "test" };
  if (await isSuperuser(userId)) return { allowed: true, bypass: "superuser" };
  if (await isBuilderAllowlistExempt(userId)) return { allowed: true, bypass: "allowlist" };

  // Enterprise seats bill to their org's shared pool — the org lane replaces
  // the personal-plan rules entirely (deterministic: one org per account).
  const orgCtx = await getNabuflowOrgSeatContext(userId);
  if (orgCtx) {
    const org = await buildNabuflowOrgGateInfo(orgCtx);
    return evaluateNabuflowGate(
      { plan: null, subscription: null, cycle: null, spendCapUsdCents: 0, org },
      request,
    );
  }

  const sub = await getNabuflowSubscription(userId);
  const plan = getNabuflowPlan(sub?.planId);

  let cycle: NabuflowBillingCycle | null = null;
  let capCents = 0;
  if (sub && plan && isChargeableNabuflowStatus(sub.status)) {
    try {
      cycle = await ensureCurrentNabuflowCycle(sub, plan);
    } catch (err) {
      logger.error({ err, userId }, "nabuflow: ensureCurrentNabuflowCycle failed in gate");
    }
    capCents = await getNabuflowSpendCapCents(userId, plan);
  }

  return evaluateNabuflowGate(
    { plan, subscription: sub, cycle, spendCapUsdCents: capCents },
    request,
  );
}

/** Standard calm HTTP body for a blocked build (402). */
export function nabuflowGateHttpBody(error: NabuflowGateError): {
  error: string;
  code: string;
  billing: NabuflowGateError;
} {
  return { error: error.message, code: "nabuflow_billing", billing: error };
}

/**
 * Convenience for route handlers: null when the build may proceed, otherwise
 * `{ status, body }` to return as-is.
 */
export async function nabuflowGateHttpError(
  userId: string,
  request: NabuflowGateRequest = {},
): Promise<{ status: number; body: ReturnType<typeof nabuflowGateHttpBody> } | null> {
  const decision = await resolveNabuflowBuildGate(userId, request);
  if (decision.allowed) return null;
  return { status: 402, body: nabuflowGateHttpBody(decision.error) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cycle materialization
// ─────────────────────────────────────────────────────────────────────────────

async function getCycleRow(userId: string, cycleStart: Date): Promise<NabuflowBillingCycle | null> {
  const [row] = await db
    .select()
    .from(nabuflowBillingCyclesTable)
    .where(
      and(
        eq(nabuflowBillingCyclesTable.userId, userId),
        eq(nabuflowBillingCyclesTable.cycleStart, cycleStart),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function latestCycleBefore(
  userId: string,
  cycleStart: Date,
): Promise<NabuflowBillingCycle | null> {
  const [row] = await db
    .select()
    .from(nabuflowBillingCyclesTable)
    .where(
      and(
        eq(nabuflowBillingCyclesTable.userId, userId),
        lt(nabuflowBillingCyclesTable.cycleStart, cycleStart),
      ),
    )
    .orderBy(desc(nabuflowBillingCyclesTable.cycleStart))
    .limit(1);
  return row ?? null;
}

/**
 * Insert-or-get the cycle row for [cycleStart, cycleEnd). Idempotent via the
 * (userId, cycleStart) unique constraint — concurrent grants collapse to one.
 */
async function materializeCycle(
  userId: string,
  plan: NabuflowPlanConfig,
  cycleStart: Date,
  cycleEnd: Date,
  rolloverCredits: number,
): Promise<NabuflowBillingCycle> {
  const included = plan.includedMonthlyCredits + Math.max(rolloverCredits, 0);
  const inserted = await db
    .insert(nabuflowBillingCyclesTable)
    .values({
      userId,
      planId: plan.id,
      cycleStart,
      cycleEnd,
      includedCredits: included,
      rolloverCredits: Math.max(rolloverCredits, 0),
    })
    .onConflictDoNothing({
      target: [nabuflowBillingCyclesTable.userId, nabuflowBillingCyclesTable.cycleStart],
    })
    .returning();
  if (inserted.length > 0) return inserted[0];
  const existing = await getCycleRow(userId, cycleStart);
  if (!existing) throw new Error("nabuflow: cycle row vanished after conflict");
  return existing;
}

/**
 * Ensure the subscription's CURRENT cycle row exists, lazily advancing the
 * anchor when `now` has passed cycleEnd (webhooks are the primary boundary;
 * this keeps accounting correct between/without them and powers simulated
 * rollover in tests). Unused included credits roll per plan policy; metered
 * counters reset because a new cycle is a fresh row.
 */
export async function ensureCurrentNabuflowCycle(
  sub: NabuflowSubscription,
  plan: NabuflowPlanConfig,
  now: Date = new Date(),
): Promise<NabuflowBillingCycle> {
  let cycleStart = sub.currentCycleStart;
  let cycleEnd = sub.currentCycleEnd;
  let rollover = sub.rolloverCredits ?? 0;

  // No anchor yet (subscription still settling) — anchor locally at `now`;
  // the subscription webhook will overwrite with Stripe's authoritative period.
  if (!cycleStart || !cycleEnd || cycleEnd.getTime() <= cycleStart.getTime()) {
    cycleStart = now;
    cycleEnd = new Date(now.getTime() + 30 * 24 * 60 * 60_000);
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ currentCycleStart: cycleStart, currentCycleEnd: cycleEnd, updatedAt: sql`now()` })
      .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  }

  if (now.getTime() >= cycleEnd.getTime()) {
    // Lazy local rollover — advance to the period containing `now`.
    const prevRow = await getCycleRow(sub.userId, cycleStart);
    const prev = {
      cycleStart,
      cycleEnd,
      includedCredits: prevRow?.includedCredits ?? plan.includedMonthlyCredits + rollover,
      usedIncludedCredits: prevRow?.usedIncludedCredits ?? 0,
    };
    const advanced = simulateNabuflowCycleAdvance(plan, prev, now);
    cycleStart = advanced.cycleStart;
    cycleEnd = advanced.cycleEnd;
    rollover = advanced.rolloverCredits;
    await db
      .update(nabuflowSubscriptionsTable)
      .set({
        currentCycleStart: cycleStart,
        currentCycleEnd: cycleEnd,
        rolloverCredits: rollover,
        updatedAt: sql`now()`,
      })
      .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  }

  return materializeCycle(sub.userId, plan, cycleStart, cycleEnd, rollover);
}

/**
 * Webhook-driven cycle grant (invoice.paid / subscription renewal): move the
 * anchor to Stripe's authoritative period and materialize the fresh bucket
 * (rollover honored, counters reset). Idempotent per (userId, cycleStart).
 */
export async function grantNabuflowCycle(
  sub: NabuflowSubscription,
  plan: NabuflowPlanConfig,
  periodStart: Date,
  periodEnd: Date,
): Promise<NabuflowBillingCycle> {
  const prev = await latestCycleBefore(sub.userId, periodStart);
  const rollover = prev
    ? computeNabuflowRollover(plan, prev.includedCredits, prev.usedIncludedCredits)
    : Math.max(sub.rolloverCredits ?? 0, 0);

  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      currentCycleStart: periodStart,
      currentCycleEnd: periodEnd,
      rolloverCredits: rollover,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));

  return materializeCycle(sub.userId, plan, periodStart, periodEnd, rollover);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charging — included bucket first, then metered overage (atomic w/ counters)
// ─────────────────────────────────────────────────────────────────────────────

export interface NabuflowChargeOpts {
  projectId?: number | null;
  taskId?: number | null;
  type: string; // build | refine | plan | architect | senses | creative | converse
  description: string;
  engineMode?: string | null;
  deepReasoning?: boolean;
  source?: string | null;
  settlementKey?: string | null;
}

function sourceForCharge(opts: NabuflowChargeOpts): string {
  if (opts.source) return opts.source;
  switch (opts.type) {
    case "architect":
      return "architect";
    case "senses":
      return "senses";
    case "converse":
      return "converse";
    case "creative":
      return "creative";
    case "plan":
      return "plan";
    default:
      return "pipeline";
  }
}

/**
 * Record an authorized builder operation whose actual charge was zero.
 *
 * Exempt owners still need a ledger row so Usage, Full History, calibration,
 * and reconciliation all describe the same real operation. A settlement key
 * makes durable retries idempotent; zero-valued rows never touch cycle counters
 * or Stripe.
 */
export async function recordZeroChargeUsage(
  userId: string,
  opts: NabuflowChargeOpts,
): Promise<void> {
  const now = new Date();
  const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  await db
    .insert(nabuflowUsageEventsTable)
    .values({
      userId,
      cycleId: null,
      cycleStart,
      projectId: opts.projectId ?? null,
      taskId: opts.taskId ?? null,
      source: sourceForCharge(opts),
      engineMode: opts.engineMode ?? null,
      deepReasoning: !!opts.deepReasoning,
      credits: 0,
      includedCredits: 0,
      overageCredits: 0,
      overageUsdCents: 0,
      usdValueCents: 0,
      attribution: "included",
      description: opts.description,
      settlementKey: opts.settlementKey ?? null,
    })
    .onConflictDoNothing();
}

/** Only real builds tick the ladder counters (never senses/architect/etc.). */
function countsTowardLadder(opts: NabuflowChargeOpts): boolean {
  return opts.type === "build" || opts.type === "refine";
}

export interface NabuflowChargeResult {
  event: NabuflowUsageEvent;
  cycle: NabuflowBillingCycle;
  includedDelta: number;
  overageDelta: number;
  overageUsdCents: number;
  remainingIncluded: number;
}

/**
 * Charge `amount` credits against the user's current cycle: included bucket
 * first, remainder as metered pay-as-you-go overage. Counter increments are
 * atomic with the charge (row lock) so concurrent builds cannot overshoot.
 * NEVER fails a started build — spend caps are enforced pre-start by the gate.
 */
export async function chargeNabuflowCycle(
  sub: NabuflowSubscription,
  plan: NabuflowPlanConfig,
  cycleId: number,
  amount: number,
  opts: NabuflowChargeOpts,
): Promise<NabuflowChargeResult> {
  const proInc = countsTowardLadder(opts) && opts.engineMode === "pro" ? 1 : 0;
  const deepInc = countsTowardLadder(opts) && opts.deepReasoning ? 1 : 0;

  const result = await db.transaction(async (tx) => {
    const [cycle] = await tx
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(eq(nabuflowBillingCyclesTable.id, cycleId))
      .for("update");
    if (!cycle) throw new Error(`nabuflow: cycle ${cycleId} not found for charge`);

    const remainingIncluded = Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0);
    const { included: includedDelta, overage: overageDelta } = splitNabuflowCharge(
      remainingIncluded,
      amount,
    );
    const overageUsdCents = nabuflowOverageCents(plan, overageDelta);
    const usdValueCents = nabuflowOverageCents(plan, amount);
    const attribution = overageDelta === 0 ? "included" : includedDelta === 0 ? "overage" : "mixed";

    const [updatedCycle] = await tx
      .update(nabuflowBillingCyclesTable)
      .set({
        usedIncludedCredits: sql`${nabuflowBillingCyclesTable.usedIncludedCredits} + ${includedDelta}`,
        overageCredits: sql`${nabuflowBillingCyclesTable.overageCredits} + ${overageDelta}`,
        overageUsdCents: sql`${nabuflowBillingCyclesTable.overageUsdCents} + ${overageUsdCents}`,
        proBuildsUsed: sql`${nabuflowBillingCyclesTable.proBuildsUsed} + ${proInc}`,
        deepBuildsUsed: sql`${nabuflowBillingCyclesTable.deepBuildsUsed} + ${deepInc}`,
        updatedAt: sql`now()`,
      })
      .where(eq(nabuflowBillingCyclesTable.id, cycleId))
      .returning();

    const [event] = await tx
      .insert(nabuflowUsageEventsTable)
      .values({
        userId: sub.userId,
        cycleId: cycle.id,
        cycleStart: cycle.cycleStart,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        source: sourceForCharge(opts),
        engineMode: opts.engineMode ?? null,
        deepReasoning: !!opts.deepReasoning,
        credits: amount,
        includedCredits: includedDelta,
        overageCredits: overageDelta,
        overageUsdCents,
        usdValueCents,
        attribution,
        description: opts.description,
        settlementKey: opts.settlementKey ?? null,
      })
      .returning();

    return {
      event,
      cycle: updatedCycle,
      includedDelta,
      overageDelta,
      overageUsdCents,
      remainingIncluded: Math.max(
        updatedCycle.includedCredits - updatedCycle.usedIncludedCredits,
        0,
      ),
    };
  });

  // Metered overage -> pending Stripe invoice item (swept into the cycle-close
  // invoice). Stripe remains off the build path, but failures are durably
  // retried instead of surviving only as an operator log.
  if (result.overageDelta > 0 && sub.stripeCustomerId) {
    const payload: NabuflowOverageSettlementPayload = {
      customerId: sub.stripeCustomerId,
      subscriptionId: sub.stripeSubscriptionId,
      amountCents: result.overageUsdCents,
      credits: result.overageDelta,
      planId: plan.id,
      userId: sub.userId,
      eventId: result.event.id,
    };
    void reportNabuflowOveragePayload(payload).catch(async (err) => {
      logger.error(
        { err, userId: sub.userId, eventId: result.event.id },
        "nabuflow: overage invoice item failed; enqueueing durable retry",
      );
      try {
        await enqueueBillingSettlement({
          kind: "overage_invoice_item",
          dedupeKey: `overage-stripe:${result.event.id}`,
          taskId: result.event.taskId,
          ownerId: sub.userId,
          amount: result.overageUsdCents,
          context: payload as unknown as Record<string, unknown>,
          error: err,
        });
      } catch {
        // Enqueue exhaustion is already logged by the outbox helper.
      }
    });
  }

  // Threshold notifications (bucket + cap) — fire-and-forget.
  void notifyNabuflowThresholds(sub, plan, result.cycle).catch((err) => {
    logger.warn({ err, userId: sub.userId }, "nabuflow: threshold notification failed");
  });

  return result;
}

export interface NabuflowOverageSettlementPayload {
  customerId: string;
  subscriptionId: string | null;
  amountCents: number;
  credits: number;
  planId: string;
  userId: string;
  eventId: number;
}

export async function reportNabuflowOveragePayload(
  payload: NabuflowOverageSettlementPayload,
): Promise<void> {
  const [existing] = await db
    .select({ stripeInvoiceItemId: nabuflowUsageEventsTable.stripeInvoiceItemId })
    .from(nabuflowUsageEventsTable)
    .where(eq(nabuflowUsageEventsTable.id, payload.eventId))
    .limit(1);
  if (!existing) throw new Error(`NabuFlow usage event ${payload.eventId} not found`);
  if (existing?.stripeInvoiceItemId) return;

  const { createNabuflowOverageInvoiceItem } = await import("./nabuflow-stripe");
  const itemId = await createNabuflowOverageInvoiceItem(payload);
  if (!itemId) throw new Error("Stripe unavailable for NabuFlow overage settlement");
  await db
    .update(nabuflowUsageEventsTable)
    .set({ stripeInvoiceItemId: itemId, stripeReportedAt: sql`now()` })
    .where(eq(nabuflowUsageEventsTable.id, payload.eventId));
}

/**
 * Delegation target for credits.ts deductCreditsAtomic: when the user is on an
 * active NabuFlow plan, the charge flows through cycle accounting (included →
 * overage) and NEVER returns "insufficient" (the gate already authorized it).
 * Returns null when NabuFlow billing does not apply (caller falls through to
 * the legacy wallet).
 */
export async function maybeChargeNabuflow(
  userId: string,
  amount: number,
  opts: NabuflowChargeOpts,
): Promise<{ newBalance: number } | null> {
  if (amount <= 0) return null;

  if (opts.settlementKey) {
    const [existing] = await db
      .select({ id: nabuflowUsageEventsTable.id })
      .from(nabuflowUsageEventsTable)
      .where(eq(nabuflowUsageEventsTable.settlementKey, opts.settlementKey))
      .limit(1);
    if (existing) return { newBalance: 0 };
  }

  // Enterprise seats draw from the org's shared pool — same charge pipeline,
  // same credit amounts, pool accounting instead of personal cycles. Never
  // fails a started build (the pool may dip below zero; the gate blocks new
  // builds pre-start).
  try {
    const orgCtx = await getNabuflowOrgSeatContext(userId);
    if (orgCtx) {
      const drawn = await chargeNabuflowOrgPool(orgCtx.org.id, userId, amount, opts);
      return { newBalance: Math.max(drawn.poolCredits, 0) };
    }

    const sub = await getNabuflowSubscription(userId);
    if (!sub || !isChargeableNabuflowStatus(sub.status)) return null;
    const plan = getNabuflowPlan(sub.planId);
    if (!plan) return null;

    const cycle = await ensureCurrentNabuflowCycle(sub, plan);
    const charged = await chargeNabuflowCycle(sub, plan, cycle.id, amount, opts);
    return { newBalance: charged.remainingIncluded };
  } catch (error) {
    // A concurrent retry may win the unique settlement-key insert after the
    // preflight lookup. Its transaction is the authoritative successful debit.
    if (
      opts.settlementKey &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      const [existing] = await db
        .select({ id: nabuflowUsageEventsTable.id })
        .from(nabuflowUsageEventsTable)
        .where(eq(nabuflowUsageEventsTable.settlementKey, opts.settlementKey))
        .limit(1);
      if (existing) return { newBalance: 0 };
    }
    throw error;
  }
}

/**
 * Delegation target for credits.ts refundCredits: reverse the most recent
 * matching un-reversed usage event (canceled/discarded reserved builds).
 * Returns the remaining included balance, or null when NabuFlow billing does
 * not apply.
 */
export async function maybeRefundNabuflow(
  userId: string,
  amount: number,
  opts: {
    projectId?: number | null;
    taskId?: number | null;
    settlementKey?: string;
    description?: string;
  },
): Promise<number | null> {
  if (amount <= 0) return null;

  // Enterprise seats: reverse the matching pool draw (mirrors charge routing).
  const orgCtx = await getNabuflowOrgSeatContext(userId);
  if (orgCtx) {
    const pool = await refundNabuflowOrgPool(orgCtx.org.id, userId, amount, opts);
    return Math.max(pool, 0);
  }

  const sub = await getNabuflowSubscription(userId);
  if (!sub || !isChargeableNabuflowStatus(sub.status)) return null;
  const plan = getNabuflowPlan(sub.planId);
  if (!plan) return null;

  const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
  const conditions = [
    eq(nabuflowUsageEventsTable.userId, userId),
    eq(nabuflowUsageEventsTable.credits, amount),
    isNull(nabuflowUsageEventsTable.reversedAt),
    // Personal-lane events only — org pool draws (orgId set, cycleId null)
    // are reversed by refundNabuflowOrgPool, never against a personal cycle
    // (matters for accounts whose org seat was removed mid-flight).
    isNull(nabuflowUsageEventsTable.orgId),
    gt(nabuflowUsageEventsTable.createdAt, cutoff),
  ];
  if (opts.projectId != null) {
    conditions.push(eq(nabuflowUsageEventsTable.projectId, opts.projectId));
  }
  if (opts.taskId != null) {
    conditions.push(eq(nabuflowUsageEventsTable.taskId, opts.taskId));
  }
  if (opts.settlementKey) {
    conditions.push(eq(nabuflowUsageEventsTable.settlementKey, opts.settlementKey));
  }
  const [event] = await db
    .select()
    .from(nabuflowUsageEventsTable)
    .where(and(...conditions))
    .orderBy(desc(nabuflowUsageEventsTable.createdAt))
    .limit(1);

  if (!event || event.cycleId === null) {
    // Nothing to reverse (e.g. charge predates the plan) — report current
    // remaining bucket without fabricating credits.
    const cycle = await ensureCurrentNabuflowCycle(sub, plan);
    logger.warn(
      { userId, amount, projectId: opts.projectId },
      "nabuflow: refund requested with no matching usage event — no-op",
    );
    return Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0);
  }
  const eventCycleId = event.cycleId;

  const proDec = event.source && event.engineMode === "pro" && isBuildSource(event.source) ? 1 : 0;
  const deepDec = event.deepReasoning && isBuildSource(event.source) ? 1 : 0;

  const remaining = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(nabuflowUsageEventsTable)
      .set({ reversedAt: sql`now()` })
      .where(
        and(eq(nabuflowUsageEventsTable.id, event.id), isNull(nabuflowUsageEventsTable.reversedAt)),
      )
      .returning();
    if (!claimed) return null; // concurrent reversal won

    const [cycle] = await tx
      .select()
      .from(nabuflowBillingCyclesTable)
      .where(eq(nabuflowBillingCyclesTable.id, eventCycleId))
      .for("update");
    if (!cycle) return null;

    const [updated] = await tx
      .update(nabuflowBillingCyclesTable)
      .set({
        usedIncludedCredits: sql`GREATEST(${nabuflowBillingCyclesTable.usedIncludedCredits} - ${event.includedCredits}, 0)`,
        overageCredits: sql`GREATEST(${nabuflowBillingCyclesTable.overageCredits} - ${event.overageCredits}, 0)`,
        overageUsdCents: sql`GREATEST(${nabuflowBillingCyclesTable.overageUsdCents} - ${event.overageUsdCents}, 0)`,
        proBuildsUsed: sql`GREATEST(${nabuflowBillingCyclesTable.proBuildsUsed} - ${proDec}, 0)`,
        deepBuildsUsed: sql`GREATEST(${nabuflowBillingCyclesTable.deepBuildsUsed} - ${deepDec}, 0)`,
        updatedAt: sql`now()`,
      })
      .where(eq(nabuflowBillingCyclesTable.id, eventCycleId))
      .returning();

    return updated ? Math.max(updated.includedCredits - updated.usedIncludedCredits, 0) : null;
  });

  // Remove the pending overage invoice item, if one was created (best-effort).
  if (event.stripeInvoiceItemId) {
    void (async () => {
      try {
        const { deleteNabuflowInvoiceItem } = await import("./nabuflow-stripe");
        await deleteNabuflowInvoiceItem(event.stripeInvoiceItemId!);
      } catch (err) {
        logger.warn(
          { err, invoiceItemId: event.stripeInvoiceItemId },
          "nabuflow: could not delete overage invoice item on refund",
        );
      }
    })();
  }

  if (remaining !== null) return remaining;
  const cycle = await ensureCurrentNabuflowCycle(sub, plan);
  return Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0);
}

function isBuildSource(source: string | null | undefined): boolean {
  return source === "pipeline" || source === "background" || source === "queue";
}

// ─────────────────────────────────────────────────────────────────────────────
// Warnings — 50/80/100% of the credit bucket AND of the spend cap
// ─────────────────────────────────────────────────────────────────────────────

async function insertNabuflowNotification(
  userId: string,
  type: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db.insert(notificationsTable).values({
    recipientId: userId,
    type,
    title,
    body,
    resourceType: "nabuflow_billing",
    metadata,
  });
}

function platformBase(): string {
  const domain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
  return `https://${domain}`;
}

async function userEmail(userId: string): Promise<string | null> {
  try {
    return (await getClerkUserById(userId))?.email ?? null;
  } catch {
    return null;
  }
}

/**
 * Raise bucket/cap warning watermarks and notify (in-app + email) when a new
 * threshold is crossed. Watermark updates are guarded (`WHERE level < new`) so
 * concurrent charges produce exactly one notification per threshold.
 */
export async function notifyNabuflowThresholds(
  sub: NabuflowSubscription,
  plan: NabuflowPlanConfig,
  cycle: NabuflowBillingCycle,
): Promise<void> {
  const capCents = await getNabuflowSpendCapCents(sub.userId, plan);
  const bucketLevel = usageThresholdLevel(cycle.usedIncludedCredits, cycle.includedCredits);
  const capLevel = usageThresholdLevel(cycle.overageUsdCents, capCents);

  if (bucketLevel > cycle.bucketNotifyLevel) {
    const [claimed] = await db
      .update(nabuflowBillingCyclesTable)
      .set({ bucketNotifyLevel: bucketLevel, updatedAt: sql`now()` })
      .where(
        and(
          eq(nabuflowBillingCyclesTable.id, cycle.id),
          lt(nabuflowBillingCyclesTable.bucketNotifyLevel, bucketLevel),
        ),
      )
      .returning({ id: nabuflowBillingCyclesTable.id });
    if (claimed) {
      const remaining = Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0);
      const title =
        bucketLevel >= 100
          ? "You've used all your included NabuFlow credits"
          : `You've used ${bucketLevel}% of your included NabuFlow credits`;
      const body =
        bucketLevel >= 100
          ? `Further builds this cycle are billed as pay-as-you-go at $${plan.overageUsdPerCredit.toFixed(3)}/credit (up to your spend cap).`
          : `${remaining.toLocaleString()} of ${cycle.includedCredits.toLocaleString()} included credits remain this cycle.`;
      await insertNabuflowNotification(sub.userId, "nabuflow_credit_warning", title, body, {
        level: bucketLevel,
        usedIncludedCredits: cycle.usedIncludedCredits,
        includedCredits: cycle.includedCredits,
        planId: plan.id,
        cycleEnd: cycle.cycleEnd.toISOString(),
      });
      const email = await userEmail(sub.userId);
      if (email) {
        const { sendNabuflowUsageWarningEmail } = await import("./emailClient");
        await sendNabuflowUsageWarningEmail({
          to: email,
          kind: "credits",
          level: bucketLevel,
          planName: plan.name,
          detail: body,
          billingUrl: `${platformBase()}/settings/billing`,
        });
      }
    }
  }

  if (capCents > 0 && capLevel > cycle.capNotifyLevel) {
    const [claimed] = await db
      .update(nabuflowBillingCyclesTable)
      .set({ capNotifyLevel: capLevel, updatedAt: sql`now()` })
      .where(
        and(
          eq(nabuflowBillingCyclesTable.id, cycle.id),
          lt(nabuflowBillingCyclesTable.capNotifyLevel, capLevel),
        ),
      )
      .returning({ id: nabuflowBillingCyclesTable.id });
    if (claimed) {
      const spent = (cycle.overageUsdCents / 100).toFixed(2);
      const cap = (capCents / 100).toFixed(2);
      const title =
        capLevel >= 100
          ? "You've reached your NabuFlow monthly spend cap"
          : `You've used ${capLevel}% of your NabuFlow spend cap`;
      const body =
        capLevel >= 100
          ? `Pay-as-you-go spend this cycle is $${spent} of your $${cap} cap. New builds that would exceed the cap are blocked until the next cycle (or a higher cap).`
          : `Pay-as-you-go spend this cycle is $${spent} of your $${cap} cap.`;
      await insertNabuflowNotification(sub.userId, "nabuflow_spend_cap_warning", title, body, {
        level: capLevel,
        overageUsdCents: cycle.overageUsdCents,
        spendCapUsdCents: capCents,
        planId: plan.id,
        cycleEnd: cycle.cycleEnd.toISOString(),
      });
      const email = await userEmail(sub.userId);
      if (email) {
        const { sendNabuflowUsageWarningEmail } = await import("./emailClient");
        await sendNabuflowUsageWarningEmail({
          to: email,
          kind: "spend_cap",
          level: capLevel,
          planName: plan.name,
          detail: body,
          billingUrl: `${platformBase()}/settings/billing`,
        });
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Webhook handlers — Stripe events are the ONLY writer of plan/card/dunning
// state (client calls never mutate these directly).
// ─────────────────────────────────────────────────────────────────────────────

// Stripe webhook payloads span API versions and are narrowed at each access.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** True when a Stripe subscription object belongs to NabuFlow. */
export function isNabuflowStripeSubscription(subscription: AnyObj | null | undefined): boolean {
  return subscription?.metadata?.surface === "nabuflow";
}

/**
 * Extract the NabuFlow linkage from an invoice across Stripe API versions:
 * subscription id + whether metadata marks it as NabuFlow.
 */
export function nabuflowInvoiceLinkage(invoice: AnyObj): {
  subscriptionId: string | null;
  markedNabuflow: boolean;
  metaUserId: string | null;
  metaPlanId: string | null;
} {
  const subRef =
    invoice?.subscription ??
    invoice?.parent?.subscription_details?.subscription ??
    invoice?.subscription_details?.subscription ??
    null;
  const subscriptionId = typeof subRef === "string" ? subRef : ((subRef as AnyObj)?.id ?? null);
  const meta =
    invoice?.subscription_details?.metadata ??
    invoice?.parent?.subscription_details?.metadata ??
    null;
  return {
    subscriptionId,
    markedNabuflow: meta?.surface === "nabuflow",
    metaUserId: meta?.userId ?? null,
    metaPlanId: meta?.plan ?? null,
  };
}

function stripeTsToDate(ts: unknown): Date | null {
  return typeof ts === "number" && Number.isFinite(ts) ? new Date(ts * 1000) : null;
}

/**
 * True when an invoice event belongs to NabuFlow: either the subscription
 * metadata marks it (`surface: nabuflow`) or the subscription id matches a
 * local NabuFlow row. Used by the webhook router so Ora's invoice handlers
 * never see NabuFlow invoices (shared Stripe Customer!) and vice versa.
 */
export async function isNabuflowInvoiceEvent(invoice: AnyObj): Promise<boolean> {
  const { subscriptionId, markedNabuflow } = nabuflowInvoiceLinkage(invoice);
  if (markedNabuflow) return true;
  if (!subscriptionId) return false;
  return !!(await findNabuflowSubscriptionByStripeId(subscriptionId));
}

/** Item-level period first (Basil moved it), then top-level fallback. */
export function extractNabuflowPeriod(subscription: AnyObj): {
  periodStart: Date | null;
  periodEnd: Date | null;
} {
  const item = subscription?.items?.data?.[0];
  const start = stripeTsToDate(item?.current_period_start ?? subscription?.current_period_start);
  const end = stripeTsToDate(item?.current_period_end ?? subscription?.current_period_end);
  return { periodStart: start, periodEnd: end };
}

function mapStripeStatus(status: string | null | undefined): string {
  switch (status) {
    case "active":
      return "active";
    case "trialing":
      return "trialing";
    case "past_due":
    case "unpaid":
    case "paused":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    default:
      return "incomplete";
  }
}

async function clearNabuflowDunning(subId: number): Promise<void> {
  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      dunningStatus: "none",
      dunningStartedAt: null,
      dunningGraceUntil: null,
      dunningPausedAt: null,
      dunningAttemptCount: 0,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.id, subId));
}

/**
 * customer.subscription.created/updated/deleted with metadata.surface ===
 * 'nabuflow'. Syncs plan, status, item id, cycle anchor; grants the cycle
 * bucket when the period advances. Never touches Ora's user_subscriptions.
 */
export async function handleNabuflowSubscriptionEvent(
  eventType: string,
  subscription: AnyObj,
): Promise<void> {
  const stripeSubId: string | null = subscription?.id ?? null;
  if (!stripeSubId) return;

  const metaUserId: string | null = subscription?.metadata?.userId ?? null;
  const metaPlan = getNabuflowPlan(subscription?.metadata?.plan);
  const customerId: string | null =
    typeof subscription?.customer === "string"
      ? subscription.customer
      : (subscription?.customer?.id ?? null);

  let sub = await findNabuflowSubscriptionByStripeId(stripeSubId);
  if (!sub && metaUserId) {
    sub = await getNabuflowSubscription(metaUserId);
  }
  if (!sub) {
    // First-time subscriber: no local row exists yet (the subscribe route's
    // direct sync and the webhook race each other, and Stripe's delivery
    // order isn't guaranteed). Materialize the row from the subscription's
    // own metadata — otherwise a brand-new subscriber would keep "no plan"
    // state forever and the gate would block them despite a live Stripe sub.
    if (!metaUserId || !metaPlan) {
      logger.warn(
        { stripeSubId, metaUserId, eventType },
        "nabuflow: subscription event with no local row and no usable metadata — ignoring",
      );
      return;
    }
    sub = await materializeNabuflowSubscriptionRow({
      userId: metaUserId,
      planId: metaPlan.id,
      stripeSubscriptionId: stripeSubId,
      stripeCustomerId: customerId,
    });
    if (!sub) {
      logger.error(
        { stripeSubId, metaUserId, eventType },
        "nabuflow: could not materialize local subscription row",
      );
      return;
    }
    logger.info(
      { userId: metaUserId, planId: metaPlan.id, stripeSubId, eventType },
      "nabuflow: materialized local subscription row (first-time subscriber)",
    );
  }

  const status =
    eventType === "customer.subscription.deleted"
      ? "canceled"
      : mapStripeStatus(subscription?.status);
  const itemId: string | null = subscription?.items?.data?.[0]?.id ?? null;
  const planId = (metaPlan?.id ?? sub.planId) as NabuflowPlanId;
  const plan = getNabuflowPlan(planId);
  const { periodStart, periodEnd } = extractNabuflowPeriod(subscription);

  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      planId,
      status,
      stripeSubscriptionId: stripeSubId,
      ...(customerId ? { stripeCustomerId: customerId } : {}),
      ...(itemId ? { stripeItemId: itemId } : {}),
      cancelAtPeriodEnd: !!subscription?.cancel_at_period_end,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));

  if (status === "active" && plan && periodStart && periodEnd) {
    const fresh = await getNabuflowSubscription(sub.userId);
    if (fresh) await grantNabuflowCycle(fresh, plan, periodStart, periodEnd);
  }
  if (status === "active" && sub.dunningStatus !== "none") {
    await clearNabuflowDunning(sub.id);
  }

  logger.info(
    { userId: sub.userId, planId, status, eventType },
    "nabuflow: subscription state synced from webhook",
  );
}

/** invoice.paid for a NabuFlow subscription: renew cycle + clear dunning. */
export async function handleNabuflowInvoicePaid(invoice: AnyObj): Promise<void> {
  const { subscriptionId, markedNabuflow, metaUserId, metaPlanId } =
    nabuflowInvoiceLinkage(invoice);
  if (!subscriptionId) return;
  let sub = await findNabuflowSubscriptionByStripeId(subscriptionId);
  if (!sub && markedNabuflow && metaUserId) {
    // invoice.paid can beat customer.subscription.created for a first-time
    // subscriber (delivery order isn't guaranteed) — materialize from the
    // subscription metadata the invoice carries.
    const metaPlan = getNabuflowPlan(metaPlanId);
    if (metaPlan) {
      sub = await materializeNabuflowSubscriptionRow({
        userId: metaUserId,
        planId: metaPlan.id,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId:
          typeof invoice?.customer === "string"
            ? invoice.customer
            : ((invoice?.customer as AnyObj)?.id ?? null),
      });
    }
  }
  if (!sub) return;
  const plan = getNabuflowPlan(sub.planId);
  if (!plan) return;

  // Prefer the subscription line's period (the renewal window).
  const lines: AnyObj[] = invoice?.lines?.data ?? [];
  const subLine =
    lines.find((l) => l?.subscription || l?.parent?.subscription_item_details) ?? lines[0];
  const periodStart =
    stripeTsToDate(subLine?.period?.start) ?? stripeTsToDate(invoice?.period_start);
  const periodEnd = stripeTsToDate(subLine?.period?.end) ?? stripeTsToDate(invoice?.period_end);

  if (periodStart && periodEnd && periodEnd.getTime() > periodStart.getTime()) {
    await grantNabuflowCycle(sub, plan, periodStart, periodEnd);
  }

  await db
    .update(nabuflowSubscriptionsTable)
    .set({ status: "active", updatedAt: sql`now()` })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  if (sub.dunningStatus !== "none") await clearNabuflowDunning(sub.id);

  logger.info({ userId: sub.userId, planId: plan.id }, "nabuflow: invoice paid — cycle granted");
}

/**
 * invoice.payment_failed for a NabuFlow subscription — dunning: Stripe
 * retries, we notify, and NEW builds pause after the grace window (in-flight
 * builds are never killed).
 */
export async function handleNabuflowInvoicePaymentFailed(invoice: AnyObj): Promise<void> {
  const { subscriptionId, markedNabuflow, metaUserId, metaPlanId } =
    nabuflowInvoiceLinkage(invoice);
  if (!subscriptionId) return;
  let sub = await findNabuflowSubscriptionByStripeId(subscriptionId);
  if (!sub && markedNabuflow && metaUserId) {
    // A first-time subscriber whose very first invoice fails must still land
    // in dunning — materialize the row so the failure isn't invisible.
    const metaPlan = getNabuflowPlan(metaPlanId);
    if (metaPlan) {
      sub = await materializeNabuflowSubscriptionRow({
        userId: metaUserId,
        planId: metaPlan.id,
        stripeSubscriptionId: subscriptionId,
        stripeCustomerId:
          typeof invoice?.customer === "string"
            ? invoice.customer
            : ((invoice?.customer as AnyObj)?.id ?? null),
      });
    }
  }
  if (!sub) return;
  const plan = getNabuflowPlan(sub.planId);

  const attempt = Math.max(
    Number(invoice?.attempt_count ?? 0) || 0,
    (sub.dunningAttemptCount ?? 0) + 1,
  );
  const now = new Date();
  const startedAt = sub.dunningStartedAt ?? now;
  const graceUntil =
    sub.dunningGraceUntil ??
    new Date(startedAt.getTime() + NABUFLOW_DUNNING.graceDays * 24 * 60 * 60_000);
  const paused = attempt >= NABUFLOW_DUNNING.maxAttempts || now.getTime() > graceUntil.getTime();

  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      status: "past_due",
      dunningStatus: paused ? "paused" : "retrying",
      dunningStartedAt: startedAt,
      dunningGraceUntil: graceUntil,
      dunningPausedAt: paused ? (sub.dunningPausedAt ?? now) : null,
      dunningAttemptCount: attempt,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));

  const planName = plan?.name ?? "NabuFlow";
  const title = paused
    ? "NabuFlow builds paused — payment failed"
    : "NabuFlow payment failed — we'll retry";
  const body = paused
    ? `Your ${planName} payment couldn't be processed after ${attempt} attempt${attempt === 1 ? "" : "s"}. New builds are paused until your payment method is updated.`
    : `Your ${planName} payment couldn't be processed (attempt ${attempt}). We'll retry automatically — new builds pause ${graceUntil.toISOString().slice(0, 10)} if payment keeps failing.`;
  await insertNabuflowNotification(
    sub.userId,
    paused ? "nabuflow_builds_paused" : "nabuflow_payment_failed",
    title,
    body,
    { attempt, paused, graceUntil: graceUntil.toISOString(), planId: sub.planId },
  );
  const email = await userEmail(sub.userId);
  if (email) {
    const { sendNabuflowPaymentFailedEmail } = await import("./emailClient");
    await sendNabuflowPaymentFailedEmail({
      to: email,
      planName,
      attempt,
      paused,
      graceUntil: graceUntil.toISOString().slice(0, 10),
      billingUrl: `${platformBase()}/settings/billing`,
    });
  }

  logger.info(
    { userId: sub.userId, attempt, paused },
    "nabuflow: payment failed — dunning state updated",
  );
}

/** Card metadata snapshot from a Stripe PaymentMethod object. */
function cardFieldsFromPaymentMethod(pm: AnyObj): {
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
} {
  return {
    cardBrand: pm?.card?.brand ?? null,
    cardLast4: pm?.card?.last4 ?? null,
    cardExpMonth: pm?.card?.exp_month ?? null,
    cardExpYear: pm?.card?.exp_year ?? null,
  };
}

/**
 * payment_method.attached — if the customer has a NabuFlow subscription with
 * no default card yet, promote this one (Stripe-side) and snapshot it.
 */
export async function handleNabuflowPaymentMethodAttached(pm: AnyObj): Promise<void> {
  const customerId = typeof pm?.customer === "string" ? pm.customer : (pm?.customer?.id ?? null);
  if (!customerId || !pm?.id) return;
  const sub = await findNabuflowSubscriptionByCustomerId(customerId);
  if (!sub) return; // not a NabuFlow customer — Ora-only, ignore

  if (!sub.defaultPaymentMethodId) {
    try {
      const { setNabuflowDefaultPaymentMethod } = await import("./nabuflow-stripe");
      await setNabuflowDefaultPaymentMethod(customerId, pm.id);
    } catch (err) {
      logger.warn({ err, customerId }, "nabuflow: could not set default payment method");
    }
    await db
      .update(nabuflowSubscriptionsTable)
      .set({
        defaultPaymentMethodId: pm.id,
        ...cardFieldsFromPaymentMethod(pm),
        updatedAt: sql`now()`,
      })
      .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  } else if (sub.defaultPaymentMethodId === pm.id) {
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ ...cardFieldsFromPaymentMethod(pm), updatedAt: sql`now()` })
      .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  }
}

/** payment_method.detached — losing the default card re-arms the card gate. */
export async function handleNabuflowPaymentMethodDetached(pm: AnyObj): Promise<void> {
  if (!pm?.id) return;
  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      defaultPaymentMethodId: null,
      cardBrand: null,
      cardLast4: null,
      cardExpMonth: null,
      cardExpYear: null,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.defaultPaymentMethodId, pm.id));
}

/**
 * setup_intent.succeeded with metadata.surface === 'nabuflow' — confirm the
 * captured card as the customer's default payment method and snapshot it.
 */
export async function handleNabuflowSetupIntentSucceeded(si: AnyObj): Promise<void> {
  if (si?.metadata?.surface !== "nabuflow") return;
  const customerId = typeof si?.customer === "string" ? si.customer : (si?.customer?.id ?? null);
  const pmId =
    typeof si?.payment_method === "string" ? si.payment_method : (si?.payment_method?.id ?? null);
  if (!customerId || !pmId) return;

  let pm: AnyObj | null = null;
  try {
    const { setNabuflowDefaultPaymentMethod, retrieveNabuflowPaymentMethod } =
      await import("./nabuflow-stripe");
    await setNabuflowDefaultPaymentMethod(customerId, pmId);
    pm = await retrieveNabuflowPaymentMethod(pmId);
  } catch (err) {
    logger.warn({ err, customerId }, "nabuflow: setup intent default-PM sync failed");
  }

  const sub = await findNabuflowSubscriptionByCustomerId(customerId);
  if (!sub && si?.metadata?.userId) {
    // Card captured before any subscription exists — nothing to store yet;
    // the subscribe flow reads the customer's default PM live from Stripe.
    return;
  }
  if (!sub) return;

  await db
    .update(nabuflowSubscriptionsTable)
    .set({
      defaultPaymentMethodId: pmId,
      ...(pm ? cardFieldsFromPaymentMethod(pm) : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));
}
