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
- Web residual gap: conversation switch/reload clears the web
  `documentRefsRef`; after a reload the edit path silently loses refs until
  a new upload.
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
