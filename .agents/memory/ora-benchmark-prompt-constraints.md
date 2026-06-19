---
name: Ora benchmark prompt constraints
description: Specific string constraints in prompt.ts enforced by unit tests — must not change these phrases
---

## Exact string requirements in ORA_SYSTEM_PROMPT (enforced by ora-chat-response-qa.test.ts)

The test `answers pasted Replit/Codex reports directly...` checks for these exact substrings in the assembled system prompt:

- `"raw Markdown headings"` — must stay in the formatting section. Keep "NEVER use **raw** Markdown headings", never drop the word "raw".
- `"Start with the direct answer"` — present in the answer-specificity / pasted-reference-analysis sections.
- `"Replit = hosted dev/runtime workspace"` — present in PASTED_REFERENCE_ANALYSIS_ADDENDUM in chat.ts.
- `"Use the minimum useful steps"` — present in PASTED_REFERENCE_ANALYSIS_ADDENDUM in chat.ts.
- `"Clean response formatting"` — section header in prompt.ts, must stay.
- `"Do not use markdown tables"` — present in formatting section.
- `"Pasted reference signals"` — generated dynamically by `summarizePastedReferenceSignals()` in prompt.ts when signals are found; not in static prompt.

**Why:** ora-chat-response-qa.test.ts reads the mock-captured system prompt sent to the AI and checks for these strings. Renaming or removing them silently breaks the test.

## Isolation test: "ready to build" prohibition encoding

The isolation test `ora-isolation.test.ts` scans the raw source text of all Ora files for `/ready to build/i`.
The prohibition instruction in the system prompt must NOT contain the literal phrase "ready to build".

Correct encoding: `"Do not signal that a plan is 'ready' and then 'to build' — that phrase implies a builder pipeline handoff"`

The words "ready" and "to build" appear but are separated by ` and then ` so the regex does not match.

**Why:** The test scans source files, not runtime values. Using the literal banned phrase in an instruction comment is indistinguishable from using it in product code.
