---
name: Stripe connector dev/prod price-id scoping
description: Why STRIPE_*_PRICE_ID env vars must be environment-scoped, not shared, with the Replit Stripe connector.
---

The Replit Stripe connector exposes TWO connections — one `development` (test mode) and one `production` (live mode) — each with its own secret key. `stripeClient.ts` picks the connection by `REPLIT_DEPLOYMENT` (dev → test key, prod → live key).

Test-mode and live-mode `price_...` IDs are NOT interchangeable: a test price ID 400s in live mode and vice versa.

**Rule:** any Stripe object ID stored as config (price IDs, product IDs) must be created in BOTH the test and live accounts and saved as **environment-scoped** env vars (`setEnvVars({environment:'development'})` + `{environment:'production'}`) — never a single `shared` value.

**Why:** a shared STRIPE_CORE_PRICE_ID holding a test price would break production checkout (and vice versa). The checkout route reads `process.env[priceIdEnv]` at request time, so the value must match the connection the running environment uses.

**How to apply:** when wiring a new paid tier, create products+recurring prices via the SDK against both `listConnections('stripe')` entries, then set the resulting IDs per environment. Price IDs are not secrets — `setEnvVars` is fine (no `requestEnvVar` needed). Restart the api-server after setting so process.env picks them up.
