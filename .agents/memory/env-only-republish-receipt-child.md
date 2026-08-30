---
name: Env-only Republish creates tree-identical receipt child
description: Republishing with only an env var change (no code push) produces a new commit hash but identical tree hash — the canonical "tree-identical receipt child" pattern.
---

When the only change between two publishes is an environment variable (no git commit), the Replit deployment creates a new build with:
- Different commit hash (e.g. 0674f330 vs 64a58104)
- **Identical tree hash** (8da344c0... in Wave B)
- New builtAt timestamp

The ceremony wave spec calls this a "tree-identical receipt child" — `/api/version commit <X> or tree-identical receipt child, TREE <Y> ABSOLUTE`. The TREE is the binding identity, commit can legitimately differ.

**Why:** Replit's build system commits an envelope around the workspace snapshot; if code is unchanged but env differs, the envelope commit hash changes but the source tree it points to does not.

**How to apply:** when verifying post-env-flip Republish, TREE match is sufficient for closure; do not require the commit to equal TIP5 verbatim.

Also: `setEnvVars({ environment: "shared", values: { KEY: "value" } })` works for the enforcement flip even when the same key exists in available_secrets — the shared env var takes effect at the next deployment boot.
