---
name: stripe-payments
description: Accept payments, subscriptions, and one-off charges using Stripe Checkout and webhooks.
triggers: [stripe, payment, subscription, billing, checkout, paywall, credit card, pricing]
---

# Stripe Payments skill

Use this skill for any paid feature: subscriptions, one-off purchases, credit
top-ups, paywalls, or pricing pages.

## Required secrets

| Secret                   | Notes                                                   |
| ------------------------ | ------------------------------------------------------- |
| `STRIPE_SECRET_KEY`      | Server only. `sk_test_*` for dev, `sk_live_*` for prod. |
| `STRIPE_PUBLISHABLE_KEY` | Server / frontend.                                      |
| `STRIPE_WEBHOOK_SECRET`  | Required to verify webhook signatures.                  |

For each priced product, also collect a `STRIPE_PRICE_<NAME>` env var holding
the Price ID (`price_…`). Never hardcode Price IDs in source.

## Server (Express + TypeScript)

```ts
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2024-12-18.acacia",
});

// 1. Create a Checkout Session
app.post("/api/billing/checkout", requireAuth(), async (req, res) => {
  const { priceId } = req.body as { priceId: string };
  const session = await stripe.checkout.sessions.create({
    mode: "subscription", // or "payment"
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${process.env.APP_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/billing/cancelled`,
    client_reference_id: req.auth!.userId,
  });
  res.json({ url: session.url });
});

// 2. Webhook — Express must use express.raw() for this route specifically
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"] as string;
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch (err) {
    res.status(400).send(`Webhook Error: ${(err as Error).message}`);
    return;
  }
  switch (event.type) {
    case "checkout.session.completed":
      /* fulfil order */ break;
    case "customer.subscription.deleted":
      /* revoke access */ break;
  }
  res.json({ received: true });
});
```

## Frontend

- Use Stripe Checkout (hosted) for almost every case — it's PCI-compliant out of the box.
- Only embed Stripe Elements when the spec requires it (e.g. saving cards without checkout).
- After the user returns to `success_url`, **do not** mark them as paid based on the URL alone. Wait for the `checkout.session.completed` webhook.

## Do

- Use idempotency keys on writes (`stripe.subscriptions.create(...,{ idempotencyKey })`).
- Store the Stripe `customer_id` on your user row the first time you create one — reuse it forever.
- Verify webhook signatures with `constructEvent` — never skip this.
- Treat webhooks as the source of truth for billing state.

## Don't

- Do not store card numbers, CVCs, or full PANs anywhere in your DB or logs.
- Do not call Stripe APIs from the browser using the secret key. Use the publishable key on the client; the secret key stays server-side.
- Do not assume webhook order — handle out-of-order events idempotently.
- Do not put Price IDs in source. Use `STRIPE_PRICE_*` env vars so test/prod can differ.

## Examples

### Create Checkout Session (server)

```ts
import Stripe from "stripe";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

app.post("/api/checkout", async (req, res) => {
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: process.env.STRIPE_PRICE_PRO!, quantity: 1 }],
    success_url: `${process.env.APP_URL}/welcome?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${process.env.APP_URL}/pricing`,
    client_reference_id: req.user.id,
  });
  res.json({ url: session.url });
});
```

### Webhook with idempotent handling

```ts
import express from "express";

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      req.header("stripe-signature")!,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return res.status(400).send("bad signature");
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    // upsert subscription record by s.id (idempotent)
  }
  res.json({ received: true });
});
```
