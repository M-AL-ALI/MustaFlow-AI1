# Task 245 trusted-build liveness repair

Date: 2026-08-15 (America/Los_Angeles)  
Base: `bfec1f446b30c6fd0c65995548e348cd3997056e`  
Branch: `codex/trusted-build-hard-deadline`

## Outcome first

Task 245 did not leave a live build behind. Fresh non-cacheable product reads and signed read-only coordinator diagnostics proved that the trusted build succeeded, the layered artifact commit succeeded, and the durable runtime-start job then failed typed because the process exited before binding port 8080. The hours-long `building` observation came from a stale browser response.

The repair nevertheless closes the structural build-plane gap found during inspection: every trusted build now has an absolute 18-minute coordinator deadline. A Durable Object alarm persists `build_timeout` (HTTP 504) even when every initiating request and queue consumer is gone. A named 60-second observation margin keeps that terminal inside the kitchen's 19-minute assembly reserve.

## Safety and forensic reconstruction

- Task: `245`, Project `51`
- Task began: `2026-08-16T00:36:21.564Z`
- Task terminal: `failed` at `2026-08-16T00:43:37.719Z` (436 seconds)
- Build identity: `pbuild_zero_8db662265d1358cbefd5e0c2298024ed0ef734dad9a9d6b962c184ed6684cf0b`
- Build terminal: `succeeded` at `2026-08-16T00:40:00.391Z`, one attempt
- Build output SHA-256: `97c8a3e61e85b5bf74a117600f01c84a72be914cb7194b0961d88c34f1131b62`
- Layered commit: `succeeded`, checkpoint `finalized`, `2026-08-16T00:42:32.598Z`
- Runtime start: typed `runtime_start_failed` (HTTP 502), `2026-08-16T00:43:36.505Z`
- Runtime evidence: process exited code 1 before port 8080 / `/healthz` became ready
- Live trusted-build cells: `0`; all Task-245-era build cell instances were inactive
- Live trusted-build ledger: `queued=0`, `running=0`, `activeCells=0`
- Preview runtime cell: inactive; production runtime was not touched

The build plane held 232 objects totaling 218,388,190 bytes. Task 245's successful, signed output is ledger-referenced release material, not an orphan, and was retained. Its request quarantine and both attempt staging prefixes were deleted by the successful build finalizer. The diagnostic count also reported 12 global quarantine objects; none belonged to Task 245's deleted request prefix, so no unrelated object was deleted. The only remaining Task 245 control-state residue is a stale preview-status row (`runningTestSnapshotId=147`, actual runtime inactive); the normal preview stop/retry path owns that reconciliation.

All forensic control-plane requests were signed GETs. Temporary Replit diagnostic scripts were deleted and `git status --short` was clean afterward.

## Product repair

- `TRUSTED_BUILD_OPERATION_BOUND_MS = 1_080_000` (18 minutes)
- `TRUSTED_BUILD_TERMINAL_OBSERVATION_MARGIN_MS = 60_000`
- The sum is asserted not to exceed `ZERO_GENERATION_ASSEMBLY_RESERVE_MS = 1_140_000`.
- New builds persist `deadlineAt`; legacy records derive the identical deadline from `createdAt`.
- Claims, lease renewals, state transitions, success/failure, retries, cancellation, cell binding, and alarms fence against the absolute deadline.
- Alarms schedule at the earliest of recovery due time and the absolute deadline.
- Deadline terminalization is atomic, clears lease/cell ownership, records typed attempt evidence, destroys any orphaned cell best-effort, and never re-enqueues.
- Status responses add optional rolling-upgrade-safe `createdAt` and `deadlineAt` evidence.
- Volatile task-list, task-event, and preview-status GET responses now send `Cache-Control: no-store` so terminal state cannot be hidden by a stale browser cache.

## Regression evidence

- Tenant runtime contracts: 20 files / 187 tests passed; typecheck passed.
- Runtime Worker: 34 files / 251 tests passed; typecheck passed.
- Focused API cache-posture suite: 1 file / 24 tests passed; API typecheck passed.
- Runtime Worker and API lint passed.
- `git diff --check` passed.
- Local release profile: `pass=18`, `warn=0`, `fail=3`. All three red groups are
  database-dependent (`ora-realtime-usage`, `ora-memory-consolidation`, and the
  dynamic-prerender phase of the web build) and failed only with
  `ECONNREFUSED 127.0.0.1:5432` because this lab has no PostgreSQL service.
- Exact-base parity against `bfec1f446b30c6fd0c65995548e348cd3997056e`
  reproduced the same three failing groups and the same connection refusal.
  The earlier typechecks, focused suites, builds before dynamic prerender, and
  lint remained green. Replit's database-equipped release profile is the
  authoritative merge gate.
- New deadline regressions prove:
  - alarm-only typed terminal after every request/consumer dies;
  - exact 18-minute boundary and named observation margin;
  - stale consumer cannot publish success after terminalization;
  - an unconsumed queued build terminalizes on a late claim.

## Files changed

- `artifacts/nabuflow-runtime-worker/src/trusted-build-model.ts`
- `artifacts/nabuflow-runtime-worker/src/trusted-build-durable-object.ts`
- `artifacts/nabuflow-runtime-worker/src/trusted-build-worker.ts`
- `artifacts/nabuflow-runtime-worker/test/trusted-build-deadline.test.ts`
- `artifacts/nabuflow-runtime-worker/test/trusted-build.test.ts`
- `lib/tenant-runtime-contracts/src/trusted-build.ts`
- `artifacts/api-server/src/routes/tasks.ts`
- `artifacts/api-server/src/routes/events.ts`
- `artifacts/api-server/src/routes/preview-env.ts`
- `artifacts/api-server/src/lib/preview-architecture.test.ts`
- `docs/task-245-trusted-build-hard-deadline-report.md`

Manifest declaration: no package, lockfile, workspace, Wrangler, Fly, or artifact-format manifest changed. Fly was untouched.

## Remaining acceptance

After Replit ships this branch, Project 51 will be retried through the actual production kitchen. The stale preview row will be reconciled by the normal stop/retry flow, and Phase 1 will close only after `/`, database flow, `/healthz`, and the post-publish canary smoke all pass.
