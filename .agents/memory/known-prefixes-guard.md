---
name: KNOWN_PREFIXES pre-auth 404 guard
description: Every new /api route prefix must be added to KNOWN_PREFIXES in routes/index.ts or the pre-auth 404 guard swallows the request before the auth wall.
---

A pre-auth middleware in `artifacts/api-server/src/routes/index.ts` (between the public routes block and `router.use(attachUser)`) checks every incoming path against a hardcoded `KNOWN_PREFIXES` array. If the path doesn't match any prefix, it returns `404 {"error":"Not found"}` immediately — before Clerk auth runs.

This means a new router registered after the auth wall will silently return 404 to anonymous callers instead of 401 unless its prefix is listed.

**Why:** The guard exists to return clean JSON 404s for genuinely unknown routes regardless of auth state. The side-effect is that every new auth-gated route prefix must be explicitly opt-in.

**How to apply:** When adding a new router after `router.use(attachUser)`, also append its prefix string to the `KNOWN_PREFIXES` array in the same file. Example: adding `vaultRouter` at `/vault` requires `"/vault"` in KNOWN_PREFIXES.

Caught during Phase 8A validation: `/vault` was missing, causing all `/api/vault` anonymous requests to return 404 instead of 401.
