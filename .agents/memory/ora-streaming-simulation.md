---
name: Ora streaming simulation
description: How Ora simulates word-by-word streaming when the AI proxy buffers the full response
---

## Rule 1 — Accumulate all chunks server-side before simulating
Always accumulate ALL provider chunks before passing to `simulateChunkStream`. Never use a per-chunk size threshold.

**Why:** The Gemini AI integration proxy returns real small streaming tokens (each < 25 chars). A per-chunk threshold like `if (delta.length > 25)` causes small chunks to bypass simulation entirely and arrive at the browser in rapid succession.

**How to apply:**
- In `streamOraMessage` (stream-adapter.ts): accumulate all deltas from `gen` into `accumulated`, then call `simulateChunkStream(accumulated, signal)` on the full string.
- Use a nested try-catch during accumulation: if provider throws WITH partial content → simulate partial text + emit `stream_interrupted`; if provider throws with NO content → rethrow to outer catch for provider retry.
- `simulateChunkStream` splits on whitespace, groups into 2-word batches with 50ms delays.
- `SIMULATE_WORDS_PER_GROUP = 2`, `SIMULATE_DELAY_MS = 50`.

## Rule 2 — Yield to the browser paint loop between tokens (frontend)
After each `onToken(text)` call in `consumeOraStream`, `await` a `setTimeout(resolve, 0)` to yield back to the browser's rendering cycle.

**Why:** The Replit dev proxy (and likely any production CDN/nginx) buffers ALL SSE frames and delivers them in one TCP chunk. `reader.read()` returns all bytes at once; the for-loop fires every `onToken` synchronously in the same JS task. `flushSync` commits DOM changes but the browser only paints at the end of a JS task — so without the setTimeout yield, the complete response appears at once even though tokens are emitted one by one. `flushSync` alone is NOT sufficient.

**How to apply:**
```ts
// Inside consumeOraStream, for-loop over SSE parts:
} else if (eventType === "token") {
    const text = (parsed as { text: string }).text;
    firstTokenReceived = true;
    accumulated += text;
    onToken(text);
    // Yield to browser paint loop between tokens
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
```

**Also keep `flushSync` in the `onToken` callback** in `use-ora-chat.ts`:
```ts
(delta) => {
  flushSync(() => {
    setMessages((prev) => { /* append delta */ });
  });
}
```

`flushSync` ensures the DOM is committed; `setTimeout(0)` ensures the browser can paint before the next token is processed. Both layers are needed.
