---
name: Playwright JWT redaction in testing tool
description: The Playwright testing agent aborts when Clerk JWTs appear in captured tool output
---

The `runTest` Playwright testing tool has a safety filter that aborts when it detects a JWT pattern (`eyJ...`) in captured output — including API response headers (Set-Cookie from Clerk token refresh) and network responses.

**Why:** The testing subagent's safety layer redacts/aborts on credential exposure. Clerk session cookies are JWTs and appear in `Set-Cookie` headers on every authenticated API response.

**How to apply:**

- Do NOT write test plans that make direct `[API]` fetch calls to authenticated endpoints; these expose Clerk session tokens in response headers.
- Use `testClerkAuth: true` + browser-only `[Browser]` navigation steps instead. The browser manages cookies internally without exposing raw header values to the tool output.
- If direct API calls are unavoidable (e.g. for verifying response shape), note that the test will likely return `status: "unable"` due to JWT redaction — check DB state directly after the test to confirm backend success.
