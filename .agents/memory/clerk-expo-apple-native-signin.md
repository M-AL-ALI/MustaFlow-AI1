---
name: Clerk Expo native Sign in with Apple
description: Which Clerk Expo API gives the NATIVE Apple sheet (App Store 4.8) vs the web flow Apple rejects
---

For "Sign in with Apple" on iOS in an Expo app using `@clerk/expo`, you MUST use
`useSignInWithApple()` from `@clerk/expo/apple`. Its `startAppleAuthenticationFlow()`
runs the true native flow: `AppleAuthentication.signInAsync` (native sheet / Face ID)
-> `signIn.create({ strategy: "oauth_token_apple", token: identityToken })`, and for
brand-new users automatically `signUp.create({ transfer: true })`. It returns
`{ createdSessionId, setActive }` and swallows `ERR_REQUEST_CANCELED` (silent cancel).

Do NOT use `useSSO().startSSOFlow({ strategy: "oauth_apple" })` on iOS — in
`@clerk/expo` 3.3.1 that unconditionally opens an `ASWebAuthenticationSession`/Safari
web login. A native Apple button that launches a web login is the exact pattern Apple
rejects under Guideline 4.8. `startSSOFlow` oauth_apple is fine only as the non-iOS
(web/Android) fallback.

**Why:** Verified in installed source (`dist/hooks/useSignInWithApple.ios.js` vs
`dist/hooks/useSSO.js`). Apple rejected MustaFlow iOS build 42 for 4.8; the first fix
attempt used the web flow and would have been rejected again — architect review caught it.

**How to apply:**
- Requires `expo-apple-authentication` + `expo-crypto` installed, `app.json`
  `ios.usesAppleSignIn: true` + the `expo-apple-authentication` plugin. (User-side:
  Apple provider enabled in Clerk, App ID "Sign In with Apple" capability + provisioning.)
- Call `useSignInWithApple()` unconditionally (rules-of-hooks safe: iOS variant calls
  useSignIn/useSignUp at top level, non-iOS stub calls no hooks and only throws when the
  returned fn is invoked — so guard the *invocation* with `Platform.OS === "ios"`).
- Metro picks `.ios.js` vs `.js` per platform automatically.
- Web-preview only: `@clerk/expo` logs `Unable to resolve "@clerk/expo"` from a lazy
  `(auth)` route chunk even though the main bundle resolves it fine; this is the known
  web-preview quirk (see clerk-expo-web-preview.md), irrelevant to EAS/iOS builds.
