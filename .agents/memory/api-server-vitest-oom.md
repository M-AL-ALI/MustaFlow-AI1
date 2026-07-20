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
