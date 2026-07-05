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
- Search fails → answer from general knowledge, prepend an honest fallback note,
  return **200** `{ reply, searchFallback:true, searchRetryable }` and **KEEP quota consumed**
  (an answer WAS delivered).
  **Why:** the user got a useful reply; charging is correct.
- Fallback answer itself fails/empty → **refund quota exactly once** (guarded for anonymous)
  and return **503** `{ searchRetryable:true }`.
  **Why:** no answer delivered, so don't charge; 503 signals "recoverable, keep the message."
- **Forced-retry exception:** when `forceSearch` is set and the (harder) forced search STILL
  fails, do NOT run the general-knowledge fallback at all. Refund once and return **503**
  `{ error, searchRetryable:true }` directly. This is the FIRST branch of the search catch, so
  it runs before/instead of the fallback → guarantees one refund and never calls
  `createChatCompletion`. **Why:** the user already saw and rejected the fallback answer via the
  first Retry; regenerating the same long answer is worse than an honest "couldn't verify" + Retry.

## Freshness-critical note (two notes, not one)
- There are TWO fallback notes. For `searchRetryable` (freshness=current) prompts, use the
  FRESH note that does NOT present general knowledge as verified/current headlines and tells the
  user to tap Retry to run a live search. Evergreen prompts keep the generic
  "answering from general knowledge" note.
  **Why:** a "news today" prompt answered from stale training data, framed as current, is a
  correctness/trust failure. Never let the fresh path claim currency.

## forceSearch (the Retry-live-search override)
- Body flag `forceSearch:boolean` on `/public-ai/chat` overrides the routing decision to
  `tool:"search"`. It MUST be applied AFTER `routeOraMessage` but BEFORE checkToolAccess /
  quota / deepAllowed, so tier gates + single-charge semantics stay intact (no double-charge,
  anonymous still gets the uncharged sign-in CTA).
- forceSearch also runs a HARDER live-search strategy inside runOraWebSearch (`forceLive:true`):
  a longer first-attempt timeout + a low-effort secondary attempt + `retryOnTimeout` (see Latency).
- Only the non-streaming `/chat` route honors forceSearch; `/chat/stream` already bounces search
  to the non-streaming path, so leave it untouched.
- Frontend (web AND mobile parity): sendMessage takes a `forceSearch` opt; when set it SKIPS the
  streaming-first path and POSTs direct to `/chat` with `forceSearch:true` (streaming would only
  bounce search back). The Retry-live-search handler always sends `forceSearch:true` for that turn.
  On the forced **503** the client must keep the user's message AND keep a working Retry — mobile
  detects `ApiRequestError` with `body.searchRetryable===true`, flags the error bubble with
  `searchRetryable`, and renders Retry in BOTH the error branch and the success-fallback branch.

## Latency + timeouts
- web-search.ts caps each attempt (ORA_SEARCH_TIMEOUT_MS=12000 / ORA_SEARCH_RETRY_TIMEOUT_MS=8000
  / backoff 250) and throws typed `OraWebSearchError`. web_search legitimately needs several
  seconds, so the first cap is generous (was 5000 and caused false timeouts on news prompts).
- createSearchResponse takes an explicit `retryOnTimeout` flag and builds an `attempts[]` list.
  - **Normal (degrade-fast) path:** `retryOnTimeout=false`. It `break`s (no retry) on
    `err instanceof APIConnectionTimeoutError`; only fast-failing transient errors get the one retry.
  - **Forced path (`forceLive`):** `retryOnTimeout=true` with longer caps
    (ORA_SEARCH_FORCE_TIMEOUT_MS=26000 first, ORA_SEARCH_FORCE_RETRY_TIMEOUT_MS=12000 secondary).
    A timeout does NOT break — it runs the low-effort secondary attempt. **Why:** the user
    explicitly asked to retry live; spend more time before giving up (but bounded, and still 503s).
  - Forced attempts use `reasoning:{effort:"low"}` (NOT `search_context_size` — that 400s on gpt-5);
    the secondary also trims instructions + lowers maxOutputTokens (min(profile,900)).
- OraWebSearchError carries triage metadata: `attemptCount`, `latencyMs`, `failureReason`
  (classifyWebSearchFailure → timeout/…), `searchProvider`. chat.ts logs these on both the forced
  503 and the non-forced fallback so forced vs normal failures are distinguishable in prod.
- Test gotcha: any test that `vi.mock("openai")` MUST also export a stub
  `APIConnectionTimeoutError: class extends Error {}`, or `err instanceof APIConnectionTimeoutError`
  throws a TypeError inside web-search.ts under test. To assert the forced timeout retry, import
  that same mocked class in the test and `mockRejectedValue(new APIConnectionTimeoutError())` — the
  provider mock should then be called TWICE (initial + forced secondary).

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
