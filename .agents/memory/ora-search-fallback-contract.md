---
name: Ora Deep-mode search fallback contract
description: Durable rules for Ora's live-web-search graceful fallback (routing, quota, retry, web/mobile parity) that future changes must not break.
---

# Ora Deep-mode search fallback contract

The Ora `/public-ai/chat` search branch degrades gracefully instead of hard-failing.
Keep these invariants when touching web-search.ts / chat.ts / the Ora clients.

## Routing (don't over-route)
- Deep mode must NOT route every prompt to live search. Only route when the prompt is
  current/live/volatile OR an explicit search ask. Evergreen/reasoning prompts stay OFF
  search in BOTH Instant and Deep. Locked in by search-routing.test.ts.
- `searchRetryable` = `inferOraSearchPlan({query}).freshness === "current"`. Same gate on
  backend + web + mobile + tests (evergreen → false).

## Quota semantics (the non-obvious part)
- Search fails → answer from general knowledge, prepend the honest SEARCH_FALLBACK_NOTE
  ("I couldn't verify live web results right now, so I'm answering from general knowledge."),
  return **200** `{ reply, searchFallback:true, searchRetryable }` and **KEEP quota consumed**
  (an answer WAS delivered).
  **Why:** the user got a useful reply; charging is correct.
- Fallback answer itself fails/empty → **refund quota exactly once** (guarded for anonymous)
  and return **503** `{ searchRetryable:true }`.
  **Why:** no answer delivered, so don't charge; 503 signals "recoverable, keep the message."

## Latency
- web-search.ts caps each attempt (ORA_SEARCH_TIMEOUT_MS / retry timeout / backoff) with ONE
  capped retry and throws typed `OraWebSearchError`; worst case ~8.25s vs the SDK ~10min default.

## Web/mobile parity (easy to break)
- On the rare **503 double-failure**, the client MUST keep the user's message in the thread and
  surface a WORKING Retry that replays that exact turn. Mobile already does this (inline error).
  Web `apiPost` must attach `searchRetryable` to the thrown error, and the executeApiCall outer
  catch must special-case `status===503 && searchRetryable` to skip the `prev.slice(0,-1)` that
  every other error path uses; the ora-panel error-banner Retry also renders when the last
  message is a `user` message (preserved turn).
  **Why:** the generic catch strips the user message → Retry replays the WRONG turn (or none in a
  fresh chat), contradicting the 503 "your message is still here" contract.

## Hard don'ts
- Never claim 100% accuracy. Never touch Instant mode or streaming cadence for this feature.
- Deep must not silently go non-streaming on mobile; search goes through the /chat non-streaming
  fallback via the pre-existing streamingFallback signal (so web + mobile hit identical fallback).
