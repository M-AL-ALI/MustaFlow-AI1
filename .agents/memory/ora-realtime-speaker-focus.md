---
name: Talk to Ora realtime speaker-focus
description: Two non-obvious constraints in the focused-mode (background-speaker rejection) realtime voice path.
---

# Talk to Ora speaker-focus (focused mode)

Two constraints that are NOT obvious from the code and were each non-trivial to get right.

## 1. The start-of-session focus-window seed is REQUIRED for multilingual cold-start
In focused mode the first turn is accepted because `start()` seeds `lastAcceptedUserTurnAt`
(opening Talk to Ora counts as an address), opening the ~12s focus window.

**Why:** the address/directed detectors are English-centric — `looksDirected` only matches an
ASCII `?` or an English lead word (what/how/can/tell/...), and `isAddressedToOra` only matches
Latin "ora"-like tokens. An Arabic first utterance (Arabic `؟`, Arabic-script address) matches
NEITHER, so without the seed an Arabic primary user's first sentence is rejected and Ora stays
silent. Removing/weakening the seed breaks the Arabic cold-start QA case.

**Inherent limitation:** focus is transcript-only (no voice diarization), so within the seeded
window a nearby bystander cannot be distinguished from the button-tapper. QA "user silent while
someone else talks nearby" can therefore accept a bystander in the first ~12s. This is a known
limitation, not a fixable bug, without speaker fingerprinting (out of scope). Future safe
improvement: broaden directed/address detection to Unicode `؟` + per-language wake/directive
lexicons (reduces, not eliminates, reliance on the seed).

## 2. Rejected transcripts must be deleted from the realtime conversation
Focused mode mints with `turn_detection.create_response=false`, so the CLIENT owns
`response.create`. A rejected (background-speaker) turn must send
`conversation.item.delete { item_id: evt.item_id }` (gated `focusMode==="focused"` + string
item_id). Otherwise the server still recorded the transcribed input item, and a later accepted
`response.create` conditions on it — pulling Ora into a bystander's language/content. Normal mode
must NOT delete (server auto-responds and owns those items). No race: with create_response=false
the server isn't generating a reply for the rejected item.

**How to apply:** any change to the focused-mode rejected branch in either hook must preserve
both the seed and the delete; the pure `scoreTranscriptFocus` block stays byte-identical across
`use-ora-realtime-voice.ts` (web) and `useOraRealtimeVoiceNative.ts` (mobile), guarded by a
source-slice parity test in `realtime-session.test.ts`.
