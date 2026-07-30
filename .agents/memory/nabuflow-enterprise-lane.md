---
name: NabuFlow enterprise (Constellation) lane
description: How the org/pool billing lane composes with the personal ladder — gate order, pool semantics, terms gating, card summary source
---

Core rules of the enterprise lane:

- **Org lane REPLACES personal rules for seats.** When a user is a seat of an active org, the build gate skips card-on-file/dunning/personal-ladder checks entirely — the prepaid pool is the only funding test. A seat with a personal sub still draws from the pool, not their cycle.
- **Pool may go negative.** Draws during in-flight builds always land (skipUsageChecks drain), so the shared pool can dip below zero; blocks are pre-start only (`pool_exhausted`, org cap, seat sub-cap). Suspended orgs are the one state that blocks even the drain.
- **Terms (pay-by-invoice, net-N) are platform-gated**: org admins can edit PO reference/contact freely, but flipping `invoiceTermsEnabled` is superuser-only (routes reject with `terms_platform_gated`). New orgs are card-only until platform enables terms.
- **Company card summary is read LIVE from the Stripe customer** (invoice_settings.default_payment_method), not from org columns; the setup-intent → `setup_intent.succeeded` webhook path sets the default PM. Attaching a PM + setting default server-side is a faithful bridge when the Elements UI is unavailable.
- **Bulk purchases are dynamic amounts** (tiered volume rates with a minimum credits floor), itemized with PO/tax custom fields on the invoice — no Stripe env price IDs involved. Personal plan prices self-provision per environment via `lookup_keys` (create-if-missing), so live mode needs zero manual Stripe setup.
- **Ledger is the reconciliation spine**: every draw row links `usage_event_id` and carries `balance_after`, purchases link `purchase_id`; org months + seat months tables mirror the drawn totals. Any new draw/refund path must write all three or the org page and usage dashboard diverge.

**Why:** the lane was designed prepaid-first — charging a company card per build (or dunning seats) contradicts the bulk-pool contract, and killing in-flight builds on pool exhaustion would burn paid work.

**How to apply:** any change to the build gate or charge pipeline must keep the org-status check FIRST (before skipUsageChecks), keep pool draws honest (negative allowed), and never re-introduce personal-lane card checks for seats.
