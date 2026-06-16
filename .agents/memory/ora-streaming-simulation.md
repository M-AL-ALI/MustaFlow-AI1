---
name: Ora streaming simulation
description: How to simulate token-by-token streaming when the Replit AI integrations proxy returns the full response as a single SSE chunk.
---

## The rule

The Replit AI integrations proxy buffers the complete AI response and emits it as **one SSE chunk**, regardless of `stream: true`. To give users a ChatGPT-style progressive delivery, split large chunks in the stream adapter itself.

## Implementation (stream-adapter.ts)

- `SIMULATE_THRESHOLD_CHARS = 25` — chunks shorter than this are small enough to emit as-is.
- `simulateChunkStream(text, signal)` — async generator that splits text at whitespace boundaries into groups of 4 words, yielding each group with a 30 ms delay between them.
- Inside `streamOraMessage`: for each `delta` from `streamChatCompletion`, if `delta.length > SIMULATE_THRESHOLD_CHARS` route through `simulateChunkStream`; otherwise yield directly.

## TCP flush (prevent Nagle batching)

Two locations must be set to ensure each SSE frame is flushed immediately:

1. **`chat.ts`** — after `res.flushHeaders()`:
   ```ts
   const sock = res.socket as import("net").Socket | null;
   if (sock?.setNoDelay) sock.setNoDelay(true);
   ```

2. **`writeSSE()`** — after `r.flush?.()`:
   ```ts
   // eslint-disable-next-line @typescript-eslint/no-explicit-any
   const sock = (res.socket ?? (res as any)._socket) as { uncork?: () => void } | null;
   if (sock?.uncork) sock.uncork();
   ```

**Why:** Without `setNoDelay`, the OS Nagle timer can hold small SSE frames (~200 ms). The Replit dev proxy also adds ~1.5 s per SSE frame line in dev; production CDN proxy handles SSE normally.

## Test behaviour

Streaming tests mock `streamChatCompletion` to yield `"Hello"` and `" World"` (both <25 chars), so `simulateChunkStream` is a no-op in tests — no test changes needed for the simulation path.
