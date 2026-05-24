// ─────────────────────────────────────────────────────────────────────────────
// Billing routes — Stripe checkout, subscriptions, usage analytics, invoices
//
//   GET  /api/billing/packages          — list credit packages (auth required)
//   POST /api/billing/checkout          — create Stripe checkout session (auth required)
//   GET  /api/billing/subscription      — current subscription tier + status
//   POST /api/billing/subscribe         — start a paid subscription
//   POST /api/billing/cancel-subscription — cancel subscription
//   POST /api/billing/portal            — create Stripe Customer Portal session
//   GET  /api/billing/invoices          — list past Stripe invoices
//   GET  /api/billing/usage             — per-user usage analytics
//   POST /api/billing/webhook           — Stripe webhook (PUBLIC)
//
// billingWebhookRouter is exported separately and mounted BEFORE the auth wall.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, desc, sql, and, like, isNull, gte } from "drizzle-orm";
import {
  db,
  creditTransactionsTable,
  stripeProcessedEventsTable,
  userCreditsTable,
  workspaceSubscriptionsTable,
  workspacesTable,
  buildAnalyticsTable,
  projectsTable,
  userSubscriptionsTable,
} from "@workspace/db";
import { TIER_MONTHLY_CREDITS, TIER_PRICE_USD } from "@workspace/db";
import { getOrCreateCredits, grantCredits } from "./credits";
import {
  stripeAvailable,
  getUncachableStripeClient,
  getStripePublishableKey,
  invalidateStripeCredentialCache,
} from "../lib/stripeClient";
import {
  PLAN_TIERS,
  type PlanTier,
  planTierForStripePriceId,
  stripePriceIdForPlan,
} from "../lib/plans";
import { logger } from "../lib/logger";

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const IS_PRODUCTION = process.env.REPLIT_DEPLOYMENT === "1";

// ── Credit packages (one-time top-up) ────────────────────────────────────────
export const CREDIT_PACKAGES = [
  {
    id: "starter",
    label: "Starter Pack",
    credits: 500,
    priceUsd: 5,
    description: "500 build credits — good for everyday building",
    priceIdEnv: "STRIPE_PRICE_STARTER",
  },
  {
    id: "builder",
    label: "Builder Pack",
    credits: 2500,
    priceUsd: 20,
    description: "2,500 build credits — best value for active builders",
    priceIdEnv: "STRIPE_PRICE_BUILDER",
  },
  {
    id: "power",
    label: "Power Pack",
    credits: 10000,
    priceUsd: 65,
    description: "10,000 build credits — for power users and teams",
    priceIdEnv: "STRIPE_PRICE_POWER",
  },
] as const;

// ── Subscription tier definitions ─────────────────────────────────────────────
export const SUBSCRIPTION_TIERS_META = [
  {
    id: "free" as const,
    name: "Free",
    monthlyCredits: TIER_MONTHLY_CREDITS.free,
    priceUsd: TIER_PRICE_USD.free,
    maxConcurrentBuilds: 1,
    priceIdEnv: null,
    features: ["100 credits / month", "1 concurrent build", "Community support"],
  },
  {
    id: "pro" as const,
    name: "Pro",
    monthlyCredits: TIER_MONTHLY_CREDITS.pro,
    priceUsd: TIER_PRICE_USD.pro,
    maxConcurrentBuilds: 3,
    priceIdEnv: "STRIPE_PRICE_PRO_MONTHLY",
    features: [
      "2,000 credits / month",
      "3 concurrent builds",
      "Priority queue",
      "Email support",
      "Stripe Tax support",
    ],
  },
  {
    id: "team" as const,
    name: "Team",
    monthlyCredits: TIER_MONTHLY_CREDITS.team,
    priceUsd: TIER_PRICE_USD.team,
    maxConcurrentBuilds: 10,
    priceIdEnv: "STRIPE_PRICE_TEAM_MONTHLY",
    features: [
      "5,000 credits / month",
      "10 concurrent builds",
      "Priority queue",
      "10 team seats",
      "Dedicated support",
      "Custom domain bandwidth",
    ],
  },
] as const;

function priceIdForPack(pkg: (typeof CREDIT_PACKAGES)[number]): string | undefined {
  const id = process.env[pkg.priceIdEnv];
  return id && id.trim() ? id.trim() : undefined;
}

function priceIdForTier(tier: { priceIdEnv: string | null }): string | undefined {
  if (!tier.priceIdEnv) return undefined;
  const id = process.env[tier.priceIdEnv];
  return id && id.trim() ? id.trim() : undefined;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getOrCreateSubscription(userId: string) {
  const [existing] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.userId, userId));
  if (existing) return existing;
  const [created] = await db
    .insert(userSubscriptionsTable)
    .values({ userId, tier: "free", status: "active" })
    .returning();
  return created!;
}

async function ensureStripeCustomer(
  userId: string,
  stripe: NonNullable<Awaited<ReturnType<typeof getUncachableStripeClient>>>,
): Promise<string> {
  const sub = await getOrCreateSubscription(userId);
  if (sub.stripeCustomerId) return sub.stripeCustomerId;
  const customer = await stripe.customers.create({
    metadata: { userId },
  });
  await db
    .update(userSubscriptionsTable)
    .set({ stripeCustomerId: customer.id, updatedAt: sql`now()` })
    .where(eq(userSubscriptionsTable.userId, userId));
  return customer.id;
}

// Grant monthly credits on subscription renewal (invoice.paid).
// Idempotent — skips if already granted in the current period.
async function maybeGrantMonthlyCredits(userId: string, periodEnd: Date): Promise<void> {
  const sub = await getOrCreateSubscription(userId);
  const tier = (sub.tier ?? "free") as keyof typeof TIER_MONTHLY_CREDITS;
  const monthlyAmount = TIER_MONTHLY_CREDITS[tier] ?? TIER_MONTHLY_CREDITS.free;
  if (monthlyAmount <= 0) return;

  // Check if already granted for this period
  if (
    sub.lastMonthlyGrantAt &&
    sub.lastMonthlyGrantAt >= new Date(periodEnd.getTime() - 35 * 24 * 60 * 60 * 1000)
  ) {
    logger.info({ userId, tier }, "Monthly credit grant already issued — skipping");
    return;
  }

  await grantCredits(userId, monthlyAmount, `Monthly ${tier} grant (${monthlyAmount} credits)`);
  await db
    .update(userSubscriptionsTable)
    .set({ lastMonthlyGrantAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(userSubscriptionsTable.userId, userId));
  logger.info({ userId, tier, monthlyAmount }, "Monthly credits granted");
}

// ── Stripe webhook handler ────────────────────────────────────────────────────

// ── Subscription event handler (Task #644) ───────────────────────────────────
// Syncs Stripe subscription state into workspace_subscriptions so that
// resolveWorkspacePlan() returns the correct tier the moment Stripe confirms
// the change. Workspace association comes from subscription.metadata.workspaceId
// (set in handleStripeWebhook on checkout.session.completed) or, as a fallback,
// a customer-id lookup against an existing workspace_subscriptions row.
async function handleSubscriptionEvent(event: {
  id: string;
  type: string;
  data: {
    object: {
      id?: string;
      status?: string;
      customer?: string | null;
      metadata?: { workspaceId?: string; planTier?: string };
      current_period_end?: number;
      cancel_at_period_end?: boolean;
      items?: { data?: Array<{ price?: { id?: string } }> };
    };
  };
}): Promise<void> {
  const sub = event.data?.object;
  const subscriptionId = sub?.id;
  if (!subscriptionId) {
    logger.warn({ eventId: event.id }, "Subscription event missing subscription id — skipping");
    return;
  }

  const customerId = typeof sub.customer === "string" ? sub.customer : null;
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;

  // Resolve workspace: prefer subscription.metadata.workspaceId, fall back to
  // existing row keyed on stripeSubscriptionId, then on stripeCustomerId.
  let workspaceId: number | null = null;
  const metaWorkspaceId = sub.metadata?.workspaceId;
  if (metaWorkspaceId) {
    const parsed = parseInt(metaWorkspaceId, 10);
    if (Number.isFinite(parsed)) workspaceId = parsed;
  }

  if (workspaceId === null) {
    const [existingBySub] = await db
      .select({ workspaceId: workspaceSubscriptionsTable.workspaceId })
      .from(workspaceSubscriptionsTable)
      .where(eq(workspaceSubscriptionsTable.stripeSubscriptionId, subscriptionId))
      .limit(1);
    if (existingBySub) workspaceId = existingBySub.workspaceId;
  }

  if (workspaceId === null && customerId) {
    const [existingByCustomer] = await db
      .select({ workspaceId: workspaceSubscriptionsTable.workspaceId })
      .from(workspaceSubscriptionsTable)
      .where(eq(workspaceSubscriptionsTable.stripeCustomerId, customerId))
      .limit(1);
    if (existingByCustomer) workspaceId = existingByCustomer.workspaceId;
  }

  if (workspaceId === null) {
    logger.warn(
      { eventId: event.id, subscriptionId, customerId },
      "Subscription event has no resolvable workspaceId — skipping",
    );
    return;
  }

  // Confirm the workspace still exists (soft-delete tolerant).
  const [ws] = await db
    .select({ id: workspacesTable.id })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), isNull(workspacesTable.deletedAt)))
    .limit(1);
  if (!ws) {
    logger.warn(
      { eventId: event.id, workspaceId },
      "Subscription event for unknown/deleted workspace — skipping",
    );
    return;
  }

  // Derive plan tier: prefer price-id mapping (canonical), fall back to
  // metadata.planTier (set during checkout for new subscriptions).
  let planTier: PlanTier = "free";
  const fromPrice = planTierForStripePriceId(priceId);
  if (fromPrice) {
    planTier = fromPrice;
  } else {
    const metaTier = sub.metadata?.planTier;
    if (metaTier && (PLAN_TIERS as readonly string[]).includes(metaTier)) {
      planTier = metaTier as PlanTier;
    }
  }

  // Deleted subscriptions always revert to free regardless of price mapping.
  const status =
    event.type === "customer.subscription.deleted" ? "canceled" : (sub.status ?? "inactive");
  if (status === "canceled") planTier = "free";

  const currentPeriodEnd =
    typeof sub.current_period_end === "number" ? new Date(sub.current_period_end * 1000) : null;

  await db
    .insert(workspaceSubscriptionsTable)
    .values({
      workspaceId,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscriptionId,
      stripePriceId: priceId,
      planTier,
      status,
      currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancel_at_period_end ? "true" : "false",
    })
    .onConflictDoUpdate({
      target: workspaceSubscriptionsTable.workspaceId,
      set: {
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        stripePriceId: priceId,
        planTier,
        status,
        currentPeriodEnd,
        cancelAtPeriodEnd: sub.cancel_at_period_end ? "true" : "false",
        updatedAt: sql`now()`,
      },
    });

  logger.info(
    { eventId: event.id, workspaceId, planTier, status, subscriptionId },
    "Workspace subscription synced",
  );
}

async function handleStripeWebhook(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
): Promise<void> {
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    logger.error("Stripe client unavailable in webhook — returning 503 so Stripe retries");
    res.status(503).json({ error: "Stripe client unavailable", willRetry: true });
    return;
  }

  const sig = req.headers["stripe-signature"] as string | undefined;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

  type StripeEvent = {
    id: string;
    type: string;
    data: {
      object: {
        metadata?: Record<string, string | undefined>;
        payment_status?: string;
        payment_intent?: string | null;
        customer?: string | null;
        amount_total?: number | null;
        mode?: string;
        subscription?: string | null;
        id?: string;
        status?: string;
        current_period_end?: number;
        cancel_at_period_end?: boolean;
        items?: { data?: Array<{ price?: { id?: string } }> };
        [key: string]: unknown;
      };
    };
  };
  let event: StripeEvent | null = null;

  if (STRIPE_WEBHOOK_SECRET) {
    if (!sig || !rawBody) {
      res.status(400).json({ error: "Missing stripe-signature header or raw body" });
      return;
    }
    try {
      event = stripe.webhooks.constructEvent(
        rawBody,
        sig,
        STRIPE_WEBHOOK_SECRET,
      ) as unknown as StripeEvent;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "verify failed";
      logger.warn({ err: msg }, "Stripe webhook signature verification failed");
      res.status(400).json({ error: "Signature verification failed" });
      return;
    }
  } else {
    if (IS_PRODUCTION) {
      logger.error("STRIPE_WEBHOOK_SECRET not set — refusing unverified webhook in production");
      res.status(500).json({ error: "Webhook secret not configured" });
      return;
    }
    logger.warn("STRIPE_WEBHOOK_SECRET not set — accepting unverified webhook (DEV ONLY)");
    event = req.body as StripeEvent;
  }

  if (!event?.id || !event.type) {
    res.status(400).json({ error: "Malformed event payload" });
    return;
  }

  // ── Subscription lifecycle events ───────────────────────────────────────────
  // customer.subscription.{created,updated,deleted} — sync workspace plan tier
  // (Task #644) and user subscription state.
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    try {
      await handleSubscriptionEvent(event);
      await db
        .insert(stripeProcessedEventsTable)
        .values({ eventId: event.id, type: event.type })
        .onConflictDoNothing();
      res.json({ ok: true, type: event.type, processed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      logger.error({ err: msg, eventId: event.id, type: event.type }, "Subscription sync failed");
      res.status(500).json({ error: "Subscription sync failed", willRetry: true });
    }
    return;
  }

  // Idempotency: mark event as processed.
  const deduped = await db
    .insert(stripeProcessedEventsTable)
    .values({ eventId: event.id, type: event.type })
    .onConflictDoNothing()
    .returning({ eventId: stripeProcessedEventsTable.eventId });

  if (deduped.length === 0) {
    logger.info({ eventId: event.id, type: event.type }, "Stripe webhook duplicate — skipping");
    res.json({ ok: true, duplicate: true });
    return;
  }

  // ── checkout.session.completed — workspace metadata attachment + domain purchase + credit grant
  if (event.type === "checkout.session.completed") {
    const session = event.data?.object;

    // Workspace subscription mode: attach workspaceId metadata so the follow-up
    // customer.subscription.created event can resolve which workspace to upgrade.
    if (session?.mode === "subscription" && session?.metadata?.workspaceId) {
      const subscriptionId = session?.subscription;
      if (subscriptionId && typeof subscriptionId === "string") {
        try {
          await stripe.subscriptions.update(subscriptionId, {
            metadata: {
              workspaceId: session.metadata.workspaceId,
              planTier: session?.metadata?.planTier ?? "",
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown";
          logger.warn(
            { err: msg, subscriptionId, eventId: event.id },
            "Failed to attach workspaceId metadata to subscription — handler will fall back to customer lookup",
          );
        }
      }
    }

    const sessionType = session?.metadata?.type;

    // Domain purchase / transfer fulfillment
    if (sessionType === "domain_purchase" || sessionType === "domain_transfer") {
      const domainUserId = session?.metadata?.userId;
      const hostname = session?.metadata?.hostname;

      if (!domainUserId || !hostname) {
        logger.warn(
          { eventId: event.id, sessionType },
          "Domain webhook: missing userId or hostname in metadata",
        );
        res.status(400).json({ error: "Missing userId or hostname in session metadata" });
        return;
      }

      // Record idempotency + fulfill (non-credit path — uses its own dedup on purchased_domains)
      await db
        .insert(stripeProcessedEventsTable)
        .values({ eventId: event.id, type: event.type })
        .onConflictDoNothing();

      if (sessionType === "domain_purchase") {
        try {
          const { fulfillDomainPurchase } = await import("../lib/domain-fulfillment");
          const pricePaidUsd = session?.amount_total
            ? String(session.amount_total / 100)
            : (session?.metadata?.priceUsd ?? "12.99");
          const stripeCustomerId = typeof session?.customer === "string" ? session.customer : null;
          const projectIdStr = session?.metadata?.projectId;
          const projectId = projectIdStr ? parseInt(projectIdStr, 10) || undefined : undefined;
          const years = session?.metadata?.years ? parseInt(session.metadata.years, 10) || 1 : 1;

          const { alreadyRegistered } = await fulfillDomainPurchase({
            hostname,
            userId: domainUserId,
            years,
            pricePaidUsd,
            stripeCustomerId,
            stripePaymentIntentId: null,
            projectId,
          });

          logger.info(
            { eventId: event.id, hostname, alreadyRegistered },
            "Domain purchase webhook fulfillment complete",
          );
          res.json({ ok: true, eventId: event.id, hostname, alreadyRegistered });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Unknown";
          logger.error(
            { err: msg, eventId: event.id, hostname },
            "Domain purchase webhook fulfillment failed — Stripe will retry",
          );
          // 500 so Stripe retries. Idempotency row was already inserted, so
          // on retry we need to check if the domain was already fulfilled first.
          // The fulfillDomainPurchase idempotency check handles this correctly.
          res.status(500).json({ error: "Domain fulfillment failed", willRetry: true });
        }
      } else {
        // domain_transfer: the transfer-in/confirm endpoint handles Namecheap
        // transfer initiation.  Webhook acknowledges payment only; the client
        // confirm endpoint is responsible for the full transfer flow.
        logger.info(
          { eventId: event.id, hostname },
          "Domain transfer webhook: payment acknowledged, client confirm handles transfer initiation",
        );
        res.json({
          ok: true,
          eventId: event.id,
          hostname,
          type: "domain_transfer",
          acknowledged: true,
        });
      }
      return;
    }
  }

  // Route to the correct handler based on event type.
  try {
    switch (event.type) {
      case "checkout.session.completed":
        await handleCheckoutCompleted(stripe, event as any);
        break;
      case "invoice.paid":
        await handleInvoicePaid(event as any);
        break;
      case "invoice.payment_failed":
        await handleInvoicePaymentFailed(event as any);
        break;
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event as any);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event as any);
        break;
      default:
        logger.info({ eventId: event.id, type: event.type }, "Stripe webhook unhandled event type");
    }
    res.json({ ok: true, type: event.type });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.error(
      { err: msg, eventId: event.id, type: event.type },
      "Stripe webhook handler threw — Stripe will retry",
    );
    // Roll back idempotency mark so retry can reprocess
    await db
      .delete(stripeProcessedEventsTable)
      .where(eq(stripeProcessedEventsTable.eventId, event.id));
    res.status(500).json({ error: "Handler failed", willRetry: true });
  }
}

async function handleCheckoutCompleted(
  stripe: NonNullable<Awaited<ReturnType<typeof getUncachableStripeClient>>>,
  event: { id: string; type: string; data: { object: Record<string, unknown> } },
): Promise<void> {
  const session = event.data.object;
  const mode = session.mode as string;

  if (mode === "subscription") {
    // Subscription checkout — provision the subscription row
    const userId = (session.metadata as Record<string, string> | undefined)?.userId;
    const tier = (session.metadata as Record<string, string> | undefined)?.tier ?? "pro";
    const customerId = session.customer as string | null;
    const subscriptionId = session.subscription as string | null;
    if (!userId || !customerId || !subscriptionId) {
      logger.warn(
        { eventId: event.id },
        "Subscription checkout missing userId/customerId/subscriptionId",
      );
      return;
    }
    // Fetch current period from Stripe
    const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
    const currentPeriodEnd = new Date(
      (stripeSub as unknown as { current_period_end: number }).current_period_end * 1000,
    );

    await db
      .update(userSubscriptionsTable)
      .set({
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        tier,
        status: "active",
        currentPeriodEnd,
        cancelAtPeriodEnd: false,
        updatedAt: sql`now()`,
      })
      .where(eq(userSubscriptionsTable.userId, userId));

    // Grant first monthly credits immediately
    await maybeGrantMonthlyCredits(userId, currentPeriodEnd);
    logger.info({ userId, tier, subscriptionId }, "Subscription activated via checkout");
    return;
  }

  // One-time credit pack purchase
  const paymentStatus = session.payment_status as string;
  if (paymentStatus !== "paid") return;

  const userId = (session.metadata as Record<string, string> | undefined)?.userId;
  const creditsStr = (session.metadata as Record<string, string> | undefined)?.credits;
  const packageId = (session.metadata as Record<string, string> | undefined)?.packageId;
  if (!userId || !creditsStr) return;

  const credits = parseInt(creditsStr, 10);
  if (isNaN(credits) || credits <= 0) return;

  // Fetch receipt URL
  let receiptUrl: string | null = null;
  const paymentIntentId = session.payment_intent as string | null;
  if (paymentIntentId) {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
      const charge = (pi as unknown as { latest_charge?: { receipt_url?: string } }).latest_charge;
      if (charge?.receipt_url) receiptUrl = charge.receipt_url;
    } catch {
      /* non-fatal */
    }
  }

  await getOrCreateCredits(userId);
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(userCreditsTable)
      .set({ balance: sql`${userCreditsTable.balance} + ${credits}`, updatedAt: sql`now()` })
      .where(eq(userCreditsTable.userId, userId))
      .returning({ balance: userCreditsTable.balance });
    const newBalance = updated?.balance ?? 0;
    await tx.insert(creditTransactionsTable).values({
      userId,
      type: "purchase",
      amount: credits,
      description: `Stripe purchase: ${packageId ?? "unknown"} pack (${credits} credits) [event ${event.id}]`,
      balanceAfter: newBalance,
      receiptUrl,
    });
  });
  logger.info({ userId, credits, packageId }, "One-time credits granted via checkout");
}

async function handleInvoicePaid(event: {
  id: string;
  data: { object: Record<string, unknown> };
}): Promise<void> {
  const invoice = event.data.object;
  const customerId = invoice.customer as string | null;
  const subscriptionId = invoice.subscription as string | null;
  const lines = invoice.lines as { data?: Array<{ period?: { end?: number } }> } | undefined;
  const periodEnd = lines?.data?.[0]?.period?.end;
  if (!customerId || !subscriptionId) return;

  const [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.stripeCustomerId, customerId));
  if (!sub) return;

  // Update subscription to active
  const currentPeriodEnd = periodEnd
    ? new Date(periodEnd * 1000)
    : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await db
    .update(userSubscriptionsTable)
    .set({ status: "active", currentPeriodEnd, gracePeriodEnd: null, updatedAt: sql`now()` })
    .where(eq(userSubscriptionsTable.userId, sub.userId));

  // Grant monthly credits
  await maybeGrantMonthlyCredits(sub.userId, currentPeriodEnd);
  logger.info(
    { userId: sub.userId, customerId },
    "invoice.paid: subscription renewed, credits granted",
  );
}

async function handleInvoicePaymentFailed(event: {
  id: string;
  data: { object: Record<string, unknown> };
}): Promise<void> {
  const invoice = event.data.object;
  const customerId = invoice.customer as string | null;
  const attemptCount = (invoice.attempt_count as number | null) ?? 1;
  if (!customerId) return;

  const [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.stripeCustomerId, customerId));
  if (!sub) return;

  const GRACE_PERIOD_DAYS = 7;
  const gracePeriodEnd = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  if (attemptCount >= 3) {
    // Final failure: downgrade to free
    await db
      .update(userSubscriptionsTable)
      .set({
        tier: "free",
        status: "canceled",
        stripeSubscriptionId: null,
        gracePeriodEnd: null,
        updatedAt: sql`now()`,
      })
      .where(eq(userSubscriptionsTable.userId, sub.userId));
    logger.warn(
      { userId: sub.userId, attemptCount },
      "invoice.payment_failed: max retries hit — downgraded to free",
    );
  } else {
    await db
      .update(userSubscriptionsTable)
      .set({ status: "grace_period", gracePeriodEnd, updatedAt: sql`now()` })
      .where(eq(userSubscriptionsTable.userId, sub.userId));
    logger.warn(
      { userId: sub.userId, attemptCount, gracePeriodEnd },
      "invoice.payment_failed: grace period started",
    );
  }
}

async function handleSubscriptionUpdated(event: {
  id: string;
  data: { object: Record<string, unknown> };
}): Promise<void> {
  const stripeSub = event.data.object;
  const subscriptionId = stripeSub.id as string;
  const status = stripeSub.status as string;
  const cancelAtPeriodEnd = (stripeSub.cancel_at_period_end as boolean) ?? false;
  const currentPeriodEnd = stripeSub.current_period_end
    ? new Date((stripeSub.current_period_end as number) * 1000)
    : null;

  const [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.stripeSubscriptionId, subscriptionId));
  if (!sub) return;

  const mappedStatus =
    status === "active"
      ? "active"
      : status === "trialing"
        ? "trialing"
        : status === "past_due"
          ? "past_due"
          : status === "canceled"
            ? "canceled"
            : "grace_period";

  await db
    .update(userSubscriptionsTable)
    .set({
      status: mappedStatus,
      cancelAtPeriodEnd,
      ...(currentPeriodEnd ? { currentPeriodEnd } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(userSubscriptionsTable.userId, sub.userId));
  logger.info(
    { userId: sub.userId, status: mappedStatus, cancelAtPeriodEnd },
    "Subscription updated",
  );
}

async function handleSubscriptionDeleted(event: {
  id: string;
  data: { object: Record<string, unknown> };
}): Promise<void> {
  const stripeSub = event.data.object;
  const subscriptionId = stripeSub.id as string;

  const [sub] = await db
    .select()
    .from(userSubscriptionsTable)
    .where(eq(userSubscriptionsTable.stripeSubscriptionId, subscriptionId));
  if (!sub) return;

  await db
    .update(userSubscriptionsTable)
    .set({
      tier: "free",
      status: "canceled",
      stripeSubscriptionId: null,
      cancelAtPeriodEnd: false,
      updatedAt: sql`now()`,
    })
    .where(eq(userSubscriptionsTable.userId, sub.userId));
  logger.info({ userId: sub.userId, subscriptionId }, "Subscription deleted — downgraded to free");
}

// ── Public webhook router — mount BEFORE auth wall ────────────────────────────
export const billingWebhookRouter: IRouter = Router();
billingWebhookRouter.post("/billing/webhook", handleStripeWebhook);

// ── Auth-required billing router ──────────────────────────────────────────────
const router: IRouter = Router();

// GET /api/billing/credits — current credit balance
router.get("/billing/credits", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const credits = await getOrCreateCredits(userId);
  res.json({ userId: credits.userId, balance: credits.balance, updatedAt: credits.updatedAt });
});

// GET /api/billing/transactions — transaction history
router.get("/billing/transactions", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const rows = await db
    .select()
    .from(creditTransactionsTable)
    .where(eq(creditTransactionsTable.userId, userId))
    .orderBy(desc(creditTransactionsTable.createdAt))
    .limit(50);
  res.json({ transactions: rows });
});

// GET /api/billing/packages
router.get("/billing/packages", async (_req, res): Promise<void> => {
  const configured = await stripeAvailable();
  const publishableKey = configured ? ((await getStripePublishableKey()) ?? "") : "";
  res.json({
    stripeConfigured: configured,
    publishableKey,
    packages: CREDIT_PACKAGES.map((p) => ({
      id: p.id,
      label: p.label,
      credits: p.credits,
      priceUsd: p.priceUsd,
      description: p.description,
      available: configured,
    })),
  });
});

// GET /api/billing/checkout/:sessionId — backup signal for slow webhooks.
router.get("/billing/checkout/:sessionId", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const sessionId = req.params.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ error: "Missing sessionId" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({ sessionId, status: "unknown", error: "Stripe not configured" });
    return;
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const sessionUserId = session.metadata?.userId;
    if (sessionUserId !== userId) {
      res.status(403).json({ error: "Session belongs to a different user" });
      return;
    }

    let creditsGranted = false;
    const createdAtMs = (session.created ?? 0) * 1000;
    if (createdAtMs > 0) {
      const packageId = session.metadata?.packageId ?? "";
      const recent = await db
        .select({ id: creditTransactionsTable.id })
        .from(creditTransactionsTable)
        .where(
          and(
            eq(creditTransactionsTable.userId, userId),
            eq(creditTransactionsTable.type, "purchase"),
            like(creditTransactionsTable.description, `%${packageId}%`),
            sql`${creditTransactionsTable.createdAt} >= ${new Date(createdAtMs)}`,
          ),
        )
        .limit(1);
      creditsGranted = recent.length > 0;
    }
    res.json({
      sessionId: session.id,
      status: session.status ?? "unknown",
      paymentStatus: session.payment_status ?? undefined,
      creditsGranted,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) invalidateStripeCredentialCache();
    res.status(502).json({ sessionId, status: "unknown", error: `Stripe API error: ${msg}` });
  }
});

// GET /api/billing/subscription — current tier + status
router.get("/billing/subscription", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const sub = await getOrCreateSubscription(userId);
  const tierMeta =
    SUBSCRIPTION_TIERS_META.find((t) => t.id === sub.tier) ?? SUBSCRIPTION_TIERS_META[0];
  const configured = await stripeAvailable();
  const publishableKey = configured ? ((await getStripePublishableKey()) ?? "") : "";
  res.json({
    tier: sub.tier,
    status: sub.status,
    currentPeriodEnd: sub.currentPeriodEnd,
    gracePeriodEnd: sub.gracePeriodEnd,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    monthlyCredits: tierMeta.monthlyCredits,
    maxConcurrentBuilds: tierMeta.maxConcurrentBuilds,
    stripeConfigured: configured,
    publishableKey,
    tiers: SUBSCRIPTION_TIERS_META.map((t) => ({
      id: t.id,
      name: t.name,
      priceUsd: t.priceUsd,
      monthlyCredits: t.monthlyCredits,
      maxConcurrentBuilds: t.maxConcurrentBuilds,
      features: t.features,
      available: configured || t.id === "free",
      current: sub.tier === t.id,
    })),
  });
});

// POST /api/billing/subscribe — start or upgrade subscription
router.post("/billing/subscribe", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({ setupRequired: true, message: "Stripe is not configured." });
    return;
  }

  const { tier, successUrl, cancelUrl } = req.body as {
    tier?: string;
    successUrl?: string;
    cancelUrl?: string;
  };

  const tierMeta = SUBSCRIPTION_TIERS_META.find((t) => t.id === tier);
  if (!tierMeta || tier === "free") {
    res.status(400).json({ error: "Invalid tier. Choose 'pro' or 'team'." });
    return;
  }

  const priceId = priceIdForTier(tierMeta);
  if (!priceId) {
    res.json({
      setupRequired: true,
      message: `Stripe Price ID for '${tier}' is not configured. Set ${tierMeta.priceIdEnv} env var.`,
    });
    return;
  }

  try {
    const customerId = await ensureStripeCustomer(userId, stripe);
    const platformBase = process.env.PLATFORM_DOMAIN
      ? `https://${process.env.PLATFORM_DOMAIN}`
      : "";
    const successUrlFinal: string = successUrl ?? `${platformBase}/billing?subscribed=1`;
    const cancelUrlFinal: string = cancelUrl ?? `${platformBase}/billing`;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription" as const,
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: { userId, tier: tier as string },
      success_url: successUrlFinal,
      cancel_url: cancelUrlFinal,
      allow_promotion_codes: true,
      automatic_tax: { enabled: process.env.STRIPE_TAX_ENABLED === "true" },
    });
    res.json({ sessionId: session.id, checkoutUrl: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication/i.test(msg)) invalidateStripeCredentialCache();
    res.status(502).json({ error: `Stripe error: ${msg}` });
  }
});

// POST /api/billing/cancel-subscription
router.post("/billing/cancel-subscription", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.status(503).json({ error: "Stripe not configured" });
    return;
  }

  const sub = await getOrCreateSubscription(userId);
  if (!sub.stripeSubscriptionId) {
    res.status(400).json({ error: "No active subscription" });
    return;
  }

  try {
    await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      cancel_at_period_end: true,
    });
    await db
      .update(userSubscriptionsTable)
      .set({ cancelAtPeriodEnd: true, updatedAt: sql`now()` })
      .where(eq(userSubscriptionsTable.userId, userId));
    res.json({ ok: true, cancelAtPeriodEnd: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    res.status(502).json({ error: `Stripe error: ${msg}` });
  }
});

// POST /api/billing/portal — Stripe Customer Portal
router.post("/billing/portal", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({ setupRequired: true });
    return;
  }

  const sub = await getOrCreateSubscription(userId);
  if (!sub.stripeCustomerId) {
    res.status(400).json({ error: "No Stripe customer record. Subscribe first." });
    return;
  }

  const { returnUrl } = req.body as { returnUrl?: string };
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url:
        returnUrl ??
        (process.env.PLATFORM_DOMAIN
          ? `https://${process.env.PLATFORM_DOMAIN}/billing`
          : "/billing"),
    });
    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    res.status(502).json({ error: `Stripe error: ${msg}` });
  }
});

// GET /api/billing/invoices — list Stripe invoices
router.get("/billing/invoices", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({ invoices: [] });
    return;
  }

  const sub = await getOrCreateSubscription(userId);
  if (!sub.stripeCustomerId) {
    res.json({ invoices: [] });
    return;
  }

  try {
    const list = await stripe.invoices.list({
      customer: sub.stripeCustomerId,
      limit: 24,
    });
    const invoices = list.data.map((inv) => ({
      id: inv.id,
      number: inv.number,
      status: inv.status,
      amountPaid: inv.amount_paid,
      currency: inv.currency,
      created: inv.created,
      pdfUrl: inv.invoice_pdf,
      hostedUrl: inv.hosted_invoice_url,
      description: inv.description,
    }));
    res.json({ invoices });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.warn({ err: msg, userId }, "Failed to fetch Stripe invoices");
    res.json({ invoices: [], error: msg });
  }
});

// GET /api/billing/usage — per-user usage analytics
router.get("/billing/usage", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Spend by model (agentMode) from build_analytics
  const byModel = await db
    .select({
      agentMode: buildAnalyticsTable.agentMode,
      model: buildAnalyticsTable.model,
      buildCount: sql<number>`count(*)::int`,
    })
    .from(buildAnalyticsTable)
    .where(and(eq(buildAnalyticsTable.userId, userId), gte(buildAnalyticsTable.createdAt, since)))
    .groupBy(buildAnalyticsTable.agentMode, buildAnalyticsTable.model);

  // Builds per day (last 30 days)
  const byDay = await db
    .select({
      day: sql<string>`date_trunc('day', created_at)::date::text`,
      buildCount: sql<number>`count(*)::int`,
      creditsSpent: sql<number>`coalesce(sum(case when amount < 0 then abs(amount) else 0 end), 0)::int`,
    })
    .from(creditTransactionsTable)
    .where(
      and(
        eq(creditTransactionsTable.userId, userId),
        gte(creditTransactionsTable.createdAt, since),
      ),
    )
    .groupBy(sql`date_trunc('day', created_at)::date`)
    .orderBy(sql`date_trunc('day', created_at)::date`);

  // Top projects by credits consumed
  const topProjects = await db
    .select({
      projectId: creditTransactionsTable.projectId,
      projectName: projectsTable.name,
      creditsConsumed: sql<number>`sum(case when amount < 0 then abs(amount) else 0 end)::int`,
    })
    .from(creditTransactionsTable)
    .leftJoin(projectsTable, eq(creditTransactionsTable.projectId, projectsTable.id))
    .where(
      and(
        eq(creditTransactionsTable.userId, userId),
        gte(creditTransactionsTable.createdAt, since),
      ),
    )
    .groupBy(creditTransactionsTable.projectId, projectsTable.name)
    .orderBy(sql`sum(case when amount < 0 then abs(amount) else 0 end) desc`)
    .limit(5);

  // Current balance
  const credits = await getOrCreateCredits(userId);

  // Total spend in period
  const [totalSpend] = await db
    .select({
      total: sql<number>`coalesce(sum(case when amount < 0 then abs(amount) else 0 end), 0)::int`,
      totalPurchased: sql<number>`coalesce(sum(case when amount > 0 then amount else 0 end), 0)::int`,
    })
    .from(creditTransactionsTable)
    .where(
      and(
        eq(creditTransactionsTable.userId, userId),
        gte(creditTransactionsTable.createdAt, since),
      ),
    );

  res.json({
    currentBalance: credits.balance,
    period: { from: since.toISOString(), to: new Date().toISOString() },
    totalCreditsSpent: totalSpend?.total ?? 0,
    totalCreditsPurchased: totalSpend?.totalPurchased ?? 0,
    byModel,
    byDay,
    topProjects: topProjects.map((p) => ({
      projectId: p.projectId,
      projectName: p.projectName ?? `Project #${p.projectId ?? "?"}`,
      creditsConsumed: p.creditsConsumed,
    })),
  });
});

// POST /api/billing/checkout — one-time credit pack
router.post("/billing/checkout", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({
      setupRequired: true,
      message:
        "Stripe is not configured. Connect the Stripe integration to enable credit purchases.",
      packages: CREDIT_PACKAGES,
    });
    return;
  }

  const { packageId, uiMode, successUrl, cancelUrl, returnUrl } = req.body as {
    packageId?: string;
    uiMode?: "hosted" | "embedded";
    successUrl?: string;
    cancelUrl?: string;
    returnUrl?: string;
  };

  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) {
    res.status(400).json({
      error: `Unknown package. Valid options: ${CREDIT_PACKAGES.map((p) => p.id).join(", ")}`,
    });
    return;
  }

  const mode = uiMode === "embedded" ? "embedded" : "hosted";
  if (mode === "hosted" && (!successUrl || !cancelUrl)) {
    res.status(400).json({ error: "successUrl and cancelUrl are required for hosted checkout" });
    return;
  }

  try {
    const { stripeCircuit, withRetry, isTransientError } = await import("../lib/resilience");
    const priceId = priceIdForPack(pkg);
    const inlineLineItem = {
      quantity: 1,
      price_data: {
        currency: "usd",
        unit_amount: pkg.priceUsd * 100,
        product_data: {
          name: `MustaFlow ${pkg.label}`,
          description: pkg.description,
        },
      },
    };

    const buildParams = (lineItem: typeof inlineLineItem | { quantity: number; price: string }) => ({
      mode: "payment" as const,
      line_items: [lineItem],
      metadata: { userId, packageId: pkg.id, credits: String(pkg.credits) },
      automatic_tax: { enabled: Boolean(process.env.STRIPE_TAX_ENABLED === "true") },
    });

    const createSession = (lineItem: typeof inlineLineItem | { quantity: number; price: string }) => {
      const baseParams = buildParams(lineItem);
      return stripeCircuit.call(() =>
        withRetry(
          () =>
            mode === "embedded"
              ? stripe.checkout.sessions.create({
                  ...baseParams,
                  ui_mode: "embedded",
                  ...(returnUrl
                    ? { return_url: returnUrl }
                    : { redirect_on_completion: "never" as const }),
                })
              : stripe.checkout.sessions.create({
                  ...baseParams,
                  success_url: successUrl!,
                  cancel_url: cancelUrl!,
                }),
          { maxAttempts: 2, baseDelayMs: 1_000, shouldRetry: isTransientError, label: "stripe:checkout.sessions.create" },
        ),
      );
    };

    let session;
    if (priceId) {
      try {
        session = await createSession({ quantity: 1, price: priceId });
      } catch (priceErr) {
        const pmsg = priceErr instanceof Error ? priceErr.message : "";
        if (/no such price|resource_missing/i.test(pmsg)) {
          req.log.warn({ priceId, packageId: pkg.id }, "Configured Stripe Price not found; falling back to inline price_data");
          session = await createSession(inlineLineItem);
        } else {
          throw priceErr;
        }
      }
    } else {
      session = await createSession(inlineLineItem);
    }

    res.json({
      sessionId: session.id,
      checkoutUrl: session.url ?? undefined,
      clientSecret: session.client_secret ?? undefined,
      package: { id: pkg.id, label: pkg.label, credits: pkg.credits, priceUsd: pkg.priceUsd },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) invalidateStripeCredentialCache();
    res.status(502).json({ error: `Stripe API error: ${msg}` });
  }
});

// ── Plan / subscription routes (Task #644) ───────────────────────────────────

// GET /api/billing/plans — list configured plan tiers with their Stripe Price
// IDs (when set). Used by the billing UI to render upgrade buttons.
router.get("/billing/plans", async (_req, res): Promise<void> => {
  const stripeConfigured = await stripeAvailable();
  const plans = (["free", "starter", "pro", "enterprise"] as const).map((tier) => ({
    tier,
    priceId: stripePriceIdForPlan(tier) ?? null,
    available: tier === "free" || (stripeConfigured && !!stripePriceIdForPlan(tier)),
  }));
  res.json({ stripeConfigured, plans });
});

// GET /api/billing/subscription/:workspaceId — current subscription state.
// Owner-only. Used by the billing UI to show "Current plan: Pro" etc.
router.get("/billing/subscription/:workspaceId", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const workspaceId = parseInt(req.params.workspaceId ?? "", 10);
  if (!Number.isFinite(workspaceId)) {
    res.status(400).json({ error: "Invalid workspace id" });
    return;
  }
  const [ws] = await db
    .select()
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), isNull(workspacesTable.deletedAt)));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  if (ws.ownerUserId !== userId) {
    res.status(403).json({ error: "You do not own this workspace" });
    return;
  }
  const [sub] = await db
    .select()
    .from(workspaceSubscriptionsTable)
    .where(eq(workspaceSubscriptionsTable.workspaceId, workspaceId));
  const { resolveWorkspacePlan } = await import("../lib/plans");
  const effectivePlan = await resolveWorkspacePlan(workspaceId);
  res.json({
    workspaceId,
    effectivePlan,
    subscription: sub
      ? {
          planTier: sub.planTier,
          status: sub.status,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          currentPeriodEnd: sub.currentPeriodEnd,
          cancelAtPeriodEnd: sub.cancelAtPeriodEnd === "true",
        }
      : null,
  });
});

// POST /api/billing/subscription/checkout — create a Stripe Checkout session in
// subscription mode for a plan upgrade. Workspace owner only. Returns the
// hosted checkout URL.
router.post("/billing/subscription/checkout", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { workspaceId, planTier, successUrl, cancelUrl } = req.body as {
    workspaceId?: number;
    planTier?: string;
    successUrl?: string;
    cancelUrl?: string;
  };

  if (typeof workspaceId !== "number" || !Number.isFinite(workspaceId)) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  if (!planTier || !(PLAN_TIERS as readonly string[]).includes(planTier) || planTier === "free") {
    res.status(400).json({
      error: "planTier must be one of: starter, pro, enterprise",
    });
    return;
  }
  if (!successUrl || !cancelUrl) {
    res.status(400).json({ error: "successUrl and cancelUrl are required" });
    return;
  }

  const priceId = stripePriceIdForPlan(planTier as PlanTier);
  if (!priceId) {
    res.status(400).json({
      error: `Stripe Price ID for plan '${planTier}' is not configured. Set the PLAN_PRICE_${planTier.toUpperCase()} env var.`,
    });
    return;
  }

  // Ownership check
  const [ws] = await db
    .select({ id: workspacesTable.id, ownerUserId: workspacesTable.ownerUserId })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), isNull(workspacesTable.deletedAt)));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  if (ws.ownerUserId !== userId) {
    res.status(403).json({ error: "You do not own this workspace" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({
      setupRequired: true,
      message:
        "Stripe is not configured. Connect the Stripe integration (or set STRIPE_SECRET_KEY) to enable plan upgrades.",
    });
    return;
  }

  try {
    // Reuse the existing Stripe customer for this workspace when we already
    // have one stored — keeps the customer's invoice history consolidated.
    const [existing] = await db
      .select({ customerId: workspaceSubscriptionsTable.stripeCustomerId })
      .from(workspaceSubscriptionsTable)
      .where(eq(workspaceSubscriptionsTable.workspaceId, workspaceId));

    const { stripeCircuit, withRetry, isTransientError } = await import("../lib/resilience");
    const session = await stripeCircuit.call(() =>
      withRetry(
        () =>
          stripe.checkout.sessions.create({
            mode: "subscription",
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: successUrl,
            cancel_url: cancelUrl,
            ...(existing?.customerId ? { customer: existing.customerId } : {}),
            metadata: {
              userId,
              workspaceId: String(workspaceId),
              planTier,
            },
            subscription_data: {
              metadata: {
                userId,
                workspaceId: String(workspaceId),
                planTier,
              },
            },
          }),
        {
          maxAttempts: 2,
          baseDelayMs: 1_000,
          shouldRetry: isTransientError,
          label: "stripe:subscription.checkout.sessions.create",
        },
      ),
    );

    res.json({
      sessionId: session.id,
      checkoutUrl: session.url ?? undefined,
      workspaceId,
      planTier,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ error: `Stripe API error: ${msg}` });
  }
});
// POST /api/billing/subscription/portal — create a Stripe Billing Portal session
// so the workspace owner can cancel, change plan, or update payment method.
router.post("/billing/subscription/portal", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { workspaceId, returnUrl } = req.body as {
    workspaceId?: number;
    returnUrl?: string;
  };

  if (typeof workspaceId !== "number" || !Number.isFinite(workspaceId)) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  if (!returnUrl || typeof returnUrl !== "string") {
    res.status(400).json({ error: "returnUrl is required" });
    return;
  }

  const [ws] = await db
    .select({ id: workspacesTable.id, ownerUserId: workspacesTable.ownerUserId })
    .from(workspacesTable)
    .where(and(eq(workspacesTable.id, workspaceId), isNull(workspacesTable.deletedAt)));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return;
  }
  if (ws.ownerUserId !== userId) {
    res.status(403).json({ error: "You do not own this workspace" });
    return;
  }

  const [sub] = await db
    .select({ customerId: workspaceSubscriptionsTable.stripeCustomerId })
    .from(workspaceSubscriptionsTable)
    .where(eq(workspaceSubscriptionsTable.workspaceId, workspaceId));

  if (!sub?.customerId) {
    res.status(400).json({
      error: "No active subscription found for this workspace. Upgrade to a paid plan first.",
    });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.json({
      setupRequired: true,
      message:
        "Stripe is not configured. Connect the Stripe integration (or set STRIPE_SECRET_KEY) to manage subscriptions.",
    });
    return;
  }

  try {
    const { stripeCircuit, withRetry, isTransientError } = await import("../lib/resilience");
    const session = await stripeCircuit.call(() =>
      withRetry(
        () =>
          stripe.billingPortal.sessions.create({
            customer: sub.customerId!,
            return_url: returnUrl,
          }),
        {
          maxAttempts: 2,
          baseDelayMs: 1_000,
          shouldRetry: isTransientError,
          label: "stripe:billingPortal.sessions.create",
        },
      ),
    );
    res.json({ portalUrl: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ error: `Stripe API error: ${msg}` });
  }
});

export default router;
