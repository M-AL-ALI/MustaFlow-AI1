---
name: Clerk dev-mode JWT expiry and 401 recovery
description: Why spurious 401s happen in dev with Clerk, and the two-part fix applied.
---

## The problem

Clerk dev-mode JWTs expire every **60 seconds**. During the ~3–5 s window between expiry and the Clerk JS SDK issuing a fresh cookie, any server request returns 401 even though the user is genuinely signed in.

A second compounding issue was found: `clerkMiddleware((req) => ({ secretKey, publishableKey }))` — the **callback form** — re-creates the Clerk SDK instance on every single request. This prevents JWKS caching, so JWKS entries are re-fetched and can intermittently fail to verify, causing additional spurious 401s that are unrelated to the JWT expiry window.

Diagnostic confirmation: `__session`, `__client_uat`, `__clerk_db_jwt` cookies were all present on the request (`hasSessionCookie: true`), but `authUserId` was null — proving cookies were sent but JWKS verification was failing.

## Fix 1 — backend (`app.ts`)

Use the **static form** of `clerkMiddleware` so the Clerk SDK is created once per process and JWKS are cached for the process lifetime:

```ts
// WRONG — re-creates SDK per request, prevents JWKS caching
app.use(clerkMiddleware((req) => ({ secretKey: ..., publishableKey: ... })));

// CORRECT — reads from env vars, one SDK, JWKS cached
app.use(clerkMiddleware());
```

**Why:** The static form reads `CLERK_SECRET_KEY` and `CLERK_PUBLISHABLE_KEY` from env (set by Clerk's Replit integration) and builds one SDK instance for the process lifetime. JWKS are cached and periodically refreshed by the Clerk SDK internally.

## Fix 2 — frontend (`[id].tsx` stream fetch)

Added a single auto-retry on 401 before the connection is established:

```ts
if (resp.status === 401 && !connectionEstablished && attempt === 0) {
  await new Promise<void>((r) => setTimeout(r, 3000));
  attempt += 1;
  continue;
}
```

**Why:** If the user clicks "Send" exactly when the JWT is mid-refresh, the stream POST returns 401. Waiting 3 s covers the full Clerk refresh window, then the retry uses the fresh cookie. If the retry also fails (e.g. truly signed out), the normal "Session expired / Sign in again" error is shown.

## Fix 3 — frontend "Refresh page" button

Changed from `window.location.reload()` to `window.location.href = '/sign-in?redirect_url=...'`. A plain reload re-initializes Clerk with the same (possibly stale) cookie; redirecting to `/sign-in` forces Clerk to issue a fresh session.

## How to apply

- Never use the callback form of `clerkMiddleware` in production.
- The 3 s retry is intentionally only on `attempt === 0`; a second 401 means the user is genuinely unauthenticated and should be asked to sign in.
