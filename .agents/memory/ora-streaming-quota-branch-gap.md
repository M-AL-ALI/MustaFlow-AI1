---
name: Ora streaming quota branch gap
description: Multi-branch /chat route had a direct incrementMessageCount call in the terminal conversational branch that bypassed the chargeSession wrapper — pattern to watch for.
---

## Rule 1 — search ALL call sites when changing session charge logic

When adding a new parameter to session-charging logic in a multi-branch route (file, image, search, conversational, …), search for ALL direct `incrementMessageCount` / `acknowledgeStreamingIncrement` calls, not just the wrapper function name. The terminal (conversational) branch had a direct `incrementMessageCount(session)` call that `replace_all` on the wrapper missed entirely.

**Why:** The `/chat` route has 5 named tool branches each ending in `chargeSession(session, isStreamingFallback)`, but the final conversational path was written with a direct `incrementMessageCount(session)` before the wrapper was introduced.

**How to apply:** After any quota-accounting change, `grep -n "incrementMessageCount\|chargeSession\|setSessionCookie" chat.ts` to audit every session-touching call site.

## Rule 2 — SSE + JWT session: use TTL guard, not one-time-consume

After a SUCCESSFUL SSE stream, the server CANNOT clear flags stored in the session JWT cookie via Set-Cookie — those headers are already flushed before the first token is sent. The only stateless guard is a timestamp TTL baked into the JWT (`preIncrementedAt`): `chargeSession` checks `Date.now() - preIncrementedAt < TTL_MS` before honouring the skip-increment path. The flag persists in the cookie after success but expires after 60 s, closing the abuse window without DB state.

**Why:** A client-asserted `isStreamingFallback: true` on a stale cookie from a prior successful stream would otherwise bypass `incrementMessageCount` entirely.

**How to apply:** Any new JWT-based session flag that must be consumed after a one-way SSE response should use a companion `*At: number` timestamp + server-side TTL validation. Clean-up on the NEXT non-fallback turn via `incrementMessageCount` (which destructures out the flag) handles the common case.
