---
name: Ora realtime voice session start race-safety
description: Why startRealtimeSession needs a per-usageKey advisory lock, not just a select-then-insert concurrency check.
---

# Ora realtime (Talk to Ora) live-voice session concurrency

The "max 1 active live-voice session per usage key" guarantee is enforced inside
`startRealtimeSession` by SELECTing for an active session and then INSERTing a new
one. That select-then-insert is **NOT race-safe** on its own: two parallel
`/public-ai/realtime/session` calls for the same usageKey can both observe "no
active session" and both INSERT, defeating the cap and double-spending the
per-plan voice-minute budget (each session charges its own elapsed time on
heartbeat).

**Rule:** the transaction must take a per-usageKey lock as its FIRST statement:
`SELECT pg_advisory_xact_lock(hashtext(${usageKey}))`. It serializes same-key
starts and is released automatically at COMMIT. Different keys hash to different
locks, so unrelated users are not serialized.

**Why:** architect review caught this; the original sequential "concurrent"
unit test passed (it awaited the first start before the second), so the race was
invisible. A `Promise.all([start, start])` parallel test is what actually proves
it — one returns "ok", the other "concurrent", and exactly one active row exists.

**How to apply:** any "check a non-unique column, then insert if absent"
concurrency/uniqueness guard inside a transaction is racy. Fix it with either a
partial unique index (e.g. unique on usageKey WHERE status='active') or a
per-key `pg_advisory_xact_lock`. Always cover it with a true parallel test, not a
sequential one.
