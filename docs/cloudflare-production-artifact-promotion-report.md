# Production artifact promotion — Slice A delivery report

**Date:** 2026-08-14 (America/Los_Angeles)  
**Branch:** `codex/production-artifact-promotion`  
**Verified base:** `182b250fb9f1e317d5964629b76e8a92afb1a147`  
**Implementation commit:** `9bfaa5dd3579fd2ca8f4eac03a9e16d36dec7ad8`  
**Authority:** `docs/cloudflare-production-cutover-plan.md`

## Scope, restated

This slice gives a trusted-kitchen release a durable application identity, moves its sealed
dependency-complete bytes from a rehearsal preview address into a deterministic production
namespace, starts the inactive production candidate, and atomically activates it only after it is
healthy. It preserves the prior route/runtime on every pre-activation failure and performs a
compare-and-swap rollback if application state cannot be persisted after activation.

It does not enable Cloudflare production, allocate a production database, change either artifact
wire format, modify Fly, deploy a Worker, open a surface, or create a live resource.

## Outcome

Slice A is complete on the branch.

The trusted kitchen now returns a strict `nabuflow.accepted-sealed-release/v1` record containing
the exact source, shelf, closure, build attestation, manifest, layered envelope, and sealed artifact
identities. The API persists that record on the exact project version that was built and carries it
into the immutable deployment snapshot.

Publishing a non-static application through the Cloudflare provider now:

1. rejects a version without a valid accepted sealed release with typed
   `sealed_release_required`;
2. deterministically selects the inactive `production/blue|green` slot;
3. derives one canonical SHA-256 promotion identity from the semantically meaningful source
   version, accepted sealed hash, target slot, project, and normalized hostname;
4. ensures the target runtime under a stable phase idempotency key;
5. asks the Runtime Worker’s shared durable-job chassis to promote and independently verify the
   layered artifact;
6. starts the target against the exact promoted revision/hash;
7. compare-and-swap activates the hostname only after the target is running and manifest-aligned;
8. persists the active production release identity; and
9. restores the prior route (or removes the first route) if post-activation database persistence
   fails.

A missing legacy preview `containerId` no longer lets the Cloudflare publish path silently skip
promotion. Once the Cloudflare production provider is selected, an application publish must take
the artifact-native path and fail closed if its control prerequisites are unavailable.

## Durable identity and storage

The canonical identity format is `nabuflow.production-promotion-identity/v1`. Its fields are:

- project ID;
- source project-version ID;
- accepted source sealed-artifact SHA-256;
- target production slot; and
- lower-cased published hostname.

The shared contract function is the sole derivation point used by publish orchestration and the
provider’s stable phase keys. Transient timestamps are excluded.

Application chunks are copied into keys derived from the deterministic production runtime identity
and the independently resealed target envelope. Each copy is:

- read from the accepted source object;
- fully SHA-256 verified;
- checked at the destination by a read, never a body-bearing existence probe;
- conditionally created only on verified absence; and
- independently read back and reverified.

Dependency layers remain immutable, globally content-addressed objects. Promotion verifies every
source layer and reuses it by hash rather than copying it. The target layered envelope is rebound to
the production runtime/manifest/revision and fully resealed; Artifact v1 and dependency-layer wire
formats are unchanged.

No new Cloudflare resource is required. The path reuses
`NABUFLOW_RUNTIME_ARTIFACTS`, `NABUFLOW_CONTROL_STATE`,
`DURABLE_OPERATION_QUEUE`, and `NABUFLOW_SANDBOX`. The application database gains only two
identity/attestation JSONB columns on `project_versions`: `sealed_release` and
`production_release`.

## Execution liveness and diagnostics

Promotion is a new `layered-artifact-promotion` kind in the existing durable-operation chassis,
not a parallel coordinator. Its durable checkpoints are:

`initialized → source-verified → target-created → payloads-copied → finalized`.

Queue delivery, renewable leases, adoption generations, alarms, deadline terminalization, and the
bounded event trail are therefore inherited from the already-proven job machinery. A signed
builder/operator diagnostic route exposes metadata and the sanitized event trail for a known
promotion identity; unknown jobs return a typed 404. It exposes no bytes or credentials.

Every provider phase uses one stable parent key,
`production-publish:<promotion-identity>`, plus a fixed phase suffix for ensure, promote, start,
activate, or rollback.

## Failure and rollback posture

- Source lookup, source envelope verification, source chunk verification, and source layer
  verification all precede target commitment.
- Existing target bytes are immutable: a hash mismatch yields typed
  `artifact_promotion_target_integrity_mismatch`; they are never overwritten.
- A candidate that does not reach the exact running manifest yields typed
  `production_runtime_not_ready`; routing is untouched.
- Activation uses the expected prior manifest revision, so a concurrent route change cannot be
  overwritten.
- Database persistence failure after activation rolls routing back and records the candidate as
  promoted-but-inactive. A successful rollback returns typed
  `production_publish_persistence_failed`; rollback failure returns typed
  `production_publish_rollback_failed`.
- The previous production runtime is never destroyed by this slice.

Committed inactive candidates are not anonymous residue: their address is reproducible from the
accepted version and canonical promotion identity, so an identical retry adopts/reuses the same
immutable objects.

## Authority correction

Inspection found a mismatch between the cutover plan’s blue/green safety requirement and shipped
Worker behavior. Locator and published-route contracts already allowed `production/blue` and
`production/green`, but activation and data-plane dispatch rejected green.

A blue-only runtime cannot preserve the previous application while a replacement is promoted.
Slice A therefore makes the existing contract operational: publish targets the inactive slot,
health precedes compare-and-swap activation, and rollback reactivates the previous slot. This is an
additive behavior correction, not an artifact-format change.

The implementation record and correction were appended to both durable authority copies. They are
byte-identical at SHA-256
`0e1f0a7a3a67b0f1355ba4c49125d66929cfad00d935170715b595d7e657c625`.

## Staging rehearsal

The rehearsal was an end-to-end staging-profile Worker/API test using the actual signed control
routes, durable coordinator, R2/DO/Sandbox interfaces, and production blue/green data-plane logic
with deterministic in-memory platform fakes. No live branch deployment was performed because this
is branch-only delivery and Replit owns shipping.

| Row                                                       | Result |
| --------------------------------------------------------- | ------ |
| Persist accepted kitchen result on the exact version      | PASS   |
| Canonical identity stable for identical semantics         | PASS   |
| Preview layered source envelope verified                  | PASS   |
| Every application chunk verified before copy              | PASS   |
| Every dependency layer verified and reused                | PASS   |
| Conditional destination create plus independent readback  | PASS   |
| Production envelope rebound and independently resealed    | PASS   |
| Durable promotion checkpoints and diagnostic trail        | PASS   |
| Ensure → promote → start under stable phase keys          | PASS   |
| Green activation after healthy start                      | PASS   |
| Previously active blue runtime remains intact             | PASS   |
| CAS rollback restores blue                                | PASS   |
| Tampered target bytes fail typed, never overwrite         | PASS   |
| Lease adoption/deadline terminalization in shared chassis | PASS   |

## Check table

| Check                                | Result | Evidence                                             |
| ------------------------------------ | -----: | ---------------------------------------------------- |
| Frozen offline install               |   PASS | 21 projects, lockfile current, zero fetches, 2.9s    |
| Workspace typecheck                  |   PASS | libraries plus all artifacts/scripts, 31.5s          |
| Workspace lint                       |   PASS | all 20 participating packages, 18.2s                 |
| Contracts full suite                 |   PASS | 19 files, 183/183, 2.7s                              |
| Runtime Worker full suite            |   PASS | 30 files, 234/234, 7.3s                              |
| API focused suite                    |   PASS | 4 files, 53/53, 3.3s                                 |
| API full suite base parity           |   PASS | branch has zero failure names absent from exact base |
| Format                               |   PASS | 25/25 implementation files                           |
| `git diff --check`                   |   PASS | zero findings                                        |
| Changed-file credential-pattern scan |   PASS | 25 files, zero findings                              |
| Fly identity                         |   PASS | zero Fly-named files changed; Fly core diff empty    |
| Artifact format identity             |   PASS | v1 and layer contract files diff empty               |

The full API suite requires local service/env fixtures not present on this lab machine. Final branch
result: 2,296 passed, 39 failed, 5 skipped of 2,340. Exact base result in the same process setup:
2,293 passed, 41 failed, 5 skipped of 2,339. Every branch failure name is present at base; two base
failures did not reproduce on the branch. Failure-set fingerprints are recorded in the evidence
JSON.

## Manifest declaration

Manifest changes are limited and explicit:

- `lib/db/package.json` adds the workspace contract package so schema columns can carry the shared
  release types.
- `pnpm-lock.yaml` records that workspace edge.

No Wrangler, Worker deployment, provider, Fly, artifact, route, or application manifest changed.
A pristine `pnpm install --frozen-lockfile --offline --prefer-offline` passed after the change.

## Shipped-path file inventory

### New Slice A contracts

- `lib/tenant-runtime-contracts/src/production-artifact.ts` — accepted release, canonical
  promotion identity, promotion transport, and durable production release schemas.
- `lib/tenant-runtime-contracts/test/production-artifact.test.ts` — canonical identity,
  cross-project/path posture, and release-record regressions.
- `lib/tenant-runtime-contracts/src/index.ts` — exports the Slice A contract.
- `lib/tenant-runtime-contracts/src/constants.ts` — advertises the additive
  `artifact-promotion-v1` capability.
- `lib/tenant-runtime-contracts/src/artifact-commit.ts` — adds the promotion job/checkpoints and
  signed diagnostic response to the shared durable-operation contract.

### Accepted-release persistence and publish orchestration

- `lib/db/src/schema/versions.ts` — typed accepted/promotion JSONB records.
- `lib/db/package.json` — contract workspace dependency.
- `pnpm-lock.yaml` — corresponding workspace lock edge.
- `artifacts/api-server/src/lib/startup-migrations.ts` — additive, idempotent column migration.
- `artifacts/api-server/src/lib/zero-generation-kitchen.ts` — constructs the strict accepted
  release from the actual shelf/build/sealer outputs.
- `artifacts/api-server/src/lib/jobs.ts` — persists acceptance on the exact project version and
  refuses unrelated runtime reuse for a new publishable version.
- `artifacts/api-server/src/lib/tenant-runtime-provider.ts` — additive production-promotion
  provider capability.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts` — stable ensure/promote/start/
  activate follow and rollback.
- `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts` — stable phase identity,
  exact runtime binding, activation, and rollback regression.
- `artifacts/api-server/src/routes/publish.ts` — fail-closed accepted-release gate, inactive-slot
  selection, canonical orchestration, durable release persistence, and rollback.

### Shipped Runtime Worker paths

- `artifacts/nabuflow-runtime-worker/src/model.ts` — stored promotion job/request shape.
- `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts` — promotion kind in the shared
  lease/checkpoint/deadline chassis.
- `artifacts/nabuflow-runtime-worker/src/worker.ts` — signed promotion/diagnostic routes,
  independent source verification, conditional copy/reverification, reseal, feature gating, and
  blue/green activation.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts` — dispatches either active
  production slot from the already-shipped route contract.

### Worker regressions

- `artifacts/nabuflow-runtime-worker/test/artifact-commit-coordinator.test.ts` — promotion
  adoption and deadline terminalization.
- `artifacts/nabuflow-runtime-worker/test/artifact-layers-control.test.ts` — complete dock
  promotion rehearsal and tamper rejection.
- `artifacts/nabuflow-runtime-worker/test/published-data-plane.test.ts` — atomic blue-to-green
  switch with the blue runtime preserved.
- `artifacts/nabuflow-runtime-worker/test/control-worker.test.ts` — production slot posture
  updated to the shipped blue/green contract.
- `artifacts/nabuflow-runtime-worker/test/helpers.ts` — shared durable-job fake support for the
  new kind.

### Durable authority

- `docs/cloudflare-production-cutover-plan.md` — Slice A implementation record and blue/green
  reality correction.

## Inertness, cost, and next cutover boundary

Production behavior remains unchanged until the already-documented provider/Worker production
locks are deliberately enabled. The Worker advertises promotion only when the existing layered
artifact platform and durable queue are bound. The API can invoke the path only when the
Cloudflare provider is selected. Fly is untouched.

This delivery made zero deployments, opened zero public surfaces, created zero provider leases or
Cloudflare resources, read/requested zero secrets, and incurred $0.

The next cutover dependency remains Slice B from the authority plan: production database capability
provisioning and allocator policy. Replit remains the authoritative merge, migration, staging-live,
and publish gate.

## Evidence

Repository evidence:
`docs/cloudflare-production-artifact-promotion-evidence-20260815T074221Z.json`.

The same report and evidence are copied to the permanent authority folder. The final pushed branch
tip is confirmed in the handoff after the report commit; no merge or publish is performed here.
