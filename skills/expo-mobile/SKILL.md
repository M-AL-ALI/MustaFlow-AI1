---
name: expo-mobile
description: Build Expo SDK 52 cross-platform mobile apps with Expo Router v3 and NativeWind v4.
triggers: [mobile, ios, android, expo, react native, native, app store, phone, tablet]
---

# Expo Mobile skill

Use this skill for any mobile app request (iOS, Android, cross-platform). The
generator produces an Expo project AND an `index.html` web preview so the
existing preview pipeline can render it inside the Replit iframe.

## Required structure

- `app.json` — `name`, `slug`, `version: "1.0.0"`, `orientation: "portrait"`, `userInterfaceStyle: "automatic"`.
- `package.json` — Expo SDK 52, Expo Router v3, NativeWind v4. React Native 0.76+.
- `app/_layout.tsx` — root `<Stack>` from `expo-router`.
- `app/index.tsx` — entry screen.
- `tailwind.config.js` + `nativewind-env.d.ts` — NativeWind configured for the `app/**/*.{ts,tsx}` glob.
- `babel.config.js` — `babel-preset-expo` + `nativewind/babel`.
- `index.html` — a static web preview (Tailwind/lucide via CDN) that mirrors the screens for the in-app preview.

## Do

- Use Expo Router (`Link`, `Stack`, `Tabs`) for navigation — never bare React Navigation.
- Use NativeWind className syntax: `<View className="flex-1 bg-slate-950 px-6">`.
- Use `expo-image`, `expo-haptics`, `expo-blur`, `expo-linear-gradient` for premium feel.
- Use SafeAreaView from `react-native-safe-area-context` on every screen.
- Request permissions via the appropriate Expo module (`expo-camera`, `expo-location`) — wrap calls in try/catch with a graceful fallback.
- Touch targets ≥ 44pt. Use `Pressable` (not `TouchableOpacity` legacy).

## Don't

- No `react-native-cli`-only APIs. Stick to Expo-managed workflow.
- No raw `<Image source={{ uri }} />` for static assets — use `expo-image` for caching.
- No web-only CSS units (`vh`, `vw`, `rem`). Use NativeWind utilities or numeric pixel values.
- No `alert()`. Use `Alert.alert()` from `react-native`.
- Do not skip the `index.html` web preview — the preview tab needs it.

## index.html web preview rules

- Tailwind via CDN, lucide via CDN.
- Render a phone-frame mockup of each screen.
- Use realistic placeholder data, not lorem ipsum.
- No interactivity beyond simple in-page navigation between mocked screens.
