---
name: Ora realtime output-audio flicker + privacy-safe diagnostics
description: Why "Talk to Ora" UI flips speaking<->listening mid-reply, and the debounce rule that fixes it; plus what realtime voice diagnostics may log.
---

# Mid-playback output-audio flicker

OpenAI Realtime emits `output_audio_buffer.started` / `stopped` / `cleared` that can
cycle *during* a single assistant reply (not just at true turn boundaries). Flipping the
UI to "listening" on every `stopped`/`cleared` makes the bubble flicker speaking<->listening
mid-playback.

**Rule:** debounce the flip back to "listening" (~350ms, `OUTPUT_STOP_DEBOUNCE_MS`).
- transient `output_audio_buffer.stopped` and non-client `cleared` schedule the listening flip
- a following `started` cancels the pending flip (it was just a transient gap)
- `response.done`, confirmed barge-in, and teardown cancel the timer and flip immediately
- client-initiated `cleared` flips immediately (we caused it)

**Why:** without the debounce the transient stop/start gaps surface as visible state churn.
No stuck-state risk: if audio really ended and no `response.done` arrives, the timer still
returns to listening; manual interrupt only re-sets listening so a pending timer self-clears.

# Privacy-safe realtime diagnostics

Realtime voice diag (`logVoiceDiag`) may log ONLY: timing deltas (`deltaMs`/`TurnTiming`),
counts (e.g. output-audio cycle count, char counts), booleans, focus mode, selected language,
and accept/reject/cancel **reasons**. NEVER log raw audio or transcript text (log `chars`, not text).

**Why:** isolation/privacy invariant for Talk to Ora; transcript/audio must never reach logs.
**How to apply:** when adding any new realtime diag event, pass derived metrics only.

# Parity

Web (`use-ora-realtime-voice.ts`) and mobile (`useOraRealtimeVoiceNative.ts`) keep these
handlers logic-equivalent; only playback differs (`audioEl.play()` vs `remoteTrackRef.enabled`).
The pure scorer block stays byte-identical across both files — never edit it when changing
timing/diagnostics/flicker handling.
