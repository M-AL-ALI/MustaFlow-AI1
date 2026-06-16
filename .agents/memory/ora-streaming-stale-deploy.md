---
name: Ora "no streaming" is usually a stale production deployment
description: When a user reports an Ora UI symptom you cannot reproduce in dev, suspect they are testing the published app, not the dev preview.
---

Symptom: user repeatedly reports "Ora answer appears all at once, no word-by-word streaming" even after hard refresh, while dev verification of every layer (backend SSE, proxies, consumeOraStream parser, per-token setMessages, OraRichText partial render) passes.

Root cause (observed): the user was testing the **published/deployed** MustaFlow, not the Replit dev preview. The deployed frontend bundle predated the streaming-first hook, so in production the client calls `POST /api/public-ai/chat` directly and never even attempts `/api/public-ai/chat/stream`. That endpoint returns the full reply after ~4-5s = "blank then all at once".

**Decisive diagnostic:** compare two log sources.
- Dev workflow logs (`refresh_all_logs`): if there is NO `POST /api/public-ai/chat*` at all (only session/usage/conversations GETs + published-project `/api/p/:slug/` polling), the user is NOT on the dev preview.
- Production logs (`fetch_deployment_logs`, filter `chat|stream`): if prod shows `POST /api/public-ai/chat` 200 (no `/chat/stream` requests), the deployed frontend is stale.

**Fix:** republish. The streaming-first code + the shared-env flags (`ORA_STREAMING_ENABLED`, `VITE_ORA_STREAMING_ENABLED`, `EXPO_PUBLIC_ORA_STREAMING_ENABLED`, all `=true` in the **shared** environment so prod inherits them at runtime/build) only take effect once a new deployment is built from current source.

**Why this matters:** I burned multiple rounds "fixing" dev streaming (which already worked — verified 98 token events ~50ms apart at the wire) because I assumed the user was on the dev preview. Always confirm WHICH surface the user is on (dev preview vs published URL vs phone) before debugging an unreproducible UI report. The current web hook has NO build-time streaming gate (grep `VITE_ORA_STREAMING` in mustaflow/src returns nothing) — memory note ora-streaming-flags.md listing a required VITE gate is stale for web; only the server `ORA_STREAMING_ENABLED` gate matters for the web surface.
