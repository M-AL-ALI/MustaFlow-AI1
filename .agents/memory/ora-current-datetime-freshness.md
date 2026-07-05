---
name: Ora current-date/time freshness convention
description: Every Ora surface must inject the authoritative date/time block and thread client timeZone; which surfaces count and which deliberately do not.
---

Ora answers today/tomorrow/date-math and freshness judgments from an authoritative
"Current date and time" block (`buildCurrentDateTimeBlock` in
`lib/public-ai/prompt.ts`), NOT from the model's training cutoff.

Rule: any NEW Ora surface that builds a system prompt must inject
`buildCurrentDateTimeBlock` and thread the client's IANA `timeZone` through its
request body. The block is computed per request (never cached at module load) so
it stays correct. It takes an injectable `now` param purely for deterministic
tests.

**Why:** "Freshness blocker" — Ora was date-unaware and guessed live/sports
answers from stale training data. The block is the single source of truth and is
what makes the fallback correct even when web search fails.

**How to apply:**
- Server surfaces already wired: `/chat`, `/chat/stream`, `realtime` (uses the
  as-of label "the start of this voice session"), `file-analysis`,
  `image-analysis`. `buildSystemPrompt(..., timeZone?, dateTimeAsOfLabel?)` is
  the shared entry for chat/stream/realtime.
- Client timeZone is threaded via a `clientTimeZone()` helper that exists on BOTH
  web (`use-ora-chat.ts`, `use-ora-realtime-voice.ts`) and mobile
  (`ora-mobile/lib/api.ts`). Mobile realtime falls back to it at the API layer.
- `public-ai/chat` is raw authFetch (NOT in OpenAPI) — no codegen; the Zod
  bodySchema is non-strict so an extra `timeZone` on routes that ignore it is
  harmless.
- Support Center `help.tsx` is DELIBERATELY NOT an Ora surface — it hits a
  separate `/api/help` endpoint and must not be wired with the Ora date block.
- Known gap (intentional, non-blocking): mobile `analyzeImage`/`analyzeDocument`
  don't send timeZone, so mobile file/image analysis gets the UTC-only variant of
  the block. The block is still injected server-side; only local-tz line is
  omitted.

Live/sports routing: `isSportsScheduleRequest` (orchestrator.ts) is OR-ed into
`isWebSearchRequest`; a build/create-verb veto keeps "build a soccer game" etc.
conversational. `inferOraSearchPlan` (web-search.ts, imports
isSportsScheduleRequest one-way, no cycle) injects the sports format guidance and
the exact honest fallback string "I could not verify scheduled matches for today".
