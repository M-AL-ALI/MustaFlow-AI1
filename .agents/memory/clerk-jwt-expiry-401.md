---
name: Clerk dev-mode JWT expiry and 401 recovery
description: Why spurious 401 "Session expired" 401s happen in dev with Clerk, and the permanent bearer-token fix.
---

## The problem

Clerk dev-mode JWTs expire every **60 seconds**. Inside the Replit preview iframe the session cookie is a cross-site cookie and is not always refreshed in time, so any API request that relies on the cookie alone intermittently returns 401 even though the user is genuinely signed in. The visible symptom is the "Session expired. Sign in again to continue." banner (raised by the AI Builder stream error handler).

Diagnostic confirmation: `__session`, `__client_uat`, `__clerk_db_jwt` cookies were all present (`hasSessionCookie: true`) but `authUserId` was null during the refresh window.

## The permanent fix — send a fresh bearer token on every API call

**Why cookie-only fails and bearer succeeds:** the backend `getAuth(req)` (ClerkAuthAdapter) reads BOTH the cookie AND an `Authorization: Bearer` header. A freshly-minted token (Clerk `getToken()`) verifies even when the cookie JWT is stale. So the rule is: every authenticated request must carry a fresh bearer token, not just the cookie.

**How it's wired:**

- Orval-generated hooks already attach the token via the global getter registered in App.tsx `ClerkTokenProvider` → `setAuthTokenGetter(() => getToken())`.
- `getAuthToken()` in `lib/api-client-react/src/custom-fetch.ts` exposes that same getter for raw `fetch` callers (returns null in E2E mode → cookie fallback).
- `authFetch()` in `artifacts/mustaflow/src/lib/api-fetch.ts` is the drop-in `fetch` wrapper: attaches the bearer token (same-origin guard) + `credentials:"include"`. **All** authenticated raw `fetch("/api/...")` calls in the frontend were migrated to `authFetch`. The SSE stream POST/resume in `[id].tsx` fetch the token inline per attempt (can't use authFetch — they need the streaming Response body + AbortSignal).

**How to apply:** never call `fetch("/api/...")` directly for an authenticated endpoint — use `authFetch` or an Orval hook. Public pre-auth endpoints (`/api/public-ai/*`, `/api/builder/handoff/*`, `/api/status`) intentionally stay raw `fetch`.

## Secondary backend fix — static clerkMiddleware

Use the **static form** `clerkMiddleware()` (reads env), NOT the callback form `clerkMiddleware((req) => ({...}))`. The callback form re-creates the Clerk SDK per request, defeating JWKS caching and causing additional intermittent verification failures.

**Why:** static form builds one SDK per process so JWKS are cached for the process lifetime.

## authFetch same-origin guard (security)

`authFetch` attaches the bearer token only when the target is same-origin. Classify with `new URL(input, window.location.href).origin === window.location.origin` (in try/catch) — NOT a `scheme://` regex. A regex-style check treats protocol-relative `//host/...` as "relative" and leaks the token cross-origin. The `new URL(..., base)` form resolves `//host`, absolute, and `data:`/`javascript:` correctly. Put `credentials:"include"` AFTER the `...init` spread so callers can't drop the cookie fallback. Covered by `api-fetch.test.ts`.
