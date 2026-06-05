---
name: Stripe checkout requires absolute success/cancel URLs
description: Why /billing/* checkout endpoints fail with "Stripe error: Not a valid URL" when tested without explicit URLs in dev
---

When verifying Stripe checkout endpoints (e.g. `POST /api/billing/subscribe` for Ora Core/Wave tiers, or `/api/billing/checkout`), a request that omits `successUrl`/`cancelUrl` fails with `{"error":"Stripe error: Not a valid URL"}`.

**Why:** The handlers fall back to `${platformBase}${path}` where `platformBase = process.env.PLATFORM_DOMAIN ? "https://"+PLATFORM_DOMAIN : ""`. In dev `PLATFORM_DOMAIN` is unset, so the fallback becomes a relative URL like `/billing?subscribed=1`, and `stripe.checkout.sessions.create` rejects relative `success_url`/`cancel_url`.

**How to apply:** When testing checkout via curl, always pass absolute `successUrl`/`cancelUrl` in the body (the real frontend `billing.tsx`/`pricing.tsx` already send `${window.location.origin}/...`, so the live UI is fine). A successful response returns `{sessionId, checkoutUrl}` with a `cs_test_...` id on `checkout.stripe.com`. Reaching this error (vs `setupRequired`/`!stripe`) actually proves the Stripe client + price IDs are configured — the only thing missing was a valid URL.

**Auth for testing:** Auth-walled billing routes honor the `x-e2e-test-user` header bypass (sets `req.userId`) only when `isE2ETestAuthEnabled()` (NODE_ENV !== "production" AND E2E_TEST_ENABLED === "true"). Ora public-ai routes additionally honor `x-e2e-test-tier` (free/core/wave) to simulate a paid tier without seeding the DB.
