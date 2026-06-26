---
name: Ora realtime VAD timing & barge-in
description: OpenAI GA Realtime turn-detection tuning and local barge-in cancel lessons for "Talk to Ora" WebRTC voice
---

# Ora realtime VAD timing & barge-in

Lessons from tuning the WebRTC "Talk to Ora" GA Realtime voice (backend mints ephemeral ek_; frontend hook drives RTCPeerConnection + data-channel state machine).

- **Bare `turn_detection:{type:"server_vad"}` cuts users off / Ora replies too fast.** Default to `semantic_vad` with `eagerness:"low"`. Keep a `server_vad` alternative with conservative `silence_duration_ms:900` / `prefix_padding_ms:300` / `threshold:0.5`. All env-overridable (ORA_REALTIME_VAD_TYPE/EAGERNESS/THRESHOLD/PREFIX_PADDING_MS/SILENCE_DURATION_MS). Both modes must set `create_response:true` + `interrupt_response:true`.
  **Why:** server_vad's silence default (~200ms) ends the user's turn during natural mid-sentence pauses.

- **Barge-in must cancel playback LOCALLY on `input_audio_buffer.speech_started`** — call a stopAssistantOutput() that sends `response.cancel` + `output_audio_buffer.clear` AND pauses the reused `<audio>` element. Do NOT rely on the remote VAD/interrupt_response alone, or stale Ora audio keeps playing over the user's next turn.
  **Why:** remote interrupt lag leaves already-queued WebRTC output audio playing.
  **Watch-item (non-blocking):** firing `response.cancel` on every speech_started can hit "cancel with no active response" when the user just starts a normal turn → benign model error events / console noise. The hook treats model errors as non-fatal. If noisy in live testing, gate stopAssistantOutput() behind an assistant-active/speaking ref before sending cancel.

- **The reused remote MediaStream means `ontrack` fires once.** After an interrupt pauses the `<audio>`, you MUST resume playback on the next `output_audio_buffer.started` or every post-interrupt reply is silent.

- **Spoken-audio language drifts to English** unless the system/voice addendum explicitly binds spoken audio to the visible transcript language + the selected reply language (and "follow the user's latest spoken language" on Auto). The model defaults to English otherwise even when the transcript is non-English.
