---
name: Source-slice parity tests need CRLF normalization
description: Web↔mobile (or any cross-file) source-string equality/snapshot tests must normalize line endings or they fail Windows-only.
---

# Source-slice / source-snapshot parity tests must normalize CRLF→LF

Any test that asserts two source-code regions are identical by reading the raw
files (e.g. the speaker-focus scorer + tokenizer parity guards in
`realtime-session.test.ts`, which slice between `ORA_REALTIME_*_PARITY_START/END`
markers and `expect(mobile).toBe(web)`) must `.replace(/\r\n/g, "\n")` the slices
before comparing.

**Why:** the repo has Windows checkouts (git autocrlf), so one mirrored file can
be CRLF and the other LF. The byte-for-byte compare then fails despite identical
logic. Linux/Replit is the canonical env and uses LF, so it will NOT reproduce
the failure — the report comes from a Windows run.

**How to apply:** normalize at the shared slice/extraction helper (one place),
not at each comparison site, so future marker-based parity checks inherit it.
Do NOT normalize lone `\r` — abnormal in this codebase, should stay a visible
mismatch. The product invariant is "duplicated logic identical across surfaces,"
not "physical line-ending equality," so this does not weaken the guard.
