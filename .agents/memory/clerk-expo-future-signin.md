---
name: Clerk @clerk/expo future sign-in/up resource API
description: The "future" useSignIn()/useSignUp() resource shape in @clerk/expo 3.3.1 and how to handle multi-step verification correctly in the Ora mobile app.
---

# Clerk @clerk/expo "future" auth API (ora-mobile)

`@clerk/expo` 3.3.1 (deps `@clerk/shared` ^4.15.0) exposes the **future** resource API, not the legacy `setActive`/`signIn.create`/`prepareSecondFactor` flow.

`useSignIn()` returns `{ signIn, errors, fetchStatus }` (NOT `{ isLoaded, signIn, setActive }`). Key `signIn` surface:
- `signIn.status`: `needs_identifier | needs_first_factor | needs_second_factor | needs_client_trust | needs_new_password | complete`
- `signIn.password({ emailAddress | identifier, password })`
- `signIn.emailCode.sendCode()/.verifyCode({ code })`, `signIn.phoneCode.*`
- `signIn.mfa.{sendPhoneCode,verifyPhoneCode,sendEmailCode,verifyEmailCode,verifyTOTP,verifyBackupCode}` — all verify params are `{ code }`
- `signIn.supportedSecondFactors[]` (each `.strategy` = `totp|phone_code|email_code|backup_code`), populated only once status is `needs_second_factor`
- `signIn.resetPasswordEmailCode.*`, `signIn.finalize({ navigate })`, `signIn.reset()`
- Every method returns `{ error: ClerkError | null }`.

## Rule: never dead-end on non-`complete` status
The classic bug: after `signIn.password()`, only handling `status === "complete"` and showing "Additional verification is required" for everything else → user is stuck (2FA accounts, new-device/client-trust). Must dispatch on `signIn.status`: `complete`→finalize; `needs_second_factor`→inspect `supportedSecondFactors` + drive `mfa.*`; `needs_first_factor`/`needs_client_trust`→`emailCode.sendCode()`+`verifyCode()`; then re-dispatch to chain steps.

**Why:** the resource is a mutable proxy — reading `signIn.status` right after an awaited method reflects the new state (same pattern `sign-up.tsx` already relies on), so a single `routeAfterFactor()` re-run handles chained factors (email code → then 2FA).

## Finding the types
The d.ts is a gitignored pnpm symlink: `node_modules/.pnpm/@clerk+shared@<ver>_*/node_modules/@clerk/shared/dist/types/index.d.ts`. `rg` needs `--no-ignore` and the explicit `.pnpm` path. Search `interface SignInFutureResource`.
