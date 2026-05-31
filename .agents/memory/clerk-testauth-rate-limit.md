---
name: Clerk testClerkAuth rate limiting
description: testClerkAuth:true in runTest hits Clerk dev-key rate limits; once blocked the subagent refuses all further tests. Workaround uses DevOnlyAuthAdapter for API-level proof.
---

## Rule
`testClerkAuth: true` in `runTest()` creates real Clerk test users against the dev key. Clerk dev keys have strict usage limits. After several test runs in one session the subagent records a "blocked" state that persists for the remainder of the notebook session — even after `restart: true`.

**Why:** Clerk dev keys throttle test-user creation. The testing subagent treats repeated auth failures as a signal that the entire test environment is auth-blocked and refuses to proceed.

**How to apply:**
- Space Playwright auth tests — avoid rapid-fire retries within the same session.
- If blocked, the backend can be validated via `DevOnlyAuthAdapter` as a temporary swap in `artifacts/api-server/src/lib/auth.ts` (line 72), restored immediately after testing.
- DevOnlyAuthAdapter sets `req.userId = "demo-user"` for all requests; it hard-fails in production (`NODE_ENV=production`).
- The swap-restore sequence: edit → restart API server → test via curl → restore → restart API server.
- Clerk sign-in token URLs (`POST https://api.clerk.com/v1/sign_in_tokens` with `CLERK_SECRET_KEY`) can be generated via bash and used in browser navigation steps, but the Playwright subagent may still be in "blocked" state and refuse to run.
- Rate limits clear over time (typically within an hour); retry the Playwright test in a fresh session.
