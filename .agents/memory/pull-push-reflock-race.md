---
name: pull/push workflow ref-lock race
description: Why pull-from-github fails with "cannot lock ref refs/remotes/github/main" and how to recover
---

# pull-from-github vs push-to-github ref-lock race

The project Run button auto-starts ALL workflows in parallel, including `push-to-github` and `pull-from-github`. Both fetch the same remote and update `refs/remotes/github/main`, so concurrent runs race on `.git/refs/remotes/github/main.lock`. The loser dies with:

```
error: cannot lock ref 'refs/remotes/github/main': Unable to create '.../main.lock': File exists.
```

If the losing process is killed at the wrong moment, the lock file is left behind and EVERY subsequent pull fails the same way (stale lock, no live git process).

**Why:** the push script rm's `.git/refs/remotes/github/main.lock` before running, but the pull script only clears `index.lock`/`HEAD.lock` — it cannot recover from a stale remote-ref lock on its own.

**How to apply:**
- Symptom = pull workflow FAILED with "cannot lock ref ... File exists" while no git process is running → it's a stale lock, not divergence. `rm .git/refs/remotes/github/main.lock` (plain file delete, allowed in agent bash), then rerun the pull workflow.
- Ref content is unharmed — the fetch that lost the race simply didn't update the tracking ref; a rerun completes it.
- Expect this after any "run all workflows" event that fires both git workflows in the same second.

## Variant: index.lock mid-merge (checkpoint git race)

The pull workflow's merge step can also die with `Unable to create '.git/index.lock': File exists` — the Replit checkpoint system runs its own git process concurrently and holds/leaves the index lock. The pull script clears index.lock only at startup, not right before the merge, so a lock appearing mid-run kills the FF merge harmlessly (HEAD/index unchanged, fetch already complete).

**How to apply:** verify no live git process (`pgrep -x git`), confirm HEAD didn't move and no MERGE_HEAD exists, `rm -f .git/index.lock` (often already self-cleared once the checkpoint process finished), then just rerun the pull workflow — the branch was already fetched, so the rerun completes the merge in seconds.
