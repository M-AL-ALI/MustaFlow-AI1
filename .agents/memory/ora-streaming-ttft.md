---
name: Ora streaming perceived-failure is TTFT, not the stream
description: Why Ora "streaming doesn't work" reports are almost always time-to-first-token, and the pre-stream orchestration ordering rule that keeps the first token fast.
---

# Ora live-streaming "not working" = time-to-first-token, not the SSE mechanism

When a user reports Ora streaming "still doesn't work / shows nothing then dumps the
whole reply at once", the SSE token mechanism is almost never broken. Prove it with a
wire test: create a session cookie, then `curl -N` the `/api/public-ai/chat/stream`
endpoint through the proxy (localhost:80) and watch `event: token` frames arrive with
timestamps. They stream fine token-by-token.

The real cause is **high time-to-first-token (TTFT)** on signed-in conversations: a
long blank "thinking" gap before the first word makes the subsequent fast stream feel
like a single dump.

**Rule: nothing slow may block the first token.** In `/public-ai/chat/stream` the
pre-stream context builders must not run as a chain of sequential `await`s. The
prompt-required builders (`buildMemoryContext`, `buildCrossConversationContext`,
`buildProfileContext`) run concurrently via `Promise.all` (pre-stream cost = max, not
sum). The rolling-summary refresh (`updateConversationSummary`) is the long pole — it
is a separate AI call with a ~5s timeout (`ORA_SUMMARY_TIMEOUT_MS`, default 5000) that
**frequently times out and burns the full 5s**. It must NOT block streaming: start it
as a pre-`.catch()`'d background promise, build the current turn's prompt from the
client-provided `priorSummary`, and `await` the in-flight promise only just before the
`done` payload (the ~5s stream lets it finish concurrently).

**Why:** sequential pre-stream awaits (classifier ~1.6s + summary up to 5s + memory/
cross-conv/profile DB) pushed first-token to 8-12s on established chats, even though
the model's own TTFT was only ~3.4s. Users read that gap as "streaming is broken."

**How to apply:** any new per-turn context enrichment added to the streaming route
must either be cheap-and-parallel (join the `Promise.all`) or backgrounded like the
summary. Never add a new blocking `await` of an AI/network call ahead of
`writeSSE(start)` / the provider stream. The non-streaming `/chat` route can keep its
sequential summary update — its UX does not depend on first-token visibility.
