---
name: Ora "Failed to fetch" after publishing
description: Diagnosing client-side fetch failures with zero server trace; network-error normalization contract in the Ora web chat hook.
---

**Rule:** A user-reported "Failed to fetch" banner on Ora chat with NO matching failed request in server logs means the browser never reached the server — almost always the short server-restart window right after republishing (or the user's own connection), not a code/CORS/URL bug. Verify by grepping prod logs for the user's Clerk session/ipHash: if all their requests are 200/304, the failure was pre-request.

**Contract in the web hook (use-ora-chat):** all transport goes through `safeAuthFetch`, which converts low-level network rejections (TypeError "Failed to fetch"/"Load failed"/"NetworkError", but never AbortError) into a friendly Error carrying `{ network: true }` and NO `status` property — error branches dispatch on `.status`, so network errors must stay status-less. Mid-stream SSE drops are normalized separately inside the reader loop (with `partialContent` when tokens already arrived). Session init retries `{ network: true }` failures with backoff before showing the banner.

**Why:** raw browser error strings shown verbatim in a sticky banner read as "the app is broken" to non-technical users, and the once-on-mount session call is the request most likely to land in a deploy restart blip.

**How to apply:** any new fetch call in Ora web surfaces must use `safeAuthFetch` (not `authFetch` directly); keep the no-status invariant when rethrowing; mobile (Hermes) shows "Network request failed" and needs the same treatment (deferred to mobile parity work).
