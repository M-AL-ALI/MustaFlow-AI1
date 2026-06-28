---
name: Ora Mobile auth-stability guard
description: How the mobile app ensures signed-in + missing Clerk token always fails closed (never silently anonymous).
---

## The rule

When `isSignedIn=true` in Clerk but `getToken()` returns null, the app MUST throw `TokenUnavailableError` — never proceed with an anonymous API call. A user who believes they are signed in must never silently get anonymous/free responses.

## How it is wired

1. **`lib/auth-client.ts`** — module-level `_authIsSignedIn` flag + `setAuthState(isLoaded, isSignedIn)` setter + `requireAuthToken()` that retries once (300ms) then throws `TokenUnavailableError`.

2. **`app/(home)/_layout.tsx`** — `HomeLayout` calls `setAuthState(isLoaded, isSignedIn ?? false)` in a `useEffect` whenever Clerk auth state changes (separate from the tokenGetter useEffect).

3. **`lib/api.ts`** — `pathRequiresAuth(path)` matches the guarded route prefixes:
   - `/api/ora/*`, `/api/me/*`, `/api/orax/*`, `/api/billing/subscription`
   - exact `/api/public-ai/chat`, `/api/public-ai/usage`
   - `/api/public-ai/realtime/session`
   `jsonRequest()` picks `authHeadersRequired` when `pathRequiresAuth(path)` is true; `authHeaders` (silent/anonymous) otherwise.
   `streamChatNative` also uses `authHeadersRequired` directly.

4. **`app/(home)/settings.tsx`** — Account Sync section now shows "Local signed in", "Token present", "Server recognized", "Ora session auth" rows; `runAccountCheck` catches `TokenUnavailableError` specifically (sets `acctTokenPresent=false` + `acctTokenMissing=true` without overwriting `acctError` with the technical message).

## Anonymous-OK routes (intentionally NOT in pathRequiresAuth)

- `/api/public-ai/session` (Ora session/quota creation — anonymous OK)
- `/api/public-ai/realtime/diagnostics`, `/api/public-ai/realtime/heartbeat`, `/api/public-ai/realtime/end` (mid-session calls)
- `/api/public-ai/tts`, `/api/public-ai/transcribe`
- `/api/public-ai/upload`, image-analysis, export-file, etc.

**Why:** These endpoints serve anonymous users by design or are called during an already-established session where re-checking the token would be disruptive.

## Test coverage

`lib/__tests__/account-sync-wiring.test.ts` — 8 new tests in "Mobile auth-stability guard" describe block verify the full wiring chain is present in source.
