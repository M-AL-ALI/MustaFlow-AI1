---
name: Vitest resource kills in Replit workspace
description: How to run workspace vitest suites when pnpm run test exits -1 with no output
---

Vitest runs in this workspace can be killed silently (exit code -1, zero output) by resource limits — not a test failure.

**Why:** The Replit container OOM-kills multi-worker vitest runs. api-server suites are worst (heavy router imports), but even a single mustaflow test file via `pnpm --filter @workspace/mustaflow run test -- <file>` has died this way.

**How to apply:**
- Retry with: `NODE_OPTIONS="--max-old-space-size=3072" pnpm --filter @workspace/<pkg> exec vitest run <files> --no-file-parallelism` — this reliably passes.
- Vitest 4 removed `--poolOptions.*` CLI flags; use `--maxWorkers=1` instead for older invocations.
- For api-server, if even single-file runs die, fall back to typechecks + manual node assertion scripts as the gate.

Manual tsx assertion scripts must live INSIDE the package dir (e.g. artifacts/api-server/tmp-script.mts): /tmp scripts run as CJS (no top-level await) and cannot resolve package deps like fflate. Use .mts, run via `pnpm --filter @workspace/api-server exec tsx <file>`, delete after.

## Release gate OOM pattern (distinct from single-file OOM)

The `ora-stability-gate` workflow runner itself gets OOM-killed after ~3 minutes of accumulated sequential process memory — even when every individual bundle passes when run in isolation.

**Observed crash points:** api-files-images (after 3 typechecks) and api-account-billing-history (after 3 typechecks + 9 vitest batches). The crash is always at the transition between bundles, not mid-test.

**Workaround:** Verify the fast profile via `ora-gate-fast` workflow (14 checks), then verify the 5 release-only additions manually from bash in smaller batches:
1. api-release-extended → split into 3 batches of 9 files each (direct vitest run)
2. api-account-billing-history → split into 2 batches of 7 files each
3. api-build → `pnpm --filter @workspace/api-server run build`
4. web-build → `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/mustaflow run build`
5. lint → `pnpm run lint`

**Key:** web-build requires PORT and BASE_PATH env vars (vite.config.ts throws without them). From bash without PORT set, use `PORT=5000 BASE_PATH=/ pnpm --filter @workspace/mustaflow run build`.

## pnpm install concurrent with gate = vitest "Command not found"

Running `pnpm install` (or `pnpm add`) while the stability gate is active causes pnpm's per-package `.bin` directory to be temporarily unlinked mid-gate. Bundles that run DURING the relinking window fail with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL Command "vitest" not found` even though the binary exists before and after.

**How to apply:** Always commit package.json changes and run `HUSKY=0 pnpm install` BEFORE starting the gate. Never run install concurrently with the gate workflow. If the gate shows "vitest not found" but the binary exists in `.bin`, the cause is a concurrent install — restart the gate from scratch once the install is complete and the working tree is committed and clean.
