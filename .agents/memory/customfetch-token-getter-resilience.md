---
name: customFetch token getter must not throw
description: Why the Orval customFetch auth-token getter must be wrapped in try/catch (cookie fallback)
---

# customFetch token getter resilience

In `lib/api-client-react/src/custom-fetch.ts`, the bearer-token attachment must
invoke the registered auth getter through the try/catch-wrapped `getAuthToken()`
helper, **never** by calling the raw `_authTokenGetter()` inline.

**Why:** the registered getter is Clerk's `() => getToken()`, which can reject
(token refresh failure inside the embedded preview iframe, expired ~60s dev-key
session, transient network). If the getter is awaited without try/catch,
`customFetch` rejects _before_ `fetch()` runs, so the request never leaves the
client. Symptoms: a generic mutation error (e.g. mode-select "Could not save
your preference") with **no matching request in the server logs**, and the
cookie-auth fallback (`credentials: "include"`) never gets a chance. Any Orval
hook can fail this way, presenting as "the app intermittently doesn't work."

**How to apply:** any client-side step that runs in the request preflight path
(token getters, header builders) must degrade to null/skip on failure, not
throw. A throwing getter should fall back to cookie auth, and an explicit
`Authorization` header from the caller must still short-circuit the getter.
