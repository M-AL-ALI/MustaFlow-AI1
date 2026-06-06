---
name: Ora voice phase4 tests are stale
description: Why phase4.test.ts fails on main and why those failures are not product bugs.
---

# Ora voice — phase4.test.ts encodes an obsolete design contract

`artifacts/api-server/src/routes/public-ai/__tests__/phase4.test.ts` (8 tests)
asserts the original "Voice-A" design: browser Web Speech API only, an
`OraVoiceMicButton` component, a specific mic-button placement, an interim
"Listening…" transcript hint, and **no** `/transcribe` backend route.

That design was deliberately superseded by Whisper-based voice conversation mode
(adds `routes/public-ai/transcribe.ts` → `POST /api/public-ai/transcribe` via
gpt-4o-mini-transcribe; UI now uses `OraVoiceModeButton` + `hooks/use-ora-voice.ts`
in `components/ora-panel.tsx` and `ora-bubble.tsx`).

**So:** these 8 failures are STALE TESTS, not regressions. The voice/upload/image
controls are all still present and working. Either update phase4.test.ts to the
Whisper contract or delete the obsolete assertions.

# Other full-suite api-server failures that are NOT bugs

- `phase6.test.ts` ("…route file still exports a router") and `phase2.test.ts`
  ("upload returns 401 with no session cookie") fail ONLY under full-suite
  parallel load — cold dynamic-import timeouts (>13s). They pass in isolation.
  See [vitest-cold-import-timeout](vitest-cold-import-timeout.md).
- `preview-architecture.test.ts` ("task-agent staged output is isolated until
  Apply") is a static source-contains assertion for a Builder task-agent feature,
  unrelated to Ora; pre-existing stale assertion.

**Net:** the full api-server suite shows ~11–12 failures that are entirely stale
tests + cold-import timeouts. Zero real product bugs in Ora / Phase 3/4/6 scope.
