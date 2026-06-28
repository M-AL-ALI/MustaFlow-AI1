---
name: Ora realtime route test strategies
description: How the three Talk-to-Ora realtime test files split responsibilities; which one owns DB cap arithmetic.
---

# Ora realtime route test strategies

The Talk-to-Ora realtime route (`routes/public-ai/realtime.ts`) is covered by
three test files with a deliberate division of labor. Keep them in their lanes:

- `realtime-session.test.ts` ? mint config / Ora<->Builder isolation / voice /
  VAD / privacy / route response shape. It **mocks** the DB-backed metering
  service `lib/public-ai/ora-realtime-usage` with a self-contained mock: static
  `getRealtimeVoiceAllowance` values + `REALTIME_HEARTBEAT_INTERVAL_SECONDS`,
  and stubs for the four stateful fns (`startRealtimeSession` /
  `heartbeatRealtimeSession` / `endRealtimeSession` / `getRealtimeUsage`). Do
  **not** call `importOriginal` here: importing the real module requires
  `DATABASE_URL` at module load, so the route/config suite fails to collect in
  non-DB environments. It must also stub BOTH `oraRealtimeSessionLimiter` AND
  `oraRealtimeSessionTickLimiter` in the `lib/rateLimit` mock ? the
  heartbeat/end routes import the tick limiter at module load, and omitting it
  makes the whole suite fail to collect (0 tests).
- `realtime-metering.test.ts` — budget->HTTP mapping edge cases (over_limit 429,
  concurrent 409, DB-down 503 fail-closed). Same mock pattern.
- `ora-realtime-usage.test.ts` — the authoritative DB-backed cap test. Owns the
  per-tier minute arithmetic (free 1200 / core 3600 / wave 7200 s; window hours
  free 5 / core,wave 3), atomic heartbeat delta, stale finalize, idempotent end,
  concurrency. This is the ONLY file that hits real Postgres.

**Why this split:** an earlier `realtime-session.test.ts` ran the real DB
through the route and was latently broken (shared userIds + no `/end` cleanup ->
409 concurrency cascade, plus a missing tick-limiter mock). Mocking the service
there removed the flakiness while keeping cap arithmetic end-to-end in
`ora-realtime-usage.test.ts`. Don't re-introduce real-DB metering into the route
config suite.

**`voice-session.test.ts` source-string parity gotcha:** it asserts EXACT mobile
home (`app/(home)/index.tsx`) label literals. The realtime status copy uses
em-dashes (`—`, e.g. "Muted — Ora can still hear you") while the legacy voice
loop copy uses hyphens (`-`, e.g. "Muted - replies stay on screen"). Reword
either side and you must update the matching assertion or the test fails.
