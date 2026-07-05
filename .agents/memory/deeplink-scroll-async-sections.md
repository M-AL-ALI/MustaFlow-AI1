---
name: Deep-link scroll to a section below async-loading siblings
description: Why a single scrollIntoView lands at the top when earlier sections grow after mount, and the multi-retry fix.
---

# Deep-link scroll to a section below async-loading siblings

When a page deep-links to a lower sub-section (e.g. `/ora/settings?section=plan`
opened from mobile) and the sections ABOVE the target fetch their data
asynchronously, a single early `scrollIntoView` (or one gated on an initial
`loading` flag that flips false before those siblings finish) lands in the wrong
place: the earlier sections grow taller AFTER the scroll fires, pushing the
target down, so the viewport drifts back toward the top.

**Fix:** keep a `scrolledRef` latch (so we only schedule once), but schedule
several re-scrolls at increasing delays (e.g. `[150, 500, 1000, 1600]ms`),
re-querying `document.getElementById(id)` inside each timeout, and clear all
timers in cleanup. Use `behavior:"auto"` for the early fires and `"smooth"` for
the late ones. Do NOT gate on a single `loading` boolean — it usually flips
before the async siblings settle.

**Why:** the real settle time is unknown and driven by independent child fetches,
not one loading flag; retrying a few times is far more robust than trying to find
the "one true" ready moment.

**How to apply:** any React deep-link-to-section scroll where content above the
target loads independently. Trade-off: the late (>=1s) re-scrolls can yank the
viewport if the user manually scrolls within ~1.6s of landing — acceptable for a
fresh deep-link entry, but don't use this pattern for scrolls triggered mid-session.
