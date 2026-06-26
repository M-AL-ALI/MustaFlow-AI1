---
name: Realtime voice history seeding
description: How to carry recent chat history into an OpenAI GA Realtime (WebRTC) voice session without creating a prompt-injection / isolation hole.
---

# Realtime voice history seeding

When a realtime voice call continues an existing text conversation, do NOT
concatenate the recent transcript into the minted session's `instructions`.

**Rule:** recent history is seeded client-side, after the data channel opens, as
`conversation.item.create` events — one per turn:

- user turn → `{ item: { type:"message", role:"user", content:[{ type:"input_text", text }] } }`
- assistant turn → `{ ... role:"assistant", content:[{ type:"output_text", text }] }`

Only a safe ranking hint (the last user utterance, as `message`) is forwarded to
the mint endpoint, used purely to rank saved-memory recall — never echoed verbatim
into instructions.

**Why:** user-authored transcript text placed in the system `instructions` is a
prompt-injection / Ora-isolation vector — a prior turn containing forbidden
Builder language or "ignore your rules" text would gain system-level authority.
Conversation items are lower-authority context, so the same text cannot override
the system prompt or the Ora-vs-Builder isolation rules. Architect flagged the
instructions-concatenation approach as a blocking security issue.

**How to apply:** any feature that "carries context" into a Realtime session must
seed it as conversation items, not instructions. Keep the trusted instructions =
system prompt + signed-in profile + Ora-scoped saved-memory recall + voice
addendum only.

**API facts (GA Realtime, gpt-realtime*):**

- `conversation.item.create` adds context only; it does NOT trigger a spoken
  response (server VAD responds to audio input). Safe to send many on open.
- A rejected item (e.g. wrong content-part type) emits a non-fatal `error` event
  over the data channel — log it, do not tear down / fall back.
- Bound it: last ~12 turns, per-turn text sliced (~2000 chars) to keep items small.

Covered by a regression test in `realtime-session.test.ts` that POSTs a hostile
`history` payload (Builder terms + "ignore all rules") and asserts none of it
reaches the minted `session.instructions` (the backend now strips `history`).
