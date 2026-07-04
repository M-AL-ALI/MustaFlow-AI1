---
name: Stale lib declarations break artifact typecheck
description: When an artifact typecheck reports "no exported member X" from a @workspace/* lib, rebuild libs first.
---

A leaf artifact typecheck (`pnpm --filter @workspace/ora-mobile run typecheck`, mustaflow, etc.) can fail with `TS2305: Module '"@workspace/ora-contracts"' has no exported member 'X'` even though the export clearly exists in `lib/ora-contracts/src/index.ts`.

**Why:** leaf artifacts consume the lib's emitted `.d.ts`, not its source. If the lib was edited but not rebuilt, the stale declarations lack the new export.

**How to apply:** before trusting an artifact typecheck, run `pnpm run typecheck:libs` (or `pnpm run typecheck`, which builds libs first). This is the canonical full gate. Only chase the "missing export" if it still fails after a lib rebuild. Same principle the pnpm-workspace skill notes for `@workspace/db`.
