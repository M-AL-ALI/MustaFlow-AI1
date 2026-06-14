---
name: Ora auto-speak (ChatGPT-style voice replies)
description: How the "Voice responses on" toggle auto-speaks Ora replies, and why the dedup ref must be armed per-transcript.
---

# Ora auto-speak TTS

The "Voice responses on" toggle (`isTtsEnabled`, sessionStorage `ora_tts_enabled`) historically only enabled a manual per-message read-aloud button (robotic browser `speechSynthesis`) — it did NOT auto-speak replies. Only Voice Conversation Mode (the orb) auto-spoke, and it is mic-driven and replaces the composer. Users expect ChatGPT-style auto-speech in normal typing mode too.

The fix lives in the merged auto-TTS `useEffect` in BOTH `ora-panel.tsx` (signed-in surface) and `ora-bubble.tsx` (anonymous surface) — keep the two in sync.

**Gate:** `shouldSpeak = voiceConvActive ? !voiceConvTtsMuted : voice.isTtsEnabled`. Always speak via `speakTextForce` (server MP3 TTS), never `speakText` (browser speechSynthesis), including the manual read-aloud button.

**Why the "arm" ref (`autoSpeakArmedRef`):** the dedup ref starts null, so without arming, a restored `isTtsEnabled=true` on remount, an async history load, or a conversation switch would replay/re-request the EXISTING last reply. Logic: on empty transcript reset arm=false; on first non-empty observation seed the dedup ref to the current last reply and return WITHOUT speaking; only later replies speak.

**Why it's safe (no suppressed first reply):** `sendMessage` appends the user message optimistically in a separate render before the assistant reply. So the effect always sees an intermediate `[..., userMsg]` (last = user, never spoken) which arms the ref, then the real reply arrives and speaks. Conversation switch/clear set messages to `[]` first, which re-arms.

**How to apply:** any change to message-load flow, the dedup ref, or the toggle handlers must preserve: (1) enable handler unlocks audio via `prepareVoicePlayback()` inside the click gesture, (2) arm-on-first-non-empty seeding, (3) `speakTextForce` only. Server TTS route caps input at 4000 chars → `truncateForTts` (3900 word-boundary) in `use-ora-voice.ts`. See also `ora-tts-direct-key.md` (TTS needs direct OPENAI_API_KEY; proxy 502s).
