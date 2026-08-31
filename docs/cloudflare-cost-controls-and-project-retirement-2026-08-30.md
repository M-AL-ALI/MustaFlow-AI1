# Cloudflare cost controls and recoverable project retirement

Date: 2026-08-30
Status: implementation verified in the lab; production activation requires the
governed rollout described below
Database: none for lab verification
Environment: `A:/NabuFlowLab/work`
Store: `A:/NabuFlowLab/.pnpm-store`
Kind: application, Worker, schema, and contract hardening

## Outcome

Moving a project to Trash now means two different things by design:

- User material remains recoverable: source, file history, versions, assets,
  secrets, domain configuration, and database ownership rows are retained.
- Cost-bearing or traffic-serving state is retired: active tasks and schedules,
  published routes, edge cache entries, hostname certificates, and preview,
  blue, and green runtime slots are reconciled to proven absence.

Restore returns the project as a draft. It does not silently republish, restart,
rebind a public hostname, or claim that an old deployment is serving. The owner
must explicitly build or publish again.

Project 51 is not hard-coded as special. The authorized production batch is an
exact caller-supplied set containing projects 1 through 50 and 52 through 55.
Project 51 is intentionally absent from that set and must be proven unchanged
before and after the operation.

## Architecture

### Durable retirement state machine

`project_retirement_operations` is the durable authority. The initial mutation
acquires the project lifecycle lock, tombstones the project, disables schedules,
records provenance, and returns an accepted operation instead of pretending
provider cleanup completed synchronously. A bounded worker advances the receipt
through task cancellation, route and cache removal, certificate removal, and
runtime destruction. Every provider step is idempotent and requires an
authoritative absence observation before a database pointer can be cleared.

The worker has bounded retries, a renewable lease, fencing, persisted progress,
typed terminal causes, and boot-time adoption for older Trash rows. Status reads
are metadata-only. Owner deletion and the admin exact-ID batch share the same
coordinator.

All task starts, queue claims, heartbeats, file writes, deployment schedules,
preview reads, share reads, and custom-domain reads independently reject a
tombstoned project. This prevents a race from recreating cost after cleanup has
started.

### Route and runtime authority

The Runtime Worker exposes signed, metadata-only route inventory and route reads,
plus exact governed cleanup. Route cleanup is hostname-scoped and cache cleanup
uses exact cache tags; no global cache purge exists. Stored runtime pointers are
classified against provider, namespace, project, role, and slot before they can
be used. Ambiguous or legacy pointers are retained as typed evidence rather than
sent to a provider or falsely cleared.

Restored custom domains are fail-closed at request time. The edge revalidates the
current database serving state before reading R2 or proxying a runtime, so stale
cache state cannot revive a restored draft.

### Cloudflare cost controls

- The acceptance provisioner is disabled by default in configuration.
- Its queue has one consumer and bounded retries.
- Deployment attempts use a durable retry owner and a capped deferral policy.
- Deployment identity construction rejects duplicate environment suffixes such
  as `-staging-staging`.
- Tenant runtime sandboxes use Cloudflare's `basic` instance type. The trusted
  pantry and build kitchen remain separate service bindings and are unchanged.
- `deploy:acceptance` is an explicit guarded script in the Runtime Worker package
  manifest. This is the only manifest change; no dependency or lockfile changed.

### Asset byte accounting

All signed NabuFlow and Ora uploads, generated images/files, background jobs,
realtime tools, and project-file materialization use one account-level quota and
one private R2 byte authority. Admissions reserve quota before provider work.
Completion records measured bytes and SHA-256; rejection or expiry releases the
reservation. Historical rows with unknown byte size make new admissions fail
closed until the governed reconciliation measures them.

Project files store typed asset references, never duplicate base64 payloads or
R2 keys. Resolution proves ownership, readiness, durable project-history usage,
byte size, and digest before preview, snapshot, CDN, tenant runtime, or export can
consume the asset. Physical deletion occurs only after the final durable usage
reference is gone. Cross-owner copying remains denied until a separate governed
clone contract exists.

## Production rollout contract

Production activation is ordered and must stop at the first typed discrepancy:

1. Merge and publish the exact verified application tree.
2. Prove the boot migration count and `/api/version` commit/tree.
3. Redeploy every changed Worker surface from that exact SHA and verify its
   `CF_VERSION_METADATA` stamp.
4. Wait past the old signed-URL window, then run bounded asset-storage
   reconciliation until `remainingUnmeasured` is zero.
5. Re-read project 51 and the exact batch set.
6. Invoke one governed admin retirement batch for
   `1..50,52,53,54,55`; never use a range expansion inside the product.
7. Poll every operation receipt to a completed or typed partial terminal.
8. Prove retired projects have no serving routes or running tenant runtimes and
   prove project 51 is unchanged and healthy.
9. Remove a duplicate acceptance Worker only after the canonical disabled Worker
   is proven live by exact source identity.

No hard project deletion, database-row deletion, source deletion, secret
deletion, asset deletion while referenced, Fly mutation, or pantry/build-kitchen
change is part of this rollout.

## Verification on the branch tree

- Focused retirement and lifecycle tests: 9 files, 111 passed.
- Custom-domain fail-closed tests: 8 passed.
- Focused cost-control tests: 4 files, 37 passed.
- Runtime Worker suite: 36 files, 330 passed.
- Tenant runtime contracts: 20 files, 196 passed.
- Focused signed Ora asset flow: 5 files, 134 passed.
- Asset contract compatibility: 23 passed.
- New API slices: 27 files, 180 passed; reference slice 14 files, 73 passed.
- Final API full suite: 1,007 suites; 3,416 tests; 3,378 passed; 33 failed;
  5 skipped. Normalized failure delta versus the recorded base: zero new;
  five base failures resolved.
- Final web full suite: 359 suites; 1,265 tests; 1,264 passed; 1 failed.
  Normalized failure delta versus the recorded base: zero.
- Root typecheck: passed.
- Root lint: passed.
- Changed-file Prettier: 209 files checked, passed.
- `git diff --check`: passed.
- High-confidence secret scan: no newly added credential-shaped literal.
- Lockfile changes: zero.

The nonzero full-suite results are inherited environment/fixture failures and
are accepted only by exact normalized parity. Raw machine-readable receipts live
under `A:/NabuFlowLab/evidence/cloudflare-cost-controls-2026-08-30/`.

## Incidental findings and preventives

1. **A restored custom domain could be served from stale cached state.** Fixed by
   database revalidation before R2/runtime service. Preventive: a regression test
   pins the Trash-to-Restore sequence and requires 404 plus `no-store`.
2. **New asset-reference imports broke database-free unit isolation.** Fixed with
   narrow resolver mocks in the affected provider tests. Preventive: those suites
   run with Database NONE and fail if a DB-backed resolver is imported again.
3. **A new delete test omitted the nullable project subject and hung at a mocked
   lifecycle boundary.** Fixed by mirroring the real row shape. Preventive: both
   complete and retryable cleanup paths now finish under the focused test.
4. **Several source census tests depended on brittle occurrence counts.** Fixed
   with structural checks that pair every mutation with consent/attribution and
   register every intentionally dormant export. Preventive: additions now fail
   unless consumed or explicitly classified.
5. **The acceptance publish path was implicit.** Fixed with an explicit guarded
   manifest script. Preventive: the acceptance configuration and deploy helper
   are covered by contract tests.
