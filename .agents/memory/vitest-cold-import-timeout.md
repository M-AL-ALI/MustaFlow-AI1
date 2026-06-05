---
name: Vitest cold-import timeout on heavy route trees
description: The first test that imports a large Express router tree can exceed the 5s default test timeout during cold transform; fix with a per-test timeout, not a logic change.
---

In `api-server`, the first test in a file that does `await import("../index")` (or otherwise pulls in the full public-ai router tree) can intermittently fail with "Test timed out in 5000ms". This is the one-time cold transform/import cost of the whole module graph landing inside a single test's window — NOT a hang or a logic bug.

**How to confirm:** re-run with `--testTimeout=30000`; if it then passes, it was cold-import slowness.

**Fix:** give the first heavy-import test(s) a per-test timeout (e.g. `it(..., async () => { ... }, 30000)`). Do not chase it as a runtime bug.

**Related:** keep heavy/optional deps lazily imported inside handlers. Example: `chat.ts` dynamically imports `lib/image-provider` (which pulls the large `openai` SDK) only inside the image-generation branch, so the route module graph stays light and route-mount tests don't pay the SDK import cost.
