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
import { createHmac } from "crypto";
import { eq, desc } from "drizzle-orm";
import { db, creditTransactionsTable } from "@workspace/db";
import { grantCredits, getOrCreateCredits } from "./credits";

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_API_BASE = "https://api.stripe.com/v1";

function stripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY);
}

export const CREDIT_PACKAGES = [
  {
    id: "starter",
    label: "Starter Pack",
    credits: 500,
    priceUsd: 5,
    priceId: process.env.STRIPE_PRICE_STARTER ?? null,
    description: "500 build credits — good for everyday building",
  },
  {
    id: "builder",
    label: "Builder Pack",
    credits: 2500,
    priceUsd: 20,
    priceId: process.env.STRIPE_PRICE_BUILDER ?? null,
    description: "2,500 build credits — best value for active builders",
  },
  {
    id: "power",
    label: "Power Pack",
    credits: 10000,
    priceUsd: 65,
    priceId: process.env.STRIPE_PRICE_POWER ?? null,
    description: "10,000 build credits — for power users and teams",
  },
] as const;

// ── Stripe webhook handler (shared between router and billingWebhookRouter) ───
async function handleStripeWebhook(
  req: Parameters<Parameters<IRouter["post"]>[1]>[0],
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
): Promise<void> {
  if (!stripeConfigured()) {
    res.json({ ok: true, setupRequired: true });
    return;
  }

  const sig = req.headers["stripe-signature"] as string | undefined;
  const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

  if (STRIPE_WEBHOOK_SECRET && sig && rawBody) {
    try {
      const parts = sig.split(",").reduce<Record<string, string>>((acc, part) => {
        const [k, v] = part.split("=");
        if (k && v) acc[k] = v;
        return acc;
      }, {});

      const timestamp = parts["t"];
      const receivedSig = parts["v1"];

      if (!timestamp || !receivedSig) {
        res.status(400).json({ error: "Invalid signature header" });
        return;
      }

      const payload = `${timestamp}.${rawBody.toString()}`;
      const expectedSig = createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(payload).digest("hex");

      if (expectedSig !== receivedSig) {
        res.status(400).json({ error: "Webhook signature mismatch" });
        return;
      }
    } catch {
      res.status(400).json({ error: "Signature verification failed" });
      return;
    }
  }

  const event = req.body as {
    type?: string;
    data?: {
      object?: {
        metadata?: { userId?: string; packageId?: string; credits?: string };
        payment_status?: string;
      };
    };
  };

  if (event.type !== "checkout.session.completed") {
    res.json({ ok: true, type: event.type, processed: false });
    return;
  }

  const session = event.data?.object;
  if (session?.payment_status !== "paid") {
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

  const newBalance = await grantCredits(
    userId,
    credits,
    `Stripe purchase: ${packageId ?? "unknown"} pack (${credits} credits)`,
  );

  res.json({ ok: true, userId, creditsGranted: credits, newBalance });
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
router.get("/billing/packages", (_req, res): void => {
  res.json({
    stripeConfigured: stripeConfigured(),
    packages: CREDIT_PACKAGES.map((p) => ({
      id: p.id,
      label: p.label,
      credits: p.credits,
      priceUsd: p.priceUsd,
      description: p.description,
      available: stripeConfigured() && Boolean(p.priceId),
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

  if (!stripeConfigured()) {
    res.json({
      setupRequired: true,
      message:
        "Stripe is not configured. Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_* env vars to enable credit purchases.",
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

  if (!pkg.priceId) {
    res.status(400).json({
      error: `Stripe price ID for package "${pkg.id}" is not configured. Set STRIPE_PRICE_${pkg.id.toUpperCase()} env var.`,
    });
    return;
  }

  if (!successUrl || !cancelUrl) {
    res.status(400).json({ error: "successUrl and cancelUrl are required" });
    return;
  }

  try {
    const params = new URLSearchParams({
      mode: "payment",
      "line_items[0][price]": pkg.priceId,
      "line_items[0][quantity]": "1",
      success_url: successUrl,
      cancel_url: cancelUrl,
      "metadata[userId]": userId,
      "metadata[packageId]": pkg.id,
      "metadata[credits]": String(pkg.credits),
    });

    const resp = await fetch(`${STRIPE_API_BASE}/checkout/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = (await resp.json()) as {
      id?: string;
      url?: string;
      error?: { message: string };
    };

    if (!resp.ok || session.error) {
      res.status(502).json({
        error: session.error?.message ?? "Stripe session creation failed",
      });
      return;
    }

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
    res.status(502).json({ error: `Stripe API error: ${msg}` });
  }
});

export default router;
