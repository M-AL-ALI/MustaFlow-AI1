---
name: Ora realtime stuck-thinking/speaking root causes
description: Four root causes of "stuck after 8-10 turns" in Talk to Ora realtime voice — and their fixes applied to both web + mobile hooks.
---

## The four bugs that caused "stuck in thinking/speaking after 8–10 turns"

### 1. No speaking watchdog (PRIMARY)
When `output_audio_buffer.started` fires, the thinking watchdog is cancelled but NO new watchdog is armed. If `response.done` AND `output_audio_buffer.stopped` both drop (degraded WebRTC after many turns), state stays stuck in "speaking" forever.

**Fix:** Add `SPEAKING_WATCHDOG_MS=40_000` + `speakingWatchdogRef`. Arm on `output_audio_buffer.started`; cancel on `response.done`, output-stop debounce, error handler, fullTeardown.

### 2. Thinking watchdog doesn't send response.cancel
On timeout, only flags were cleared. The model (still processing) sent stale `response.created` / audio events after recovery, re-setting `assistantResponseActiveRef=true` → next user turn confused.

**Fix:** Send `sendEvent({ type: "response.cancel" })` in both thinking watchdog callbacks (speech_stopped site AND response.created site).

### 3. No consecutive failure escalation
Consecutive watchdog fires (no clean `response.done`) never triggered reconnect. The user was left in a silently degraded session indefinitely.

**Fix:** Add `consecutiveWatchdogFiresRef`. After 2 consecutive fires, call `handleConnectionDrop("consecutive_thinking_watchdog"|"consecutive_speaking_watchdog")`. Reset to 0 on clean `response.done` or `fullTeardown`.

**Consequence:** Also add `handleConnectionDrop` to `handleServerEvent` useCallback deps array.

### 4. Focus window not refreshed on debounce path
When `response.done` dropped but audio did stop (output_audio_buffer.stopped debounce fired), `lastAcceptedUserTurnAtRef` was NOT updated. Next user utterance failed the focus filter in "focused" mode → `response.create` never sent → UI showed "thinking" with no model activity.

**Fix:** Add `lastAcceptedUserTurnAtRef.current = Date.now()` inside the `outputStopDebounceRef` callback (after the speaking watchdog cancel).

## How to apply
Both hooks (`use-ora-realtime-voice.ts` and `useOraRealtimeVoiceNative.ts`) must be kept byte-for-byte identical in the watchdog constants and debounce logic. The regression suite at `artifacts/mustaflow/src/lib/__tests__/ora-realtime-watchdog.test.ts` (35 tests) verifies parity.
