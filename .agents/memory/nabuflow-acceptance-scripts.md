---
name: NabuFlow acceptance script pattern + Stripe test-mode gotchas
description: How to write/run the tsx assertion scripts in api-server/acceptance/ and the Stripe test tokens/fields that tripped us
---

Pattern (Vitest OOMs on api-server in Replit, so acceptance runs as plain tsx scripts):

- Scripts live in `artifacts/api-server/acceptance/` — OUTSIDE `src/`, so tsconfig (`include:["src"]`) and lint ignore them; they are committed as durable acceptance artifacts. Run: `cd artifacts/api-server && pnpm exec tsx acceptance/<file>.ts`.
- First lines: `process.env.CREDITS_ENFORCEMENT="true"` (gate is live-read) and `delete process.env.NABUFLOW_BILLING_TEST_BYPASS`. Mix HTTP against the dev server (`x-e2e-test-user` header) with direct lib imports for gate/charge/webhook internals; use real Stripe test-mode objects; end with `process.exit()` (the pg pool holds the loop open).
- Unique user ids per run (`e2e-<slug>-${Date.now()}`) make cleanup unnecessary; unique credit amounts per draw make refund matching unambiguous.
- Seeded personal subs MUST set `defaultPaymentMethodId` + future `cardExpMonth/Year` or the gate blocks with `no_payment_method` before any ladder logic runs.
- Simulate cycle rollover by shifting the sub's cycleStart/End (and the cycle row) into the past, then calling the gate — the lazy advance materializes a fresh cycle with counters reset and plan-policy rollover.

Stripe test-mode gotchas:

- `pm_card_chargeDeclined` declines at ATTACH time; use `pm_card_chargeCustomerFail` for attach-succeeds/charge-fails scenarios.
- Finalized invoices expose `due_date` (epoch seconds), not `days_until_due`.
- Overage/usage invoice-item description text is "pay-as-you-go … over included", not the word "overage" — match loosely in assertions.
- Failed purchases don't persist an invoice id; verify decline→void invariants via `stripe.invoices.list({ customer })` (all void).

**Why:** these scripts are the only reliable full-pipeline gate in this environment; the token/field quirks each cost a debugging loop.

**How to apply:** extend the existing scripts for new billing behavior instead of adding Vitest suites; rerun them before any enforcement or pricing change ships.
