---
name: Superuser full-access allowlist
description: A hard-coded email allowlist grants one account admin + zero-credit + free-plan-switch access across every gating layer.
---

# Superuser allowlist

A small hard-coded email allowlist (`lib/superusers.ts`, `isSuperuser`/`isSuperuserSync`)
grants matching accounts complete free full-access. It resolves email → Clerk userId
via `findClerkUserByEmail`, caching for the process lifetime (re-attempts every 60s only
while resolution is incomplete, so non-superuser requests never repeatedly hit Clerk).

**Consulted by every gating layer:**

- `adminAuth.isAdminUser` — superuser is always admin (before ADMIN_USER_IDS + user_roles).
- `credits.deductCredits` + `deductCreditsAtomic` — short-circuit to no-charge regardless of `CREDITS_ENFORCEMENT`.
- Direct-balance preflights that bypass the deduct helpers: `jobs.ts` build/refine preflight, `builds.ts` EAS preflight, `image-generation-jobs.ts` image preflight. (The in-loop senses/creative balance checks only skip metering, never fail a build, so they were left untouched.)
- `billing.ts` Mode 2 workspace plan checkout — superuser branch upserts an active `workspace_subscriptions` row with null Stripe IDs (accepts `free` too) and returns `{ applied:true }` with NO checkout session. `resolveWorkspacePlan` then reflects the tier with no plans.ts change.

**Why:** a single account needed admin + unlimited usage + free plan switching without
touching any other user or the global `CREDITS_ENFORCEMENT`/plan defaults.

**How to apply:** any NEW credit/admin/plan gate that reads balance or role directly
(not via the deduct helpers) must also consult `isSuperuser`, or it will wrongly block
the allowlisted account. Frontend gating is exposed via `isSuperuser` on
`GET /api/billing/subscription/:workspaceId`.
