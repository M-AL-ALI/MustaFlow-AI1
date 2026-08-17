# Wall #14 — durable reconciliation observation evidence

## Scope and delivery state

Wall #14 closes the forensic gap proven by Wall #13. Every governed runtime reconciliation now
persists a bounded, sanitized, structured observation trail one attempt at a time; every
reconciliation terminal explains itself with the same evidence; operators can retrieve the durable
record through a signed metadata-only read; and the changed semantics use a fresh v2 durable
identity so the Wall #13 inconclusive result cannot shadow a new run.

- Verified base: `ce58802d0136ba6b8a907f4c5c6dfad42601da8a`.
- Branch: `codex/reconciliation-observation-trail`.
- Implementation commit: `0e4f1cdca35f9ddc031a6a1b7c0a802517a16418`.
- Evidence: `wall-14-runtime-reconciliation-observation-trail-evidence-20260817T111243Z.json`.
- Canonical/permanent LF evidence SHA-256:
  `79dc9f2487b5181c5c769b2172dc151a0f3aa979149c03818763c1ff4ce086aa`.
- Windows checked-out evidence SHA-256 (CRLF materialization):
  `ae80fb522f901867f650fa40ae92bb54b0a8f9cdcbf421506b7ce3d45a33735e`.

Production remained frozen. No reconciliation, deployment, publish, rollback, runtime restart,
route change, capability mutation, resource creation, new public surface, Fly action, or new spend
occurred. Replit must ship the platform side first; Runtime Worker parity and its marker remain the
next commissioned step.

## Product shape

### Durable trail

The contract allowlists exactly these observation sources:

- `provider-metadata`;
- `process-probe`;
- `health-probe`.

Each persisted attempt contains only the attempt number, observation timestamp, typed stage,
allowlisted cause, sanitized HTTP status or null, the sources consulted, decision inputs, and the
typed decision. Decision inputs are limited to stored runtime status, whether a stored process
identity existed, provider-process classification, and health classification. There is no response
body, raw transport detail, provider error, stack, address, credential, process output, or tenant
content.

The backend awaits the durable append before it can issue the next observation. The record is
initialized before the first decision, appended transactionally in attempt order, and terminalized
with `{ at, status, code, retryable }`. A regression proves attempt 1 is delivered to the persistence
sink before attempt 2 begins. A Durable Object restart regression proves attempts and the terminal
survive coordinator reconstruction.

Records are bounded to the newest 256 reconciliation requests. This keeps the forensic surface
durable for incident work without creating unbounded Durable Object storage.

### Terminals carry their evidence

Successful reconciliation responses retain the existing outcome, observation summary, capability
state, and runtime descriptor, and add:

```json
{
  "evidence": {
    "semanticsVersion": "runtime-reconciliation-v2",
    "reconciliationId": "operator-supplied-nonsecret-id",
    "trail": [],
    "terminal": {
      "at": "RFC3339 timestamp",
      "status": 200,
      "code": "ok",
      "retryable": false
    }
  }
}
```

Typed reconciliation failures carry the identical evidence shape. Tests pin both the three-attempt
`runtime_reconciliation_inconclusive` terminal and the zero-observation
`runtime_reconciliation_conflict` terminal. Forbidden raw detail injected by a test backend is
projected out before persistence and is absent from both the response and stored record.

### Signed audit read

New control surface:

`GET /_nabuflow/control/v1/audit/reconciliations/:requestId`

It follows the existing control signature convention and returns exactly `{ ok: true, record }`,
where `record` contains request ID, reconciliation ID, v2 semantics version, runtime locator,
created/updated timestamps, bounded trail, and nullable terminal. Unknown records return typed
`runtime_reconciliation_audit_not_found` with HTTP 404.

The route performs no runtime probe and no product, reconciliation, capability, log, route,
idempotency, or request-audit write. The only coordinator mutation is the existing signed-request
nonce consumption required for replay protection. Regressions pin both found and missing reads,
zero request-audit growth, unchanged durable reconciliation records, and zero runtime/reconciliation
mutator calls.

### Fresh reconciliation identity

The request contract now requires
`semanticsVersion: "runtime-reconciliation-v2"`. Worker idempotency storage additionally namespaces
the caller's stable key as `runtime-reconciliation-v2:<key>`. Thus an identically named pre-v2 key
cannot replay or conflict with the new observation semantics. A regression plants a legacy v1
terminal under the raw key and proves the v2 request executes, persists a fresh record, and replays
only its own v2 result.

The feature registry is additive: `runtime-reconciliation-v1` remains declared for shipped-history
compatibility and `runtime-reconciliation-v2` declares the new semantics.

## Verification

- `pnpm install --offline --frozen-lockfile`: pass; 1,899 packages linked, 1,870 reused, **zero
  downloads**, lockfile unchanged.
- Focused contract/Worker regression pass: 54 tests.
- Full contracts suite: 20 files / 187 tests pass.
- Full Runtime Worker suite: 36 files / 265 tests pass.
- Package typechecks and lints: pass.
- Workspace root typecheck: pass across every configured artifact and scripts package.
- Workspace root lint: pass across all 20 participating projects.
- Explicit touched-file Prettier check and `git diff --check`: pass.

Manifest declaration: **no package manifest or lockfile changed**. No dependency was added. Artifact
v1 and layered-artifact wire formats are unchanged. Fly code and configuration are untouched.

## Files changed

### Shared contracts

- `lib/tenant-runtime-contracts/src/constants.ts` — additive v2 feature declaration.
- `lib/tenant-runtime-contracts/src/control-schemas.ts` — observation, terminal, evidence, audit
  record/read, request version, and response contracts.
- `lib/tenant-runtime-contracts/test/control-schemas.test.ts` — exhaustive request/response fixtures.

### Runtime Worker shipped path

- `artifacts/nabuflow-runtime-worker/src/runtime-backend.ts` — builds the allowlisted per-attempt
  trail and awaits durable persistence before the next observation.
- `artifacts/nabuflow-runtime-worker/src/model.ts` — coordinator persistence/read interface.
- `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts` — bounded transactional trail
  storage, ordered append, terminalization, and metadata read.
- `artifacts/nabuflow-runtime-worker/src/worker.ts` — v2 idempotency namespace, sanitizer,
  evidence-bearing terminals, and signed read route.

### Regression support

- `artifacts/nabuflow-runtime-worker/test/helpers.ts`
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts`
- `artifacts/nabuflow-runtime-worker/test/runtime-availability.test.ts`
- `artifacts/nabuflow-runtime-worker/test/runtime-reconciliation-coordinator.test.ts`
- `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts`

## INCIDENTAL FINDINGS

1. **The clean Windows offline relink was slow but healthy.** The frozen install took 10m03s while
   continuously advancing. It reused the local store, downloaded zero packages, completed cleanly,
   and all subsequent verification was fast. This was local filesystem linking, not network use,
   disk saturation, or a product defect.

No active-danger finding, credential exposure, data-loss condition, cost leak, unrelated product
defect, or unexpected production mutation was observed.
