---
name: RN SSRF URL guard must canonicalize numeric IPv4
description: Porting a web new-URL() host-safety guard to React Native requires manual IPv4 canonicalization or it is an SSRF bypass
---

When porting a web SSRF/host-safety guard (the kind that does
`new URL(url).hostname` then rejects localhost/private ranges) to React Native,
a naive regex host extractor is **not equivalent** and silently bypasses the
filter.

**Why:** RN has no reliable `URL` and no `url` polyfill is installed, so the port
extracts the host with a regex. But the browser's WHATWG URL parser
*canonicalizes* numeric IPv4 hosts before exposing `.hostname` — decimal
(`2130706433`), short (`127.1`), octal (`0177.0.0.1`), and hex (`0x7f000001`)
all normalize to `127.0.0.1`. A regex that only matches dotted-quad lets every
one of those forms through, and `expo-image` / `expo-web-browser` /
`expo-file-system` then normalize them right back to the private address — the
exact SSRF probe the guard was supposed to stop.

**How to apply:** the RN guard must replicate the IPv4 canonicalization itself:
parse 1–4 dot-separated parts (decimal / leading-zero octal / `0x` hex), apply
the "last part absorbs the remaining octets" rule, reject overflow as unsafe
(the browser throws on these, so treat them as blocked), assemble the 32-bit
address, and run the private-range check on the resulting dotted-quad. Apply the
guard at *every* untrusted-URL sink — render, auto-fetch, open, AND copy — not
just the obvious image/source cards (Markdown link opens are an easy one to
miss). Keep first-party/backend asset URLs (which may be `data:`) exempt only
while they stay first-party.
