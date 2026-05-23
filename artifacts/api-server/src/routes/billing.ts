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
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  creditTransactionsTable,
  stripeProcessedEventsTable,
  userCreditsTable,
} from "@workspace/db";
import { getOrCreateCredits } from "./credits";
import {
  stripeAvailable,
  getUncachableStripeClient,
  invalidateStripeCredentialCache,
} from "../lib/stripeClient";
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
  },
  {
    id: "builder",
    label: "Builder Pack",
    credits: 2500,
    priceUsd: 20,
    description: "2,500 build credits — best value for active builders",
  },
  {
    id: "power",
    label: "Power Pack",
    credits: 10000,
    priceUsd: 65,
    description: "10,000 build credits — for power users and teams",
  },
] as const;

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

  type CheckoutEvent = {
    id: string;
    type: string;
    data: {
      object: {
        metadata?: { userId?: string; packageId?: string; credits?: string };
        payment_status?: string;
      };
    };
  };
  let event: CheckoutEvent | null = null;

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
      ) as unknown as CheckoutEvent;
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
    event = req.body as CheckoutEvent;
  }

  if (!event?.id || !event.type) {
    res.status(400).json({ error: "Malformed event payload" });
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
  if (session?.payment_status !== "paid") {
    await db
      .insert(stripeProcessedEventsTable)
      .values({ eventId: event.id, type: event.type })
      .onConflictDoNothing();
    res.json({ ok: true, processed: false, reason: "payment_status not paid" });
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
  res.json({
    stripeConfigured: configured,
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

  const { packageId, successUrl, cancelUrl } = req.body as {
    packageId?: string;
    successUrl?: string;
    cancelUrl?: string;
  };

  const pkg = CREDIT_PACKAGES.find((p) => p.id === packageId);
  if (!pkg) {
    res.status(400).json({
      error: `Unknown package. Valid options: ${CREDIT_PACKAGES.map((p) => p.id).join(", ")}`,
    });
    return;
  }

  if (!successUrl || !cancelUrl) {
    res.status(400).json({ error: "successUrl and cancelUrl are required" });
    return;
  }

  try {
    // Use inline price_data instead of pre-created Stripe Price IDs so
    // operators don't need to create products in the Stripe Dashboard first.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pkg.priceUsd * 100,
            product_data: {
              name: `MustaFlow ${pkg.label}`,
              description: pkg.description,
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        userId,
        packageId: pkg.id,
        credits: String(pkg.credits),
      },
    });

    res.json({
      sessionId: session.id,
      checkoutUrl: session.url,
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

export default router;
