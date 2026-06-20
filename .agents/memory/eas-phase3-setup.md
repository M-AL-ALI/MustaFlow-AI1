---
name: EAS Phase 3 Setup
description: EAS project link, env vars, first cloud builds for MustaFlow mobile
---

## EAS secret name mismatch
The Expo token was saved in Replit Secrets as `Expo_Token` (mixed case), not `EXPO_TOKEN`.
All EAS CLI commands must prefix with `EXPO_TOKEN="$Expo_Token"`.
Recommend renaming the secret to `EXPO_TOKEN` in Replit Secrets for standard EAS CLI compatibility.

**Why:** EAS CLI reads `EXPO_TOKEN` env var; wrong case means not found, causing auth failure.

## EAS_NO_VCS=1 required in Replit main agent
Replit's bash tool blocks git operations (index.lock creation, git archive).
EAS CLI's default behavior uses git to archive files for upload → blocked.
Fix: prefix every `eas build` command with `EAS_NO_VCS=1`.

**How to apply:** Always use `EAS_NO_VCS=1 EXPO_TOKEN="$Expo_Token" pnpm dlx eas-cli@latest build ...`

## iOS deploymentTarget required
For Expo SDK 54 + React Native 0.81.x + New Architecture, set `ios.deploymentTarget: "16.0"` in app.json.
Without it, CocoaPods install phase fails with "Unknown error. See logs of the Install pods build phase".
Packages requiring 16.0+: react-native-worklets, react-native-keyboard-controller.

**How to apply:** app.json → `"ios": { "deploymentTarget": "16.0", ... }`

## iOS preview profile = simulator build
eas.json preview profile has `ios.simulator: true`.
iOS preview builds are simulator binaries (.app) not real-device IPAs.
For App Store submission, use the production profile (no simulator flag).

## Clerk key gap
All 3 EAS environments (dev/preview/production) currently have `pk_test_...` Clerk key.
Preview and production should use `pk_live_...` when a live Clerk key is available.
Update via: `eas env:update --environment production --name EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY --value pk_live_...`

## Build IDs (Phase 3 first attempt)
- Android preview (in-progress): c2a35ac8-2029-4644-bc68-615857f3fcf6
- iOS preview first attempt (errored): 927ec282 — missing deploymentTarget
- iOS preview retry: queued after adding deploymentTarget: "16.0"
Dashboard: https://expo.dev/accounts/mus192/projects/mustaflow-ai/builds
