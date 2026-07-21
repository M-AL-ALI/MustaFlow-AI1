---
name: Filtered pnpm add prunes root node_modules bins
description: A `pnpm --filter <pkg> add ...` can prune root node_modules/.bin links (e.g. vitest), breaking other packages' typecheck/tests until a full install.
---

**Rule:** After any `pnpm --filter <pkg> add <dep>` in this monorepo, if an unrelated package suddenly fails with "Cannot find module 'vitest'" (or another root devDependency) during typecheck or its bin disappears from `node_modules/.bin`, the filtered install pruned root links.

**Why:** Observed after pinning a mobile dependency: `@workspace/api-server` typecheck started failing with TS2307 "Cannot find module 'vitest'" in test files, and `node_modules/.bin/vitest` was gone while the `vitest` package dir remained. Nothing was wrong with the code.

**How to apply:** Run a full `HUSKY=0 pnpm install` at the workspace root to restore the links, then re-run the failing check before debugging anything else. Also expect running workflows (Expo/Vite) to need a restart after the install churn.

Update (2026-07-21): vitest is NOT a root dependency in this repo — a full `HUSKY=0 pnpm install` will not create a root `node_modules/.bin/vitest`. Each package that tests (api-server, mustaflow, ora-mobile) has its own vitest devDependency; run tests via `cd <pkg> && ./node_modules/.bin/vitest run <file>` or `pnpm --filter <pkg> exec vitest run`.
