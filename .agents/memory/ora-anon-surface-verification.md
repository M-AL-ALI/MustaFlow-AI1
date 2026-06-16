---
name: Ora streaming verification via anonymous surface
description: How to visually verify Ora token streaming when Clerk testing auth is blocked for the session.
---

When the Playwright testing subagent is auth-blocked for the whole session (programmatic Clerk sign-in fails -> /sign-in redirect + 401s; see clerk-testauth-rate-limit), you can still verify Ora **streaming** without auth.

**Use the anonymous landing-page OraBubble** (rendered on path `/` for signed-out visitors). It shares the EXACT streaming path with the authenticated OraPanel (`/ora`, Clerk-Protected): both call the same `useOraChat` hook (`consumeOraStream` -> per-token `setMessages`) and render with the same `OraRichText` + blinking `OraStreamCursor`. Only the container chrome differs.

**Why:** validating the anonymous bubble proves the identical parser + per-token state + partial-render mechanism the signed-in user sees, so you do not need to defeat Clerk throttling to confirm streaming works.

**How to apply:** if even the anonymous Playwright run is blocked (the whole testing tool can be poisoned for the session by one earlier Clerk failure), fall back to: (1) wire-level SSE checks through `https://$REPLIT_DEV_DOMAIN` (or `localhost:80` via the shared proxy: POST `/api/public-ai/session` to get the `ora-session` cookie, then POST `/api/public-ai/chat/stream` and timestamp each `event: token`), and (2) an app_preview screenshot to confirm health.

Note: a temporary dev-only "streaming live · N tokens" counter (`import.meta.env.DEV`, `OraMessage.streamTokens`) was used once to let the user self-confirm incremental delivery; it has since been removed at the user's request (users should never see debug labels). The `viaFallback` dev badge remains.
