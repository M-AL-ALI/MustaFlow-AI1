---
name: Gemini 3 thinking slows streaming first-token
description: Why Ora live-streaming looked "empty" and how thinkingConfig fixes time-to-first-token
---

On the Ora live-streaming path, Gemini 3 models (gemini-3-flash-preview, gemini-3.1-pro-preview) "think" silently before emitting any output token. Measured first-token latency on a realistic prompt: ~8.8s with thinking on vs ~4.2-5s with `thinkingConfig: { thinkingBudget: 0 }`. With classifier latency stacked on top this pushes time-to-first-token toward ~10s.

**Why this matters:** during that silent window the streaming bubble shows only an empty blinking cursor, so users report "not streaming / showing empty" even though the backend, proxy, and SSE pipeline are all healthy and stream incrementally (~50ms/token) once the first token arrives. A slow first token can also outlast a client that aborts the connection, so the user never sees any tokens at all.

**How to apply:** for conversational/live-streaming Gemini calls, set `thinkingConfig: { thinkingBudget: 0 }` in the generate config to trade extended reasoning for a fast first token. Both router-selectable Gemini 3 models accept `thinkingBudget:0` (verified — flash returns a `thoughtSignature`, pro does not, both respond fine). Do NOT debug this as a proxy-buffering or frontend-render bug: the Replit workspace proxy does NOT buffer SSE (start event is instant, tokens flow incrementally end-to-end), and OraRichText already renders a cursor for empty streaming content. The bottleneck is provider time-to-first-token, not the transport.
