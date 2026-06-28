---
name: EAS Clerk dev-vs-live key trap (mobile signed-in but anonymous/free)
description: Why an Expo TestFlight/prod build can authenticate against the DEV Clerk instance and get 401 on every authed prod route, and the eas.json config that fixes it.
---

# Mobile "signed in" but resolves anonymous/free + 401 on every authed route

## Symptom
Ora Mobile UI shows the user as signed in, but Account sync says "Unauthenticated", plan tier is wrong, and projects/memories/history don't load — i.e. every authenticated production API call 401s and Ora falls back to anonymous/free.

## Root cause
The EAS build baked the **DEV** Clerk publishable key (`pk_test_...`, dev instance host like `loyal-puma-95.clerk.accounts.dev`) with **no** `EXPO_PUBLIC_CLERK_PROXY_URL`. The device's `@clerk/expo` reaches the dev Clerk FAPI directly (publicly reachable, so sign-in *succeeds* and mints a **dev** token), but the published server verifies against the **LIVE** Clerk instance and rejects every dev-instance token.

**Why:** Replit's web publish swaps the web app + API server Clerk keys to live *together*, so the website works. EAS/TestFlight is a **separate pipeline** that never receives that live swap — it only gets whatever is in `eas.json` env / EAS server env vars. A `.env.example` that says "leave the proxy URL empty for EAS builds" will reproduce this bug.

## Fix (config only — never change app/Ora logic for this)
In `artifacts/ora-mobile/eas.json`, for **both** the `testflight` and `production` profiles, pin:
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` = the LIVE `pk_live_...` key (instance `clerk.www.mustaflow.com`)
- `EXPO_PUBLIC_CLERK_PROXY_URL` = `https://www.mustaflow.com/api/__clerk`
- `EXPO_PUBLIC_DOMAIN` = `www.mustaflow.com` (apex has no DNS A record; www resolves + serves the Clerk proxy)

Then delete any stale production-scoped EAS *server* env vars for the same names so `eas.json` is the single source of truth (eas.json env overrides EAS server vars, but the stale ones are a landmine). A Clerk publishable key is public client config, not a secret — safe to commit in `eas.json`.

Config bakes at build time, so an existing build can't be repaired in place — cut a fresh build.

## How to apply / diagnose
Any "mobile signed in but treated anonymous/free" or "401 on all authed routes only on the device" report: first inspect the **baked** `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` (pk_test vs pk_live) and proxy URL in the build before touching app code. The live key is publicly derivable from the published web bundle; verify the proxy with `GET https://www.mustaflow.com/api/__clerk/v1/environment` → 200.

## Device-state caveat (architect-flagged)
After installing the corrected build, an upgraded app can retain the old dev Clerk SecureStore/session state (may look signed out, or stale). Have the user delete + reinstall (or sign out/in) under the live key before running QA.

## Related profiles
`development`/`preview` EAS profiles are intentionally NOT production-pinned, so internal-QA builds from those profiles can still use dev/missing Clerk config. That does not affect store (`testflight`/`production`) builds.
