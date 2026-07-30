---
name: NabuFlow billing UI test recipe
description: How to put a browser test user into any NabuFlow billing state (env flags, DB seeding, restore expectations)
---

Recipe for E2E-testing builder billing UI (ladder counters, blocked states, meters, charts) with the testing subagent:

- `BUILDER_OPEN_TO_ALL=true` (api-server env override on workflow restart) grants builder access to fresh Clerk test users WITHOUT billing exemption — exemption stays allowlist/superuser-only, so ladder and blocked states remain testable on those users.
- `CREDITS_ENFORCEMENT=true` is live-read by the nabuflow gate/state resolver (no code change or reseed needed to flip); the tester restarts the API workflow with env overrides and MUST restart with none afterwards to restore gating.
- Seed exactly three tables to fabricate any billing state: `nabuflow_subscriptions` (status 'active'; card_* columns drive the card-on-file UI), `nabuflow_billing_cycles` (meters + Pro/Deep counters; UNIQUE(user_id, cycle_start)), `nabuflow_usage_events` (charts; rows with reversed_at are excluded from charts but included in CSV).
- Get the Clerk user id for seeding via `SELECT owner_id FROM projects WHERE id = <id>` after the tester creates a project in the UI.
- After restoring env, non-allowlisted test users bounce from builder routes to `/mode-select` — that IS the restored gating working, not a test failure. Brief the tester on this or it reports a false failure.
- Never click plan CTAs while seeded with fake Stripe ids (`cus_e2e_fake`/`sub_e2e_fake`) — checkout/switch would call Stripe with them. The invoices endpoint reads the legacy subscriptions row's Stripe customer (shared-customer design), so nabuflow seeding does not break it.
- The metered blocked card only fires on an actual BUILD submission; a plain chat/plan message may not hit the gate — have the tester send a build-style prompt in the gated mode.
- The testing agent's headless browser CANNOT load Stripe Elements iframes (they resolve to chrome-error://) — card-entry dialogs are untestable in-browser. Bridge: attach `pm_card_visa` to the customer + set invoice_settings.default_payment_method server-side, then resume the UI flow (purchase dialogs that charge the saved PM work fine in the browser).
- A build submitted while a prior build is still running on the same project queues; its reserve charge fires only when the job starts — don't assert its ledger draw immediately, and don't restore env (enforcement off) before it starts or the draw never lands.
- Composer trigger copy like "Mode: Pro · 10 credits" is the selected-mode COST label, not a limit counter — brief testers on this or they report a false Nova failure.

**Why:** builder surfaces are allowlist-gated in dev; without the env override every fresh test user lands on /mode-select and all billing pages are unreachable, while allowlisted users are billing-exempt and can never show blocked states.

**How to apply:** any future billing UI work (e.g. the Constellation enterprise flow) — reuse the flags + seeding verbatim; clean up seeded rows by user_id afterwards.
