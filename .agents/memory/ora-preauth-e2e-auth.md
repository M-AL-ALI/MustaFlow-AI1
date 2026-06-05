---
name: Ora pre-auth endpoint E2E auth
description: Why the standalone Ora chat endpoint needs its own E2E auth simulation, separate from the auth-wall bypass.
---

The standalone Ora assistant endpoint (`/api/public-ai/chat`) is mounted IN FRONT
of the auth wall. It resolves the signed-in user itself by reading the Clerk
session directly (via its own `resolveAuthedOraUser()` resolver), NOT through the
`attachUser()` middleware that guards auth-walled routes.

**Consequence:** the E2E test-auth bypass that `attachUser()` honors (setting
`req.userId` from a test header) never reaches Ora. To make authenticated/paid
Ora flows verifiable in a real browser without Google OAuth, the resolver needs
the SAME guard applied at its own level.

**Rule:** any pre-auth endpoint that does its own session resolution must reuse
the single shared guard `isE2ETestAuthEnabled()` (NODE_ENV !== "production" AND
E2E_TEST_ENABLED === "true") rather than re-implementing the env check or relying
on the middleware bypass.

**Why double-gated:** the test path honors impersonation headers
(`x-e2e-test-user`, optional `x-e2e-test-tier` allowlisted free|core|wave to
simulate a subscription without DB writes). Two independent conditions must both
hold, so it is inert in production. A loud structured boot-time warning fires when
E2E_TEST_ENABLED=true so accidental enablement is immediately visible in logs.

**How to apply:** when adding a new endpoint before the auth wall that needs
authenticated-user behavior under test, gate the test path with
`isE2ETestAuthEnabled()` (exported from `lib/auth.ts`) — do not add a second env
check or a second bypass mechanism.
