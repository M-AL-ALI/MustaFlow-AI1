---
name: Ora realtime stuck-thinking fix
description: Three Talk to Ora bugs (stuck thinking, glitched audio, stops listening) and the fixes applied to both hooks.
---

# Three Talk to Ora bugs and fixes

## Bug 1 — Stuck in "thinking" indefinitely

**Root cause:** `response.done` can be dropped over the WebRTC data channel. When that happens, `assistantResponseActiveRef` stays `true` and the state machine never leaves `"thinking"`.

**Fix:** Add a 15-second `thinkingWatchdogRef` timer. Start it on `speech_stopped` (when we enter thinking) and re-arm it on `response.created` (overlapping turns). Clear it on `output_audio_buffer.started` (audio arrived, model is making progress) and on `response.done` (authoritative end). If the timer fires, log `thinking_watchdog_timeout`, clear `assistantResponseActiveRef`, and `setState("listening")`.

**Why 15 s:** sits comfortably above real model latency (typical < 5 s) while preventing an indefinite stuck state.

## Bug 2 — Glitched / incomplete voice responses + no error recovery

**Root cause:** `OUTPUT_STOP_DEBOUNCE_MS = 350` was too short for OpenAI's multi-chunk audio buffer cycles. The "stop → listening" flip fired between chunks, cutting playback off mid-sentence. Additionally the `error` event had no recovery path — if the model errored mid-response, `assistantResponseActiveRef` stayed set and the session was stranded.

**Fix:**
- Increase `OUTPUT_STOP_DEBOUNCE_MS` from 350 → 600.
- In the `error` event handler: if `assistantResponseActiveRef || assistantSpeakingRef`, clear both flags, cancel both timers (watchdog + debounce), and `setState("listening")`. Mobile hook had no `error` case at all — added one.

## Bug 3 — Stops listening after a couple conversations

**Root cause:** Speaker-focus mode uses `lastAcceptedUserTurnAtRef` to measure the follow-up window (`FOCUS_FOLLOWUP_WINDOW_MS = 4 s`). This ref was only updated when the *user* had an accepted turn. After Ora gives a 10-second reply, the window has already expired — casual follow-ups ("that's great", "continue") fail the focus filter and are rejected.

**Fix:** Refresh `lastAcceptedUserTurnAtRef.current = Date.now()` in `response.done`. The 4-second follow-up window now reopens from the moment Ora finishes speaking, not from the last accepted user turn.

## Applied identically to both hooks

- Web: `artifacts/mustaflow/src/hooks/use-ora-realtime-voice.ts`
- Mobile: `artifacts/ora-mobile/hooks/useOraRealtimeVoiceNative.ts`

Teardown also clears `thinkingWatchdogRef` alongside `outputStopDebounceRef`.
