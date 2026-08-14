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
    /** FIFO of per-select results; when empty, falls back to selectResult. */
    selectQueue: [] as unknown[][],
    updates: [] as Array<Record<string, unknown>>,
    inserted: [] as Array<Record<string, unknown>>,
  };

  const makeWhereResult = () => {
    const arr =
      state.selectQueue.length > 0 ? (state.selectQueue.shift() as unknown[]) : state.selectResult;
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
    select: () => ({
      from: () => ({
        where: () => makeWhereResult(),
        innerJoin: () => ({ where: () => makeWhereResult() }),
        leftJoin: () => ({ where: () => makeWhereResult() }),
      }),
    }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        state.inserted.push(v);
        const p = Promise.resolve(undefined) as Promise<unknown> & {
          onConflictDoNothing: () => { returning: () => Promise<unknown[]> };
          onConflictDoUpdate: (opts: unknown) => { returning: () => Promise<unknown[]> };
          returning: () => Promise<unknown[]>;
        };
        p.onConflictDoNothing = () => {
          const settlementKey = v.settlementKey;
          if (
            typeof settlementKey === "string" &&
            state.inserted.filter((row) => row.settlementKey === settlementKey).length > 1
          ) {
            state.inserted.splice(state.inserted.lastIndexOf(v), 1);
          }
          return { returning: () => Promise.resolve([]) };
        };
        // Upsert returns the row as the DB would: schema defaults + values.
        p.onConflictDoUpdate = () => ({
          returning: () =>
            Promise.resolve([
              {
                id: 991,
                status: "incomplete",
                rolloverCredits: 0,
                dunningStatus: "none",
                dunningAttemptCount: 0,
                cancelAtPeriodEnd: false,
                ...v,
              },
            ]),
        });
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

  return { state, mockDb, loggerWarn: vi.fn() };
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
  logger: { info: () => {}, warn: h.loggerWarn, error: () => {}, debug: () => {} },
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

vi.mock("../nabuflow-org", async () => ({
  resolveNabuflowOrgContext: vi.fn(async () => null),
  getNabuflowOrgSeatContext: vi.fn(async () => null),
  buildNabuflowOrgGateInfo: vi.fn(async () => null),
  chargeNabuflowOrgPool: vi.fn(async () => ({ poolCredits: 0 })),
  refundNabuflowOrgPool: vi.fn(async () => 0),
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
  handleNabuflowSubscriptionEvent,
  handleNabuflowInvoicePaid,
  _clearNabuflowAllowlistCache,
  isBuilderAllowlistExempt,
  isSealedStagingAcceptanceExempt,
  recordZeroChargeUsage,
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
import { hasBuilderAccess } from "../builder-access";
import { RERUN7_SUBSCRIPTION_UPDATE_INVOICE_PAID } from "./rerun7-subscription-update-invoice-paid.fixture";

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
): asserts decision is {
  allowed: false;
  error: NonNullable<Parameters<typeof nabuflowGateHttpBody>[0]>;
} {
  expect(decision.allowed).toBe(false);
  if (!decision.allowed) expect(decision.error.code).toBe(code);
}

const ENV_KEYS = [
  "CREDITS_ENFORCEMENT",
  "NABUFLOW_BILLING_TEST_BYPASS",
  "BUILDER_ALLOWLIST",
  "BILLING_EXEMPT_ALLOWLIST",
  "REPLIT_DEPLOYMENT",
  "TENANT_RUNTIME_PROVIDER",
  "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
  "NABUFLOW_ZERO_GENERATION_TARGET",
  "NABUFLOW_ACCEPTANCE_BILLING_EXEMPT_ALLOWLIST",
] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  h.state.selectResult = [];
  h.state.selectQueue = [];
  h.state.updates = [];
  h.state.inserted = [];
  h.loggerWarn.mockClear();
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
describe("zero-charge usage ledger", () => {
  it("records one idempotent actual zero with task attribution and no billable amounts", async () => {
    const opts = {
      projectId: 47,
      taskId: 176,
      type: "build",
      description: "Lite build",
      engineMode: "lite",
      deepReasoning: false,
      source: "pipeline",
      settlementKey: "task-credit:176:pipeline",
    } as const;

    await recordZeroChargeUsage("owner-1", opts);
    await recordZeroChargeUsage("owner-1", opts);

    expect(h.state.inserted).toHaveLength(1);
    const [row] = h.state.inserted;
    expect(row).toMatchObject({
      userId: "owner-1",
      cycleId: null,
      projectId: 47,
      taskId: 176,
      source: "pipeline",
      engineMode: "lite",
      deepReasoning: false,
      credits: 0,
      includedCredits: 0,
      overageCredits: 0,
      overageUsdCents: 0,
      usdValueCents: 0,
      settlementKey: "task-credit:176:pipeline",
    });
    expect((row.cycleStart as Date).getUTCDate()).toBe(1);
    expect((row.cycleStart as Date).getUTCHours()).toBe(0);
  });
});

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

  it("keeps Comet Deep entitlement while an Orbit downgrade is pending", () => {
    const state = gateState("comet", {
      pendingPlanId: "orbit",
      pendingEffectiveAt: CYCLE_END,
    } as Partial<NonNullable<NabuflowGateState["subscription"]>>);
    const decision = evalGate(state, { engineMode: "power", deepReasoning: true });

    expect(decision.allowed).toBe(true);
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
    const d = evalGate(gateState("orbit", {}, { usedIncludedCredits: 0, overageUsdCents: 2499 }), {
      engineMode: "power",
      projectedCredits: 100,
    });
    expect(d.allowed).toBe(true);
  });

  it("blocks when projected overage would exceed the cap — honest message, never mid-flight", () => {
    // Bucket exhausted; existing overage $24.00 of a $25.00 cap; 100 more
    // credits at Orbit's configured rate push the request above the cap.
    const d = evalGate(
      gateState("orbit", {}, { usedIncludedCredits: 1800, overageUsdCents: 2400 }),
      { engineMode: "power", projectedCredits: 100 },
    );
    expectBlocked(d, "spend_cap_reached");
    if (!d.allowed) expect(d.error.message).toMatch(/spend cap/i);
  });

  it("allows when projected overage stays within the cap (partial bucket split)", () => {
    const plan = NABUFLOW_PLANS.orbit;
    const projectedCredits = 100;
    const remainingIncluded = 50;
    const projectedOverageCents = nabuflowOverageCents(plan, projectedCredits - remainingIncluded);
    const safeExistingOverage = 2500 - projectedOverageCents;

    // The request consumes the last included credits, then bills only the
    // remainder. Derive the boundary from the current configured rate.
    const d = evalGate(
      gateState(
        "orbit",
        {},
        {
          usedIncludedCredits: plan.includedMonthlyCredits - remainingIncluded,
          overageUsdCents: safeExistingOverage,
        },
      ),
      { engineMode: "power", projectedCredits },
    );
    expect(d.allowed).toBe(true);

    const over = evalGate(
      gateState(
        "orbit",
        {},
        {
          usedIncludedCredits: plan.includedMonthlyCredits - remainingIncluded,
          overageUsdCents: safeExistingOverage + 1,
        },
      ),
      { engineMode: "power", projectedCredits },
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
    const orbit = NABUFLOW_PLANS.orbit;
    const comet = NABUFLOW_PLANS.comet;
    expect(computeNabuflowRollover(orbit, orbit.includedMonthlyCredits, 500)).toBe(0);
    expect(computeNabuflowRollover(comet, comet.includedMonthlyCredits, 3800)).toBe(
      Math.min(comet.includedMonthlyCredits - 3800, comet.rolloverMaxCredits),
    );
    expect(computeNabuflowRollover(comet, comet.includedMonthlyCredits * 2, 0)).toBe(
      comet.rolloverMaxCredits,
    );
    expect(
      computeNabuflowRollover(
        comet,
        comet.includedMonthlyCredits,
        comet.includedMonthlyCredits + 1,
      ),
    ).toBe(0);
  });

  it("overage pricing per plan follows the live plan configuration", () => {
    for (const plan of [NABUFLOW_PLANS.orbit, NABUFLOW_PLANS.comet, NABUFLOW_PLANS.nova]) {
      expect(nabuflowOverageCents(plan, 100)).toBe(
        Math.round(plan.overageUsdPerCredit * 100 * 100),
      );
    }
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
    const comet = NABUFLOW_PLANS.comet;
    const next = simulateNabuflowCycleAdvance(
      comet,
      {
        cycleStart: JUL1,
        cycleEnd: AUG1,
        includedCredits: comet.includedMonthlyCredits,
        usedIncludedCredits: comet.includedMonthlyCredits - 1000,
      },
      new Date("2026-09-10T00:00:00Z"), // skips the entire August cycle
    );
    expect(next.cycleStart.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    expect(next.rolloverCredits).toBe(comet.rolloverMaxCredits);
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

  it("permits only an identity listed behind every sealed staging acceptance lock", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "staging";
    process.env.NABUFLOW_ZERO_GENERATION_TARGET = "cloudflare-sealed-staging-v1";
    process.env.NABUFLOW_ACCEPTANCE_BILLING_EXEMPT_ALLOWLIST = "runner@example.com";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: " Runner@Example.com " } as never);

    await expect(isSealedStagingAcceptanceExempt("user_runner")).resolves.toBe(true);
    await expect(resolveNabuflowBuildGate("user_runner", {})).resolves.toEqual({
      allowed: true,
      bypass: "staging_acceptance",
    });
  });

  it.each([
    ["deployment", { REPLIT_DEPLOYMENT: undefined }],
    ["provider", { TENANT_RUNTIME_PROVIDER: "fly" }],
    ["namespace", { CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "production" }],
    ["target", { NABUFLOW_ZERO_GENERATION_TARGET: "legacy" }],
    ["identity", { NABUFLOW_ACCEPTANCE_BILLING_EXEMPT_ALLOWLIST: "other@example.com" }],
    ["malformed allowlist", { NABUFLOW_ACCEPTANCE_BILLING_EXEMPT_ALLOWLIST: "not-an-email" }],
  ])("fails closed when the staging acceptance %s lock is absent", async (_label, override) => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.REPLIT_DEPLOYMENT = "1";
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
    process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE = "staging";
    process.env.NABUFLOW_ZERO_GENERATION_TARGET = "cloudflare-sealed-staging-v1";
    process.env.NABUFLOW_ACCEPTANCE_BILLING_EXEMPT_ALLOWLIST = "runner@example.com";
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.mocked(getClerkUserById).mockResolvedValue({ email: "runner@example.com" } as never);

    await expect(isSealedStagingAcceptanceExempt("user_runner")).resolves.toBe(false);
    const decision = await resolveNabuflowBuildGate("user_runner", {});
    expect(decision.allowed).toBe(false);
  });

  it("superuser bypasses everything (order: before allowlist and DB reads)", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    vi.mocked(isSuperuser).mockResolvedValueOnce(true);
    const d = await resolveNabuflowBuildGate("user_super", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "superuser" });
  });

  it("lets an allowlisted payer build while keeping that account chargeable", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com,payer@x.com";
    process.env.BILLING_EXEMPT_ALLOWLIST = "owner@x.com";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: "payer@x.com" } as never);

    expect(hasBuilderAccess("payer@x.com")).toBe(true);
    await expect(isBuilderAllowlistExempt("user_payer")).resolves.toBe(false);
    const d = await resolveNabuflowBuildGate("user_payer", {});
    expect(d.allowed).toBe(false);
  });

  it("keeps the explicit billing owner exempt", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com,payer@x.com";
    process.env.BILLING_EXEMPT_ALLOWLIST = "owner@x.com";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: " Owner@X.com " } as never);

    const d = await resolveNabuflowBuildGate("user_owner", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "allowlist" });
  });

  it("falls back to BUILDER_ALLOWLIST when BILLING_EXEMPT_ALLOWLIST is unset", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: " Owner@X.com " } as never);
    const d = await resolveNabuflowBuildGate("user_owner", { engineMode: "pro" });
    expect(d).toEqual({ allowed: true, bypass: "allowlist" });
  });

  it("fails closed when BILLING_EXEMPT_ALLOWLIST contains a malformed entry", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    process.env.BUILDER_ALLOWLIST = "owner@x.com";
    process.env.BILLING_EXEMPT_ALLOWLIST = "owner@x.com,not-an-email";
    vi.mocked(getClerkUserById).mockResolvedValue({ email: "owner@x.com" } as never);

    const d = await resolveNabuflowBuildGate("user_owner", {});
    expect(d.allowed).toBe(false);
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

describe("invoice.paid cycle-grant reasons", () => {
  const PS = Math.floor(new Date("2026-09-01T00:00:00Z").getTime() / 1000);
  const PE = Math.floor(new Date("2026-10-01T00:00:00Z").getTime() / 1000);
  const subRow = (over: Record<string, unknown> = {}) => ({
    id: 77,
    userId: "u_paid",
    planId: "comet",
    stripeSubscriptionId: "sub_paid",
    rolloverCredits: 0,
    dunningStatus: "none",
    dunningAttemptCount: 0,
    dunningStartedAt: null,
    dunningGraceUntil: null,
    dunningPausedAt: null,
    ...over,
  });

  it("rerun-7 subscription_update payment keeps payment health but grants no cycle", async () => {
    h.state.selectQueue = [
      [
        subRow({
          userId: "user_3HIbv5LHwRz3W7yTFycbZ2NqzfZ",
          stripeSubscriptionId: "sub_1TzUdXDCzx2AknNDyCGR56fn",
          dunningStatus: "retrying",
        }),
      ],
    ];

    await handleNabuflowInvoicePaid(RERUN7_SUBSCRIPTION_UPDATE_INVOICE_PAID as never);

    expect(h.state.inserted).toHaveLength(0);
    expect(h.state.updates).toContainEqual(expect.objectContaining({ status: "active" }));
    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        dunningStatus: "none",
        dunningStartedAt: null,
        dunningGraceUntil: null,
        dunningPausedAt: null,
        dunningAttemptCount: 0,
      }),
    );
  });

  it("subscription_create payment grants the first cycle", async () => {
    h.state.selectQueue = [
      [subRow()],
      [],
      [{ id: 9001, includedCredits: NABUFLOW_PLANS.comet.includedMonthlyCredits }],
    ];

    await handleNabuflowInvoicePaid({
      id: "in_create",
      billing_reason: "subscription_create",
      subscription: "sub_paid",
      lines: { data: [{ subscription: "sub_paid", period: { start: PS, end: PE } }] },
    } as never);

    const cycle = h.state.inserted.find((row) => "includedCredits" in row);
    expect(cycle).toMatchObject({
      userId: "u_paid",
      planId: "comet",
      includedCredits: NABUFLOW_PLANS.comet.includedMonthlyCredits,
      rolloverCredits: 0,
    });
  });

  it("subscription_cycle payment grants Comet rollover from the preceding cycle", async () => {
    h.state.selectQueue = [
      [subRow()],
      [{ includedCredits: 4000, usedIncludedCredits: 1000 }],
      [{ id: 9002, includedCredits: 7000, rolloverCredits: 3000 }],
    ];

    await handleNabuflowInvoicePaid({
      id: "in_cycle",
      billing_reason: "subscription_cycle",
      subscription: "sub_paid",
      lines: { data: [{ subscription: "sub_paid", period: { start: PS, end: PE } }] },
    } as never);

    const cycle = h.state.inserted.find((row) => "includedCredits" in row);
    expect(cycle).toMatchObject({
      planId: "comet",
      includedCredits: 7000,
      rolloverCredits: 3000,
    });
  });

  it("lands a scheduled Comet-to-Orbit downgrade at renewal with 1,600 credits and zero rollover", async () => {
    h.state.selectQueue = [
      [
        subRow({
          pendingPlanId: "orbit",
          pendingEffectiveAt: new Date(PS * 1000),
        }),
      ],
      [{ includedCredits: 4000, usedIncludedCredits: 1000 }],
      [{ id: 9003, includedCredits: 1600, rolloverCredits: 0 }],
    ];

    await handleNabuflowInvoicePaid({
      id: "in_rerun8_deferred_renewal",
      billing_reason: "subscription_cycle",
      subscription: "sub_paid",
      parent: {
        subscription_details: {
          subscription: "sub_paid",
          metadata: { surface: "nabuflow", plan: "orbit", userId: "u_paid" },
        },
      },
      lines: { data: [{ subscription: "sub_paid", period: { start: PS, end: PE } }] },
    } as never);

    expect(h.state.updates).toContainEqual(
      expect.objectContaining({
        planId: "orbit",
        pendingPlanId: null,
        pendingEffectiveAt: null,
      }),
    );
    const cycle = h.state.inserted.find((row) => "includedCredits" in row);
    expect(cycle).toMatchObject({
      planId: "orbit",
      includedCredits: 1600,
      rolloverCredits: 0,
    });
  });

  it("fails closed when a pending renewal invoice does not prove the scheduled target", async () => {
    h.state.selectQueue = [
      [
        subRow({
          pendingPlanId: "orbit",
          pendingEffectiveAt: new Date(PS * 1000),
        }),
      ],
    ];

    await handleNabuflowInvoicePaid({
      id: "in_unknown_pending_transition",
      billing_reason: "subscription_cycle",
      subscription: "sub_paid",
      parent: {
        subscription_details: {
          subscription: "sub_paid",
          metadata: { surface: "nabuflow", plan: "comet", userId: "u_paid" },
        },
      },
      lines: { data: [{ subscription: "sub_paid", period: { start: PS, end: PE } }] },
    } as never);

    expect(h.state.inserted).toHaveLength(0);
    expect(h.state.updates).not.toContainEqual(
      expect.objectContaining({ planId: "orbit", pendingPlanId: null }),
    );
    expect(h.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ invoiceId: "in_unknown_pending_transition" }),
      expect.stringContaining("could not be verified"),
    );
  });

  it.each([undefined, "unexpected_reason"])(
    "billing reason %s grants no cycle and logs a warning",
    async (billingReason) => {
      h.state.selectQueue = [[subRow()]];

      await handleNabuflowInvoicePaid({
        id: "in_unknown",
        billing_reason: billingReason,
        subscription: "sub_paid",
        lines: { data: [{ subscription: "sub_paid", period: { start: PS, end: PE } }] },
      } as never);

      expect(h.state.inserted).toHaveLength(0);
      expect(h.state.updates).toContainEqual(expect.objectContaining({ status: "active" }));
      expect(h.loggerWarn).toHaveBeenCalledWith(
        expect.objectContaining({ invoiceId: "in_unknown", billingReason }),
        expect.stringContaining("unknown billing reason"),
      );
    },
  );
});

// ─── First-time subscription materialization ─────────────────────────────────
// A brand-new subscriber has NO local nabuflow_subscriptions row when the
// first Stripe event (or the subscribe route's direct sync) arrives. The
// handlers must create it from metadata — otherwise the gate would keep
// resolving "no plan" for a paying customer forever.
describe("first-time subscription materialization", () => {
  const PS = Math.floor(new Date("2026-07-30T00:00:00Z").getTime() / 1000);
  const PE = Math.floor(new Date("2026-08-29T00:00:00Z").getTime() / 1000);

  it("customer.subscription.created with no local row creates it, syncs state, and grants the first cycle", async () => {
    const freshRow = {
      id: 991,
      userId: "u_first",
      planId: "comet",
      status: "active",
      rolloverCredits: 0,
      dunningStatus: "none",
    };
    h.state.selectQueue = [
      [], // findNabuflowSubscriptionByStripeId — nothing yet
      [], // getNabuflowSubscription(metadata userId) — first-timer
      [freshRow], // re-fetch after the sync update, feeding grantNabuflowCycle
      [], // latestCycleBefore — no previous cycle
      [{ id: 5001, includedCredits: 4800 }], // getCycleRow (insert took conflict path)
    ];

    await handleNabuflowSubscriptionEvent("customer.subscription.created", {
      id: "sub_first",
      status: "active",
      customer: "cus_shared_9",
      cancel_at_period_end: false,
      metadata: { surface: "nabuflow", plan: "comet", userId: "u_first" },
      items: { data: [{ id: "si_first", current_period_start: PS, current_period_end: PE }] },
    } as never);

    // Row created with plan + Stripe linkage:
    const created = h.state.inserted.find((i) => i.stripeSubscriptionId === "sub_first");
    expect(created).toBeDefined();
    expect(created!.userId).toBe("u_first");
    expect(created!.planId).toBe("comet");
    expect(created!.stripeCustomerId).toBe("cus_shared_9");

    // State synced (status/plan/item id):
    const sync = h.state.updates.find((u) => u.status === "active" && "stripeItemId" in u);
    expect(sync).toBeDefined();
    expect(sync!.planId).toBe("comet");
    expect(sync!.stripeItemId).toBe("si_first");

    // First cycle bucket granted from Stripe's authoritative period:
    const cycle = h.state.inserted.find((i) => "includedCredits" in i);
    expect(cycle).toBeDefined();
    expect(cycle!.userId).toBe("u_first");
    expect(cycle!.includedCredits).toBe(NABUFLOW_PLANS.comet.includedMonthlyCredits);
    expect(cycle!.cycleStart).toEqual(new Date(PS * 1000));
    expect(cycle!.cycleEnd).toEqual(new Date(PE * 1000));
  });

  it("gate resolves allowed for the fresh subscriber right afterwards (no lingering 'no plan')", async () => {
    process.env.CREDITS_ENFORCEMENT = "true";
    const cycleStart = new Date(Date.now() - 24 * 60 * 60_000);
    const cycleEnd = new Date(Date.now() + 29 * 24 * 60 * 60_000);
    h.state.selectQueue = [
      [
        {
          id: 991,
          userId: "u_first",
          planId: "comet",
          status: "active",
          dunningStatus: "none",
          dunningGraceUntil: null,
          defaultPaymentMethodId: "pm_9",
          cardExpMonth: 12,
          cardExpYear: 2031,
          currentCycleStart: cycleStart,
          currentCycleEnd: cycleEnd,
          rolloverCredits: 0,
        },
      ], // getNabuflowSubscription — the row the webhook just materialized
      [
        {
          includedCredits: 4800,
          usedIncludedCredits: 0,
          overageUsdCents: 0,
          proBuildsUsed: 0,
          deepBuildsUsed: 0,
        },
      ], // getCycleRow (materializeCycle insert hits the conflict path)
      [], // billing settings — default spend cap
    ];

    const d = await resolveNabuflowBuildGate("u_first", {
      engineMode: "pro",
      projectedCredits: 50,
    });
    expect(d.allowed).toBe(true);
  });

  it("subscription event with no row AND no metadata is still ignored (cannot attribute)", async () => {
    h.state.selectQueue = [[]];
    await handleNabuflowSubscriptionEvent("customer.subscription.updated", {
      id: "sub_orphan",
      status: "active",
    } as never);
    expect(h.state.inserted).toHaveLength(0);
    expect(h.state.updates).toHaveLength(0);
  });

  it("keeps current entitlements when a scheduled target subscription update arrives before renewal payment", async () => {
    h.state.selectQueue = [
      [
        {
          id: 77,
          userId: "u_paid",
          planId: "comet",
          pendingPlanId: "orbit",
          pendingEffectiveAt: new Date(PE * 1000),
          stripeSubscriptionId: "sub_paid",
          dunningStatus: "none",
        },
      ],
    ];

    await handleNabuflowSubscriptionEvent("customer.subscription.updated", {
      id: "sub_paid",
      status: "active",
      customer: "cus_paid",
      metadata: { surface: "nabuflow", plan: "orbit", userId: "u_paid" },
      items: {
        data: [{ id: "si_paid", current_period_start: PE, current_period_end: PE + 2_592_000 }],
      },
    } as never);

    expect(h.state.inserted).toHaveLength(0);
    expect(h.state.updates).toContainEqual(expect.objectContaining({ planId: "comet" }));
    expect(h.state.updates).not.toContainEqual(
      expect.objectContaining({ pendingPlanId: null, pendingEffectiveAt: null }),
    );
  });

  it("invoice.paid racing ahead of subscription.created materializes the row and grants the cycle", async () => {
    h.state.selectQueue = [
      [], // findNabuflowSubscriptionByStripeId
      [], // latestCycleBefore
      [{ id: 5002, includedCredits: 1800 }], // getCycleRow (insert took conflict path)
    ];

    await handleNabuflowInvoicePaid({
      billing_reason: "subscription_create",
      customer: "cus_shared_9",
      parent: {
        subscription_details: {
          subscription: "sub_race",
          metadata: { surface: "nabuflow", plan: "orbit", userId: "u_race" },
        },
      },
      lines: { data: [{ subscription: "sub_race", period: { start: PS, end: PE } }] },
    } as never);

    const created = h.state.inserted.find((i) => i.stripeSubscriptionId === "sub_race");
    expect(created).toBeDefined();
    expect(created!.userId).toBe("u_race");
    expect(created!.planId).toBe("orbit");
    expect(created!.stripeCustomerId).toBe("cus_shared_9");

    const cycle = h.state.inserted.find((i) => "includedCredits" in i);
    expect(cycle).toBeDefined();
    expect(cycle!.includedCredits).toBe(NABUFLOW_PLANS.orbit.includedMonthlyCredits);

    const activated = h.state.updates.find((u) => u.status === "active");
    expect(activated).toBeDefined();
  });
});
