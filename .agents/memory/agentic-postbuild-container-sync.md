---
name: Agentic post-build container sync must be honest
description: After a successful build/refine, syncing files + installing deps + restarting the app in the Fly container must use the robust background-install path and verify real reachability — never a direct exec that reports success blindly.
---

# Agentic post-build container sync must be honest

When a build/refine succeeds for an agentic (containerized) project, the post-build
step that pushes files into the live Fly container, installs deps, and restarts the
app server MUST:

1. Install deps via the **detached background installer** (polls a sentinel file),
   never a direct `execInContainer(["npm","install",...])`. A direct exec holds the
   HTTP connection open for the whole install, and Fly autostop (~60s idle) cuts it
   with EOF, so the install dies. The background path also cleans stale npm locks
   (idealTree conflict) and re-syncs files if the machine restarts mid-install.
2. Only restart the server / report success when the install actually succeeded.
3. **Poll real preview reachability** (HTTP health) before emitting a "ready" /
   "Server started" status. Publish an honest ready/failed event either way.
4. Not hard-gate on `containerStatus === "running"` — the canonical sync helper
   wakes a hibernated machine itself; gating skips the sync after autostop and
   leaves the preview stale.

**Why:** A prior bug emitted "Server started." unconditionally even when the
container install failed and the server was never reachable. That false success
masked the real failure, so users kept re-requesting fixes — builds appeared to
"cycle" while nothing actually got deployed. Reuse the one canonical container-sync
helper across all build/refine/apply paths; do not hand-roll a second, weaker one.

**How to apply:** Any new code path that mutates files in a running agentic
container should call the shared sync helper (the same one the apply path uses),
not a bespoke install+start sequence.
