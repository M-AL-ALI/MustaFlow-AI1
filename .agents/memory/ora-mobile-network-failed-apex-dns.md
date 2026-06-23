---
name: Ora Mobile "Network request failed" = apex DNS gap
description: Why on-device Ora Mobile chat fails with "Network request failed" and the domain fix
---

Ora Mobile (Expo) chat failing on-device with RN `TypeError: Network request failed`
(surfaced as "You appear to be offline or the server is unreachable.") is almost
always a **domain/DNS mismatch**, not an app/network bug.

**Root cause:** the app built `API_BASE` from `EXPO_PUBLIC_DOMAIN || "mustaflow.com"`
(the apex). The apex `mustaflow.com` has **no public DNS A record** — `getent hosts
mustaflow.com` / curl returns "Could not resolve host". Only `www.mustaflow.com`
resolves (34.111.179.208, Google Frontend) and serves the live API. On the iPhone,
DNS resolution of the apex fails before any HTTP response → RN throws the TypeError.

**Why it's invisible in dev:** the dev script injects `EXPO_PUBLIC_DOMAIN` from
`$REPLIT_DEV_DOMAIN`, so dev never hits the apex default. Only EAS/TestFlight builds
(which set/leave the apex value) break.

**Fix:** point every domain source at the resolvable host `www.mustaflow.com`:
`eas.json` (testflight + production `env.EXPO_PUBLIC_DOMAIN`), `lib/api.ts` default
fallback, `app/_layout.tsx` `setBaseUrl` fallback, `app.json` expo-router `origin`,
and the `.env.example` doc.

**How to verify without a build (sandbox curl == external client over public DNS/TLS):**
- `curl https://www.mustaflow.com/api/healthz` → 200
- `POST /api/public-ai/session` → 200 (returns sessionId, msgLimit:20)
- `POST /api/public-ai/chat {"message":"hi","messages":[]}` → 200 with `reply`
- `POST /api/public-ai/chat/stream` → 200 `text/event-stream`, `x-accel-buffering:no`, `event: token` deltas
Valid TLS on www means iOS ATS is satisfied (no cleartext/weak-TLS exception needed).

**Why (durable):** publish/DNS config is environment reality the code cannot reveal;
always confirm the chosen host actually resolves over public DNS before trusting an
apex-vs-www default. Prefer the host that serves the live deployment.
