---
name: localStorage cache user scoping
description: Per-user UI caches in localStorage must be keyed by userId and treated as cache, not source of truth, to avoid cross-user leakage on shared browsers.
---

# localStorage caches must be user-scoped + server-authoritative

When a signed-in feature caches per-user data (chat transcripts, drafts) in
`localStorage`, two rules are load-bearing:

1. **Key the entry by the authenticated user id**, e.g. `feature_v1:${userId}` — a
   single global key (`feature_v1`) leaks the previous account's data to the next
   person on a shared browser. Also purge any pre-scoping legacy global key once on
   mount.
2. **When the backend is the source of truth, finalize hydration even when the
   server returns empty.** A once-guard that only fires on non-empty server data
   leaves stale cache visible; instead, after the list/detail queries settle,
   replace from the server when it has data and *clear* the cache when it doesn't.

**Why:** code review flagged that a global `localStorage` key plus a
hydrate-only-when-non-empty guard could surface one user's support-chat transcript
to another user on a shared device (real privacy regression).

**How to apply:** any new signed-in localStorage cache — scope the key by userId,
load the user's own cache for instant display, then let the settled server query
overwrite-or-clear. Keep helpers (key builder, load/persist/clear) pure and
exported so the scoping/clearing can be unit-tested in jsdom without mounting the
component.
