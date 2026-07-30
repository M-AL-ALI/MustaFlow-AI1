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
import type Stripe from "stripe";
import { eq, desc, sql, and, like, isNull, gte } from "drizzle-orm";
import {
  db,
  creditTransactionsTable,
  creditGrantsTable,
  stripeProcessedEventsTable,
  userCreditsTable,
  workspaceSubscriptionsTable,
  workspacesTable,
  buildAnalyticsTable,
  projectsTable,
  userSubscriptionsTable,
} from "@workspace/db";
import {
  TIER_MONTHLY_CREDITS,
  TIER_PRICE_USD,
  TIER_MONTHLY_IMAGE_CAP,
  TIER_ORA_MESSAGE_LIMIT,
  TIER_ORA_IMAGE_LIMIT,
  TIER_ORA_WINDOW_HOURS,
  TIER_ORA_REALTIME_LIMIT_SECONDS,
} from "@workspace/db";
import type { SubscriptionTier } from "@workspace/db";
import { getOrCreateCredits } from "./credits";
import {
  stripeAvailable,
  getUncachableStripeClient,
  getStripePublishableKey,
  invalidateStripeCredentialCache,
} from "../lib/stripeClient";
import { evictTierCache } from "../lib/public-ai/authed-user";
import {
  PLAN_TIERS,
  type PlanTier,
  planTierForStripePriceId,
  stripePriceIdForPlan,
  resolveWorkspacePlan,
} from "../lib/plans";
import { isSuperuser, SUPERUSER_ORA_TIER } from "../lib/superusers";
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
    monthlyImageCap: TIER_MONTHLY_IMAGE_CAP.free,
    priceIdEnv: null,
    features: [
      "30 Ora messages every 5 hours",
      "4 Ora images every 5 hours",
      "150 credits / month",
      "Instant replies",
      "1 concurrent build",
      '"Built with MustaFlow" badge on published apps',
      "Community support",
    ],
  },
  {
    id: "core" as const,
    name: "Core Pack",
    monthlyCredits: TIER_MONTHLY_CREDITS.core,
    priceUsd: TIER_PRICE_USD.core,
    maxConcurrentBuilds: 3,
    monthlyImageCap: TIER_MONTHLY_IMAGE_CAP.core,
    priceIdEnv: "STRIPE_CORE_PRICE_ID",
    features: [
      "100 Ora messages every 3 hours",
      "15 Ora images every 3 hours",
      "1,500 credits / month",
      "Instant + Deep Thinking",
      "Connectors (GitHub & more)",
      "3 concurrent builds",
      "No badge on published apps",
      "Priority queue",
      "Email support",
    ],
  },
  {
    id: "wave" as const,
    name: "Deep Wave",
    monthlyCredits: TIER_MONTHLY_CREDITS.wave,
    priceUsd: TIER_PRICE_USD.wave,
    maxConcurrentBuilds: 10,
    monthlyImageCap: TIER_MONTHLY_IMAGE_CAP.wave,
    priceIdEnv: "STRIPE_WAVE_PRICE_ID",
    features: [
      "280 Ora messages every 3 hours",
      "30 Ora images every 3 hours",
      "4,000 credits / month",
      "Instant + Deep Thinking",
      "Connectors (GitHub & more)",
      "10 concurrent builds",
      "No badge on published apps",
      "Priority queue",
      "Priority support",
    ],
  },
] as const;

// ── Ora-only plan metadata (Ora plan/billing parity) ─────────────────────────
// Ora surfaces (website Ora settings/pricing/billing plan cards + mobile
// Settings) must render ONLY Ora features — never AI Builder credits, concurrent
// builds, build queue, the "Built with MustaFlow" badge, or Builder connectors.
// This array is the SINGLE SOURCE OF TRUTH consumed by BOTH website and mobile
// via the API (GET /billing/subscription -> oraTiers, GET /billing/ora-plans).
// Everything is derived from the canonical per-tier constants in
// @workspace/db so the numbers can never drift between surfaces.
const ORA_TIER_IDS = ["free", "core", "wave"] as const;

const ORA_TIER_NAMES: Record<SubscriptionTier, string> = {
  free: "Free",
  core: "Core Pack",
  wave: "Deep Wave",
};

function oraVoiceMinutes(tier: SubscriptionTier): number {
  return Math.round(TIER_ORA_REALTIME_LIMIT_SECONDS[tier] / 60);
}

function buildOraTierFeatures(tier: SubscriptionTier): string[] {
  const win = TIER_ORA_WINDOW_HOURS[tier];
  const features = [
    `${TIER_ORA_MESSAGE_LIMIT[tier]} Ora messages every ${win} hours`,
    `${TIER_ORA_IMAGE_LIMIT[tier]} Ora images every ${win} hours`,
    `Talk to Ora: ${oraVoiceMinutes(tier)} voice minutes every ${win} hours`,
    "Unlimited file uploads to Ora",
    tier === "free" ? "Ora Instant replies" : "Ora Instant + Deep Thinking",
  ];
  if (tier !== "free") features.push("Saved memory & history");
  features.push(
    tier === "free" ? "Community support" : tier === "core" ? "Email support" : "Priority support",
  );
  return features;
}

export const ORA_TIERS_META = ORA_TIER_IDS.map((id) => ({
  id,
  name: ORA_TIER_NAMES[id],
  priceUsd: TIER_PRICE_USD[id],
  messageLimit: TIER_ORA_MESSAGE_LIMIT[id],
  imageLimit: TIER_ORA_IMAGE_LIMIT[id],
  windowHours: TIER_ORA_WINDOW_HOURS[id],
  voiceMinutes: oraVoiceMinutes(id),
  deepThinking: id !== "free",
  features: buildOraTierFeatures(id),
}));

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

// Exported for NabuFlow billing (Task #1516): both plan families share the
// account's single Stripe Customer, stored on user_subscriptions.
export async function ensureStripeCustomer(
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
//
// Fully atomic: the credit_grants insert, credit balance increment, and
// transaction log entry all execute inside a single db.transaction(). If any
// step fails the entire transaction rolls back — including the credit_grants
// row — so Stripe's next retry can re-claim the grant cleanly. The unique
// constraint on (subscription_id, period_start) is the primary dedup guard:
// a row already existing means credits were already granted for this period.
async function maybeGrantMonthlyCredits(
  userId: string,
  subscriptionId: string,
  periodStart: Date,
): Promise<void> {
  const sub = await getOrCreateSubscription(userId);
  const tier = (sub.tier ?? "free") as keyof typeof TIER_MONTHLY_CREDITS;
  const monthlyAmount = TIER_MONTHLY_CREDITS[tier] ?? TIER_MONTHLY_CREDITS.free;
  if (monthlyAmount <= 0) return;

  // Ensure the user_credits row exists before opening the transaction so we
  // don't run a potentially slow upsert inside a serialised write transaction.
  await getOrCreateCredits(userId);

  let granted = false;
  await db.transaction(async (tx) => {
    // Attempt to claim this billing period. ON CONFLICT DO NOTHING means an
    // existing row (already-granted period) causes inserted.length === 0.
    const inserted = await tx
      .insert(creditGrantsTable)
      .values({ userId, subscriptionId, periodStart, amount: monthlyAmount })
      .onConflictDoNothing()
      .returning({ id: creditGrantsTable.id });

    if (inserted.length === 0) return; // already granted — leave granted=false

    // Both operations in the same transaction so a partial failure cannot
    // produce an orphaned credit_grants row (tx rolls back entirely).
    const [updated] = await tx
      .update(userCreditsTable)
      .set({
        balance: sql`${userCreditsTable.balance} + ${monthlyAmount}`,
        updatedAt: sql`now()`,
      })
      .where(eq(userCreditsTable.userId, userId))
      .returning({ balance: userCreditsTable.balance });

    const newBalance = updated?.balance ?? monthlyAmount;

    await tx.insert(creditTransactionsTable).values({
      userId,
      type: "subscription_grant",
      amount: monthlyAmount,
      description: `Monthly ${tier} grant (${monthlyAmount} credits)`,
      balanceAfter: newBalance,
    });

    granted = true;
  });

  if (!granted) {
    logger.info(
      { userId, tier, subscriptionId },
      "Monthly credit grant already issued for this period — skipping",
    );
    return;
  }

  await db
    .update(userSubscriptionsTable)
    .set({ lastMonthlyGrantAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(userSubscriptionsTable.userId, userId));
  logger.info({ userId, tier, monthlyAmount, subscriptionId }, "Monthly credits granted");
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
    // Race condition guard: checkout.session.completed may not have had time to
    // write workspaceId metadata to the subscription before this event fired.
    // Wait 3 seconds and retry all workspace lookups using the customer ID.
    await new Promise((r) => setTimeout(r, 3_000));

    if (subscriptionId) {
      const [retrySub] = await db
        .select({ workspaceId: workspaceSubscriptionsTable.workspaceId })
        .from(workspaceSubscriptionsTable)
        .where(eq(workspaceSubscriptionsTable.stripeSubscriptionId, subscriptionId))
        .limit(1);
      if (retrySub) workspaceId = retrySub.workspaceId;
    }

    if (workspaceId === null && customerId) {
      const [retryCustomer] = await db
        .select({ workspaceId: workspaceSubscriptionsTable.workspaceId })
        .from(workspaceSubscriptionsTable)
        .where(eq(workspaceSubscriptionsTable.stripeCustomerId, customerId))
        .orderBy(desc(workspaceSubscriptionsTable.workspaceId))
        .limit(1);
      if (retryCustomer) workspaceId = retryCustomer.workspaceId;
    }

    if (workspaceId === null) {
      logger.warn(
        { eventId: event.id, subscriptionId, customerId },
        "Subscription event has no resolvable workspaceId after retry — skipping",
      );
      return;
    }

    logger.info(
      { eventId: event.id, subscriptionId, customerId, workspaceId },
      "Subscription event workspace resolved after retry",
    );
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

  const currentPeriodEnd = extractSubscriptionPeriod(sub).end;

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

export async function handleStripeWebhook(
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

  // ── Unified idempotency: claim the event with status-based deduplication ────
  //
  // On new event:    INSERT with status='processing' succeeds → we own it.
  // On conflict where status='failed':  re-claim (Stripe retry is legitimate).
  // On conflict where status='processing' AND age>5min: re-claim (stuck job).
  // On conflict otherwise (status='succeeded' or fresh 'processing'): skip.
  //
  // The row is NEVER deleted — on failure we set status='failed' so the next
  // Stripe retry can reclaim it cleanly.
  const claimed = await db
    .insert(stripeProcessedEventsTable)
    .values({
      eventId: event.id,
      type: event.type,
      status: "processing",
      processingStartedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: stripeProcessedEventsTable.eventId,
      set: {
        status: "processing",
        processingStartedAt: sql`now()`,
      },
      setWhere: sql`${stripeProcessedEventsTable.status} = 'failed' OR (${stripeProcessedEventsTable.status} = 'processing' AND ${stripeProcessedEventsTable.processingStartedAt} < now() - interval '5 minutes')`,
    })
    .returning({ eventId: stripeProcessedEventsTable.eventId });

  if (claimed.length === 0) {
    logger.info({ eventId: event.id, type: event.type }, "Stripe webhook duplicate — skipping");
    res.json({ ok: true, duplicate: true });
    return;
  }

  const markEventSucceeded = async () => {
    await db
      .update(stripeProcessedEventsTable)
      .set({ status: "succeeded", succeededAt: sql`now()` })
      .where(eq(stripeProcessedEventsTable.eventId, event!.id));
  };

  const markEventFailed = async (errorMessage: string) => {
    await db
      .update(stripeProcessedEventsTable)
      .set({ status: "failed", failedAt: sql`now()`, errorMessage })
      .where(eq(stripeProcessedEventsTable.eventId, event!.id));
  };

  // ── Subscription lifecycle events ───────────────────────────────────────────
  // customer.subscription.{created,updated,deleted} — sync workspace plan tier
  // (Task #644) and user subscription state.
  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    // NabuFlow subscriptions are namespaced via metadata.surface === 'nabuflow'
    // and share the account's Stripe Customer with Ora/workspace plans — they
    // must be routed EARLY so Ora's customer-id fallback can never misattribute
    // them (and NabuFlow code never touches user_subscriptions).
    if (event.data?.object?.metadata?.surface === "nabuflow") {
      try {
        const { handleNabuflowSubscriptionEvent } = await import("../lib/nabuflow-billing");
        await handleNabuflowSubscriptionEvent(event.type, event.data.object);
        await markEventSucceeded();
        res.json({ ok: true, type: event.type, surface: "nabuflow", processed: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unexpected error";
        logger.error(
          { err: msg, eventId: event.id, type: event.type },
          "NabuFlow subscription sync failed",
        );
        await markEventFailed(msg);
        res.status(500).json({ error: "NabuFlow subscription sync failed", willRetry: true });
      }
      return;
    }

    try {
      await handleSubscriptionEvent(event);
      await markEventSucceeded();
      res.json({ ok: true, type: event.type, processed: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      logger.error({ err: msg, eventId: event.id, type: event.type }, "Subscription sync failed");
      await markEventFailed(msg);
      res.status(500).json({ error: "Subscription sync failed", willRetry: true });
    }
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
        await markEventFailed("Missing userId or hostname in session metadata");
        res.status(400).json({ error: "Missing userId or hostname in session metadata" });
        return;
      }

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

          await markEventSucceeded();
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
          await markEventFailed(msg);
          res.status(500).json({ error: "Domain fulfillment failed", willRetry: true });
        }
      } else {
        // domain_transfer: the transfer-in/confirm endpoint handles Namecheap
        // transfer initiation.  Webhook acknowledges payment only; the client
        // confirm endpoint is responsible for the full transfer flow.
        await markEventSucceeded();
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
      case "invoice.paid": {
        // NabuFlow invoices (namespaced subscription on the SHARED customer)
        // must never reach Ora's invoice handler — it would grant Ora monthly
        // credits off a NabuFlow renewal. Routing is metadata-first with a
        // local nabuflow_subscriptions lookup as fallback. Enterprise org
        // bulk-pool invoices (their own COMPANY customer) route first of all.
        const { isNabuflowOrgInvoiceEvent, handleNabuflowOrgInvoicePaid } = await import(
          "../lib/nabuflow-org"
        );
        const { isNabuflowInvoiceEvent, handleNabuflowInvoicePaid } = await import(
          "../lib/nabuflow-billing"
        );
        const invoice = event.data?.object as any;
        if (await isNabuflowOrgInvoiceEvent(invoice)) {
          await handleNabuflowOrgInvoicePaid(invoice);
        } else if (await isNabuflowInvoiceEvent(invoice)) {
          await handleNabuflowInvoicePaid(invoice);
        } else {
          await handleInvoicePaid(event as any);
        }
        break;
      }
      case "invoice.payment_failed": {
        const { isNabuflowOrgInvoiceEvent, handleNabuflowOrgInvoicePaymentFailed } = await import(
          "../lib/nabuflow-org"
        );
        const { isNabuflowInvoiceEvent, handleNabuflowInvoicePaymentFailed } = await import(
          "../lib/nabuflow-billing"
        );
        const invoice = event.data?.object as any;
        if (await isNabuflowOrgInvoiceEvent(invoice)) {
          await handleNabuflowOrgInvoicePaymentFailed(invoice);
        } else if (await isNabuflowInvoiceEvent(invoice)) {
          await handleNabuflowInvoicePaymentFailed(invoice);
        } else {
          await handleInvoicePaymentFailed(event as any);
        }
        break;
      }
      case "customer.subscription.updated":
        await handleSubscriptionUpdated(event as any);
        break;
      case "customer.subscription.deleted":
        await handleSubscriptionDeleted(event as any);
        break;
      // NabuFlow card-on-file state is webhook-driven (never client calls).
      case "payment_method.attached": {
        const { handleNabuflowPaymentMethodAttached } = await import("../lib/nabuflow-billing");
        await handleNabuflowPaymentMethodAttached(event.data?.object as any);
        break;
      }
      case "payment_method.detached": {
        const { handleNabuflowPaymentMethodDetached } = await import("../lib/nabuflow-billing");
        await handleNabuflowPaymentMethodDetached(event.data?.object as any);
        break;
      }
      case "setup_intent.succeeded": {
        const { handleNabuflowSetupIntentSucceeded } = await import("../lib/nabuflow-billing");
        await handleNabuflowSetupIntentSucceeded(event.data?.object as any);
        break;
      }
      default:
        logger.info({ eventId: event.id, type: event.type }, "Stripe webhook unhandled event type");
    }
    await markEventSucceeded();
    res.json({ ok: true, type: event.type });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.error(
      { err: msg, eventId: event.id, type: event.type },
      "Stripe webhook handler threw — Stripe will retry",
    );
    // Mark failed WITHOUT deleting so Stripe's next retry can reclaim the row.
    await markEventFailed(msg);
    res.status(500).json({ error: "Handler failed", willRetry: true });
  }
}

/**
 * Extract the current billing period from a Stripe subscription object.
 *
 * Newer Stripe API versions expose `current_period_start`/`current_period_end`
 * on each subscription *item* (`items.data[0]`) rather than on the top-level
 * subscription. We read the item first and fall back to the legacy top-level
 * fields so the handler works across API versions. Returns `null` for either
 * boundary when no usable value is present (caller supplies a sane default).
 */
export function extractSubscriptionPeriod(stripeSub: unknown): {
  start: Date | null;
  end: Date | null;
} {
  const sub = stripeSub as {
    current_period_start?: number;
    current_period_end?: number;
    items?: {
      data?: Array<{ current_period_start?: number; current_period_end?: number }>;
    };
  };
  const item = sub.items?.data?.[0];
  const startSec =
    typeof item?.current_period_start === "number"
      ? item.current_period_start
      : typeof sub.current_period_start === "number"
        ? sub.current_period_start
        : null;
  const endSec =
    typeof item?.current_period_end === "number"
      ? item.current_period_end
      : typeof sub.current_period_end === "number"
        ? sub.current_period_end
        : null;
  return {
    start: startSec !== null ? new Date(startSec * 1000) : null,
    end: endSec !== null ? new Date(endSec * 1000) : null,
  };
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
    const tier = (session.metadata as Record<string, string> | undefined)?.tier ?? "core";
    const customerId = session.customer as string | null;
    const subscriptionId = session.subscription as string | null;
    if (!userId || !customerId || !subscriptionId) {
      logger.warn(
        { eventId: event.id },
        "Subscription checkout missing userId/customerId/subscriptionId",
      );
      return;
    }
    // Fetch current period from Stripe. In newer Stripe API versions the
    // current_period_start/current_period_end fields live on the subscription
    // *item*, not the top-level subscription object; fall back to the legacy
    // top-level fields for older API versions.
    const stripeSub = await stripe.subscriptions.retrieve(subscriptionId);
    const period = extractSubscriptionPeriod(stripeSub);
    // Deterministic fallback anchor (subscription start_date/created) so a
    // retried webhook can't compute a different period and double-grant credits
    // when Stripe omits the period boundaries.
    const subAnchor = stripeSub as unknown as { start_date?: number; created?: number };
    const anchorSec = subAnchor.start_date ?? subAnchor.created ?? Math.floor(Date.now() / 1000);
    const anchorMs = anchorSec * 1000;
    const currentPeriodStart = period.start ?? new Date(anchorMs);
    const currentPeriodEnd = period.end ?? new Date(anchorMs + 30 * 24 * 60 * 60 * 1000);

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

    evictTierCache(userId);
    // Grant first monthly credits immediately
    await maybeGrantMonthlyCredits(userId, subscriptionId, currentPeriodStart);
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
  const lines = invoice.lines as
    | {
        data?: Array<{ period?: { start?: number; end?: number } }>;
      }
    | undefined;
  const periodStart = lines?.data?.[0]?.period?.start;
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
  // Fall back to 30 days before period end if Stripe doesn't supply period start
  const currentPeriodStart = periodStart
    ? new Date(periodStart * 1000)
    : new Date(currentPeriodEnd.getTime() - 30 * 24 * 60 * 60 * 1000);

  await db
    .update(userSubscriptionsTable)
    .set({ status: "active", currentPeriodEnd, gracePeriodEnd: null, updatedAt: sql`now()` })
    .where(eq(userSubscriptionsTable.userId, sub.userId));

  evictTierCache(sub.userId);
  // Grant monthly credits atomically — credit_grants unique constraint prevents duplicates
  await maybeGrantMonthlyCredits(sub.userId, subscriptionId, currentPeriodStart);
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
    evictTierCache(sub.userId);
    logger.warn(
      { userId: sub.userId, attemptCount },
      "invoice.payment_failed: max retries hit — downgraded to free",
    );
  } else {
    await db
      .update(userSubscriptionsTable)
      .set({ status: "grace_period", gracePeriodEnd, updatedAt: sql`now()` })
      .where(eq(userSubscriptionsTable.userId, sub.userId));
    evictTierCache(sub.userId);
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
  const currentPeriodEnd = extractSubscriptionPeriod(stripeSub).end;

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
  evictTierCache(sub.userId);
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
  evictTierCache(sub.userId);
  logger.info({ userId: sub.userId, subscriptionId }, "Subscription deleted — downgraded to free");
}

// ── Public webhook router — mount BEFORE auth wall ────────────────────────────
export const billingWebhookRouter: IRouter = Router();
billingWebhookRouter.post("/billing/webhook", handleStripeWebhook);

// ── Public Ora plans router — mount BEFORE auth wall ──────────────────────────
// GET /api/billing/ora-plans — PUBLIC Ora-only plan metadata for the anonymous
// pricing page. Same single source of truth (ORA_TIERS_META) as the authed
// /billing/subscription -> oraTiers, so website + mobile + marketing never drift.
// Must stay OUTSIDE the auth wall so signed-out visitors get live server data
// instead of silently falling back to hardcoded tiers.
export const billingPublicRouter: IRouter = Router();
billingPublicRouter.get("/billing/ora-plans", async (_req, res): Promise<void> => {
  const configured = await stripeAvailable();
  res.json({
    tiers: ORA_TIERS_META.map((t) => ({
      ...t,
      available: configured || t.id === "free",
    })),
  });
});
// Public NabuFlow plans metadata — no auth required (pricing page, landing page).
// Parallel to GET /billing/ora-plans; does NOT leak per-user state.
billingPublicRouter.get("/billing/nabuflow/plans", (_req, res): void => {
  const { NABUFLOW_BUILD_MODE_COSTS, NABUFLOW_PLAN_IDS, NABUFLOW_PLANS } =
    require("../lib/nabuflow-plans") as typeof import("../lib/nabuflow-plans");
  res.json({
    plans: NABUFLOW_PLAN_IDS.map((id: string) => {
      const plan = NABUFLOW_PLANS[id as keyof typeof NABUFLOW_PLANS];
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
    }),
    modeCosts: NABUFLOW_BUILD_MODE_COSTS,
  });
});

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
  const superuser = await isSuperuser(userId);
  const effectiveTier =
    sub.tier === "core" || sub.tier === "wave"
      ? sub.tier
      : superuser
        ? SUPERUSER_ORA_TIER
        : sub.tier;
  const tierMeta =
    SUBSCRIPTION_TIERS_META.find((t) => t.id === effectiveTier) ?? SUBSCRIPTION_TIERS_META[0];
  const configured = await stripeAvailable();
  const publishableKey = configured ? ((await getStripePublishableKey()) ?? "") : "";
  res.json({
    tier: effectiveTier,
    status: sub.status,
    sourceTier: sub.tier,
    isSuperuser: superuser,
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
      current: effectiveTier === t.id,
    })),
    // Ora-only plan metadata (no AI Builder features). Website Ora plan cards
    // and mobile Settings both render THIS, never the Builder-flavored `tiers`.
    oraTiers: ORA_TIERS_META.map((t) => ({
      ...t,
      available: configured || t.id === "free",
      current: effectiveTier === t.id,
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
    res.status(400).json({ error: "Invalid tier. Choose 'core' or 'wave'." });
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
      payment_method_collection: "always",
      saved_payment_method_options: { payment_method_save: "enabled" },
      subscription_data: {
        metadata: { userId, tier: tier as string },
      },
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

// GET /api/billing/payment-method — default card + plan summary for Ora Settings.
// No raw card data ever passes through MustaFlow — Stripe returns only the safe
// brand/last4/expiry fields. Free users and users without a Stripe customer
// simply report hasPaymentMethod:false alongside their plan summary.
router.get("/billing/payment-method", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const sub = await getOrCreateSubscription(userId);
  const base = {
    hasPaymentMethod: false as boolean,
    customerId: sub.stripeCustomerId ?? undefined,
    plan: sub.tier ?? "free",
    renewalDate: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd).toISOString() : null,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd ?? false,
  };

  const stripe = await getUncachableStripeClient();
  if (!stripe || !sub.stripeCustomerId) {
    res.json(base);
    return;
  }

  try {
    // Prefer the customer's default invoice payment method, then fall back to
    // the most recent card on file.
    let card: Stripe.PaymentMethod.Card | null = null;
    const customer = await stripe.customers.retrieve(sub.stripeCustomerId, {
      expand: ["invoice_settings.default_payment_method"],
    });
    if (!("deleted" in customer)) {
      const dpm = customer.invoice_settings?.default_payment_method;
      if (dpm && typeof dpm !== "string" && dpm.card) {
        card = dpm.card;
      }
    }
    if (!card) {
      const list = await stripe.paymentMethods.list({
        customer: sub.stripeCustomerId,
        type: "card",
        limit: 1,
      });
      const first = list.data[0];
      if (first?.card) card = first.card;
    }

    if (!card) {
      res.json(base);
      return;
    }

    const now = new Date();
    const expired =
      card.exp_year < now.getFullYear() ||
      (card.exp_year === now.getFullYear() && card.exp_month < now.getMonth() + 1);

    res.json({
      ...base,
      hasPaymentMethod: true,
      brand: card.brand,
      last4: card.last4,
      expMonth: card.exp_month,
      expYear: card.exp_year,
      status: expired ? "expired" : "active",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication/i.test(msg)) invalidateStripeCredentialCache();
    logger.warn({ err: msg, userId }, "Failed to fetch payment method");
    res.json(base);
  }
});

// POST /api/billing/payment-method/setup — Stripe-hosted Checkout in "setup"
// mode so a user can add/replace a card without upgrading. Used for free users
// and paid users whose default card is missing. Raw card details are collected
// only on Stripe's hosted page, never by MustaFlow.
router.post("/billing/payment-method/setup", async (req, res): Promise<void> => {
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

  // Stripe rejects relative return URLs, so never fall back to one. Use the
  // caller-supplied returnUrl, else an absolute PLATFORM_DOMAIN URL, else 400.
  const { returnUrl } = req.body as { returnUrl?: string };
  let returnTo: string;
  if (returnUrl && typeof returnUrl === "string") {
    returnTo = returnUrl;
  } else if (process.env.PLATFORM_DOMAIN) {
    returnTo = `https://${process.env.PLATFORM_DOMAIN}/ora/settings`;
  } else {
    res.status(400).json({ error: "returnUrl is required" });
    return;
  }
  try {
    const customerId = await ensureStripeCustomer(userId, stripe);
    const session = await stripe.checkout.sessions.create({
      mode: "setup" as const,
      currency: "usd",
      customer: customerId,
      success_url: `${returnTo}?pm=added`,
      cancel_url: returnTo,
    });
    res.json({ url: session.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication/i.test(msg)) invalidateStripeCredentialCache();
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
      amountDue: inv.amount_due,
      currency: inv.currency,
      created: inv.created,
      pdfUrl: inv.invoice_pdf,
      hostedUrl: inv.hosted_invoice_url,
      description: inv.description,
      // Human-readable line items for the Billing & Usage invoices page.
      lines: (inv.lines?.data ?? []).map((line) => ({
        description: line.description,
        amount: line.amount,
      })),
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

    const buildParams = (
      lineItem: typeof inlineLineItem | { quantity: number; price: string },
    ) => ({
      mode: "payment" as const,
      line_items: [lineItem],
      metadata: { userId, packageId: pkg.id, credits: String(pkg.credits) },
      automatic_tax: { enabled: Boolean(process.env.STRIPE_TAX_ENABLED === "true") },
    });

    const createSession = (
      lineItem: typeof inlineLineItem | { quantity: number; price: string },
    ) => {
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
          {
            maxAttempts: 2,
            baseDelayMs: 1_000,
            shouldRetry: isTransientError,
            label: "stripe:checkout.sessions.create",
          },
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
          req.log.warn(
            { priceId, packageId: pkg.id },
            "Configured Stripe Price not found; falling back to inline price_data",
          );
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
    isSuperuser: await isSuperuser(userId),
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
// subscription mode for a plan upgrade.
//
// Two modes:
//   1. User-level Core subscription: { tier: 'core', successUrl, cancelUrl }
//      Uses STRIPE_CORE_PRICE_ID; sets user_subscriptions.tier on checkout.session.completed.
//   2. Workspace plan upgrade (legacy): { workspaceId, planTier, successUrl, cancelUrl }
//      Uses workspace-scoped plan prices (PLAN_PRICE_*).
router.post("/billing/subscription/checkout", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { tier, workspaceId, planTier, successUrl, cancelUrl } = req.body as {
    tier?: string;
    workspaceId?: number;
    planTier?: string;
    successUrl?: string;
    cancelUrl?: string;
  };

  if (!successUrl || !cancelUrl) {
    res.status(400).json({ error: "successUrl and cancelUrl are required" });
    return;
  }

  // ── Mode 1: User-level subscription (Core Pack / Deep Wave) ──────────────────
  // Any tier defined in SUBSCRIPTION_TIERS_META with a configured Stripe price is
  // handled here. Free has no price; the workspace-legacy path (Mode 2) is only
  // reached when no recognized user-level `tier` is supplied.
  if (tier === "core" || tier === "wave") {
    const tierMeta = SUBSCRIPTION_TIERS_META.find((t) => t.id === tier);
    const tierPriceId = priceIdForTier(tierMeta ?? { priceIdEnv: null });
    if (!tierPriceId) {
      const envName = tierMeta?.priceIdEnv ?? "the Stripe price";
      res.json({
        setupRequired: true,
        message: `${envName} is not configured. Contact your administrator.`,
      });
      return;
    }

    const stripe = await getUncachableStripeClient();
    if (!stripe) {
      res.json({
        setupRequired: true,
        message:
          "Stripe is not configured. Connect the Stripe integration to enable plan upgrades.",
      });
      return;
    }

    try {
      const customerId = await ensureStripeCustomer(userId, stripe);
      const { stripeCircuit, withRetry, isTransientError } = await import("../lib/resilience");
      const session = await stripeCircuit.call(() =>
        withRetry(
          () =>
            stripe.checkout.sessions.create({
              mode: "subscription",
              customer: customerId,
              line_items: [{ price: tierPriceId, quantity: 1 }],
              success_url: successUrl,
              cancel_url: cancelUrl,
              metadata: { userId, tier },
              payment_method_collection: "always",
              saved_payment_method_options: { payment_method_save: "enabled" },
              subscription_data: { metadata: { userId, tier } },
              allow_promotion_codes: true,
              automatic_tax: { enabled: process.env.STRIPE_TAX_ENABLED === "true" },
            }),
          {
            maxAttempts: 2,
            baseDelayMs: 1_000,
            shouldRetry: isTransientError,
            label: `stripe:${tier}.subscription.checkout`,
          },
        ),
      );
      res.json({ sessionId: session.id, checkoutUrl: session.url ?? undefined, tier });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unexpected error";
      if (/api key|authentication|invalid_api_key/i.test(msg)) invalidateStripeCredentialCache();
      res.status(502).json({ error: `Stripe API error: ${msg}` });
    }
    return;
  }

  // ── Mode 2: Workspace plan upgrade ──────────────────────────────────────────
  if (typeof workspaceId !== "number" || !Number.isFinite(workspaceId)) {
    res.status(400).json({ error: "workspaceId is required for workspace plan upgrades" });
    return;
  }
  // Validate the target tier. Superusers may select any tier (including free);
  // normal users cannot "checkout" the free tier (handled below).
  if (!planTier || !(PLAN_TIERS as readonly string[]).includes(planTier)) {
    res.status(400).json({
      error: "planTier must be one of: free, starter, pro, enterprise",
    });
    return;
  }

  // Ownership check (needed before any plan change, Stripe or superuser bypass).
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

  // ── Superuser bypass: apply the chosen tier instantly, no Stripe payment ────
  // Persist an active workspace_subscriptions row with no Stripe IDs so
  // resolveWorkspacePlan() reflects the selected tier immediately. Accepts any
  // tier including 'free' (switch back down). NO checkout session is created.
  if (await isSuperuser(userId)) {
    await db
      .insert(workspaceSubscriptionsTable)
      .values({
        workspaceId,
        planTier,
        status: "active",
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        stripePriceId: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: null,
      })
      .onConflictDoUpdate({
        target: workspaceSubscriptionsTable.workspaceId,
        set: {
          planTier,
          status: "active",
          stripeSubscriptionId: null,
          stripePriceId: null,
          currentPeriodEnd: null,
          cancelAtPeriodEnd: null,
          updatedAt: sql`now()`,
        },
      });
    const effectivePlan = await resolveWorkspacePlan(workspaceId);
    res.json({ ok: true, applied: true, workspaceId, planTier, effectivePlan });
    return;
  }

  // Normal users: the free tier is not a checkout target, and a Stripe price
  // must be configured for the requested plan.
  if (planTier === "free") {
    res.status(400).json({
      error: "planTier must be one of: starter, pro, enterprise",
    });
    return;
  }

  const priceId = stripePriceIdForPlan(planTier as PlanTier);
  if (!priceId) {
    res.status(400).json({
      error: `Stripe Price ID for plan '${planTier}' is not configured. Set the PLAN_PRICE_${planTier.toUpperCase()} env var.`,
    });
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
            payment_method_collection: "always",
            saved_payment_method_options: { payment_method_save: "enabled" },
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
