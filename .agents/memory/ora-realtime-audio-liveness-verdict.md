---
name: Ora realtime audio-liveness verdict
description: Invariants the response.done silent-audio verdict must keep in the Talk-to-Ora realtime voice hooks
---

## The rule
The `response.done` audio-liveness verdict (in `use-ora-realtime-voice.ts` and
`useOraRealtimeVoiceNative.ts`, kept in byte-for-byte parity) drives the
silent-audio reconnect ladder. It must preserve three invariants:

1. A genuinely silent COMPLETED turn (no audible audio, no in-turn recovery)
   counts toward escalation via `recoverSilentAudio("response_done_no_audio")`.
   The counter reset must be GUARDED (`else if` on `audioDeliveredThisResponse`),
   never unconditional.
2. The whole verdict runs ONLY for a normally-completed response. Gate it on
   server status: `responseStatus = (evt.response as {status?:string}|undefined)?.status`
   and skip both increment and reset when status is `"cancelled"` (user
   barge-in / manual interrupt) or `"failed"` (model error).
3. `armSilentAudioWatchdog` must bail when `!activeResponseIdRef.current` so a
   stale trailing transcript delta cannot arm a watchdog whose null===null
   fire-guard would otherwise pass.

**Why:** Two separate architect rounds caught real regressions here.
- An UNCONDITIONAL `consecutiveSilentAudioRef.current = 0` in `response.done`
  wiped each silent turn's incident before the next could accumulate, making the
  reconnect escalation unreachable for the exact reported symptom (response.done
  arriving while audio is silent).
- Without the status gate, `stopAssistantOutput` (barge-in) and the error path
  reset `audioStartedForResponseRef`, so the following
  `response.done(status:"cancelled"|"failed")` entered the verdict with
  delivered=false and spuriously called `recoverSilentAudio`. Two consecutive
  barge-ins then forced a full reconnect in a perfectly healthy call.

**How to apply:** Any edit to the `response.done` verdict must keep all three
invariants AND web/mobile parity. `ora-realtime-watchdog.test.ts` enforces them
as source-string assertions (guarded reset + status-gate parity test); a
`status:"incomplete"` truncation is intentionally treated as completed-normally
and is self-healing on the next healthy turn.
