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
  nabuflowUsageEventsTable,
  notificationsTable,
} from "@workspace/db";
import {
  NABUFLOW_PLAN_IDS,
  NABUFLOW_PLANS,
  getNabuflowPlan,
  nabuflowEffectiveSpendCapCents,
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
import { ensureStripeCustomer } from "./billing";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function requireUserId(req: { userId?: string }, res: { status: (n: number) => { json: (b: unknown) => void } }): string | null {
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

function handleNabuflowError(res: {
  status: (n: number) => { json: (b: unknown) => void };
}, err: unknown, fallback: string): void {
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

// ── GET /billing/nabuflow/state ───────────────────────────────────────────────
// Single read model for the UI: plan, card, cap, counters + reset date — an
// exact mirror of what the build gate will decide.
router.get("/billing/nabuflow/state", async (req, res): Promise<void> => {
  const userId = requireUserId(req, res);
  if (!userId) return;

  try {
    const [sub, exempt] = await Promise.all([
      getNabuflowSubscription(userId),
      isNabuflowBillingExempt(userId),
    ]);
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

export default router;
