---
name: pull-from-github merge conflict blocks main agent
description: The pull-from-github workflow can leave an in-progress merge with a conflicted pnpm-lock.yaml that the main agent cannot resolve (git writes blocked).
---

# pull-from-github auto-merge leaves an unresolvable (for main agent) lockfile conflict

The `pull-from-github` workflow runs `git merge github/main`. When local `main` and
`github/main` have diverged only in `pnpm-lock.yaml` (e.g. an upstream branch bumped a
transitive dep so `@types/react` exists at two versions), the merge fails with conflict
markers in `pnpm-lock.yaml` and leaves an **in-progress merge** (`.git/MERGE_HEAD` present,
`UU pnpm-lock.yaml` in `git status`).

## Symptoms
- `quality-gate` / `typecheck` fail across many files (e.g. `spinner.tsx`, `calendar.tsx`)
  with `TS2322 ... Two different types with this name exist, but they are unrelated` —
  this is duplicate `@types/react` from the half-merged lockfile, NOT a code bug.
- `format` may also fail on unrelated upstream files (e.g. `artifacts/ora-mobile/*`).
- `pull-from-github` log: `Merging is not possible because you have unmerged files`.

## Why the main agent cannot fix it
- The bash tool blocks **all** git writes, so `git add` / `git merge --continue|--abort`
  are impossible from the main agent.
- `pnpm install` (which auto-resolves pnpm-lock merge conflicts) **also fails**: pnpm's
  prepare/husky hook touches `.git/config`, which trips the destructive-git guard
  (`Destructive git operations are not allowed in the main agent ... .git/config.lock`).

## How to apply
- If you see the dual-`@types/react` TS2322 wall + `UU pnpm-lock.yaml`, do **not** chase it
  as a code bug and do **not** hand-edit the 50+ lockfile hunks.
- Treat it as out-of-scope environment damage. Resolve it via a **background Project Task**
  (git ops allowed there): run `pnpm install` to auto-resolve the lockfile, then complete
  the merge. Your own clean code changes are unaffected once the lockfile is regenerated.
