---
name: Ora realtime route test strategies
description: The two Talk-to-Ora realtime route test files use opposite DB strategies; the real-DB one is latently broken.
---

# Ora realtime route test strategies

The Talk-to-Ora realtime route (`routes/public-ai/realtime.ts`) has two test
files that take **opposite** approaches to the DB-backed metering service
`lib/public-ai/ora-realtime-usage`:

- `realtime-metering.test.ts` **mocks** `ora-realtime-usage` via
  `vi.mock(..., importOriginal)` and stubs `startRealtimeSession` /
  `heartbeatRealtimeSession` / `endRealtimeSession` / `getRealtimeUsage` per
  test. It never touches the real DB, so it is stable.
- `realtime-session.test.ts` does **not** mock the service, so it exercises the
  real Postgres metering through the route.

**Two latent bugs in `realtime-session.test.ts` (it has never actually
collected on main, so no one caught these):**

1. Its `vi.mock("../../../lib/rateLimit", ...)` only stubs
   `oraRealtimeSessionLimiter` and omits `oraRealtimeSessionTickLimiter`, which
   the heartbeat + end routes import. Missing export → the whole suite fails to
   collect (hard error, 0 tests run).
2. Even with that mock added, the tier-duration and memory-gating tests share a
   fixed `userId` (`user_123` / `user_mem`), start real sessions, and never call
   `/end` or clean up between tests. The concurrency rule (max 1 active session
   per usageKey) then returns `409` on the 2nd/3rd request, cascading into
   `undefined maxDurationSeconds` and `calls[0]`-of-undefined failures.

**Why this matters / how to apply:** if you make `realtime-session.test.ts`
collect (add the tick-limiter mock), expect 7 real-DB failures. To make it
green you must either (a) add a `beforeEach` that deletes the test usageKeys'
rows from `ora_realtime_sessions` + `ora_realtime_usage_windows` (mirrors the
DB-backed `ora-realtime-usage.test.ts` pattern), or (b) switch it to mock
`ora-realtime-usage` like `realtime-metering.test.ts` (but then the per-tier
duration assertions become assert-what-you-mock and lose end-to-end value).

The per-tier duration arithmetic (free 1200 / core 3600 / wave 7200 seconds,
matching the per-window budget so a single session can use the full allowance)
is already validated end-to-end by the DB-backed `ora-realtime-usage.test.ts`,
which passes. Treat that as the authoritative cap test.
