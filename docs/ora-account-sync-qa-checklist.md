# Ora Account-Sync — Same-Account QA Checklist

Purpose: verify that the SAME Clerk user resolves to the SAME server-side
identity, plan, and per-user data on both the website and the mobile app. The
backing endpoint is `GET /api/ora/account-consistency` (protected; behind
`attachUser`). It returns only privacy-safe diagnostics: a sha256 fingerprint of
the user id (first 12 chars) plus the last 4 of the Clerk id, never the raw id,
and never message/memory content or payment details.

## Preconditions

- One Clerk account used on both surfaces.
- Website running (`pnpm --filter @workspace/mustaflow run dev`) and API server
  running (`pnpm --filter @workspace/api-server run dev`).
- Mobile app pointed at the same API host (`EXPO_PUBLIC_DOMAIN`), signed in with
  the same account.

## A. Signed-out (anonymous) behavior

1. Website, signed out: the Account sync section requires sign-in; the endpoint
   returns 401 for anonymous callers.
2. Mobile, signed out: "Check account sync" surfaces the anonymous/free state;
   the fingerprint shows `anonymous`. No crash, no Stripe/checkout UI.

## B. Same-account parity (the core check)

Sign in as the same user on both surfaces, run the check on each, and compare:

1. Account fingerprint (`identity.userIdHash`) — MUST match across web + mobile.
2. Account id ending (`identity.clerkUserIdLast4`) — MUST match.
3. Email — MUST match.
4. Billing plan (`billing.billingTier`) — MUST match.
5. Chat plan (`chatSession.tier`) and paid flag — MUST match.
6. Counts — conversations, projects, saved memories (scope=user, origin=ora),
   project memories, assets, support tickets — MUST match.
7. API host + environment — confirm both surfaces hit the same host/environment.

If any of 1-6 differ, the two surfaces are NOT resolving the same account.

## C. Mismatch / warning behavior (mobile)

1. Signed-in-but-no-token: if the device is signed in locally but no Clerk token
   reaches the server, the chat tier row and a red warning appear stating Ora
   will resolve as anonymous/free until sign-in is fixed.
2. Billing paid but chat free: if `billing.sourceTier` is `core`/`wave` but the
   chat session resolves free, the Chat tier row is flagged red with a plan
   mismatch warning. This indicates the device is not authenticating as the same
   paid user.

## D. Privacy / isolation guarantees

1. Response never contains the raw user id (only hash + last4).
2. Response never contains message or memory content.
3. Counts are filtered by the calling user only — no cross-user leakage.
4. Memory counts use scope=user, origin=ora, archivedAt IS NULL.
5. No payment/card details are returned; mobile has no Stripe/checkout path.

## E. Automated coverage

- Backend: `artifacts/api-server/src/routes/__tests__/ora-account-consistency.test.ts`
  (401 signed-out, hash present, per-user counts, no cross-user leak, origin=ora
  memory only, superuser tier).
- Website wiring: `artifacts/mustaflow/src/pages/__tests__/ora-account-sync-wiring.test.ts`.
- Mobile wiring: `artifacts/ora-mobile/lib/__tests__/account-sync-wiring.test.ts`
  (includes a guard that mobile settings has no Stripe/checkout path).

## F. Out of scope

- No native build, EAS, or TestFlight submission is part of this verification.
- Live signed-in browser/device runs may be limited by Clerk dev-key throttling;
  rerun manually in a fresh authenticated session when needed.
