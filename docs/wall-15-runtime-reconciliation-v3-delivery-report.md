# Wall #15 delivery — runtime reconciliation v3

Delivered: 2026-08-17  
Branch: `codex/runtime-reconciliation-v3`  
Verified base: `ba6656489f77433eb986c6208c9b967c13561799`  
Production state: frozen throughout; no reconciliation, deploy, restart, rollback, publish, or other production mutation was performed.

## Scope in plain language

Wall #15 replaces the v2 judge that could only say “healthy” or “ambiguous” with a v3 judge that
can distinguish three useful outcomes: truthful state, a definite repair, and intentional preview
idleness. Every Project 51 signature preserved from Walls #12–#14 now has a definite result and a
governed action. Long-running repair execution is not tied to the reconciliation request: v3
schedules the existing checkpointed, leased, queue-driven runtime-start job, which owns artifact
verification, materialization, process start, capability rebinding, retries, and its typed deadline.

## Phase 1 findings

### The health probe does not depend on the capability binding

The reconciler resolves the fixed platform process `tenant-service` through the Sandbox for the
deterministic runtime identity and then calls `sandbox.containerFetch()` directly on the manifest
service port. It does not resolve the coordinator container binding. The binding is used only when
tenant code calls the allowlisted doorman host and the capability endpoint resolves the caller's
container ID.

Wall #12's unbind can therefore break database capability calls, but it cannot cause
`health_transport`. The e0ecf724 trail means the process lookup reported running and the direct
port probe produced no HTTP response.

### Preview idle semantics

An explicitly `stopped` preview with no process is a valid non-serving idle state. It has no active
capability binding and claims no readiness. The preview data plane serves only a descriptor that is
`running`. Project 51's preview is stored as `error`, so it is not idle-eligible; it must repair or
end in a typed repair terminal.

### One damage class covers the ladder

Preview, blue, and green all have the Wall #12 false-terminal signature: provider VM `running`,
stored descriptor `error`, stored process identity absent, capability unbound, and retained sealed
artifact metadata. Their manifest revisions are recorded in the Phase 1 evidence. The same v3 rule
therefore covers all three roles/slots.

## V3 decision table

| Captured state                                                   | Observation                                    | Verdict                 | Governed action                                         |
| ---------------------------------------------------------------- | ---------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Any role; provider ready; stored identity absent or binding lost | Health 2xx                                     | `ready`                 | Re-register fixed process identity and bind capability  |
| Explicitly stopped preview; no process                           | Process missing/not running                    | `healthy-idle`          | Persist clean stopped state and keep capability unbound |
| False terminal (`error`, identity absent, artifact retained)     | Process missing/not running or health rejected | `repair-required`       | Schedule durable restart/rebind job                     |
| Same false terminal                                              | Three health transport/timeouts                | `repair-required`       | Schedule durable restart/rebind job                     |
| Truthful running state with identity present                     | Ambiguous provider weather                     | `ambiguous`             | No writes; return typed retryable evidence              |
| Honest definite stop/error outside the captured damage class     | Definite provider observation                  | Existing typed terminal | Persist the corresponding truthful state                |

The exact `e0ecf724-aa61-427c-8997-2b465a100bb8` three-observation trail is test-pinned. Its first
two `health_transport` observations remain ambiguous; the third resolves to `repair-required` with
`restart-and-rebind`.

## Durable repair execution

The reconciliation response is `202` with outcome `repair-scheduled` and a metadata-only repair
job receipt (`jobKey`, state, attempt). A single v3 content-derived repair key registers one
`runtime-start` durable operation. The common nudge helper sends it to the existing queue; if that
send is lost, the coordinator watchdog re-enqueues it. The queue consumer retains the existing
artifact verification, checkpoints, renewable lease, adoption, typed deadline, and final
capability bind.

This preserves the execution-liveness law: the reconciliation HTTP request can end immediately
after scheduling, and the exact e0ecf724 regression proves the queue job subsequently reaches
`running` and `bound`. Replays return the same 202 receipt and do not create a second operation.

## Contract and wire declaration

- Added advertised feature `runtime-reconciliation-v3`; v1 and v2 remain advertised for historical
  capability discovery.
- The governed reconciliation request now requires semantics identity
  `runtime-reconciliation-v3`, intentionally isolating all v2 terminals.
- Reconciliation observations add typed `repairAction`; decisions add `repair-required` and
  `healthy-idle`.
- Successful reconciliation responses add `repair-scheduled`, `healthy-idle`, and the nullable,
  metadata-only `repairJob` receipt.
- Artifact v1, layered artifact formats, tenant egress, capability payloads, and all unrelated
  routes are unchanged.

## Files changed

### Contracts

- `lib/tenant-runtime-contracts/src/constants.ts` — advertise v3.
- `lib/tenant-runtime-contracts/src/control-schemas.ts` — v3 identity, typed decisions/actions, and
  metadata-only repair receipt.
- `lib/tenant-runtime-contracts/test/control-schemas.test.ts` — schema and sanitization fixtures.

### Runtime Worker

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — evidence-derived v3 decision table.
- `artifacts/nabuflow-runtime-worker/src/worker.ts` — governed repair actions; shared durable nudge;
  queue-driven restart scheduling; typed 202 receipt.

### Regressions

- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — exact e0ecf724 fixture, preview,
  blue/green scheduling, v2 identity isolation, replay/no-duplicate behavior, and eventual durable
  start/rebind.
- `artifacts/nabuflow-runtime-worker/test/runtime-availability.test.ts` — decision-table signatures,
  explicit preview idle, both production slots, and truthful-state weather.
- `artifacts/nabuflow-runtime-worker/test/runtime-reconciliation-coordinator.test.ts` — persisted v3
  trail shape.
- `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts` — feature inventory.
- `artifacts/nabuflow-runtime-worker/test/helpers.ts` — typed mock reconciliation result.

### Durable evidence

- `docs/wall-15-runtime-reconciliation-v3-phase1.md`
- `docs/wall-15-runtime-reconciliation-v3-phase1-evidence.json`
- `docs/wall-15-runtime-reconciliation-v3-delivery-evidence-20260817T182950Z.json`
- this report

## Verification

- Frozen offline install: PASS; 21 projects, lockfile current, zero downloads.
- Tenant runtime contracts: 20 files / 187 tests PASS.
- Runtime Worker: 36 files / 269 tests PASS.
- Exact focused v3 battery: 3 Worker files / 30 tests plus 23 contract schema tests PASS.
- Repository-wide typecheck: PASS.
- Repository-wide lint: PASS.
- Package typecheck/lint: PASS.
- `git diff --check`: PASS.
- Changed-file Prettier: PASS.
- Manifest/lockfile diff: NONE.
- Repository-wide Prettier: inherited failure recorded below; no changed file is implicated.

## Delivery state

Branch-only. No merge, publish, deploy, marker, parity operation, or live ladder run was performed.
The final remote tip is reported in the handoff because a commit cannot contain its own SHA.

## INCIDENTAL FINDINGS

1. Repository-wide `pnpm format:check` reports style drift in three untouched files:
   `wrangler.build.production.jsonc`, `wrangler.pantry.production.jsonc`, and
   `wrangler.runtime.production.jsonc`. `git diff` proves all three are byte-unchanged from the
   verified base. Per the incidental-findings rule, Wall #15 reports this inherited issue and does
   not fix it.
