---
name: Stripe current_period fields moved to subscription item
description: Newer Stripe API versions expose current_period_start/end on the subscription item, not the top-level subscription; reading top-level yields undefined and Invalid Date.
---

# Stripe subscription period fields relocated

In newer Stripe API versions, `current_period_start` / `current_period_end` live on each
subscription **item** (`subscription.items.data[0].current_period_start/end`), NOT on the
top-level subscription object. Reading them off the top-level subscription returns
`undefined` → `new Date(undefined * 1000)` = Invalid Date → any DB write of that timestamp
throws `RangeError: Invalid time value`. In a webhook handler this surfaces as a 500
("Handler failed", willRetry:true) and Stripe keeps retrying forever.

**Why:** Stripe split billing periods onto line items to support items billed on different
cycles. Code written against older API versions silently breaks after the account/library
moves to a newer API version, even though the price/subscription was created fine.

**How to apply:** When reading period boundaries from any Stripe subscription, read the
item first and fall back to the legacy top-level field, and null-guard before constructing
Dates. In this repo the shared helper is `extractSubscriptionPeriod()` in
`artifacts/api-server/src/routes/billing.ts` — use it everywhere instead of reading
`current_period_*` directly. For a fallback period anchor (when both are absent), use the
subscription's stable `start_date`/`created` (not Date.now()) so a retried webhook computes
the same period and can't double-grant credits.

Related: the user Core/Wave subscription tier flips on `checkout.session.completed` via
`session.metadata.tier` (set at checkout creation), NOT via price metadata. `plans.ts` is a
separate workspace-plan system (free/starter/pro/enterprise) — do not conflate the two.
