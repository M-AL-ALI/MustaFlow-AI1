---
name: Talk to Ora live-voice per-plan minute budgets
description: The per-plan realtime voice minute-budget feature is fully built+tested; verify, do not rebuild when re-spec'd.
---

# Talk to Ora live-voice per-plan minute budgets — COMPLETE, do not rebuild

A detailed-looking "add per-plan live voice minute limits + improve performance"
spec for Talk to Ora is **already fully implemented and tested**. Treat such a
request as a verify-only task unless live QA shows a specific bug with evidence.

**Why:** the user has twice handed a from-scratch-style spec for this; rebuilding
risks regressing the tuned focus/language gating (`bargeInRequiresDirection`,
12s cold-start / 4s follow-up windows). They explicitly said keep as-is.

**Durable product limits (rolling window, metered in actual spoken seconds):**
- Free / anonymous: 1200s (20 min) per 5h window
- Core: 3600s (60 min) per 3h window
- Wave: 7200s (120 min) per 3h window

**How to apply / what already exists (grep before assuming a gap):**
- `getRealtimeVoiceAllowance(tier)` in `ora-realtime-usage.ts` returns the above.
- Endpoints: `/session`, `/heartbeat` (30s), `/end`, `/diagnostics` in `realtime.ts`.
- Tables `ora_realtime_usage_windows` + `ora_realtime_sessions`; 1 active session
  per usage key via `pg_advisory_xact_lock`; stale sessions auto-expire; over-limit
  returns 429 with `resetsAt`.
- Per-turn timing diagnostics (`logVoiceDiag`) already emit on web + mobile
  (speech start/stop, transcript, focus decision, response create/created, audio
  start/stop, done) with NO raw audio/transcript.
- Settings (web `ora-settings.tsx`, mobile `settings.tsx`) show remaining/reset
  time + Marine/Mustafa preset; provider/model names never rendered.
- Known optional-only gaps (each has a tradeoff, ask first): realtime endpoints
  are NOT in `openapi.yaml` (hand-written, direct-fetch, not Orval-consumed);
  diagnostics omits explicit `tier`/`voicePreset`/`voiceLabel` fields.
- Actual latency tuning needs real call diagnostics (manual QA), not blind VAD edits.
