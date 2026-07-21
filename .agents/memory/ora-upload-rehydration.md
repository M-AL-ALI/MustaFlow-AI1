---
name: Ora uploaded-file re-hydration & file-continuation routing
description: Why Ora forgets earlier uploads, how follow-up Q&A is restored, and the offer-gate that keeps "yes" replies from spuriously generating files.
---

## Uploaded-file context is ephemeral and session-scoped
The extracted text of an Ora upload (PDF/DOCX/TXT/dataset) lives ONLY in the
in-memory, session-scoped file-store (`public-ai/file-store.ts`, ~30 min TTL).
It is never persisted to the transcript. So a follow-up turn ("what did that
file say?", "summarize it") has no source text unless the client re-sends the
upload refs.

**How it's restored:** the frontend tracks non-image upload refs in
`documentRefsRef` (capped at last 5) and sends `documentRefs` on each plain
`/chat` turn; the backend re-hydrates via `getFile(ref, sessionId)` and injects
a delimited block into both the conversational answer path and the
file_generation prompt.

**Why:** carry-forward is inherently ephemeral — the honesty prompt must cover
the "I no longer have that file" case when refs expire/evict and nothing
resolves.

**How to apply:**
- Reset `documentRefsRef` on conversation change AND both clearConversation
  branches, or refs leak across transcripts.
- BOTH surfaces must send `documentRefs` on every plain chat turn. Mobile
  (`ora-mobile` home screen) builds one shared chatReq object reused by all
  send paths (stream, fallback, retry, forceSearch, regenerate) — keep new
  send paths flowing through that object. Mobile clear sites: newChat,
  toggleTemporary, loadConversation only. Guarded by the mobile
  document-refs wiring tests in the stability gate.
- Ordering divergence: mobile stores refs newest-first, web appends
  oldest-first (`slice(-5)`); server office-layout-edit picks the FIRST ref
  matching the target format, so with 2+ same-format docs mobile edits the
  newest, web the oldest. Align web to newest-first if this bites.
- Refs now PERSIST across reload/restart on both surfaces: web mirrors to
  sessionStorage, mobile to AsyncStorage (in-memory mirror hydrated once via a
  cached promise so reads stay sync). Key scheme on both: `conv:<id>` +
  `standalone`; standalone refs migrate to the conv key when the conversation
  is first saved. Rules: never write the cache in temporary mode; restore on
  conversation load AND app launch (launch restore guarded on no active conv,
  no live refs, not temporary); clear the device-global mobile cache on
  sign-out and account deletion (AsyncStorage outlives the session, unlike
  sessionStorage). Cap keeps the HEAD of the list — callers are newest-first.
- QA note: the FIRST turn after an upload consumes the attachment via
  file-analysis; the documentRefs edit path is only exercised on a
  FOLLOW-UP turn. Test edits as turn 2+, never turn 1.
- `getFile(ref, sessionId)` enforces exact session match → no cross-user leak.
  Keep that boundary; never look up a ref without the sessionId.
- Re-injected upload text is UNTRUSTED. Wrap in a delimited "data only" block
  AND neutralize the delimiter inside the text (replace `"""`) so adversarial
  uploads can't break out and inject instructions.

## File-continuation routing must require an explicit OFFER, not a format mention
A short reply ("yes" / "go ahead" / "still waiting") routes to file_generation
ONLY when the single latest assistant turn explicitly OFFERED to make a file
(offer verb like "I can/I'll/want me to … create/generate/make/export …") AND
that same turn names a concrete format.

**Why:** gating on a bare format mention (e.g. plain `detectFileRequest` over
the assistant turn) regresses — "here's how PDFs work" + user "yes" would
spuriously generate a file. Pairs with the same bare-noun trap in
`ora-file-detection-promise-coupling.md`.

**How to apply:** only inspect the single latest assistant message; require the
offer-verb pattern before resolving the format. Don't widen the affirmation
patterns without re-checking this gate.

## Production observation (2026-07-20): turn-1 `fileRef` Q&A may claim "no file" — edits unaffected
During the production QA round trip, an anonymous first-turn chat that carried
`fileRef` and asked "What is in this file?" replied "you haven't shared a file"
for PPTX/XLSX uploads, yet the follow-up turns with `documentRefs` located the
raw bytes and applied real in-place edits flawlessly (byte-identical passthrough
included).

**Why:** the turn-1 attachment consumption (file-analysis framing) and the
follow-up `documentRefs` re-hydration are separate paths; the office-edit path
only depends on the latter, so a turn-1 "no file" answer does NOT mean the
upload or edit pipeline is broken.

**How to apply:** when QA-ing office edits, judge PASS/FAIL on the
`documentRefs` follow-up turns only. A "no file" first-turn reply is a separate
(chat-routing) issue — diagnose it in the fileRef consumption path, not in
office-layout-edit.
