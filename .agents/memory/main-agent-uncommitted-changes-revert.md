---
name: Main-agent uncommitted edits revert across turn boundaries
description: Why main-agent file edits can silently vanish before the push-to-github workflow stages them, and how to avoid it.
---

Main agent cannot run git writes from bash; commits to GitHub happen only via the
push-to-github workflow (it `git add`s an explicit file list, commits, pushes).
Uncommitted working-tree edits are NOT durable across many turn boundaries (nor
across a context-compression boundary): they can be silently reverted to HEAD with
NO reflog entry and NO stash.

Observed: edits to a file survived one turn (a later typecheck still saw them) but
were gone ~3 turns later when the push workflow's `git add` ran, so the commit
captured only an unrelated change. Re-applying the edits and running push-to-github
in the *very next turn* succeeded (the commit then contained the file's full diff).

**Why:** the platform checkpoint / gitsafe-backup system restores the working tree
to HEAD at some boundaries; only changes already committed survive. The gitsafe
revert leaves no reflog/stash trace, so it looks like the edits "never happened."

**How to apply:** when landing a main-agent edit to GitHub, add the file to
push-to-github.sh's `git add` list and run the push-to-github workflow in the turn
immediately after editing — do not interleave several unrelated turns (reads,
typechecks, other edits) between the edit and the commit. After the push, VERIFY the
change is really in HEAD with `git --no-optional-locks show HEAD:<path> | grep ...`;
a commit stat showing only the unrelated script change is the tell-tale that the
target file was reverted before staging.
