// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow billing API (Task #1516).
//
// Read endpoints mirror the server-side canBuild gate (plan, card, cap,
// counters + reset date) so the UI can render state WITHOUT authorizing
// anything client-side — the gate itself runs at every build entry point.
// Write endpoints drive Stripe; durable plan/card/dunning state is
// webhook-driven (see routes/billing.ts + lib/nabuflow-billing.ts).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { z } from "zod";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  nabuflowBillingCyclesTable,
  nabuflowBillingSettingsTable,
  nabuflowOrgLedgerTable,
  nabuflowOrgPurchasesTable,
  nabuflowOrgsTable,
  nabuflowUsageEventsTable,
  notificationsTable,
  type NabuflowOrg,
  type NabuflowOrgSeat,
} from "@workspace/db";
import {
  NABUFLOW_ORG_BULK_TIERS,
  NABUFLOW_ORG_MIN_PURCHASE_CREDITS,
  NABUFLOW_PLAN_IDS,
  NABUFLOW_PLANS,
  getNabuflowPlan,
  nabuflowBulkPurchaseCents,
  nabuflowBulkTierFor,
  nabuflowEffectiveSpendCapCents,
  nabuflowOrgDrawRateUsdPerCredit,
  type NabuflowPlanConfig,
} from "../lib/nabuflow-plans";
import {
  creditsEnforcementEnabled,
  ensureCurrentNabuflowCycle,
  getNabuflowSpendCapCents,
  getNabuflowSubscription,
  handleNabuflowSubscriptionEvent,
  isChargeableNabuflowStatus,
  isNabuflowBillingExempt,
  resolveNabuflowBuildGate,
} from "../lib/nabuflow-billing";
import {
  NabuflowOrgError,
  addNabuflowOrgSeat,
  buildNabuflowOrgGateInfo,
  creditNabuflowOrgPurchase,
  getNabuflowOrgSeatContext,
  listNabuflowOrgSeats,
  nabuflowOrgEffectiveCapCents,
  registerNabuflowOrg,
  removeNabuflowOrgSeat,
} from "../lib/nabuflow-org";
import {
  createNabuflowOrgBulkInvoice,
  createNabuflowOrgSetupIntent,
  getNabuflowOrgCardSummary,
} from "../lib/nabuflow-org-stripe";
import {
  NabuflowStripeError,
  cancelNabuflowStripeSubscription,
  createNabuflowSetupIntent,
  createNabuflowStripeSubscription,
  previewNabuflowPlanSwitch,
  requireStripe,
  resumeNabuflowStripeSubscription,
  snapshotCustomerCard,
  switchNabuflowStripePlan,
} from "../lib/nabuflow-stripe";
import { isSuperuser } from "../lib/superusers";
import { ensureStripeCustomer } from "./billing";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireUserId(
  req: { userId?: string },
  res: { status: (n: number) => { json: (b: unknown) => void } },
): string | null {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  return userId;
}

function stripeErrStatus(code: NabuflowStripeError["code"]): number {
  switch (code) {
    case "stripe_unavailable":
      return 503;
    case "plan_unavailable":
      return 400;
    case "no_payment_method":
    case "payment_failed":
      return 402;
    case "no_subscription":
      return 404;
    case "already_subscribed":
      return 409;
    default:
      return 500;
  }
}

function handleNabuflowError(
  res: {
    status: (n: number) => { json: (b: unknown) => void };
  },
  err: unknown,
  fallback: string,
): void {
  if (err instanceof NabuflowStripeError) {
    res.status(stripeErrStatus(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ err: msg }, fallback);
  res.status(500).json({ error: fallback });
}

function publicPlanShape(plan: NabuflowPlanConfig) {
  return {
    id: plan.id,
    name: plan.name,
    available: plan.available,
    priceUsd: plan.priceUsd,
    includedMonthlyCredits: plan.includedMonthlyCredits,
    overageUsdPerCredit: plan.overageUsdPerCredit,
    rolloverCycles: plan.rolloverCycles,
    rolloverMaxCredits: plan.rolloverMaxCredits,
    parallelBuildLimit: plan.parallelBuildLimit,
    queuePriority: plan.queuePriority,
    defaultSpendCapUsdCents: Math.round(plan.defaultSpendCapUsd * 100),
    maxSpendCapUsdCents: Math.round(plan.maxSpendCapUsd * 100),
    ladder: {
      proBuildsPerCycle: plan.ladder.proBuildsPerCycle,
      deepBuildsPerCycle: plan.ladder.deepBuildsPerCycle,
      proDeepCombo: plan.ladder.proDeepCombo,
    },
  };
}

// ── GET /billing/nabuflow/plans ───────────────────────────────────────────────
router.get("/billing/nabuflow/plans", async (_req, res): Promise<void> => {
  res.json({
    plans: NABUFLOW_PLAN_IDS.map((id) => publicPlanShape(NABUFLOW_PLANS[id])),
  });
});

// ── GET /billing/nabuflow/credit-costs ─────────────────────────────────────────
// PUBLIC — no auth required; returns the current builder credit cost table so
// the frontend can display mode costs without hard-coding them.
router.get("/billing/nabuflow/credit-costs", async (_req, res): Promise<void> => {
  const { creditCostFor, DEEP_REASONING_CREDIT_COST } = await import("../lib/ai-providers");
  res.json({
    standard: {
      lite: creditCostFor("lite"),
      eco: creditCostFor("eco"),
      power: creditCostFor("power"),
      pro: creditCostFor("pro"),
    },
    deep: {
      eco: DEEP_REASONING_CREDIT_COST.eco ?? creditCostFor("eco"),
      power: DEEP_REASONING_CREDIT_COST.power ?? creditCostFor("power"),
      pro: DEEP_REASONING_CREDIT_COST.pro ?? creditCostFor("pro"),
    },
  });
});

// ── GET /billing/nabuflow/state ───────────────────────────────────────────────
// Single read model for the UI: plan, card, cap, counters + reset date — an
// exact mirror of what the build gate will decide.
//
// SOURCE OF TRUTH AUDIT (NabuFlow R2 Phase D): All displayed counters derive
// from the charge ledger. `usedIncludedCredits`, `overageCredits`, and
// `overageUsdCents` come from `nabuflow_billing_cycles` which is updated
// atomically by the charge pipeline (chargeNabuflowCredits). Neither
// agent_tasks.token_count nor any report-claimed amount is surfaced here.
router.get("/billing/nabuflow/state", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const [sub, exempt, orgCtx] = await Promise.all([
      getNabuflowSubscription(userId),
      isNabuflowBillingExempt(userId),
      getNabuflowOrgSeatContext(userId),
    ]);

    // Enterprise seats: the org pool replaces the personal plan entirely.
    // Plan shape is Constellation (unlimited ladder — the composer shows no
    // counters), subscription/card/cycle are null, and the `org` block carries
    // pool + cap state. The gate below routes through the org lane itself.
    if (orgCtx) {
      const [org, gate] = await Promise.all([
        buildNabuflowOrgGateInfo(orgCtx),
        resolveNabuflowBuildGate(userId, {}),
      ]);
      res.json({
        enforcementEnabled: creditsEnforcementEnabled(),
        exempt,
        canBuild: gate.allowed,
        blockedReason: gate.allowed ? null : gate.error,
        plan: publicPlanShape(NABUFLOW_PLANS.constellation),
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
        org: {
          orgId: org.orgId,
          companyName: org.companyName,
          role: org.role,
          status: org.status,
          poolCredits: org.poolCredits,
          capUsdCents: org.capUsdCents,
          monthDrawnUsdCents: org.monthDrawnUsdCents,
          seatCapUsdCents: org.seatCapUsdCents,
          seatMonthDrawnUsdCents: org.seatMonthDrawnUsdCents,
          monthResetsAt: org.monthResetsAt.toISOString(),
        },
      });
      return;
    }

    const plan = getNabuflowPlan(sub?.planId);

    let cycle = null;
    let capCents = 0;
    if (sub && plan && isChargeableNabuflowStatus(sub.status)) {
      try {
        cycle = await ensureCurrentNabuflowCycle(sub, plan);
      } catch (err) {
        logger.warn({ err, userId }, "nabuflow state: cycle materialization failed");
      }
      capCents = await getNabuflowSpendCapCents(userId, plan);
    }

    const gate = await resolveNabuflowBuildGate(userId, {});
    const remainingIncluded = cycle
      ? Math.max(cycle.includedCredits - cycle.usedIncludedCredits, 0)
      : 0;

    res.json({
      enforcementEnabled: creditsEnforcementEnabled(),
      exempt,
      canBuild: gate.allowed,
      blockedReason: gate.allowed ? null : gate.error,
      plan: plan ? publicPlanShape(plan) : null,
      subscription: sub
        ? {
            status: sub.status,
            cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
            currentCycleStart: sub.currentCycleStart?.toISOString() ?? null,
            currentCycleEnd: sub.currentCycleEnd?.toISOString() ?? null,
            dunningStatus: sub.dunningStatus,
            dunningGraceUntil: sub.dunningGraceUntil?.toISOString() ?? null,
          }
        : null,
      card: sub?.defaultPaymentMethodId
        ? {
            brand: sub.cardBrand,
            last4: sub.cardLast4,
            expMonth: sub.cardExpMonth,
            expYear: sub.cardExpYear,
          }
        : null,
      spendCap: plan
        ? {
            usdCents: capCents,
            defaultUsdCents: Math.round(plan.defaultSpendCapUsd * 100),
            maxUsdCents: Math.round(plan.maxSpendCapUsd * 100),
          }
        : null,
      cycle: cycle
        ? {
            includedCredits: cycle.includedCredits,
            rolloverCredits: cycle.rolloverCredits,
            usedIncludedCredits: cycle.usedIncludedCredits,
            remainingIncludedCredits: remainingIncluded,
            overageCredits: cycle.overageCredits,
            overageUsdCents: cycle.overageUsdCents,
            proBuildsUsed: cycle.proBuildsUsed,
            deepBuildsUsed: cycle.deepBuildsUsed,
            remainingProBuilds:
              plan!.ladder.proBuildsPerCycle === null
                ? null
                : Math.max(plan!.ladder.proBuildsPerCycle - cycle.proBuildsUsed, 0),
            remainingDeepBuilds:
              plan!.ladder.deepBuildsPerCycle === null
                ? null
                : Math.max(plan!.ladder.deepBuildsPerCycle - cycle.deepBuildsUsed, 0),
            resetsAt: sub?.currentCycleEnd?.toISOString() ?? null,
          }
        : null,
    });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to load NabuFlow billing state");
  }
});

// ── GET /billing/nabuflow/usage ───────────────────────────────────────────────
// SOURCE OF TRUTH AUDIT (NabuFlow R2 Phase D): All displayed usage figures are
// sourced from `nabuflow_usage_events` (the charge ledger). No path reads from
// agent_tasks.token_count, agent_tasks.report, or any report-claimed amount.
// The `credits`, `overage_usd_cents`, and `usd_value_cents` columns originate
// from the charge pipeline (reserveNabuflowCredits → chargeNabuflowCredits).
router.get("/billing/nabuflow/usage", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 200);
  const rows = await db
    .select()
    .from(nabuflowUsageEventsTable)
    .where(eq(nabuflowUsageEventsTable.userId, userId))
    .orderBy(desc(nabuflowUsageEventsTable.createdAt))
    .limit(limit);

  res.json({
    events: rows.map((r) => ({
      id: r.id,
      cycleId: r.cycleId,
      orgId: r.orgId ?? null,
      projectId: r.projectId,
      taskId: r.taskId,
      source: r.source,
      engineMode: r.engineMode,
      deepReasoning: r.deepReasoning,
      credits: r.credits,
      includedCredits: r.includedCredits,
      overageCredits: r.overageCredits,
      overageUsdCents: r.overageUsdCents,
      usdValueCents: r.usdValueCents,
      attribution: r.attribution,
      description: r.description,
      reversedAt: r.reversedAt?.toISOString() ?? null,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  });
});

// ── GET /billing/nabuflow/notifications ──────────────────────────────────────
router.get("/billing/nabuflow/notifications", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const rows = await db
    .select()
    .from(notificationsTable)
    .where(
      and(
        eq(notificationsTable.recipientId, userId),
        eq(notificationsTable.resourceType, "nabuflow_billing"),
      ),
    )
    .orderBy(desc(notificationsTable.createdAt))
    .limit(50);

  res.json({
    notifications: rows.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      metadata: n.metadata ?? null,
      createdAt: n.createdAt?.toISOString() ?? null,
    })),
  });
});

// ── POST /billing/nabuflow/setup-intent ──────────────────────────────────────
// SetupIntent-based card capture (off-session). Card state is confirmed by the
// setup_intent.succeeded / payment_method.attached webhooks, never the client.
router.post("/billing/nabuflow/setup-intent", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const stripe = await requireStripe();
    const customerId = await ensureStripeCustomer(userId, stripe);
    const intent = await createNabuflowSetupIntent(customerId, userId);
    res.json({ clientSecret: intent.clientSecret, setupIntentId: intent.setupIntentId });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to create SetupIntent");
  }
});

const SubscribeBody = z.object({
  planId: z.enum(NABUFLOW_PLAN_IDS),
});

// ── POST /billing/nabuflow/subscribe ─────────────────────────────────────────
router.post("/billing/nabuflow/subscribe", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = SubscribeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const plan = NABUFLOW_PLANS[parsed.data.planId];
  if (!plan.available || plan.priceUsd === null) {
    res.status(400).json({
      error: `The ${plan.name} plan isn't available for self-serve signup yet. Contact us for enterprise plans.`,
      code: "plan_unavailable",
    });
    return;
  }

  try {
    const existing = await getNabuflowSubscription(userId);
    if (existing && isChargeableNabuflowStatus(existing.status)) {
      res.status(409).json({
        error: "You already have an active NabuFlow plan — use plan switch instead.",
        code: "already_subscribed",
      });
      return;
    }

    const stripe = await requireStripe();
    const customerId = await ensureStripeCustomer(userId, stripe);
    const stripeSub = await createNabuflowStripeSubscription({ customerId, userId, plan });

    // Sync local state through the same idempotent path the webhook uses, so
    // the row is correct immediately; the webhook re-run is a no-op overwrite.
    await handleNabuflowSubscriptionEvent("customer.subscription.created", stripeSub as never);

    // Seed the card snapshot inline (webhooks will confirm/refresh it).
    try {
      const card = await snapshotCustomerCard(customerId);
      if (card) {
        const { nabuflowSubscriptionsTable } = await import("@workspace/db");
        await db
          .update(nabuflowSubscriptionsTable)
          .set({ ...card, updatedAt: sql`now()` })
          .where(eq(nabuflowSubscriptionsTable.userId, userId));
      }
    } catch (err) {
      logger.warn({ err, userId }, "nabuflow subscribe: card snapshot failed (webhook will fix)");
    }

    const sub = await getNabuflowSubscription(userId);
    res.json({
      ok: true,
      planId: plan.id,
      status: sub?.status ?? "active",
      currentCycleEnd: sub?.currentCycleEnd?.toISOString() ?? null,
    });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to subscribe to NabuFlow plan");
  }
});

const SwitchBody = z.object({
  planId: z.enum(NABUFLOW_PLAN_IDS),
  confirm: z.boolean().optional().default(false),
});

// ── POST /billing/nabuflow/switch ────────────────────────────────────────────
// confirm=false → proration preview only. confirm=true → execute the switch.
router.post("/billing/nabuflow/switch", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = SwitchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const targetPlan = NABUFLOW_PLANS[parsed.data.planId];
  if (!targetPlan.available || targetPlan.priceUsd === null) {
    res.status(400).json({
      error: `The ${targetPlan.name} plan isn't available for self-serve signup yet.`,
      code: "plan_unavailable",
    });
    return;
  }

  try {
    const sub = await getNabuflowSubscription(userId);
    if (!sub || !isChargeableNabuflowStatus(sub.status)) {
      res.status(404).json({
        error: "No active NabuFlow plan to switch — subscribe first.",
        code: "no_subscription",
      });
      return;
    }
    if (sub.planId === targetPlan.id) {
      res.status(400).json({ error: `You're already on ${targetPlan.name}.` });
      return;
    }

    if (!parsed.data.confirm) {
      const preview = await previewNabuflowPlanSwitch(sub, targetPlan);
      res.json({ preview });
      return;
    }

    const currentPlan = getNabuflowPlan(sub.planId);
    // Pin the pre-switch cycle row so the upgrade bump below can never
    // double-grant against a cycle materialized with the new allotment.
    let preCycleId: number | null = null;
    if (currentPlan) {
      try {
        preCycleId = (await ensureCurrentNabuflowCycle(sub, currentPlan)).id;
      } catch {
        preCycleId = null;
      }
    }

    const updated = await switchNabuflowStripePlan(sub, targetPlan);
    await handleNabuflowSubscriptionEvent("customer.subscription.updated", updated as never);

    // Upgrade policy: raise the CURRENT cycle's included bucket by the
    // allotment difference immediately. Downgrades wait for renewal.
    const allotmentDiff =
      targetPlan.includedMonthlyCredits - (currentPlan?.includedMonthlyCredits ?? 0);
    if (allotmentDiff > 0 && preCycleId !== null) {
      await db
        .update(nabuflowBillingCyclesTable)
        .set({
          includedCredits: sql`${nabuflowBillingCyclesTable.includedCredits} + ${allotmentDiff}`,
          updatedAt: sql`now()`,
        })
        .where(eq(nabuflowBillingCyclesTable.id, preCycleId));
    }

    const fresh = await getNabuflowSubscription(userId);
    res.json({
      ok: true,
      planId: fresh?.planId ?? targetPlan.id,
      status: fresh?.status ?? "active",
      upgradedCreditsGranted: allotmentDiff > 0 ? allotmentDiff : 0,
    });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to switch NabuFlow plan");
  }
});

// ── POST /billing/nabuflow/cancel ────────────────────────────────────────────
router.post("/billing/nabuflow/cancel", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const sub = await getNabuflowSubscription(userId);
    if (!sub || !sub.stripeSubscriptionId) {
      res.status(404).json({ error: "No NabuFlow plan to cancel.", code: "no_subscription" });
      return;
    }
    await cancelNabuflowStripeSubscription(sub);
    res.json({
      ok: true,
      cancelsAt: sub.currentCycleEnd?.toISOString() ?? null,
      message: "Your plan stays active until the end of the current cycle.",
    });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to cancel NabuFlow plan");
  }
});

// ── POST /billing/nabuflow/resume ────────────────────────────────────────────
// Un-cancel a subscription that was set to cancel at period end.
router.post("/billing/nabuflow/resume", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const sub = await getNabuflowSubscription(userId);
    if (!sub || !sub.stripeSubscriptionId) {
      res.status(404).json({ error: "No NabuFlow plan to resume.", code: "no_subscription" });
      return;
    }
    if (!sub.cancelAtPeriodEnd) {
      res.status(400).json({ error: "Your plan isn't scheduled for cancellation." });
      return;
    }
    await resumeNabuflowStripeSubscription(sub);
    res.json({ ok: true });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to resume NabuFlow plan");
  }
});

const SpendCapBody = z.object({
  /** null → revert to the plan default. Cents, clamped to [minimum, tier max]. */
  spendCapUsdCents: z.number().int().min(0).nullable(),
});

// ── POST /billing/nabuflow/spend-cap ─────────────────────────────────────────
router.post("/billing/nabuflow/spend-cap", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = SpendCapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const sub = await getNabuflowSubscription(userId);
    const plan = getNabuflowPlan(sub?.planId);
    if (!sub || !plan) {
      res.status(404).json({
        error: "Spend caps apply to active NabuFlow plans — subscribe first.",
        code: "no_subscription",
      });
      return;
    }

    const requested = parsed.data.spendCapUsdCents;
    const maxCapCents = Math.round(plan.maxSpendCapUsd * 100);
    if (requested !== null && requested > maxCapCents) {
      res.status(400).json({
        error: `The ${plan.name} plan allows a spend cap of at most $${plan.maxSpendCapUsd.toFixed(2)}.`,
        maxSpendCapUsdCents: maxCapCents,
      });
      return;
    }

    await db
      .insert(nabuflowBillingSettingsTable)
      .values({ userId, spendCapUsdCents: requested })
      .onConflictDoUpdate({
        target: nabuflowBillingSettingsTable.userId,
        set: { spendCapUsdCents: requested, updatedAt: sql`now()` },
      });

    const effective = nabuflowEffectiveSpendCapCents(plan, requested);
    res.json({ ok: true, spendCapUsdCents: requested, effectiveSpendCapUsdCents: effective });
  } catch (err) {
    handleNabuflowError(res, err, "Failed to update spend cap");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Constellation enterprise organizations (Task #1518)
//
// Gated setup — a company registers, gets its own company-flagged Stripe
// Customer, funds a shared credit pool via volume-discounted bulk purchases,
// and its seats draw builds from that pool through the same charge pipeline.
// No self-serve subscription checkout on this lane.
// ═════════════════════════════════════════════════════════════════════════════

function orgErrStatus(code: NabuflowOrgError["code"]): number {
  switch (code) {
    case "already_in_org":
    case "seat_exists":
      return 409;
    case "not_in_org":
    case "seat_not_found":
    case "user_not_found":
      return 404;
    case "not_billing_admin":
      return 403;
    case "last_billing_admin":
      return 400;
    default:
      return 500;
  }
}

function handleOrgError(
  res: { status: (n: number) => { json: (b: unknown) => void } },
  err: unknown,
  fallback: string,
): void {
  if (err instanceof NabuflowOrgError) {
    res.status(orgErrStatus(err.code)).json({ error: err.message, code: err.code });
    return;
  }
  handleNabuflowError(res, err, fallback);
}

/** Resolve the caller's org seat; 404 when they have none. */
async function requireOrgSeat(
  userId: string,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): Promise<{ org: NabuflowOrg; seat: NabuflowOrgSeat } | null> {
  const ctx = await getNabuflowOrgSeatContext(userId);
  if (!ctx) {
    res.status(404).json({
      error: "You're not part of a NabuFlow organization yet.",
      code: "not_in_org",
    });
    return null;
  }
  return ctx;
}

/** Resolve the caller's org seat and require the billing_admin role. */
async function requireOrgAdmin(
  userId: string,
  res: { status: (n: number) => { json: (b: unknown) => void } },
): Promise<{ org: NabuflowOrg; seat: NabuflowOrgSeat } | null> {
  const ctx = await requireOrgSeat(userId, res);
  if (!ctx) return null;
  if (ctx.seat.role !== "billing_admin") {
    res.status(403).json({
      error: "Only your organization's billing admin can do that.",
      code: "not_billing_admin",
    });
    return null;
  }
  return ctx;
}

function publicOrgShape(org: NabuflowOrg) {
  return {
    id: org.id,
    companyName: org.companyName,
    billingContactName: org.billingContactName,
    billingContactEmail: org.billingContactEmail,
    taxId: org.taxId,
    addressLine1: org.addressLine1,
    addressLine2: org.addressLine2,
    city: org.city,
    region: org.region,
    postalCode: org.postalCode,
    country: org.country,
    poReference: org.poReference,
    invoiceTermsEnabled: org.invoiceTermsEnabled,
    termsNetDays: org.termsNetDays,
    status: org.status,
    poolCredits: org.poolCredits,
    monthlySpendCapUsdCents: org.monthlySpendCapUsdCents,
    effectiveSpendCapUsdCents: nabuflowOrgEffectiveCapCents(org),
    createdAt: org.createdAt?.toISOString() ?? null,
  };
}

const OrgRegisterBody = z.object({
  companyName: z.string().trim().min(2).max(200),
  billingContactName: z.string().trim().max(200).optional(),
  billingContactEmail: z.string().trim().email().max(320),
  taxId: z.string().trim().max(60).optional(),
  addressLine1: z.string().trim().min(1).max(300),
  addressLine2: z.string().trim().max(300).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1).max(20),
  country: z
    .string()
    .trim()
    .length(2)
    .transform((s) => s.toUpperCase()),
  poReference: z.string().trim().max(140).optional(),
});

// ── POST /billing/nabuflow/org ───────────────────────────────────────────────
// Register the company (gated setup from the Constellation card — creates the
// company-flagged Stripe Customer + org record, requester = billing admin).
router.post("/billing/nabuflow/org", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = OrgRegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const { org, seat } = await registerNabuflowOrg(userId, {
      ...parsed.data,
      billingContactName: parsed.data.billingContactName ?? null,
      taxId: parsed.data.taxId ?? null,
      addressLine2: parsed.data.addressLine2 ?? null,
      region: parsed.data.region ?? null,
      poReference: parsed.data.poReference ?? null,
    });
    res.status(201).json({ ok: true, org: publicOrgShape(org), role: seat.role });
  } catch (err) {
    handleOrgError(res, err, "Failed to set up the enterprise organization");
  }
});

// ── GET /billing/nabuflow/org ────────────────────────────────────────────────
// Org billing state for the caller's seat. Billing admins additionally get
// seats, recent purchases, ledger tail and the company card summary.
router.get("/billing/nabuflow/org", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const ctx = await requireOrgSeat(userId, res);
    if (!ctx) return;
    const info = await buildNabuflowOrgGateInfo(ctx);
    const isAdmin = ctx.seat.role === "billing_admin";

    const base = {
      org: publicOrgShape(ctx.org),
      role: ctx.seat.role,
      month: {
        drawnUsdCents: info.monthDrawnUsdCents,
        capUsdCents: info.capUsdCents,
        seatDrawnUsdCents: info.seatMonthDrawnUsdCents,
        seatCapUsdCents: info.seatCapUsdCents,
        resetsAt: info.monthResetsAt.toISOString(),
      },
    };

    if (!isAdmin) {
      res.json(base);
      return;
    }

    const [seats, purchases, ledger, card] = await Promise.all([
      listNabuflowOrgSeats(ctx.org.id),
      db
        .select()
        .from(nabuflowOrgPurchasesTable)
        .where(eq(nabuflowOrgPurchasesTable.orgId, ctx.org.id))
        .orderBy(desc(nabuflowOrgPurchasesTable.createdAt))
        .limit(50),
      db
        .select()
        .from(nabuflowOrgLedgerTable)
        .where(eq(nabuflowOrgLedgerTable.orgId, ctx.org.id))
        .orderBy(desc(nabuflowOrgLedgerTable.createdAt))
        .limit(100),
      ctx.org.stripeCustomerId
        ? getNabuflowOrgCardSummary(ctx.org.stripeCustomerId).catch(() => null)
        : Promise.resolve(null),
    ]);

    res.json({
      ...base,
      card,
      seats: seats.map((s) => ({
        userId: s.userId,
        role: s.role,
        email: s.email,
        seatSpendCapUsdCents: s.seatSpendCapUsdCents,
        createdAt: s.createdAt?.toISOString() ?? null,
      })),
      purchases: purchases.map((p) => ({
        id: p.id,
        credits: p.credits,
        amountUsdCents: p.amountUsdCents,
        method: p.method,
        status: p.status,
        poReference: p.poReference,
        hostedInvoiceUrl: p.hostedInvoiceUrl,
        invoicePdfUrl: p.invoicePdfUrl,
        dueAt: p.dueAt?.toISOString() ?? null,
        paidAt: p.paidAt?.toISOString() ?? null,
        createdAt: p.createdAt?.toISOString() ?? null,
      })),
      ledger: ledger.map((l) => ({
        id: l.id,
        entryType: l.entryType,
        credits: l.credits,
        balanceAfter: l.balanceAfter,
        usdCents: l.usdCents,
        userId: l.userId,
        description: l.description,
        createdAt: l.createdAt?.toISOString() ?? null,
      })),
    });
  } catch (err) {
    handleOrgError(res, err, "Failed to load organization billing");
  }
});

const OrgPatchBody = z.object({
  poReference: z.string().trim().max(140).nullable().optional(),
  billingContactName: z.string().trim().max(200).nullable().optional(),
  billingContactEmail: z.string().trim().email().max(320).optional(),
  termsNetDays: z.number().int().min(1).max(90).optional(),
  /** Platform-gated: only the platform owner can enable invoice terms. */
  invoiceTermsEnabled: z.boolean().optional(),
});

// ── PATCH /billing/nabuflow/org ──────────────────────────────────────────────
router.patch("/billing/nabuflow/org", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = OrgPatchBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;

    const patch: Record<string, unknown> = {};
    if (parsed.data.poReference !== undefined) patch.poReference = parsed.data.poReference;
    if (parsed.data.billingContactName !== undefined)
      patch.billingContactName = parsed.data.billingContactName;
    if (parsed.data.billingContactEmail !== undefined)
      patch.billingContactEmail = parsed.data.billingContactEmail;
    if (parsed.data.termsNetDays !== undefined) patch.termsNetDays = parsed.data.termsNetDays;

    if (parsed.data.invoiceTermsEnabled !== undefined) {
      // "Invoice with terms WHERE ENABLED": terms are a platform-granted
      // capability (credit exposure), not self-serve — owner flips it.
      if (!(await isSuperuser(userId))) {
        res.status(403).json({
          error:
            "Invoice terms are enabled by the NabuFlow team — get in touch and we'll set it up.",
          code: "terms_platform_gated",
        });
        return;
      }
      patch.invoiceTermsEnabled = parsed.data.invoiceTermsEnabled;
    }

    if (Object.keys(patch).length === 0) {
      res.json({ ok: true, org: publicOrgShape(ctx.org) });
      return;
    }

    const [updated] = await db
      .update(nabuflowOrgsTable)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgsTable.id, ctx.org.id))
      .returning();
    res.json({ ok: true, org: publicOrgShape(updated) });
  } catch (err) {
    handleOrgError(res, err, "Failed to update organization");
  }
});

// ── GET /billing/nabuflow/org/pricing ────────────────────────────────────────
// Volume tiers for the bulk-purchase dialog (auth required; org not required
// so the setup flow can show pricing before registration).
router.get("/billing/nabuflow/org/pricing", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  res.json({
    minPurchaseCredits: NABUFLOW_ORG_MIN_PURCHASE_CREDITS,
    selfServeRateUsdPerCredit: nabuflowOrgDrawRateUsdPerCredit(),
    tiers: NABUFLOW_ORG_BULK_TIERS.map((t) => ({
      minCredits: t.minCredits,
      usdPerCredit: t.usdPerCredit,
      label: t.label,
    })),
  });
});

// ── POST /billing/nabuflow/org/setup-intent ──────────────────────────────────
// Card capture for the COMPANY customer (billing admin only).
router.post("/billing/nabuflow/org/setup-intent", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;
    if (!ctx.org.stripeCustomerId) {
      res.status(409).json({ error: "This organization has no Stripe customer yet." });
      return;
    }
    const intent = await createNabuflowOrgSetupIntent(ctx.org.stripeCustomerId, ctx.org.id, userId);
    res.json({ clientSecret: intent.clientSecret, setupIntentId: intent.setupIntentId });
  } catch (err) {
    handleOrgError(res, err, "Failed to create organization SetupIntent");
  }
});

const OrgPurchaseBody = z.object({
  credits: z.number().int().positive(),
  method: z.enum(["card", "invoice"]),
  poReference: z.string().trim().max(140).optional(),
});

// ── POST /billing/nabuflow/org/purchase ──────────────────────────────────────
// Bulk credit-pool purchase at volume-discounted rates. Card → charged now,
// pool funded immediately. Invoice → sent with net-N terms; pool funded when
// `invoice.paid` arrives. Either way the invoice line item is human-readable
// and carries the PO reference + tax id as printed custom fields.
router.post("/billing/nabuflow/org/purchase", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = OrgPurchaseBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;
    const { credits, method } = parsed.data;

    const tier = nabuflowBulkTierFor(credits);
    const amountUsdCents = nabuflowBulkPurchaseCents(credits);
    if (!tier || amountUsdCents === null) {
      res.status(400).json({
        error: `Bulk purchases start at ${NABUFLOW_ORG_MIN_PURCHASE_CREDITS.toLocaleString("en-US")} credits.`,
        code: "below_minimum",
        minPurchaseCredits: NABUFLOW_ORG_MIN_PURCHASE_CREDITS,
      });
      return;
    }

    if (method === "invoice" && !ctx.org.invoiceTermsEnabled) {
      res.status(402).json({
        error:
          "Invoice terms aren't enabled for your organization yet — pay by card, or contact us to set up net terms.",
        code: "terms_not_enabled",
      });
      return;
    }

    const poReference = parsed.data.poReference ?? ctx.org.poReference ?? null;

    // 1. Local purchase record first (pending) — the Stripe invoice references
    //    it by id, and the webhook path funds the pool through its
    //    credited_at idempotency latch.
    const [purchase] = await db
      .insert(nabuflowOrgPurchasesTable)
      .values({
        orgId: ctx.org.id,
        credits,
        amountUsdCents,
        method,
        status: "pending",
        poReference,
        requestedByUserId: userId,
      })
      .returning();

    let invoiceResult;
    try {
      invoiceResult = await createNabuflowOrgBulkInvoice({
        org: ctx.org,
        credits,
        amountUsdCents,
        tier,
        method,
        poReference,
        requestedByUserId: userId,
        purchaseId: purchase.id,
      });
    } catch (err) {
      await db
        .update(nabuflowOrgPurchasesTable)
        .set({ status: "failed", updatedAt: sql`now()` })
        .where(eq(nabuflowOrgPurchasesTable.id, purchase.id));
      throw err;
    }

    await db
      .update(nabuflowOrgPurchasesTable)
      .set({
        stripeInvoiceId: invoiceResult.stripeInvoiceId,
        hostedInvoiceUrl: invoiceResult.hostedInvoiceUrl,
        invoicePdfUrl: invoiceResult.invoicePdfUrl,
        dueAt: invoiceResult.dueAt,
        updatedAt: sql`now()`,
      })
      .where(eq(nabuflowOrgPurchasesTable.id, purchase.id));

    // Card path: fund the pool right now (webhook re-delivery is a no-op).
    if (invoiceResult.paid) {
      await creditNabuflowOrgPurchase(purchase.id, { paidAt: new Date() });
    }

    const [freshOrg] = await db
      .select()
      .from(nabuflowOrgsTable)
      .where(eq(nabuflowOrgsTable.id, ctx.org.id))
      .limit(1);

    res.status(201).json({
      ok: true,
      purchase: {
        id: purchase.id,
        credits,
        amountUsdCents,
        method,
        status: invoiceResult.paid ? "paid" : "pending",
        tierLabel: tier.label,
        usdPerCredit: tier.usdPerCredit,
        hostedInvoiceUrl: invoiceResult.hostedInvoiceUrl,
        invoicePdfUrl: invoiceResult.invoicePdfUrl,
        dueAt: invoiceResult.dueAt?.toISOString() ?? null,
      },
      poolCredits: freshOrg?.poolCredits ?? ctx.org.poolCredits,
    });
  } catch (err) {
    handleOrgError(res, err, "Failed to purchase bulk credits");
  }
});

const OrgSeatBody = z.object({
  email: z.string().trim().email().max(320),
  seatSpendCapUsdCents: z.number().int().min(0).nullable().optional(),
});

// ── POST /billing/nabuflow/org/seats ─────────────────────────────────────────
router.post("/billing/nabuflow/org/seats", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = OrgSeatBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;
    const seat = await addNabuflowOrgSeat(ctx.org, {
      email: parsed.data.email,
      addedByUserId: userId,
      seatSpendCapUsdCents: parsed.data.seatSpendCapUsdCents ?? null,
    });
    res.status(201).json({
      ok: true,
      seat: {
        userId: seat.userId,
        role: seat.role,
        email: seat.email,
        seatSpendCapUsdCents: seat.seatSpendCapUsdCents,
      },
    });
  } catch (err) {
    handleOrgError(res, err, "Failed to add seat");
  }
});

// ── DELETE /billing/nabuflow/org/seats/:seatUserId ───────────────────────────
router.delete("/billing/nabuflow/org/seats/:seatUserId", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;
    await removeNabuflowOrgSeat(ctx.org, req.params.seatUserId);
    res.json({ ok: true });
  } catch (err) {
    handleOrgError(res, err, "Failed to remove seat");
  }
});

const SeatCapBody = z.object({
  /** null → no per-seat sub-cap. Cents; effective value is clamped to the org cap. */
  seatSpendCapUsdCents: z.number().int().min(0).nullable(),
});

// ── POST /billing/nabuflow/org/seats/:seatUserId/cap ─────────────────────────
router.post("/billing/nabuflow/org/seats/:seatUserId/cap", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = SeatCapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;
    const seats = await listNabuflowOrgSeats(ctx.org.id);
    const target = seats.find((s) => s.userId === req.params.seatUserId);
    if (!target) {
      res.status(404).json({ error: "That account has no seat here.", code: "seat_not_found" });
      return;
    }
    const { nabuflowOrgSeatsTable } = await import("@workspace/db");
    const [updated] = await db
      .update(nabuflowOrgSeatsTable)
      .set({ seatSpendCapUsdCents: parsed.data.seatSpendCapUsdCents, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgSeatsTable.id, target.id))
      .returning();
    res.json({
      ok: true,
      seat: {
        userId: updated.userId,
        role: updated.role,
        email: updated.email,
        seatSpendCapUsdCents: updated.seatSpendCapUsdCents,
      },
    });
  } catch (err) {
    handleOrgError(res, err, "Failed to update seat cap");
  }
});

const OrgSpendCapBody = z.object({
  /** null → Constellation plan default. Cents, capped at the plan max. */
  spendCapUsdCents: z.number().int().min(0).nullable(),
});

// ── POST /billing/nabuflow/org/spend-cap ─────────────────────────────────────
router.post("/billing/nabuflow/org/spend-cap", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  const parsed = OrgSpendCapBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const ctx = await requireOrgAdmin(userId, res);
    if (!ctx) return;

    const plan = NABUFLOW_PLANS.constellation;
    const requested = parsed.data.spendCapUsdCents;
    const maxCapCents = Math.round(plan.maxSpendCapUsd * 100);
    if (requested !== null && requested > maxCapCents) {
      res.status(400).json({
        error: `The organization spend cap can be at most $${plan.maxSpendCapUsd.toFixed(2)} per month.`,
        maxSpendCapUsdCents: maxCapCents,
      });
      return;
    }

    const [updated] = await db
      .update(nabuflowOrgsTable)
      .set({ monthlySpendCapUsdCents: requested, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgsTable.id, ctx.org.id))
      .returning();
    res.json({
      ok: true,
      spendCapUsdCents: requested,
      effectiveSpendCapUsdCents: nabuflowOrgEffectiveCapCents(updated),
    });
  } catch (err) {
    handleOrgError(res, err, "Failed to update organization spend cap");
  }
});

export default router;
