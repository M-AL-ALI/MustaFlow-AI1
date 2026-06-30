---
name: Ora Mobile XHR SSE streaming transport
description: Why Hermes fetch/ReadableStream always buffers and how XHR progressive responseText fixes it.
---

# Hermes fetch/ReadableStream always buffers (Expo SDK 54 / RN 0.81)

Hermes' JS runtime does not yield `read()` calls on a `Response.body.getReader()` until the **entire** SSE body is available. This means the old `streamChatNative` implementation always produced "all at once" rendering even when the server was streaming correctly (confirmed: 878 ms TTFT in prod logs, `/chat/stream` returning 200 with chunked SSE).

**Fix:** Use `XMLHttpRequest.onreadystatechange` — at `readyState=3`, `responseText` grows progressively in React Native even on Hermes. Each callback delivers one or more SSE tokens that can be painted immediately.

**Why:** Hermes optimizes fetch for throughput, not streaming ergonomics. XHR's `onreadystatechange` fires on partial data at the transport layer before Hermes does any buffering.

**How to apply:** See `artifacts/ora-mobile/lib/api.ts` → `sseViaXHR()`. Key points:
- Track `processedLength` and slice `xhr.responseText.slice(processedLength)` each callback.
- Parse SSE lines from the new slice; emit each token to `onToken`.
- Use a `renderChain` promise queue with ~55ms gaps (`await sleep(55)` before each `onToken` call) so words appear one-by-one even if XHR batches several tokens in one `readyState=3` callback.
- Wrap in a `StreamChatDiagnostics` struct (exported via `getLastStreamDiagnostics()`) so Settings → Diagnostics can show transport, status, TTFT, token count, done flag, and fallback reason after each chat turn.

## Diagnostics integration
- `getLastStreamDiagnostics()` — read after a chat turn to get the last snapshot.
- `notifyStreamFallbackCalled()` — call before every `sendChat()` fallback branch in index.tsx so `viaFallback` is correctly recorded.
- Settings → Diagnostics card renders 14 InfoRows from the snapshot for TestFlight QA.

**Why:** "All at once" on device + word-by-word in simulator = Hermes buffering, not a server or fallback issue. Check `viaFallback` + `tokenCount` in diagnostics to distinguish transport failure from UI queue failure.
