---
name: Ora web-search media (images + videos)
description: How Ora surfaces real web images/videos from web_search, and the SSRF guard that gates all media + citation URLs.
---

Ora's web search (Responses API `web_search`, gpt-4o, direct `OPENAI_API_KEY`) returns
text + citations. To also surface real images (inline gallery) and videos (link cards),
the model is instructed to append ONE trailing fenced ```ora-media JSON block
(`{images:[{url,title,source}], videos:[{url,title,thumbnailUrl}]}`); the server parses,
strips, and sanitizes it. YouTube thumbnails are derived from the watch URL.

**Provenance is NOT verifiable.** The `web_search` Responses API does not expose a
machine-checkable list of tool-returned media URLs — the model self-reports media. So
"never invent URLs" cannot be enforced by matching against tool output. Mitigation baseline:
http(s)-only + public-host-only + dedupe/cap + frontend `<img onError>` hide-on-failure.
Do not claim full provenance enforcement.

**Videos: existence-verified via oEmbed (not just shape-checked).** The model routinely
hallucinates plausible-but-dead YouTube IDs → the card renders a broken player ("An error
occurred / Playback ID …") behind a dead "Watch on YouTube" link. `sanitizeVideos` only
validates URL *shape*. `verifyVideos` (in `web-search.ts`, awaited in `runOraWebSearch` after
`parseOraMediaBlock`) confirms each video against its provider's **public oEmbed endpoint**
(`youtube.com` / `vimeo.com` — fixed trusted hosts, so the outbound call is NOT SSRF even
though the input URL came from the model) and DROPS anything non-2xx/timeout/error. Runs in
parallel with a per-request timeout, preserves order. **Tradeoff:** videos on providers we
can't oEmbed-verify (anything but YouTube/Vimeo) are dropped entirely — "show nothing" beats
"show a fake card." Images are NOT verified (broken `<img>` just hides; no fake-link UX).
**How to apply:** any new video provider must get an oEmbed entry in `videoOembedEndpoint` or
its cards never surface.

**SSRF guard (load-bearing): `isPrivateOrLocalHost` gates every media + citation URL.**
**Why:** media URLs are auto-fetched by the viewer's browser via `<img src>` (no click),
so a hallucinated/poisoned internal URL turns a chat reply into an SSRF-style probe of the
viewer's own network. **How to apply:** the check lives in BOTH the backend shared guard
(`web-search.ts` `isSafeHttpUrl`, which gates `cleanSourceUrl` → all sources + sanitizeImages/
sanitizeVideos) and the frontend guard (`ora-source-cards.tsx` `isSafeHttpUrl`, imported by
`ora-media-cards.tsx`). It blocks localhost/`*.local`/`*.internal`/`0.0.0.0`, IPv4 loopback/
RFC1918/link-local incl. `169.254.169.254` metadata, IPv6 `::1`/`fc00::/7`/`fe80::/10`, and
normalizes bypass forms (trailing-dot FQDN, `::ffff:` IPv4-mapped IPv6). Keep the two copies
in sync — any new media/citation surface must run through `isSafeHttpUrl`, never a bare
protocol check.

**Residual risk (accepted, documented):** string-hostname checks do NOT stop DNS rebinding
(a public hostname resolving to a private IP). Closing that needs a server-side media proxy
that resolves DNS and rejects non-public IPs before returning bytes — a separate feature, not
built here.

**Persistence:** media round-trips through `use-ora-chat.ts` (`OraMessage.images/videos` +
`serializeForStorage` spreads) and BOTH backend validators (`ora-transcript.ts` +
`ora-conversations.ts` messageSchema). Mirrors the existing "Ora message persistence schema
mirroring" rule — miss either schema and rich fields are silently stripped on save.

**Personalization parity — the search branch is a separate code path.** `chat.ts` has two
branches: the SEARCH branch (`decision.tool === "search"` → `runOraWebSearch` → early
`return`) and the conversational branch below it. `buildMemoryContext`/`buildProfileContext`
are only injected in the conversational branch's `systemPrompt`. **Any per-user context
(memory, profile, "About you") must be wired into BOTH branches independently, or it silently
fails for whichever branch was missed** — e.g. "Ora remembers everything about you" broke
during web searches because the search branch returned before any memory injection.
**Why:** the search branch builds its own instructions in `web-search.ts buildInstructions`,
not `buildSystemPrompt`. **How to apply:** the search branch passes
`personalContext = profileContext + (referenceSavedMemories ? memoryContext : "")` into
`runOraWebSearch({...personalContext})`; keep the toggle semantics identical to the
conversational branch (profile always for authed users, memories gated on
`referenceSavedMemories`). Both context builders are best-effort (try/catch → "") so awaiting
them inside the search try block can't break search.
