/**
 * NabuFlow billing core unit tests (Task #1516).
 *
 * Covers the enforcement-flip safety matrix so the later production flip is a
 * pure config change:
 *   - gate matrix: no plan / inactive / no card / expired card / dunning
 *     paused / grace / spend cap / skipUsageChecks,
 *   - ladder matrix: Orbit 4th Pro blocked, Orbit Deep blocked, Comet 11th
 *     Deep blocked, Pro+Deep combo Nova-only,
 *   - cycle math: charge splitting, rollover policy (Orbit none, Comet/Nova
 *     one cycle capped), simulated rollover resetting counters,
 *   - warning thresholds (50/80/100), overage pricing, spend-cap clamping,
 *   - bypass ordering: enforcement-off / test / superuser / allowlist — and
 *     the guarantee that NO test bypass can activate in production,
 *   - dunning transitions driven by invoice.payment_failed (retry → notify →
 *     pause), including the notification records.
 *
 * @workspace/db opens a real Pool at import, so we swap in an in-memory stub
 * (same approach as billing-webhooks.test.ts). Clerk, email, Stripe helpers
 * and the logger are mocked — no network/IO happens here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Shared mock state (hoisted so vi.mock factories can reach it) ────────────
const h = vi.hoisted(() => {
  const state = {
    selectResult: [] as unknown[],
    updates: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
  };

  const makeWhereResult = () => {
    const arr = state.selectResult;
    const thenable = Promise.resolve(arr) as Promise<unknown[]> & {
      limit: () => Promise<unknown[]>;
      orderBy: () => { limit: () => Promise<unknown[]> };
      for: () => Promise<unknown[]>;
    };
    thenable.limit = () => Promise.resolve(arr);
    thenable.orderBy = () => ({ limit: () => Promise.resolve(arr) });
    thenable.for = () => Promise.resolve(arr);
    return thenable;
  };

  const mockDb = {
    select: () => ({ from: () => ({ where: () => makeWhereResult() }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        const p = Promise.resolve(undefined) as Promise<unknown> & {
          onConflictDoNothing: () => { returning: () => Promise<unknown[]> };
          returning: () => Promise<unknown[]>;
        };
        p.onConflictDoNothing = () => ({ returning: () => Promise.resolve([]) });
        p.returning = () => Promise.resolve([v]);
        return p;
      },
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updates.push(v);
        return {
          where: () => {
            const p = Promise.resolve(undefined) as Promise<unknown> & {
              returning: () => Promise<unknown[]>;
            };
            p.returning = () => Promise.resolve([]);
            return p;
          },
        };
      },
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };

  return { state, mockDb };
});

vi.mock("@workspace/db", async () => {
  const schema = await import("../../../../../lib/db/src/schema/index");
  return { ...schema, db: h.mockDb };
});

vi.mock("../superusers", () => ({
  isSuperuser: vi.fn(async () => false),
}));

vi.mock("../clerk-users", async () => ({
  getClerkUserById: vi.fn(async () => null),
}));

vi.mock("../logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

// Async factories: nabuflow-billing pulls these via dynamic import() at call
// time, which a sync factory can miss (see vitest-dynamic-import-mock-gap).
vi.mock("../emailClient", async () => ({
  sendNabuflowUsageWarningEmail: vi.fn(async () => undefined),
  sendNabuflowPaymentFailedEmail: vi.fn(async () => undefined),
}));

vi.mock("../nabuflow-stripe", async () => ({
  createNabuflowOverageInvoiceItem: vi.fn(async () => ({ id: "ii_test" })),
  deleteNabuflowInvoiceItem: vi.fn(async () => undefined),
}));

import {
  evaluateNabuflowGate,
  splitNabuflowCharge,
  computeNabuflowRollover,
  simulateNabuflowCycleAdvance,
  usageThresholdLevel,
  nabuflowTestBypassActive,
  resolveNabuflowBuildGate,
  nabuflowGateHttpBody,
  isChargeableNabuflowStatus,
  handleNabuflowInvoicePaymentFailed,
  _clearNabuflowAllowlistCache,
  type NabuflowGateState,
  type NabuflowGateRequest,
} from "../nabuflow-billing";
import {
  NABUFLOW_PLANS,
  nabuflowOverageCents,
  nabuflowEffectiveSpendCapCents,
  nabuflowUpgradeTarget,
} from "../nabuflow-plans";
import { isSuperuser } from "../superusers";
import { getClerkUserById } from "../clerk-users";

const NOW = new Date("2026-07-30T12:00:00Z");
const CYCLE_END = new Date("2026-08-15T00:00:00Z");

type PaidPlanId = "orbit" | "comet" | "nova";

function gateState(
  planId: PaidPlanId,
  subOver: Partial<NonNullable<NabuflowGateState["subscription"]>> = {},
  cycleOver: Partial<NonNullable<NabuflowGateState["cycle"]>> = {},
  capCents?: number,
): NabuflowGateState {
  const plan = NABUFLOW_PLANS[planId];
  return {
    plan,
    subscription: {
      status: "active",
      planId,
      dunningStatus: "none",
      dunningGraceUntil: null,
      defaultPaymentMethodId: "pm_1",
      cardExpMonth: 12,
      cardExpYear: 2031,
      currentCycleEnd: CYCLE_END,
      ...subOver,
    } as NonNullable<NabuflowGateState["subscription"]>,
    cycle: {
      includedCredits: plan.includedMonthlyCredits,
      usedIncludedCredits: 0,
      overageUsdCents: 0,
      proBuildsUsed: 0,
      deepBuildsUsed: 0,
      ...cycleOver,
    } as NonNullable<NabuflowGateState["cycle"]>,
    spendCapUsdCents: capCents ?? Math.round(plan.defaultSpendCapUsd * 100),
  };
}

function evalGate(state: NabuflowGateState, request: NabuflowGateRequest = {}) {
  return evaluateNabuflowGate(state, request, NOW);
}

function expectBlocked(
  decision: ReturnType<typeof evaluateNabuflowGate>,
  code: string,
): asserts decision is { allowed: false; error: NonNullable<Parameters<typeof nabuflowGateHttpBody>[0]> } {
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.error.code).toBe(code);
}

const ENV_KEYS = [
  "CREDITS_ENFORCEMENT",
  "NABUFLOW_BILLING_TEST_BYPASS",
  "BUILDER_ALLOWLIST",
  "REPLIT_DEPLOYMENT",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.state.selectResult = [];
  h.state.updates = [];
  h.state.inserted = [];
  _clearNabuflowAllowlistCache();
  vi.mocked(isSuperuser).mockResolvedValue(false);
  vi.mocked(getClerkUserById).mockResolvedValue(null as never);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

// ─── Plans config sanity ─────────────────────────────────────────────────────
describe("plans config", () => {
  it("prices the family Orbit $20 / Comet $50 / Nova $100", () => {
    expect(NABUFLOW_PLANS.orbit.priceUsd).toBe(20);
    expect(NABUFLOW_PLANS.comet.priceUsd).toBe(50);
    expect(NABUFLOW_PLANS.nova.priceUsd).toBe(100);
  });

  it("keeps Constellation as a non-purchasable stub", () => {
    expect(NABUFLOW_PLANS.constellation.available).toBe(false);
    expect(NABUFLOW_PLANS.constellation.priceUsd).toBeNull();
  });

  it("encodes the access ladder: Orbit 3 Pro + no Deep; Comet ∞ Pro + 10 Deep; Nova ∞ + combo", () => {
    expect(NABUFLOW_PLANS.orbit.ladder).toEqual({
      proBuildsPerCycle: 3,
      deepBuildsPerCycle: 0,
      proDeepCombo: false,
    });
    expect(NABUFLOW_PLANS.comet.ladder).toEqual({
      proBuildsPerCycle: null,
      deepBuildsPerCycle: 10,
      proDeepCombo: false,
    });
    expect(NABUFLOW_PLANS.nova.ladder).toEqual({
      proBuildsPerCycle: null,
      deepBuildsPerCycle: null,
      proDeepCombo: true,
    });
  });

  it("rollover policy: Orbit none; Comet/Nova one cycle capped at a month's allotment", () => {
    expect(NABUFLOW_PLANS.orbit.rolloverCycles).toBe(0);
    expect(NABUFLOW_PLANS.comet.rolloverCycles).toBe(1);
    expect(NABUFLOW_PLANS.nova.rolloverCycles).toBe(1);
    expect(NABUFLOW_PLANS.comet.rolloverMaxCredits).toBe(
      NABUFLOW_PLANS.comet.includedMonthlyCredits,
    );
  });

  it("upgrade targets follow the ladder", () => {
    expect(nabuflowUpgradeTarget("orbit", "deep")).toBe("comet");
    expect(nabuflowUpgradeTarget("comet", "deep")).toBe("nova");
    expect(nabuflowUpgradeTarget("comet", "combo")).toBe("nova");
  });

  it("chargeable statuses are active/trialing/past_due only", () => {
    expect(isChargeableNabuflowStatus("active")).toBe(true);
    expect(isChargeableNabuflowStatus("trialing")).toBe(true);
    expect(isChargeableNabuflowStatus("past_due")).toBe(true);
    expect(isChargeableNabuflowStatus("canceled")).toBe(false);
    expect(isChargeableNabuflowStatus(null)).toBe(false);
  });
});

// ─── Ladder matrix ───────────────────────────────────────────────────────────
describe("ladder matrix", () => {
  it("Orbit: 3rd Pro build of the cycle is allowed", () => {
    const d = evalGate(gateState("orbit", {}, { proBuildsUsed: 2 }), { engineMode: "pro" });
    expect(d.allowed).toBe(true);
  });

  it("Orbit: 4th Pro build is blocked pre-start with reason, reset date, upgrade target", () => {
    const d = evalGate(gateState("orbit", {}, { proBuildsUsed: 3 }), { engineMode: "pro" });
    expectBlocked(d, "mode_limit_reached");
    if (!d.allowed) {
      expect(d.error.remainingProBuilds).toBe(0);
      expect(d.error.resetsAt).toBe(CYCLE_END.toISOString());
      expect(d.error.upgradeTarget).toBe("comet");
      expect(d.error.message).toMatch(/3 Pro builds/);
    }
  });

  it("Orbit: Deep reasoning is not available at all", () => {
    const d = evalGate(gateState("orbit"), { engineMode: "power", deepReasoning: true });
    expectBlocked(d, "mode_not_available");
    if (!d.allowed) expect(d.error.upgradeTarget).toBe("comet");
  });

  it("Comet: 10th Deep build allowed, 11th blocked with upgrade target Nova", () => {
    const ok = evalGate(gateState("comet", {}, { deepBuildsUsed: 9 }), {
      engineMode: "power",
      deepReasoning: true,
    });
    expect(ok.allowed).toBe(true);

    const blocked = evalGate(gateState("comet", {}, { deepBuildsUsed: 10 }), {
      engineMode: "power",
      deepReasoning: true,
    });
    expectBlocked(blocked, "mode_limit_reached");
    if (!blocked.allowed) {
      expect(blocked.error.remainingDeepBuilds).toBe(0);
      expect(blocked.error.upgradeTarget).toBe("nova");
      expect(blocked.error.resetsAt).toBe(CYCLE_END.toISOString());
    }
  });

  it("Pro+Deep combo is Nova-exclusive", () => {
    const comet = evalGate(gateState("comet"), { engineMode: "pro", deepReasoning: true });
    expectBlocked(comet, "combo_not_available");
    if (!comet.allowed) expect(comet.error.upgradeTarget).toBe("nova");

    const nova = evalGate(gateState("nova"), { engineMode: "pro", deepReasoning: true });
    expect(nova.allowed).toBe(true);
  });

  it("Comet/Nova Pro is unlimited; Nova Deep is unlimited", () => {
    expect(
      evalGate(gateState("comet", {}, { proBuildsUsed: 999 }), { engineMode: "pro" }).allowed,
    ).toBe(true);
    expect(
      evalGate(gateState("nova", {}, { deepBuildsUsed: 999 }), {
        engineMode: "eco",
        deepReasoning: true,
      }).allowed,
    ).toBe(true);
  });

  it("non-Pro modes never consume the Pro counter path", () => {
    const d = evalGate(gateState("orbit", {}, { proBuildsUsed: 3 }), { engineMode: "power" });
    expect(d.allowed).toBe(true);
  });

  it("mode-less requests (EAS builds) skip the ladder but keep plan/card checks", () => {
    const d = evalGate(gateState("orbit", {}, { proBuildsUsed: 3, deepBuildsUsed: 0 }), {
      source: "eas",
    });
    expect(d.allowed).toBe(true);

    const noCard = evalGate(
      gateState("orbit", { defaultPaymentMethodId: null }, { proBuildsUsed: 0 }),
      { source: "eas" },
    );
    expectBlocked(noCard, "no_payment_method");
  });
});

// ─── Gate matrix ─────────────────────────────────────────────────────────────
describe("gate matrix", () => {
  it("no plan → calm structured no_plan error", () => {
    const d = evalGate({ plan: null, subscription: null, cycle: null, spendCapUsdCents: 0 });
    expectBlocked(d, "no_plan");
    if (!d.allowed) expect(d.error.upgradeTarget).toBe("orbit");
  });

  it("inactive subscription → subscription_inactive", () => {
    const d = evalGate(gateState("comet", { status: "canceled" }));
    expectBlocked(d, "subscription_inactive");
  });

  it("no card on file → 'add a payment method' error", () => {
    const d = evalGate(gateState("nova", { defaultPaymentMethodId: null }));
    expectBlocked(d, "no_payment_method");
    if (!d.allowed) expect(d.error.message).toMatch(/payment method/i);
  });

  it("expired card → card_expired; current-month expiry is still valid", () => {
    const expired = evalGate(gateState("comet", { cardExpMonth: 6, cardExpYear: 2026 }));
    expectBlocked(expired, "card_expired");

    const currentMonth = evalGate(gateState("comet", { cardExpMonth: 7, cardExpYear: 2026 }));
    expect(currentMonth.allowed).toBe(true);
  });

  it("unknown card expiry with a PM present rules by presence", () => {
    const d = evalGate(gateState("comet", { cardExpMonth: null, cardExpYear: null }));
    expect(d.allowed).toBe(true);
  });

  it("dunning-paused → billing_paused; retrying inside grace still builds", () => {
    const paused = evalGate(gateState("orbit", { dunningStatus: "paused" }));
    expectBlocked(paused, "billing_paused");

    const inGrace = evalGate(
      gateState("orbit", {
        dunningStatus: "retrying",
        dunningGraceUntil: new Date("2026-08-05T00:00:00Z"),
      }),
    );
    expect(inGrace.allowed).toBe(true);

    const gracePassed = evalGate(
      gateState("orbit", {
        dunningStatus: "retrying",
        dunningGraceUntil: new Date("2026-07-25T00:00:00Z"),
      }),
    );
    expectBlocked(gracePassed, "billing_paused");
  });

  it("skipUsageChecks (reserved-at-enqueue drain) skips ladder+cap but never plan/card", () => {
    const ladderSkipped = evalGate(gateState("orbit", {}, { proBuildsUsed: 3 }), {
      engineMode: "pro",
      skipUsageChecks: true,
    });
    expect(ladderSkipped.allowed).toBe(true);

    const cardStillEnforced = evalGate(gateState("orbit", { defaultPaymentMethodId: null }), {
      engineMode: "pro",
      skipUsageChecks: true,
    });
    expectBlocked(cardStillEnforced, "no_payment_method");
  });
});

// ─── Spend cap ───────────────────────────────────────────────────────────────
describe("spend cap", () => {
  it("builds covered by the included bucket never hit the cap", () => {
    const d = evalGate(
      gateState("orbit", {}, { usedIncludedCredits: 0, overageUsdCents: 2499 }),
      { engineMode: "power", projectedCredits: 100 },
    );
    expect(d.allowed).toBe(true);
  });

  it("blocks when projected overage would exceed the cap — honest message, never mid-flight", () => {
    // Bucket exhausted; existing overage $24.00 of a $25.00 cap; 100 more
    // credits at Orbit's $0.012 = $1.20 projected → over.
    const d = evalGate(
      gateState("orbit", {}, { usedIncludedCredits: 1800, overageUsdCents: 2400 }),
      { engineMode: "power", projectedCredits: 100 },
    );
    expectBlocked(d, "spend_cap_reached");
    if (!d.allowed) expect(d.error.message).toMatch(/spend cap/i);
  });

  it("allows when projected overage stays within the cap (partial bucket split)", () => {
    // 50 credits left in bucket, 100 projected → only 50 metered = $0.60.
    const d = evalGate(
      gateState("orbit", {}, { usedIncludedCredits: 1750, overageUsdCents: 2440 }),
      { engineMode: "power", projectedCredits: 100 },
    );
    expect(d.allowed).toBe(true);

    const over = evalGate(
      gateState("orbit", {}, { usedIncludedCredits: 1750, overageUsdCents: 2441 }),
      { engineMode: "power", projectedCredits: 100 },
    );
    expectBlocked(over, "spend_cap_reached");
  });
});

// ─── Pure cycle math ─────────────────────────────────────────────────────────
describe("cycle math", () => {
  it("splitNabuflowCharge splits included-first, then overage", () => {
    expect(splitNabuflowCharge(1000, 300)).toEqual({ included: 300, overage: 0 });
    expect(splitNabuflowCharge(100, 300)).toEqual({ included: 100, overage: 200 });
    expect(splitNabuflowCharge(0, 300)).toEqual({ included: 0, overage: 300 });
    expect(splitNabuflowCharge(-50, 300)).toEqual({ included: 0, overage: 300 });
  });

  it("rollover: Orbit none; Comet one cycle capped at a month's allotment", () => {
    expect(computeNabuflowRollover(NABUFLOW_PLANS.orbit, 1800, 500)).toBe(0);
    expect(computeNabuflowRollover(NABUFLOW_PLANS.comet, 4800, 3800)).toBe(1000);
    expect(computeNabuflowRollover(NABUFLOW_PLANS.comet, 9600, 0)).toBe(4800);
    expect(computeNabuflowRollover(NABUFLOW_PLANS.comet, 4800, 6000)).toBe(0);
  });

  it("overage pricing per plan: $0.012 / $0.011 / $0.010 per credit", () => {
    expect(nabuflowOverageCents(NABUFLOW_PLANS.orbit, 100)).toBe(120);
    expect(nabuflowOverageCents(NABUFLOW_PLANS.comet, 100)).toBe(110);
    expect(nabuflowOverageCents(NABUFLOW_PLANS.nova, 100)).toBe(100);
  });

  it("spend-cap clamping: null → default, user value clamped to tier max", () => {
    const orbit = NABUFLOW_PLANS.orbit;
    expect(nabuflowEffectiveSpendCapCents(orbit, null)).toBe(2500);
    expect(nabuflowEffectiveSpendCapCents(orbit, 999_999)).toBe(10_000);
    expect(nabuflowEffectiveSpendCapCents(orbit, 0)).toBe(0);
  });

  it("usageThresholdLevel steps at 50/80/100", () => {
    expect(usageThresholdLevel(0, 100)).toBe(0);
    expect(usageThresholdLevel(49, 100)).toBe(0);
    expect(usageThresholdLevel(50, 100)).toBe(50);
    expect(usageThresholdLevel(79, 100)).toBe(50);
    expect(usageThresholdLevel(80, 100)).toBe(80);
    expect(usageThresholdLevel(99, 100)).toBe(80);
    expect(usageThresholdLevel(100, 100)).toBe(100);
    expect(usageThresholdLevel(150, 100)).toBe(100);
    expect(usageThresholdLevel(10, 0)).toBe(0);
  });
});

// ─── Simulated cycle rollover ────────────────────────────────────────────────
describe("simulated cycle rollover", () => {
  const JUL1 = new Date("2026-07-01T00:00:00Z");
  const AUG1 = new Date("2026-08-01T00:00:00Z");

  it("advances one cycle: unused Comet credits roll, metered counters reset by construction", () => {
    const next = simulateNabuflowCycleAdvance(
      NABUFLOW_PLANS.comet,
      { cycleStart: JUL1, cycleEnd: AUG1, includedCredits: 4800, usedIncludedCredits: 3800 },
      new Date("2026-08-05T00:00:00Z"),
    );
    expect(next.cycleStart.toISOString()).toBe(AUG1.toISOString());
    expect(next.rolloverCredits).toBe(1000);

    // The fresh cycle starts with zeroed counters — a Comet user blocked on
    // their 11th Deep build last cycle builds again after the rollover.
    const blockedLastCycle = evalGate(gateState("comet", {}, { deepBuildsUsed: 10 }), {
      deepReasoning: true,
    });
    expect(blockedLastCycle.allowed).toBe(false);
    const freshCycle = evalGate(gateState("comet", {}, { deepBuildsUsed: 0 }), {
      deepReasoning: true,
    });
    expect(freshCycle.allowed).toBe(true);
  });

  it("Orbit never rolls credits over", () => {
    const next = simulateNabuflowCycleAdvance(
      NABUFLOW_PLANS.orbit,
      { cycleStart: JUL1, cycleEnd: AUG1, includedCredits: 1800, usedIncludedCredits: 0 },
      new Date("2026-08-05T00:00:00Z"),
    );
    expect(next.rolloverCredits).toBe(0);
  });

  it("chains through skipped idle cycles and stays capped at one month's allotment", () => {
    const next = simulateNabuflowCycleAdvance(
      NABUFLOW_PLANS.comet,
      { cycleStart: JUL1, cycleEnd: AUG1, includedCredits: 4800, usedIncludedCredits: 3800 },
      new Date("2026-09-10T00:00:00Z"), // skips the entire August cycle
    );
    expect(next.cycleStart.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(next.rolloverCredits).toBe(4800); // min(4800 + 1000, cap 4800)
  });
});

// ─── Enforcement flag + bypass ordering ──────────────────────────────────────
describe("enforcement & bypass", () => {
  it("CREDITS_ENFORCEMENT off (default) → everything allowed, flagged as such", async () => {
    const d = await resolveNabuflowBuildGate("user_any", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "enforcement_disabled" });
  });

  it("enforcement on + no plan → blocked no_plan (the resolver reaches the evaluator)", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    const d = await resolveNabuflowBuildGate("user_no_plan", {});
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.error.code).toBe("no_plan");
  });

  it("test bypass works in dev but is dead in production builds of the flag", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.NABUFLOW_BILLING_TEST_BYPASS = "true";
    expect(nabuflowTestBypassActive()).toBe(true);
    const d = await resolveNabuflowBuildGate("user_e2e", {});
    expect(d).toEqual({ allowed: true, bypass: "test" });

    // Production: REPLIT_DEPLOYMENT=1 is read at module init — re-import fresh.
    process.env.REPLIT_DEPLOYMENT = "1";
    vi.resetModules();
    const fresh = await import("../nabuflow-billing");
    expect(fresh.nabuflowTestBypassActive()).toBe(false);
    const prodDecision = await fresh.resolveNabuflowBuildGate("user_e2e", {});
    expect(prodDecision.allowed).toBe(false); // falls through to no_plan
    vi.resetModules();
  });

  it("superuser bypasses everything (order: before allowlist and DB reads)", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    vi.mocked(isSuperuser).mockResolvedValueOnce(true);
    const d = await resolveNabuflowBuildGate("user_super", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "superuser" });
  });

  it("BUILDER_ALLOWLIST owner builds freely with no card and no charge", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: " Owner@X.com " } as never);
    const d = await resolveNabuflowBuildGate("user_owner", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "allowlist" });
  });

  it("allowlist lookup failure degrades CLOSED (no free builds on Clerk outage)", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com";
    vi.mocked(getClerkUserById).mockRejectedValue(new Error("clerk down"));
    const d = await resolveNabuflowBuildGate("user_unlucky", {});
    expect(d.allowed).toBe(false);
  });
});

// ─── Calm structured HTTP body ───────────────────────────────────────────────
describe("gate HTTP body", () => {
  it("wraps the structured error under code nabuflow_billing", () => {
    const d = evalGate(gateState("orbit", {}, { proBuildsUsed: 3 }), { engineMode: "pro" });
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      const body = nabuflowGateHttpBody(d.error);
      expect(body.code).toBe("nabuflow_billing");
      expect(body.error).toBe(d.error.message);
      expect(body.billing).toBe(d.error);
    }
  });
});

// ─── Dunning transitions (invoice.payment_failed) ────────────────────────────
describe("dunning transitions", () => {
  const subRow = (over: Record<string, unknown> = {}) => ({
    id: 7,
    userId: "u_dun",
    planId: "orbit",
    stripeSubscriptionId: "sub_nf_1",
    dunningStatus: "none",
    dunningAttemptCount: 0,
    dunningStartedAt: null,
    dunningGraceUntil: null,
    dunningPausedAt: null,
    ...over,
  });

  it("first failure → retrying + past_due + payment-failed notification", async () => {
    h.state.selectResult = [subRow()];
    await handleNabuflowInvoicePaymentFailed({ subscription: "sub_nf_1", attempt_count: 1 });

    const update = h.state.updates.find((u) => "dunningStatus" in u);
    expect(update).toBeDefined();
    expect(update!.dunningStatus).toBe("retrying");
    expect(update!.status).toBe("past_due");
    expect(update!.dunningAttemptCount).toBe(1);

    const notif = h.state.inserted.find((i) => i.recipientId === "u_dun");
    expect(notif).toBeDefined();
    expect(notif!.type).toBe("nabuflow_payment_failed");
  });

  it("max attempts reached → paused + builds-paused notification", async () => {
    h.state.selectResult = [subRow({ dunningStatus: "retrying", dunningAttemptCount: 2 })];
    await handleNabuflowInvoicePaymentFailed({ subscription: "sub_nf_1", attempt_count: 3 });

    const update = h.state.updates.find((u) => "dunningStatus" in u);
    expect(update!.dunningStatus).toBe("paused");
    expect(update!.dunningPausedAt).toBeInstanceOf(Date);

    const notif = h.state.inserted.find((i) => i.recipientId === "u_dun");
    expect(notif!.type).toBe("nabuflow_builds_paused");
  });

  it("grace window expired → paused even below max attempts", async () => {
    h.state.selectResult = [
      subRow({
        dunningStatus: "retrying",
        dunningAttemptCount: 1,
        dunningStartedAt: new Date("2026-07-01T00:00:00Z"),
        dunningGraceUntil: new Date("2026-07-08T00:00:00Z"), // long past
      }),
    ];
    await handleNabuflowInvoicePaymentFailed({ subscription: "sub_nf_1", attempt_count: 2 });

    const update = h.state.updates.find((u) => "dunningStatus" in u);
    expect(update!.dunningStatus).toBe("paused");
  });

  it("invoice without NabuFlow linkage or local row is a no-op", async () => {
    h.state.selectResult = [];
    await handleNabuflowInvoicePaymentFailed({ subscription: "sub_unknown", attempt_count: 1 });
    expect(h.state.updates).toHaveLength(0);
    expect(h.state.inserted).toHaveLength(0);

    await handleNabuflowInvoicePaymentFailed({ attempt_count: 1 });
    expect(h.state.updates).toHaveLength(0);
  });
});
