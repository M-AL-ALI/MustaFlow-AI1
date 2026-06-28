---
name: Ora Mobile auth-stability guard
description: How the mobile app ensures signed-in + missing Clerk token always fails closed (never silently anonymous). Includes the isLoaded race fix and Account Sync probe.
---

## The rule

When `isSignedIn=true` in Clerk but `getToken()` returns null, the app MUST throw `TokenUnavailableError` — never proceed with an anonymous API call. A user who believes they are signed in must never silently get anonymous/free responses.

## The isLoaded startup race (build #29 fix)

React runs **child effects before parent effects**. `index.tsx` (child of `_layout.tsx`) fires its `getOraSession()` useEffect before `_layout.tsx` runs `setAuthState(isLoaded, isSignedIn)`. This means `_authIsLoaded=false` inside `requireAuthToken()`, which previously caused a race where the session was created as anonymous even for paid users.

**Double-gate fix:**
1. `index.tsx` destructures `isLoaded` from `useAuth()` and early-returns from the session effect when `!isLoaded`. Effect re-runs once Clerk loads.
2. `auth-client.ts` adds `waitForAuthLoaded(maxMs=1500)` — polls `_authIsLoaded` every 100ms — as a belt-and-suspenders fallback for other callers of `requireAuthToken()`.

**`sessionSyncError` state:** When the session effect catches `TokenUnavailableError` it sets `sessionSyncError="token_unavailable"` and does NOT call `setSession(null)` (which would create an anonymous session). A red re-sync banner renders in the chat UI; tapping it retries `getOraSession()`.

## How it is wired

1. **`lib/auth-client.ts`** — module-level `_authIsLoaded`/`_authIsSignedIn` flags + `setAuthState(isLoaded, isSignedIn)` setter + `waitForAuthLoaded(1500ms)` + `requireAuthToken()` that waits for load, retries once (300ms), then throws.

2. **`app/(home)/_layout.tsx`** — `HomeLayout` calls `setAuthState(isLoaded, isSignedIn ?? false)` in a `useEffect` whenever Clerk auth state changes.

3. **`lib/api.ts`** — `pathRequiresAuth(path)` matches guarded route prefixes:
   - `/api/ora/*`, `/api/me/*`, `/api/orax/*`, `/api/billing/subscription`
   - exact `/api/public-ai/session`, `/api/public-ai/chat`, `/api/public-ai/usage`
   - `/api/public-ai/realtime/session`
   `jsonRequest()` picks `authHeadersRequired` when `pathRequiresAuth(path)` is true; `authHeaders` (silent/anonymous) otherwise.
   `streamChatNative` also uses `authHeadersRequired` directly.

4. **`lib/session-store.ts`** — module-level store (`setCurrentSessionTier`, `getCurrentSessionTier`, `getCurrentSessionIsPaid`). `index.tsx` writes to it after a successful session load; `settings.tsx` reads from it during Account Sync without needing a React context.

5. **`app/(home)/settings.tsx`** — Account Sync:
   - Shows "Local signed in", "Token present", "Server recognized", "Ora session auth" rows.
   - Also probes `getOraSession()` live during each check to show "Public session tier", "Local session tier", "Session authenticated" rows.
   - `acctPublicSessionMismatch`: billing paid but probe returned free → red warning.
   - `runAccountCheck` catches `TokenUnavailableError` specifically; sets `acctTokenPresent=false` + `acctTokenMissing=true` without overwriting `acctError`.
   - Plan & billing card shows `subscriptionError` banner with Retry instead of silently defaulting to Free.

## Anonymous-OK routes (intentionally NOT in pathRequiresAuth)

- `/api/public-ai/realtime/diagnostics`, `/api/public-ai/realtime/heartbeat`, `/api/public-ai/realtime/end` (mid-session calls)
- `/api/public-ai/tts`, `/api/public-ai/transcribe`
- `/api/public-ai/upload`, image-analysis, export-file, etc.

**Why:** These endpoints serve anonymous users by design or are called during an already-established session where re-checking the token would be disruptive. NOTE: `/api/public-ai/session` is NOW guarded (in pathRequiresAuth) so signed-in users always get their paid tier assigned.

## Test coverage

`lib/__tests__/account-sync-wiring.test.ts` — 41 tests across 2 describe blocks verify the full wiring chain in source, including the isLoaded gate, session-store writes, TokenUnavailableError handling, public session probe, and subscription error UI.
