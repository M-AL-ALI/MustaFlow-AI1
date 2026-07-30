---
name: Stripe shared-customer surface routing
description: How to keep two plan families (Ora + NabuFlow) isolated when they share one Stripe Customer per account.
---

# Stripe shared-customer surface routing

The account has ONE Stripe Customer reused by every plan family (Ora/workspace tiers AND NabuFlow builder plans). That makes webhook routing the safety-critical piece: a NabuFlow renewal reaching Ora's `invoice.paid` handler would grant Ora monthly credits (and vice versa).

**Rules:**
- Namespace every NabuFlow product/price/subscription with `metadata.surface = "nabuflow"` at creation time.
- Route webhooks **metadata-first, local-lookup fallback**: `surface` metadata on the subscription object, else match the subscription id against the `nabuflow_subscriptions` table (`isNabuflowInvoiceEvent`). Never route by customer id — it's shared.
- Route **EARLY**, before any legacy customer-id fallback logic runs, and `return` (subscription events) or branch exclusively (invoice events). Both directions need tests: nabuflow-marked event never touches `user_subscriptions`; unmarked event never calls a NabuFlow handler.
- Webhooks are authoritative for plan/card/dunning state; client-called subscribe/switch routes may sync local state by invoking the SAME idempotent webhook handler function directly, but never write divergent state of their own.
- **Sync handlers must UPSERT, never update-only.** The FIRST event for a subscriber arrives before any local row exists (and Stripe delivery order isn't guaranteed — invoice.paid can beat subscription.created), so subscription AND invoice handlers must materialize the missing row from the event's metadata (unique-userId upsert), then proceed. An update-only handler leaves first-time subscribers permanently plan-less; a completion review caught exactly this.

**Why:** shared customer + two subscription families is invisible in any single handler's code — only the router sees the collision.

**How to apply:** any new plan family on the same customer gets its own `surface` metadata value and the same early-routing + isolation tests.
