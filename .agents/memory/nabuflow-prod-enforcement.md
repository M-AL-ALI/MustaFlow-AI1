---
name: NabuFlow production enforcement flip checklist
description: Env-var invariants for CREDITS_ENFORCEMENT in production and how changes reach the live deployment
---

Production billing-enforcement invariants (verify ALL when touching billing env):

- `production.CREDITS_ENFORCEMENT=true`; `BUILDER_ALLOWLIST` lives in production ONLY, with exactly the owner entry — never in shared/development.
- `BUILDER_OPEN_TO_ALL`, `E2E_TEST_ENABLED`, and `NABUFLOW_BILLING_TEST_BYPASS` must be absent from BOTH `shared` and `production` — **shared env vars reach production**, which is the easy mistake (E2E_TEST_ENABLED once lived in shared). Dev keeps `E2E_TEST_ENABLED=true` in the development environment.
- Defense in depth: `isE2ETestAuthEnabled()` also requires `NODE_ENV !== "production"`, so the header bypass stays dead in prod even if the flag leaks — but the env must still be clean (probe: the live domain returns 401 with an `x-e2e-test-user` header).
- Production env-var changes only reach the live app on the NEXT republish (user-clicked Publish); setting them prepares the flip but the running deployment keeps old values until then. New tables likewise reach prod via startup migrations on the next deploy.
- NabuFlow Stripe objects need no live-mode pre-setup: prices/products self-provision via `lookup_keys` on first use in each environment.

**Why:** the flip is only safe when every bypass lane (open-to-all, e2e header auth, billing test bypass) is provably closed in the environment that actually serves production traffic.

**How to apply:** before flipping or auditing enforcement, run the five-key check across shared/development/production, then probe the live domain anonymously and with the e2e header.
