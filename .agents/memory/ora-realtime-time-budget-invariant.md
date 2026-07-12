---
name: Ora realtime time-budget-only invariant
description: Talk to Ora realtime voice — a silent/stuck reply is recovered LOCALLY and never tears down; only a dead track reconnects. The sole session limit is the per-tier time budget.
---

## Rule
In Talk to Ora realtime voice (both `use-ora-realtime-voice.ts` and `useOraRealtimeVoiceNative.ts`):

- A "responding but silent" turn is recovered **locally**: resume the audio sink, and after `MAX_SILENT_AUDIO_FAILURES` end only the stuck response (`response.cancel` + return to `listening`). `recoverSilentAudio` must **never** call `handleConnectionDrop` / the reconnect ladder.
- Only a **genuinely dead remote audio track** (`track.muted === true || track.readyState === "ended"`) escalates to the reconnect ladder, and that escalation lives in the **stall poll** (`handleConnectionDrop("audio_track_dead")`), not in `recoverSilentAudio`.
- Reconnect is a **backoff ladder** (`RECONNECT_BACKOFF_MS`, `RECONNECT_MAX_ATTEMPTS=6`) that **resets on any successful reconnect**; legacy fallback is entered **only after the whole ladder is exhausted**.

**Why:** The ONLY permitted session limit is the per-tier TIME budget (`maxDurationSeconds`) — never exchange count nor reply length. Escalating a benign silence to the reconnect ladder (or a one-shot "second drop → legacy") burns the session early and violates that hard product requirement. A dead track is a real transport failure, so reconnecting is correct and, because the ladder resets on success, costs only a few seconds — the budget is never forfeited.

## How to apply
- Never "simplify" `recoverSilentAudio` to escalate to reconnect, and never add an exchange/turn cap.
- On react-native-webrtc `muted` support is weak (often stays false), so mobile `trackDead` effectively keys on `readyState === "ended"` — conservative in the safe direction; that asymmetry is intentional, keep it.
- The stall poll must stay response-id-guarded and zero its stale counter while `assistantSpeaking` is false, so a normal quiet gap can't be misread as a stall.
- Keep web and mobile behaviorally consistent (identical ladder constants + stall-poll structure). Parity is enforced by `ora-realtime-watchdog.test.ts` and the byte-identical `scoreTranscriptFocus` parity checks.
