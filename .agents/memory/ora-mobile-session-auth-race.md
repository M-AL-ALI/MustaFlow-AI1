---
name: Ora Mobile session auth race
description: React child-before-parent effect ordering causes requireAuthToken() to see stale _authIsSignedIn=false on sign-in, sending no bearer and returning free tier.
---

## The Rule

Call `setAuthState(isLoaded, !!isSignedIn)` as the **first statement** in any
`useEffect` that calls `getOraSession()` (or any other `authHeadersRequired`
path), before any `await` or API call.

## Why

React runs child effects before parent effects. `_layout.tsx` (parent) calls
`setAuthState(isLoaded, isSignedIn)` in its `useEffect`. `index.tsx` (child)
calls `getOraSession()` in its own `useEffect`.

`waitForAuthLoaded()` in `requireAuthToken()` only polls when `_authIsLoaded`
is **false**. After the first successful auth load, `_authIsLoaded` is already
true, so subsequent calls resolve immediately — but `_authIsSignedIn` is still
the **old value** from the previous render cycle (false) because `_layout.tsx`'s
effect hasn't fired for this render yet.

Result: bearer token is never sent → server sees anonymous user → session has
no `tier` field → paid users see free tier.

## How to Apply

Every `useEffect` in a child component that calls APIs gated on auth must
mirror `_layout.tsx`'s `setAuthState` call at the top:

```typescript
useEffect(() => {
  if (!isLoaded) return;
  setAuthState(isLoaded, !!isSignedIn);  // ← always first, before any await
  setSessionSyncError(null);
  getOraSession()...
}, [loadPreferences, isSignedIn, isLoaded]);
```

This is idempotent — `_layout.tsx` still calls it too, which is fine.

## Why Website Doesn't Have This Bug

Cookies are sent automatically by the browser on every request. The server
reads them via `clerkMiddleware()` without needing `_authIsSignedIn`. The
module-level auth guard only applies to mobile bearer-token calls.

## Test Coverage

`account-sync-wiring.test.ts` → "index.tsx calls setAuthState before
getOraSession to prevent stale _authIsSignedIn race" verifies the ordering
with source-string position checks.
