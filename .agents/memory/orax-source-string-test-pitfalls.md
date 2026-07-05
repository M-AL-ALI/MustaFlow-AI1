---
name: ORAX source-string test pitfalls
description: Common failures when writing source-string assertions for orax.ts and orax-wiring.test.ts
---

## The rule
Source-string `toContain()` assertions on multiline function signatures are fragile — Prettier or any reformatting will change whitespace and break them.

**Why:** Saw this break when the `isPlanModeTask(task, messages?)` signature was written with explicit `\n` escapes that didn't match what Prettier emitted. The wiring test also had an exact-newline assertion on `buildOraxRunnerReadPaths(` that needed loosening.

**How to apply:**
- For function signatures: assert a short, unique phrase from the body (e.g. `"isNlPlanModeMessage(latestUserMsg)"`) rather than the full multiline signature.
- For call sites: use the existing `collapse()` helper in orax-wiring.test.ts (`collapse(source).toContain(...)`) when the call spans multiple lines, OR assert only the function name + first argument on one line.
- Direct unit tests (importing pure helpers) are always more reliable than source-string tests. Export helpers from `lib/` files rather than keeping them private in `routes/` when they need behavior coverage.

## Fixed-length slice windows
When a source-string test anchors on a comment/marker and asserts on code with
`src.slice(anchorIdx, anchorIdx + N)`, adding lines to the asserted block can
push the target text past `N` chars, so `indexOf` returns -1 and the assertion
fails even though the source is correct. Symptom: a `toBeGreaterThan(other)`
ordering check fails because one index is -1. Fix: widen `N` generously (the
window is just a bound, not a precise measure). Seen in
`ora-realtime-watchdog.test.ts` after the `response.done` verdict grew.

## Mobile `app/(home)/settings.tsx` inference gap
The first domain inference heuristic did not score `app/(home)/settings.tsx` high enough for mobile prompts because the regex only matched `screen|tab|navigation|nav|stack|component|style|theme|layout`. Adding the `app/(home)` path segment pattern (or any `/(home)/`, `/(tabs)/`, `/(screens)/` style Expo router segment) was required to catch these correctly.
