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
