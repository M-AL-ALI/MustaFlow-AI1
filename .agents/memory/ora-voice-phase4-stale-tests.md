---
name: Ora phase2/3/4/6 api-server tests now pass
description: History — these were once stale/flaky; as of the Ora-memory merges they pass cleanly. Treat new failures as real.
---

# Ora phase2/3/4/6 tests — formerly stale, now green

Historically `artifacts/api-server/src/routes/public-ai/__tests__/phase4.test.ts`
encoded an obsolete "Voice-A" contract (browser Web Speech only, `OraVoiceMicButton`,
no `/transcribe` route) that was superseded by Whisper-based voice mode
(`routes/public-ai/transcribe.ts` → `POST /api/public-ai/transcribe`;
`OraVoiceModeButton` + `hooks/use-ora-voice.ts`). phase2/phase6 also failed only
under full-suite parallel load via cold dynamic-import timeouts.

**Current status (verified during a full Ora E2E sweep):** phase2, phase3, phase4,
and phase6 all PASS — phase4=part of 111 (phase2/4/6), phase3=51 in isolation. The
obsolete phase4 assertions were updated/removed in the Ora-memory merges, and the
cold-import timeouts did not recur when files are run in small chunks (2-3 files)
rather than the whole api-server suite at once.

**So:** do NOT pre-dismiss a phase2/3/4/6 failure as "known stale" anymore. If one
fails now, investigate it as a real regression. The only remaining load-sensitive
gotcha is running the *entire* api-server suite at once (cold-import timeouts) — run
in chunks. See [vitest-cold-import-timeout](vitest-cold-import-timeout.md).

`preview-architecture.test.ts` (Builder task-agent static source assertion, unrelated
to Ora) remains a separate pre-existing brittle assertion.
