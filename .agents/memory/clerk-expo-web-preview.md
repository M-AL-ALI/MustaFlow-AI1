---
name: Clerk-expo web preview script error
description: @clerk/expo throws loadClerkJsScript errors in the web preview but works fine on native iOS/Android
---

When verifying an Expo app that uses `@clerk/expo` via the web preview (the only
screenshot path available for Expo artifacts), a toast/console error like
`(0 , import_loadClerkJsScript.load...)` appears on the sign-in screen.

**Why:** `@clerk/expo` on the web platform tries to load the ClerkJS browser
script; native (Expo Go / device builds) uses Clerk's native token flow instead
and never hits that code path. The error is web-platform-only.

**How to apply:** For native-targeted Expo apps, treat this as a harmless
verification artifact — the screen still renders and the native build is
unaffected. Do not chase a web-only ClerkJS fix when the deliverable is
iOS/Android. Confirm correctness via typecheck + a clean Metro bundle instead.
