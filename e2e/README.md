# End-to-end (Playwright) runbook

These specs drive a real browser / HTTP client against the locally-running app
through the shared proxy at `http://localhost:80`.

## Prerequisites

- The app workflows are running (`API Server`, `web`).
- The API server has the test-only env flags set. The bypasses are **double-gated**:
  they only activate when `NODE_ENV !== "production"` **and** `E2E_TEST_ENABLED === "true"`.
  They can never run in production.

| Env var (on the API server) | Required for | Purpose |
| --- | --- | --- |
| `E2E_TEST_ENABLED=true` | all specs | Enables the `x-e2e-test-user` auth bypass and Ora authed test path |
| `ORA_SESSION_SECRET` | `ora-auth` | Required to mint Ora chat sessions |
| `DEV_SLOW_BUILD_DELAY_MS` | `stop-button` | Makes the build pipeline sleep so cancellation is observable |

Optional on the test runner: `E2E_BASE_URL` (defaults to `http://localhost:80`).

## Running

```bash
# all specs
npx playwright test

# a single spec
npx playwright test e2e/ora-auth.spec.ts
```

## The test-only authenticated paths

Two complementary bypasses share the exact same guard
(`isE2ETestAuthEnabled()` in `artifacts/api-server/src/lib/auth.ts`):

1. **Auth-walled routes** — `attachUser()` reads `x-e2e-test-user` and sets
   `req.userId`, so any `/api/...` route behind the auth wall sees a signed-in
   user.
2. **Ora chat (`/api/public-ai/chat`)** — this route sits *in front* of the auth
   wall and reads the Clerk session directly, so `attachUser()` never runs for
   it. `resolveAuthedOraUser()`
   (`artifacts/api-server/src/lib/public-ai/authed-user.ts`) honours the same
   `x-e2e-test-user` header under the identical guard.

### Simulating a subscription tier (Ora paid gating)

Send an optional `x-e2e-test-tier` header alongside `x-e2e-test-user`:

| Header value | Effect |
| --- | --- |
| `core` or `wave` | Treated as a paid user → Deep mode allowed |
| `free` | Treated as a free user → Deep mode denied (Instant + upgrade CTA) |
| (omitted / invalid) | Falls back to the real `user_subscriptions` lookup |

This lets a test exercise paid-only gating **without writing to the database**.

### Example

```ts
const request = await playwright.request.newContext({
  extraHTTPHeaders: {
    "x-e2e-test-user": "e2e-ora-user",
    "x-e2e-test-tier": "core",
  },
});
```

## Safety notes

- The headers are inert unless `E2E_TEST_ENABLED=true` **and**
  `NODE_ENV !== "production"`. In production both bypasses return as if the
  request were anonymous.
- Never set `E2E_TEST_ENABLED` in a production or shared-staging deployment.
