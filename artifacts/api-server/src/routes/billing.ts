// ─────────────────────────────────────────────────────────────────────────────
// Billing routes — Stripe checkout + credit top-up
//
//   GET  /api/billing/packages       — list available credit packages (auth required)
//   POST /api/billing/checkout       — create Stripe checkout session (auth required)
//   POST /api/billing/webhook        — Stripe webhook (PUBLIC — Stripe calls this)
//
// If STRIPE_SECRET_KEY is not set, checkout returns { setupRequired: true }.
// billingWebhookRouter is exported separately and mounted BEFORE the auth wall.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, desc, sql, and, like, isNull } from "drizzle-orm";
import {
  db,
  creditTransactionsTable,
  stripeProcessedEventsTable,
  userCreditsTable,
  workspaceSubscriptionsTable,
  workspacesTable,
} from "@workspace/db";
import { getOrCreateCredits } from "./credits";
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

// Stripe credentials come from the Replit Stripe connector at runtime
// (via lib/stripeClient.ts). Falls back to STRIPE_SECRET_KEY env var if
// the connector is not present (e.g. local dev outside Replit).
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

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

// Resolve a pack's Stripe Price ID from env. When unset, the checkout falls
// back to inline price_data so dev/test still works without seeded prices.
function priceIdForPack(pkg: (typeof CREDIT_PACKAGES)[number]): string | undefined {
  const id = process.env[pkg.priceIdEnv];
  return id && id.trim() ? id.trim() : undefined;
}

// ── Stripe webhook handler (shared between router and billingWebhookRouter) ───
//
// Security contract:
// - In production (REPLIT_DEPLOYMENT=1): STRIPE_WEBHOOK_SECRET MUST be set and
//   the signature MUST verify. Unverified or unsigned payloads are rejected.
// - In dev: when STRIPE_WEBHOOK_SECRET is unset we log a warning and accept
//   the payload (so local Stripe CLI testing without a secret still works).
// - Every accepted event.id is recorded in stripe_processed_events with a
//   unique primary key. Duplicate deliveries (Stripe retries / replays) skip
//   the credit grant idempotently.
const IS_PRODUCTION = process.env.REPLIT_DEPLOYMENT === "1";

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
    // Return 5xx (NOT 200) so Stripe retries the delivery. Acking here would
    // silently drop billable events during transient credential outages.
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
        // checkout.session.completed (subscription mode) fields
        mode?: string;
        subscription?: string | null;
        // customer.subscription.* fields
        id?: string;
        status?: string;
        current_period_end?: number;
        cancel_at_period_end?: boolean;
        items?: {
          data?: Array<{ price?: { id?: string } }>;
        };
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

  // ── Subscription lifecycle events (Task #644) ───────────────────────────────
  // customer.subscription.{created,updated,deleted} sync the workspace plan
  // tier into workspace_subscriptions so resolveWorkspacePlan() returns the
  // correct quotas without operator overrides.
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

  // Non-credit events: record idempotency, ack, done.
  if (event.type !== "checkout.session.completed") {
    await db
      .insert(stripeProcessedEventsTable)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing();
    res.json({ ok: true, type: event.type, processed: false });
    return;
  }

  const session = event.data?.object;

  // Subscription-mode checkout sessions: the session itself doesn't grant
  // plan access — that comes from customer.subscription.created. We just
  // attach the workspaceId metadata onto the subscription so the follow-up
  // event can resolve which workspace to upgrade.
  if (session?.mode === "subscription") {
    const workspaceIdStr = session?.metadata?.workspaceId;
    const subscriptionId = session?.subscription;
    if (workspaceIdStr && subscriptionId && typeof subscriptionId === "string") {
      try {
        await stripe.subscriptions.update(subscriptionId, {
          metadata: {
            workspaceId: workspaceIdStr,
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
    await db
      .insert(stripeProcessedEventsTable)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing();
    res.json({ ok: true, type: event.type, mode: "subscription", processed: true });
    return;
  }

  if (session?.payment_status !== "paid") {
    await db
      .insert(stripeProcessedEventsTable)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing();
    res.json({ ok: true, processed: false, reason: "payment_status not paid" });
    return;
  }

  const sessionType = session?.metadata?.type;

  // ── Domain purchase / transfer fulfillment ──────────────────────────────────
  // Provides server-side idempotent fulfillment so Namecheap registration
  // succeeds even if the user closes the tab before the browser confirm call.
  if (sessionType === "domain_purchase" || sessionType === "domain_transfer") {
    const domainUserId = session?.metadata?.userId;
    const hostname = session?.metadata?.hostname;

    if (!domainUserId || !hostname) {
      logger.warn({ eventId: event.id, sessionType }, "Domain webhook: missing userId or hostname in metadata");
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
        const stripeCustomerId =
          typeof session?.customer === "string" ? session.customer : null;
        const projectIdStr = session?.metadata?.projectId;
        const projectId =
          projectIdStr ? (parseInt(projectIdStr, 10) || undefined) : undefined;
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
      res.json({ ok: true, eventId: event.id, hostname, type: "domain_transfer", acknowledged: true });
    }
    return;
  }

  const userId = session?.metadata?.userId;
  const creditsStr = session?.metadata?.credits;
  const packageId = session?.metadata?.packageId;

  if (!userId || !creditsStr) {
    res.status(400).json({ error: "Missing userId or credits in session metadata" });
    return;
  }

  const credits = parseInt(creditsStr, 10);
  if (isNaN(credits) || credits <= 0) {
    res.status(400).json({ error: "Invalid credits value in session metadata" });
    return;
  }

  // Best-effort: fetch the Stripe-hosted receipt URL from the payment_intent's
  // latest_charge so we can show users a "View receipt" link in billing history.
  // Failures here are non-fatal — credits should always grant even if the
  // receipt fetch fails (network blip, expanded API change, etc.).
  let receiptUrl: string | null = null;
  const paymentIntentId = session?.payment_intent;
  if (paymentIntentId && typeof paymentIntentId === "string") {
    try {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, {
        expand: ["latest_charge"],
      });
      const latestCharge = (pi as { latest_charge?: unknown }).latest_charge;
      if (latestCharge && typeof latestCharge === "object") {
        const url = (latestCharge as { receipt_url?: string | null }).receipt_url;
        if (typeof url === "string" && url.length > 0) receiptUrl = url;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "unknown";
      logger.warn(
        { err: msg, paymentIntentId, eventId: event.id },
        "Failed to fetch receipt_url from Stripe — proceeding without it",
      );
    }
  }

  // Atomic: insert event row + grant credits + write transaction in one tx.
  // If anything throws, the event row rolls back so Stripe's retry can succeed.
  // If event was already processed (concurrent retry won earlier), the insert
  // returns 0 rows and we short-circuit to a duplicate ack.
  try {
    const result = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(stripeProcessedEventsTable)
        .values({ eventId: event.id, type: event.type })
        .onConflictDoNothing()
        .returning({ eventId: stripeProcessedEventsTable.eventId });

      if (inserted.length === 0) return { duplicate: true as const };

      // Ensure user_credits row exists (uses outer db, but the upsert is
      // idempotent and any failure here will throw out of the transaction).
      await getOrCreateCredits(userId);

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

      return { duplicate: false as const, newBalance };
    });

    if (result.duplicate) {
      logger.info({ eventId: event.id, type: event.type }, "Stripe webhook duplicate — skipping");
      res.json({ ok: true, duplicate: true, eventId: event.id });
      return;
    }

    res.json({
      ok: true,
      userId,
      creditsGranted: credits,
      newBalance: result.newBalance,
      eventId: event.id,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    logger.error(
      { err: msg, eventId: event.id, userId, credits },
      "Stripe webhook credit grant failed — transaction rolled back, Stripe will retry",
    );
    // 500 so Stripe retries. The idempotency row was rolled back so retry can succeed.
    res.status(500).json({ error: "Credit grant failed", willRetry: true });
  }
}

// ── Public webhook router — mount BEFORE auth wall ────────────────────────────
export const billingWebhookRouter: IRouter = Router();
billingWebhookRouter.post("/billing/webhook", handleStripeWebhook);

// ── Auth-required billing router ──────────────────────────────────────────────
const router: IRouter = Router();

// GET /api/billing/credits — current credit balance (alias for /api/credits)
router.get("/billing/credits", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const credits = await getOrCreateCredits(userId);
  res.json({ userId: credits.userId, balance: credits.balance, updatedAt: credits.updatedAt });
});

// GET /api/billing/transactions — transaction history (alias for /api/credits/transactions)
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
  // Publishable key is safe to expose to the browser (it's the pk_ key designed
  // for client-side use). Needed for the embedded checkout flow.
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
// Returns the Stripe session.status + payment_status plus whether the credits
// for this session have already been recorded in credit_transactions.
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

    // Ownership check: only the user who created the session can read it.
    // Strict — sessions without a userId in metadata are treated as not-yours.
    const sessionUserId = session.metadata?.userId;
    if (sessionUserId !== userId) {
      res.status(403).json({ error: "Session belongs to a different user" });
      return;
    }

    // Detect whether the webhook has already credited this session by
    // looking for our purchase transaction that embeds the (unique) event id
    // for this session — fallback: match on the session metadata pack + recent
    // transactions. We rely on the description tag we write in handleStripeWebhook:
    // "Stripe purchase: ... [event evt_xxx]". Since we don't store the session
    // id directly, we approximate by checking for a recent purchase of the same
    // package after the session was created.
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
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ sessionId, status: "unknown", error: `Stripe API error: ${msg}` });
  }
});

// POST /api/billing/checkout
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
        "Stripe is not configured. Connect the Stripe integration (or set STRIPE_SECRET_KEY) to enable credit purchases.",
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
    // Prefer pre-created Stripe Price IDs (set via `pnpm --filter @workspace/scripts
    // run seed:stripe`, then stored as STRIPE_PRICE_STARTER/BUILDER/POWER secrets).
    // Falls back to inline price_data so dev/test still works without seeding.
    const priceId = priceIdForPack(pkg);
    const lineItem = priceId
      ? { quantity: 1, price: priceId }
      : {
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

    const baseParams = {
      mode: "payment" as const,
      line_items: [lineItem],
      metadata: {
        userId,
        packageId: pkg.id,
        credits: String(pkg.credits),
      },
    };

    const session = await stripeCircuit.call(() =>
      withRetry(
        () =>
          mode === "embedded"
            ? stripe.checkout.sessions.create({
                ...baseParams,
                ui_mode: "embedded",
                // When no return_url is provided, configure the session so the
                // embedded form stays in place after payment and the client polls
                // (via session status / webhook + credit refetch) for completion.
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

    res.json({
      sessionId: session.id,
      checkoutUrl: session.url ?? undefined,
      clientSecret: session.client_secret ?? undefined,
      package: {
        id: pkg.id,
        label: pkg.label,
        credits: pkg.credits,
        priceUsd: pkg.priceUsd,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    // If Stripe rejects with auth error, drop the cached secret so the next
    // request refetches from the connector (handles key rotation).
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
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


export default router;
