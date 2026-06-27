---
name: Talk to Ora realtime speaker-focus
description: Two non-obvious constraints in the focused-mode (background-speaker rejection) realtime voice path.
---

# Talk to Ora speaker-focus (focused mode)

Two constraints that are NOT obvious from the code and were each non-trivial to get right.

## 1. The start-of-session focus-window seed is STILL the cold-start safety net
In focused mode the first turn is accepted because `start()` seeds `lastAcceptedUserTurnAt`
(opening Talk to Ora counts as an address), opening the ~12s focus window.

**Why:** the address/directed detectors are now multilingual (see below) but still pattern-only —
they cannot recognize EVERY directed phrasing in every language, and an idle-state declarative
sentence in any language is intentionally NOT accepted. The seed guarantees the engaged primary
user's first utterance always gets through regardless of language/phrasing. Removing/weakening the
seed re-breaks non-English cold-start QA.

**Detectors are multilingual (no longer English-only).** `looksDirected` accepts a turn whose
FIRST or LAST token is a lead word (last-token handles SOV verb-final imperatives in Turkish/
Hindi) OR that ends with any of QUESTION_MARKS (ASCII `?`, Arabic `؟` U+061F, fullwidth `？`
U+FF1F, Armenian U+055E). `isAddressedToOra`/lead-word matching uses `matchesLeadSet` = raw OR
`foldForMatch` (NFD then strip `\p{M}`): Latin/Arabic lead words are stored accent/harakat-FOLDED,
Devanagari is stored RAW (folding mangles matras). DIRECT_LEAD_WORDS/ADDRESS_LEAD_WORDS/
ORA_ADDRESS_TOKENS carry ES/FR/PT/DE/IT/TR/AR/Hindi-Urdu entries + non-Latin Ora transliterations.

**Tokenizer must preserve `\p{M}`.** `normalizeWord` strips `[^\p{L}\p{N}\p{M}]` — the `\p{M}` is
REQUIRED or Devanagari matras/viramas (`\p{M}`) get stripped and Hindi words never match the lead
set. `normalizeWord`/`tokenizeTranscript` live OUTSIDE the byte-identical scorer block, so they
are kept identical in both hooks MANUALLY and guarded by a separate tokenizer source-parity test.

**Inherent limitation:** focus is transcript-only (no voice diarization), so within the seeded
window a nearby bystander cannot be distinguished from the button-tapper, and the first/last-token
rule can admit a directly-worded background question outside the window. Both are accepted design
tradeoffs, not fixable without speaker fingerprinting (out of scope).

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
