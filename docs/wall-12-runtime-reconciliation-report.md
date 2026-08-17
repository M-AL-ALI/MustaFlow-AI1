# Wall #12 Phase 2 — truthful runtime reconciliation

## Scope and delivery state

This branch repairs the product mechanism found in Wall #12 Phase 1. Runtime status is now a
metadata-only read. Provider reconciliation is a separate signed, idempotent, audited mutation.
Ambiguous provider transport cannot change runtime or capability state. An attached active recovery
job is reported as recovering, and consecutive genuinely failed recovery terminals are capped.

Base: `81a8c84a4531bbaebf46da5957b62dd859203258` (verified `origin/main`).
Branch: `codex/published-runtime-reconciliation`.

Production remained frozen for this delivery. No second publish, rollback, runtime restart,
reconciliation, deployment, route edit, resource creation, new surface exposure, Fly action, or new
spend occurred. The one-time state repair is deliberately deferred until Replit ships the
platform-side change and the Runtime Worker has exact deployed-surface parity.

Durable Phase 1 authority:
`wall-12-runtime-recovery-phase1-evidence-20260817T083648Z.json` and
`wall-12-runtime-recovery-phase1-diagnosis-20260817T083648Z.md`.

Delivery evidence: `wall-12-runtime-reconciliation-evidence-20260817T091357Z.json`.

## The six commissioned repairs

### 1. Reads never write

Signed `GET /_nabuflow/control/v1/runtimes/:projectId/:role/:slot` now returns a clone of the stored
descriptor. It performs no Sandbox process/health probe and makes no runtime, log, or capability-
binding write. Signing nonce and operator audit bookkeeping remain the existing control-plane
security convention; the product resource state is read-only.

The regression calls status twice while the backend is rigged to return `health_transport`. It
asserts zero availability calls and byte-equivalent runtime, log, process, and binding state after
both reads.

### 2. Explicit governed mutation

New contract surface:

`POST /_nabuflow/control/v1/runtimes/:projectId/:role/:slot/reconcile`

It is in the existing mutation set, so it requires the normal control signature and idempotency
key and produces the normal bounded audit record. The request contains only:

- the runtime locator;
- expected stored status;
- expected manifest revision;
- a stable, nonsecret reconciliation ID.

An expected-state mismatch returns typed `runtime_reconciliation_conflict` and writes no runtime
state. The successful response contains only `ok`, reconciliation ID, typed outcome, sanitized
observation (`attempts`, `stage`, `cause`, HTTP status or null), capability state (`bound` or
`unbound`), and the runtime descriptor. It contains no provider value, address, credential,
container ID, error detail, or payload.

The operation rediscovers only the platform-owned fixed process identity `tenant-service`. A ready
process becomes `running`, has the container-to-runtime capability binding restored, and receives a
sanitized system event. A conclusive missing/stopped process becomes `stopped` and unbound. A
conclusive unhealthy response becomes typed `error` and unbound. Replaying the identical request
and idempotency key returns the stored result without a second provider observation.

### 3. Ambiguous transport has no terminal authority

The backend may make at most three exact availability observations, each with the existing named
five-second timeout, inside a named twenty-second reconciliation bound. This leaves five seconds
for evidence and response finalization. `health_transport`, `health_timeout`, and provider process-
check exceptions are ambiguous. If a later observation is healthy, reconciliation restores truth.
If all observations remain ambiguous, the mutation returns typed retryable
`runtime_reconciliation_inconclusive`; it does not update the runtime, clear the process, append a
runtime log, bind, or unbind.

The tests pin both a first ambiguous observation followed by health and a fully exhausted ambiguous
observation budget.

### 4. Active recovery is recovering

The published data plane now consults the latest runtime-start job when the stored descriptor is
not running. A matching active job is idempotently nudged and remains
`published_runtime_recovering`; it is never downgraded to `published_runtime_unavailable` merely
because a consumer already claimed it.

### 5. Failed recovery rescheduling is bounded

Published recovery identity v2 is derived from stable semantic fields only: runtime identity,
artifact revision, and artifact SHA-256. Transient `readyAt` timestamps are excluded. Recovery job
records carry their series identity and generation. Only a matching **failed** terminal increments
that generation. Three consecutive failed terminals are permitted; the next observation returns
typed nonretryable `published_runtime_recovery_exhausted`. An active job coalesces. A changed
artifact starts a distinct series. A recovery that previously succeeded may anchor a new bounded
series if that runtime later becomes unavailable.

This reuses the existing durable runtime-start job chassis, queue nudge, watchdog, leases,
checkpointing, typed terminals, and event trail. No second job implementation was created.

### 6. One-time post-ship repair of the three captured runtimes

After Replit ships this branch, Worker parity and the post-publish marker are proven first. One
operator reconciliation operation then performs exactly three guarded invocations, one for each
captured Project 51 runtime:

| Target             | Expected stored status | Expected manifest revision                                                      |
| ------------------ | ---------------------- | ------------------------------------------------------------------------------- |
| preview / primary  | `error`                | `zero-node-v1-f8dd2e2df3487cc3c3c5e8f008266ef4ce0b61ac8dbb7bb56849389784b7e039` |
| production / blue  | `error`                | `prod-e7060cad1aab9f5764727d28ffc058f186117c80ec77ab5`                          |
| production / green | `error`                | `prod-a8940c976f1cf943d03c5bccd52e3bdb5b1ea51b8d56e228`                         |

Each invocation uses its own stable reconciliation ID and idempotency key. Its signed response and
audit identity are retained before proceeding. A conflict or inconclusive result stops the
operation without guessing. Provider truth decides whether each target is restored/bound,
confirmed stopped, or confirmed error. Only after all three typed results are recorded does the
published-route probe resume. This is the sole authorized production state-repair path; no manual
runtime restart or direct coordinator edit is part of it.

## Captured-evidence fixtures and regression coverage

The production fixtures use the exact Phase 1 green artifact identity/SHA and exact green, blue,
and preview manifest revisions. The suite pins:

- repeated status reads across a `health_transport` stub with zero product-state writes;
- the captured production blue and green slots under the explicit mutation;
- preview ambiguity with runtime and binding unchanged;
- one ambiguous observation followed by health;
- the named ambiguous-observation cap;
- stable idempotent replay of the one-time reconciliation;
- active durable job to `published_runtime_recovering`;
- three failed generations followed by typed recovery exhaustion;
- existing route activation in both blue-to-green and green-to-blue directions;
- the additive contract route, schemas, response taxonomy, and feature declaration.

## Verification

- `pnpm install --offline --frozen-lockfile`: pass; zero downloads; lockfile unchanged. The first
  Windows relink was lengthy but continuously active; the proof rerun completed in 2.9 seconds and
  reported `Already up to date`.
- Contracts: typecheck pass; lint pass; 20 files / 187 tests pass.
- Runtime Worker: typecheck pass; lint pass; 35 files / 264 tests pass.
- Workspace root typecheck: pass across all configured artifacts and scripts.
- Workspace root lint: pass across all 20 participating projects.
- Prettier and `git diff --check`: pass.

Manifest declaration: **no package manifest or lockfile changed**. No dependency was added.
Artifact v1 and layered artifact wire formats are unchanged. Fly code/config is untouched.

## Files changed

### Shared contracts

- `lib/tenant-runtime-contracts/src/constants.ts` — declares `runtime-reconciliation-v1`.
- `lib/tenant-runtime-contracts/src/control-schemas.ts` — reconciliation request/response, route,
  types, named observation/deadline margins, and failed-terminal cap.
- `lib/tenant-runtime-contracts/test/control-schemas.test.ts` — exhaustive contract fixtures.

### Runtime Worker shipped path

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — bounded, non-mutating provider
  observation and fixed platform process rediscovery.
- `artifacts/nabuflow-runtime-worker/src/worker.ts` — metadata-only status and governed mutation.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` — active-job truth and bounded
  failed-terminal rescheduling.
- `artifacts/nabuflow-runtime-worker/src/model.ts` — optional recovery series metadata on the shared
  runtime-start job.
- `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts` — persists and identity-checks
  that metadata in the existing job chassis.

### Regression/support files

- `artifacts/nabuflow-runtime-worker/test/helpers.ts`
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts`
- `artifacts/nabuflow-runtime-worker/test/published-data-plane.test.ts`
- `artifacts/nabuflow-runtime-worker/test/runtime-availability.test.ts`
- `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts`

## INCIDENTAL FINDINGS

1. **PowerShell argument packing can make a dynamic Prettier check non-authoritative.** Passing the
   changed-file array through one shell variable produced one combined path and a misleading zero
   exit after a no-match diagnostic. The delivery uses an explicit file-list check instead; no
   product code was changed for this harness behavior.
2. **The first full offline relink on this Windows worktree took several minutes.** CPU and byte
   counters advanced continuously, disk retained roughly 97 GB free, and the completed proof rerun
   was clean. This was slow local linking, not saturation, a network fetch, or a product defect.
