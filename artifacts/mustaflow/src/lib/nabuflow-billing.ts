// NabuFlow builder-billing client helpers.
//
// Mirrors the server's canBuild gate contract (artifacts/api-server/src/lib/
// nabuflow-billing.ts). The UI NEVER authorizes builds on its own — it only
// renders what the server decided. Blocked builds arrive as HTTP 402 with:
//   { error: string, code: "nabuflow_billing", billing: NabuflowGateError }

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
  // Constellation organization lane (seats drawing from the shared pool)
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

const GATE_CODES: ReadonlySet<string> = new Set([
  "no_plan",
  "subscription_inactive",
  "no_payment_method",
  "card_expired",
  "billing_paused",
  "mode_not_available",
  "combo_not_available",
  "mode_limit_reached",
  "spend_cap_reached",
  "org_suspended",
  "org_pool_exhausted",
  "org_spend_cap_reached",
  "org_seat_cap_reached",
]);

function numberOrNull(value: unknown): number | null | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null) return null;
  return undefined;
}

function stringOrNull(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  if (value === null) return null;
  return undefined;
}

/**
 * Extracts a structured gate error from a raw (already parsed) response body
 * or from the bare `billing` object (e.g. the state endpoint's blockedReason).
 */
export function extractNabuflowGate(body: unknown): NabuflowGateError | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;

  // Wrapped shape: { error, code: "nabuflow_billing", billing: {...} }
  if (b.code === "nabuflow_billing" && b.billing && typeof b.billing === "object") {
    return extractNabuflowGate(b.billing);
  }

  // Bare gate-error shape: { code: <gate code>, message, planId, ... }
  if (typeof b.code === "string" && GATE_CODES.has(b.code) && typeof b.message === "string") {
    return {
      code: b.code as NabuflowGateErrorCode,
      message: b.message,
      planId: stringOrNull(b.planId) ?? null,
      remainingProBuilds: numberOrNull(b.remainingProBuilds),
      remainingDeepBuilds: numberOrNull(b.remainingDeepBuilds),
      resetsAt: stringOrNull(b.resetsAt),
      upgradeTarget: stringOrNull(b.upgradeTarget),
    };
  }
  return null;
}

/**
 * Detects a NabuFlow billing block on any thrown error shape we see in the
 * app: the generated client's ApiError (body on `.data`), raw parsed bodies,
 * or anything exposing the wrapped body directly.
 */
export function parseNabuflowGateError(err: unknown): NabuflowGateError | null {
  if (!err || typeof err !== "object") return null;
  const data = (err as { data?: unknown }).data;
  return extractNabuflowGate(data) ?? extractNabuflowGate(err);
}

// ── Display helpers ──────────────────────────────────────────────────────────

const PLAN_DISPLAY_NAMES: Record<string, string> = {
  orbit: "Orbit",
  comet: "Comet",
  nova: "Nova",
  constellation: "Constellation",
};

export function nabuflowPlanDisplayName(planId: string | null | undefined): string {
  if (!planId) return "a higher plan";
  return PLAN_DISPLAY_NAMES[planId] ?? planId.charAt(0).toUpperCase() + planId.slice(1);
}

/** "$12.50" from cents; whole dollars render without decimals ("$20"). */
export function formatUsdCents(cents: number | null | undefined): string {
  const value = (cents ?? 0) / 100;
  const hasCents = Math.abs(value % 1) > 0.001;
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: 2,
  });
}

/** "Aug 12, 2026" (local) from an ISO date, or null when absent/invalid. */
export function formatResetDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// ── Engine-mode ladder (plain language, derived from server plan config) ─────

export interface NabuflowPlanLike {
  id: string;
  name: string;
  available: boolean;
  priceUsd?: number | null;
  ladder: {
    proBuildsPerCycle?: number | null;
    deepBuildsPerCycle?: number | null;
    proDeepCombo: boolean;
  };
}

/** Cheapest self-serve plan that includes any Deep builds. */
export function nabuflowDeepUnlockPlan<T extends NabuflowPlanLike>(plans: T[]): T | null {
  return (
    plans
      .filter((p) => p.available && (p.ladder.deepBuildsPerCycle ?? null) !== 0)
      .sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity))[0] ?? null
  );
}

/** Cheapest self-serve plan that allows the Pro + Deep combination. */
export function nabuflowComboUnlockPlan<T extends NabuflowPlanLike>(plans: T[]): T | null {
  return (
    plans
      .filter((p) => p.available && p.ladder.proDeepCombo)
      .sort((a, b) => (a.priceUsd ?? Infinity) - (b.priceUsd ?? Infinity))[0] ?? null
  );
}

export interface NabuflowLadderLine {
  key: "pro" | "deep" | "combo";
  text: string;
  included: boolean;
}

/** Plain-language ladder lines for a plan card — never hard-code counts. */
export function nabuflowLadderLines(
  plan: NabuflowPlanLike,
  allPlans: NabuflowPlanLike[],
): NabuflowLadderLine[] {
  const pro = plan.ladder.proBuildsPerCycle ?? null;
  const deep = plan.ladder.deepBuildsPerCycle ?? null;
  const deepUnlock = nabuflowDeepUnlockPlan(allPlans);
  const comboUnlock = nabuflowComboUnlockPlan(allPlans);

  const proLine: NabuflowLadderLine = {
    key: "pro",
    text: pro === null ? "Unlimited Pro builds" : `${pro} Pro build${pro === 1 ? "" : "s"} / cycle`,
    included: pro === null || pro > 0,
  };
  const deepLine: NabuflowLadderLine = {
    key: "deep",
    text:
      deep === null
        ? "Unlimited Deep builds"
        : deep === 0
          ? deepUnlock && deepUnlock.id !== plan.id
            ? `Deep builds — from ${deepUnlock.name} up`
            : "Deep builds not included"
          : `${deep} Deep build${deep === 1 ? "" : "s"} / cycle`,
    included: deep !== 0,
  };
  const comboLine: NabuflowLadderLine = {
    key: "combo",
    text: plan.ladder.proDeepCombo
      ? "Pro + Deep together included"
      : comboUnlock
        ? `Pro + Deep — ${comboUnlock.name} exclusive`
        : "Pro + Deep not included",
    included: plan.ladder.proDeepCombo,
  };
  return [proLine, deepLine, comboLine];
}

/** Proration preview returned by POST /billing/nabuflow/switch (confirm=false). */
export interface NabuflowProrationPreview {
  currentPlanId: string;
  targetPlanId: string;
  amountDueCents: number;
  currency: string;
  periodEnd: string | null;
  lines: Array<{ description: string | null; amountCents: number }>;
}

export function parseProrationPreview(value: unknown): NabuflowProrationPreview | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.amountDueCents !== "number" || typeof v.targetPlanId !== "string") return null;
  const rawLines = Array.isArray(v.lines) ? v.lines : [];
  return {
    currentPlanId: typeof v.currentPlanId === "string" ? v.currentPlanId : "",
    targetPlanId: v.targetPlanId,
    amountDueCents: v.amountDueCents,
    currency: typeof v.currency === "string" ? v.currency : "usd",
    periodEnd: stringOrNull(v.periodEnd) ?? null,
    lines: rawLines
      .filter((l): l is Record<string, unknown> => !!l && typeof l === "object")
      .map((l) => ({
        description: stringOrNull(l.description) ?? null,
        amountCents: typeof l.amountCents === "number" ? l.amountCents : 0,
      })),
  };
}
