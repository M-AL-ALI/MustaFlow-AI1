---
name: Ora Mobile current status
description: What exists, what was fixed in Phase 1, and what remains for production readiness.
---

## What the app is

Expo SDK 54 / React Native 0.81.5 / Expo Router v6 + Drawer navigation.
Located in `artifacts/ora-mobile`. Full Clerk auth (sign-in required, no anonymous mode per user decision). Orax screen kept (user decision).

## What is fully working (code is complete)

- Chat screen with SSE streaming + /chat fallback
- Voice: STT via /api/public-ai/transcribe (Whisper), TTS via /api/public-ai/tts (audio/mpeg → expo-audio)
- Talk Mode (continuous voice loop)
- File upload (PDF, DOCX, TXT, CSV, XLSX, images) via /api/public-ai/upload
- Image analysis, document analysis, dataset analysis
- Conversation persistence via /api/ora/conversations/*
- Memory management /api/ora/memories
- Profile /api/ora/profile
- Asset library /api/ora/assets
- Orax screen (codebase analysis)
- Clerk auth (sign-in, sign-up, token refresh, secure storage)
- Safe-area, dark mode, haptics, Markdown rendering

## Phase 1 fixes applied (commit 6333a57b)

- app.json name: "MustaFlow" → "Ora by MustaFlow"
- expo-router origin: https://replit.com/ → https://mustaflow.com
- Added expo-image-picker plugin to app.json with cameraPermission + photosPermission strings
- Camera capture + gallery pick wired in chat screen: doUpload helper, handleCameraCapture, handleGalleryPick; Paperclip now shows Alert.alert action sheet (Take Photo / Photo Library / Browse Files)
- eas.json: EXPO_PUBLIC_ORA_STREAMING_ENABLED=true in all build profiles
- .env.example created with all required env vars documented
- expo-audio bumped ~1.0.16 → ~1.1.1 (SDK 54 expectation)

## What remains before native build

1. `EXPO_PUBLIC_DOMAIN` must be set in EAS secrets or eas.json production env to the deployed API domain
2. `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` must be a live Clerk key in EAS secrets for production builds
3. `eas build --profile development --platform ios` (and android) to produce actual native binaries
4. Bundle IDs: both iOS/Android use `com.mustaflow.app` — if main MustaFlow Builder app uses same ID, they will conflict in App Store/Play Store. Consider `com.mustaflow.ora`.
5. App icon: `./assets/images/icon.png` — needs Ora-branded icon for store submission
6. Privacy policy URL required for App Store submission

## Visual + feature parity pass (complete)

Source-verified against `ora-panel.tsx`. Fonts (Inter), dark color tokens, and plan
accents already matched (no change needed). Applied: native `OraAtom` (RN svg mirror
of web DOM-only DynamicAtom) used in empty state + assistant avatar; empty state now
"Hi, I'm Ora" + website subtitle + the exact 6 example chips (tap sends); user bubble
muted bg + foreground text; assistant restructured bubble-less (atom avatar + content)
to match web; sensitive-memory warning note added to the save chip. Architect review
PASS. See `ora-mobile-web-parity.md` for the durable decisions.

## API compatibility

All mobile API calls hit the real Ora backend. No backend changes needed. CORS is origin:true + credentials:true which accepts bearer tokens from mobile.

## Key env vars for the mobile app

- `EXPO_PUBLIC_DOMAIN` — API base domain (no https://, no trailing slash)
- `EXPO_PUBLIC_ORA_STREAMING_ENABLED` — "true" to enable SSE streaming
- `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` — Clerk publishable key
- `EXPO_PUBLIC_CLERK_PROXY_URL` — Replit dev only, empty for EAS/production
