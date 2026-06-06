---
name: Stripe setup-mode Checkout requires currency
description: Stripe Checkout sessions created with mode:"setup" must include a currency param or the API 400s.
---

# Stripe setup-mode Checkout requires `currency`

When creating a Stripe Checkout Session with `mode: "setup"` (save/replace a card, no
immediate charge — e.g. a "Add payment method" flow), the call fails with
`Stripe error: Missing required param: currency.` unless a `currency` is passed.

**Rule:** include `currency: "usd"` (or the user's billing locale) in
`stripe.checkout.sessions.create({ mode: "setup", currency, customer, ... })`.

**Why:** `subscription`/`payment` modes infer currency from the price/line items, but
`setup` mode has no line items so Stripe cannot infer it and rejects the request. The
error surfaces only at runtime (not at typecheck), so it's easy to ship a setup endpoint
that always 400s.

**How to apply:** any new card-setup / SetupIntent-via-Checkout endpoint in
`artifacts/api-server/src/routes/billing.ts` needs the `currency` field. Hardcoding
`"usd"` is fine for a card-only setup flow; derive from billing locale only if
multi-currency payment-method setup is ever needed.
