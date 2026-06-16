---
name: Ora streaming quota branch gap
description: Multi-branch /chat route had a direct incrementMessageCount call in the terminal conversational branch that bypassed the chargeSession wrapper — pattern to watch for.
---

## Rule

When adding a new parameter to session-charging logic in a multi-branch route (file, image, search, conversational, …), search for ALL direct `incrementMessageCount` / `acknowledgeStreamingIncrement` calls, not just the wrapper function name. The terminal (conversational) branch had a direct `incrementMessageCount(session)` call that `replace_all` on the wrapper missed entirely.

**Why:** The `/chat` route has 5 named tool branches each ending in `chargeSession(session, isStreamingFallback)`, but the final conversational path was written with a direct `incrementMessageCount(session)` before the wrapper was introduced. `replace_all` only catches what it's searching for.

**How to apply:** After any quota-accounting change, run `grep -n "incrementMessageCount\|chargeSession\|setSessionCookie" chat.ts` to audit every session-touching call site — not just the ones that use the wrapper.
