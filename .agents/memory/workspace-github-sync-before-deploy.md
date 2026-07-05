---
name: Verify workspace == GitHub main before publishing
description: The main-agent workspace can silently lag GitHub main; publish ships the workspace, not GitHub, so a stale workspace deploys old code.
---

Changes pushed to GitHub main from a *different* environment (an isolated task-agent env, another session, or the user's machine) do NOT automatically appear in the main-agent working tree. The cached `github/main` remote-tracking ref can also be stale (it only updates when the pull-from-github workflow last fetched). So `git log`/`rg` on the workspace can show OLD code even though the user says "it's on GitHub at <sha>".

**Why it matters:** Replit publish/deploy builds from the **current workspace files**, not from GitHub. If the workspace is behind, publishing ships stale code (e.g. old token budgets) even though GitHub is correct and the user "verified" it in their env.

**How to apply:** Before advising or triggering a deploy after a user says work is "pushed":
1. `git --no-optional-locks log -1 --oneline` and grep a known changed line in the working tree to confirm the change is actually present locally.
2. If missing, run the `pull-from-github` workflow (restart_workflow) — it force-fetches GitHub main into `refs/remotes/github/main` and merges into local main. A clean fast-forward is the normal happy path when the remote commit descends from local HEAD.
3. Re-confirm `HEAD == github/main == <expected sha>` and the changed line is present, then restart the affected service workflow so the dev server runs the new code before re-measuring.
4. Main-agent git writes are blocked, so the pull workflow is the only fetch/merge mechanism; if the merge conflicts (e.g. pnpm-lock.yaml) resolve via a background task, not directly.
