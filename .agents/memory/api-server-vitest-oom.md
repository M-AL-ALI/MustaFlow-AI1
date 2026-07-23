---
name: Vitest resource kills in Replit workspace
description: How to run workspace vitest suites when pnpm run test exits -1 with no output
---

Vitest runs in this workspace can be killed silently (exit code -1, zero output) by resource limits — not a test failure.

**Why:** The Replit container OOM-kills multi-worker vitest runs. api-server suites are worst (heavy router imports), but even a single mustaflow test file via `pnpm --filter @workspace/mustaflow run test -- <file>` has died this way.

**How to apply:**
- Retry with: `cd <artifact> && NODE_OPTIONS="--max-old-space-size=3072" npx vitest run <file> --maxWorkers=1` — this reliably passes (mustaflow orax-wiring 300 tests in ~3s).
- Vitest 4 removed `--poolOptions.*` CLI flags; use `--maxWorkers=1` instead.
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
