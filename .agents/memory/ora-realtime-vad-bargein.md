---
name: Ora realtime VAD timing & barge-in
description: OpenAI GA Realtime turn-detection tuning and client-confirmed barge-in / echo-guard lessons for "Talk to Ora" WebRTC voice
---

# Ora realtime VAD timing & barge-in

Lessons from tuning the WebRTC "Talk to Ora" GA Realtime voice (backend mints ephemeral ek_; frontend hook drives RTCPeerConnection + data-channel state machine). Two surfaces must stay behaviorally identical: web `use-ora-realtime-voice.ts` and mobile `useOraRealtimeVoiceNative.ts` (byte-for-byte-equivalent pure helpers).

- **Bare `turn_detection:{type:"server_vad"}` cuts users off / Ora replies too fast.** Default to `semantic_vad` with `eagerness:"low"`. Keep a `server_vad` alternative with conservative `silence_duration_ms:900` / `prefix_padding_ms:300` / `threshold:0.5`. All env-overridable (ORA_REALTIME_VAD_TYPE/EAGERNESS/THRESHOLD/PREFIX_PADDING_MS/SILENCE_DURATION_MS).
  **Why:** server_vad's silence default (~200ms) ends the user's turn during natural mid-sentence pauses.

- **The CLIENT is the sole barge-in authority; the server must NOT auto-cancel Ora on raw VAD.** `interrupt_response` is env-gated via `ORA_REALTIME_INTERRUPT_RESPONSE` and DEFAULTS FALSE (reversible escape hatch = set it true). `create_response` stays true. If the server cancels on raw `speech_started`, Ora self-interrupts on the speaker's own echo / room noise.

- **Barge-in is CONFIRMATION-GUARDED, never immediate.** `input_audio_buffer.speech_started` must NOT call stopAssistantOutput directly. It arms a `pendingBargeInRef` + a `BARGE_IN_CONFIRM_MS` (~320ms) timer. Ora is cancelled only by `confirmBargeIn()` which fires either from the timer (sustained speech while assistant active/speaking) OR immediately on a real non-filler transcription delta (`isPartialSpeechEvidence`). `speech_stopped` before confirm → `cancelPendingBargeIn` (noise blip; Ora keeps talking). Manual `interrupt()` (user tapped control) stays unconditional. `stopAssistantOutput()` itself still sends `response.cancel` + `output_audio_buffer.clear` and pauses the reused `<audio>` (web) / disables `remoteTrackRef` track (mobile).
  **Why:** firing cancel on every speech_started also caused "cancel with no active response" model-error noise; the guard removes both the self-interrupt and the spurious cancels.

- **Echo / phantom-turn guard needs a LIVE echo buffer, not just the last finalized turn.** `validateUserTranscript` echo-rejects a finalized user transcript when it arrives within `ECHO_GUARD_MS` (~1200ms) of Ora audio AND is a subset of Ora's recent words. The echo buffer (`recentAssistantSpeechRef`) must be updated on EVERY assistant transcript delta (`recentAssistantSpeechRef.current = assistantTextRef.current`), not only on `*.done`. It must be preserved across cancel — `stopAssistantOutput()` must NEVER reset it (only `start()` clears it for a fresh session). The time window bounds staleness.
  **Why:** comparing only against the previous *finalized* turn lets an echo of Ora's CURRENT (mid-turn) speech, or speech arriving right after a confirmed cancel cleared `assistantTextRef`, be accepted as a real user turn → phantom replies + language drift.

- **Validity filter:** reject empty / `<MIN_MEANINGFUL_CHARS` (3) meaningful chars / single filler word; always accept clear voice commands (stop/yes/no). Only ACCEPTED transcripts call `onUserRef` and may influence language.

- **Language must be captured ONCE at start** (`selectedLanguageRef = ctx.language || "auto"`), and rejected/noisy/echo transcripts must never re-derive or drift it mid-call. Spoken-audio language still drifts to English unless the system/voice addendum explicitly binds spoken audio to the visible transcript + selected reply language ("follow the user's latest spoken language" on Auto).

- **The reused remote MediaStream means `ontrack` fires once.** After a cancel pauses/disables output, you MUST re-enable on the next `output_audio_buffer.started` (mobile: `remoteTrackRef.current.enabled = !mutedRef.current`) or every post-interrupt reply is silent.

- **Diagnostics must be structured + privacy-safe** (`logVoiceDiag`): emit event name / counts / reasons / selected_language only — NEVER raw audio or full transcript text.

- **Tests are source-string snapshots** in `realtime-session.test.ts` (readMustaflow/readOraMobile): they assert the speech_started block contains `pendingBargeInRef`/`BARGE_IN_CONFIRM_MS`/`confirmBargeIn(` and NOT `stopAssistantOutput()`; that the delta block sets `recentAssistantSpeechRef.current = assistantTextRef.current`; and that the stopAssistantOutput block does NOT contain `recentAssistantSpeechRef.current = ""`. Both surfaces must pass identically. Refactoring a matched call site breaks these even when source is correct.
