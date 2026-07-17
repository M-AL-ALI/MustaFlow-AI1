---
name: Ora ZIP upload extraction guards
description: Durable decisions from adding ZIP repo upload support to Ora (zip-bomb bounds, compressed-size cap, code-vs-prose content scanning)
---

# Ora ZIP upload extraction guards

- **fflate `unzipSync` memory bound:** it allocates output buffers at the header-claimed `originalSize` with `resize=false`, so a lying header cannot cause unbounded memory. The filter callback's pre-inflate `originalSize` accounting IS the true allocation bound.
- **Cap compressed size too:** `info.size` (compressed bytes) must be capped per accepted entry alongside `originalSize`, or an attacker can claim a tiny originalSize while shipping a ~90MB deflate stream that burns CPU synchronously on the request thread. Real inflation is ≤ ~1032× compressed, so a compressed cap also tightens the total-CPU bound.
- **Code content needs its own safety scan:** the general malware signature patterns (`os.system(`, `rm -rf`, etc.) false-positive on nearly every real repository. ZIP digests use `scanCodeContent()` (prompt-injection patterns only). **Why:** the code is read as text and never executed; injection scanning is the layer that actually protects the prompt.
- **How to apply:** any future archive/code-upload surface (tar, multi-file paste, repo import) should reuse `extractZipDigest`'s guard set: scanned-entry throw cap, accepted-file cap, per-file caps on BOTH sizes, total inflate cap, post-inflate lying-header re-check, binary NUL sniff, ignored-dir list, and injection-only scanning.
- fflate `UnzipFileInfo`: `size` = compressed, `originalSize` = uncompressed.
