---
name: GitHub checkpoint auto-sync vs stale tracking ref
description: Why push-to-github says "Everything up-to-date" for a brand-new local merge commit, and how to confirm the real remote SHA.
---

Replit platform checkpoints auto-sync merged commits to the connected GitHub remote. So after a task merge creates a new local merge commit, running the `push-to-github` workflow often reports `Everything up-to-date` even though it looks like the commit was never pushed — the remote already has it via checkpoint sync.

**Why the confusion:** the local remote-tracking ref (`refs/remotes/github/main`) frequently gets stuck with `cannot lock ref ... is at X but expected Y` during the pre-push fetch, so `git rev-parse github/main` and `ls -t /tmp/logs/*.log` reads show a STALE older SHA. This makes it look like the remote is behind when it is not.

**How to confirm the real remote SHA (authoritative):**
- Restart the `pull-from-github` workflow — it does a FORCED ref update (`+main:refs/remotes/github/main`) that bypasses the lock and prints `Local HEAD is now: <SHA>`. If that equals your local `git rev-parse HEAD` and the merge was "Already up to date", the remote is in sync.
- Read workflow output via `refresh_all_logs`, NOT `tail`/`ls -t` on `/tmp/logs` — those files lag and return stale runs even right after a restart.

**How to apply:** don't loop re-running push-to-github chasing a "behind" state. Confirm once via a forced pull-from-github + refresh_all_logs, then trust `Everything up-to-date`.
