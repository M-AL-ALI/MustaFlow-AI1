---
name: Ora file-generation detection ↔ system-prompt coupling
description: Why a gap in Ora's file-request detection produces a confident reply with NO file (silent failure), and how to gate detection safely.
---

# Ora file detection silently fails when the gate misses a phrasing

Ora's chat route auto-generates downloadable files: `routeOraMessage` →
`detectFileRequest()` (in `lib/public-ai/prompt.ts`). If that returns null, the
message routes to the plain `answer` tool.

**The trap:** Ora's system prompt PROMISES "the file is generated and delivered
as a download automatically." So when detection misses a phrasing, Ora still
replies confidently describing the file — but no file is ever attached. The user
sees a normal reply and assumes it worked. There is no error; it's a silent
failure. Any change to supported file types or phrasings must keep
`detectFileRequest` and the system-prompt promise in sync.

**Detection gating rule:** `detectFileRequest` first checks
`FILE_GENERATION_PATTERNS` (the "is this a generation request?" gate), then
`FILE_FORMAT_DETECT` (which format). Bare format nouns in the gate
(`powerpoint`, `presentation`, `slides`, `excel`, ...) over-match plain
questions ("what is a presentation?") — this is long-standing, intentional-ish
behavior. **Do NOT add new ambiguous / multi-word / abbreviated cues
("power point", "ppt", "slide deck", "pitch deck", "slideshow") to the bare-noun
gate** — that widens false positives. Put them behind a creation verb
(generate/create/make/build/...) in a dedicated verb-gated pattern instead.
Broadening `FILE_FORMAT_DETECT` (the classifier) is safe — it only runs after the
gate already decided it's a generation request.

**Why:** "create a power point file" (two words) routed to `answer` and Ora
claimed it delivered a file that never existed. The verb-gated fix catches the
creation intent without making "what is a pitch deck?" generate a deck.
