# Cloudflare cost controls and recoverable project retirement

Date: 2026-08-30
Status: application and compatible Worker parity published; governed retirement
activation and batch remain pending
Database: `none` for isolated unit verification; `ora_gate` for the release gate
Environment: `A:/NabuFlowLab/work`
Store: `A:/NabuFlowLab/.pnpm-store`
Kind: application, Worker, schema, and contract hardening

## Outcome

Moving a project to Trash now means two different things by design:

- User material remains recoverable: source, file history, versions, assets,
  secrets, domain configuration, purchased-domain assignment, and database
  ownership rows are retained.
- Cost-bearing or traffic-serving state is retired: active tasks and schedules,
  published routes, edge cache entries, hostname certificates, and preview,
  blue, and green runtime slots are reconciled to proven absence.

Restore returns the project as a draft. It does not silently republish, restart,
rebind a public hostname, or claim that an old deployment is serving. The owner
must explicitly build or publish again.

Recoverable Trash is not a zero-cost state: purchased-domain registration and
billing, retained databases, assets, snapshots, uploads, and project history
continue during the 30-day recovery window. Permanent deletion owns their later
destruction or detachment contract.

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
  manifest. The dormant snapshot package's generic and production deploy scripts
  are explicit fail-closed guards. No dependency or lockfile changed.

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

1. Merge the exact verified application tree without publishing it yet.
2. Publish the application once with `PROJECT_RETIREMENT_EXECUTION_ENABLED`
   absent. Prove the migration and `/api/version` commit/tree, and prove no
   retirement worker registered or legacy Trash row was adopted.
3. Inventory the live Worker surfaces, then redeploy every Worker that is both
   live and changed from that exact SHA. Verify every available
   `CF_VERSION_METADATA` stamp. The 2026-08-31 provider inventory found only the
   Runtime and acceptance Workers live; both were redeployed from
   `b001cba86e3f163e00d3094cf82360347c28ae9f`. No snapshot Worker exists in the
   account, and the checked snapshot configuration contains placeholder KV ids,
   no production route, and no version metadata. Its production script therefore
   fails closed, as does its generic deploy script. Activation must stop if a
   snapshot Worker later appears without an audited configuration, guarded
   deployment path, and source-identity proof.
4. Set `PROJECT_RETIREMENT_EXECUTION_ENABLED=true` through hidden production
   configuration and republish once. Prove the boot migration count, worker
   registration, and exact application commit/tree again.
5. Wait past the old signed-URL window, then run bounded asset-storage
   reconciliation until `remainingUnmeasured` is zero.
6. Re-read project 51 and the exact batch set.
7. Invoke one governed admin retirement batch for
   `1..50,52,53,54,55`; never use a range expansion inside the product.
8. Poll every operation receipt to a completed or typed partial terminal.
9. Prove retired projects have no serving routes or running tenant runtimes and
   prove project 51 is unchanged and healthy.
10. Record any duplicate acceptance Worker for a separate, explicit provider
    deletion authorization. Do not delete it during retirement activation.

### Live rollout receipts on 2026-08-31

- Application commit `b001cba86e3f163e00d3094cf82360347c28ae9f`, tree
  `221ba04c2c3a33ae82918903c1fac06d26e9b223`, served by both governed version
  endpoints; `/api/healthz` reported `startupMigrations: "ok"`.
- Runtime Worker version `88f99983-ad03-4d40-92f9-c0cf1f34a56a`, active at
  100%, with exact full-SHA message and `git-b001cba8` tag.
- Acceptance Worker version `2c3caa96-4c40-4f53-a114-463c17638518`, active at
  100%, with exact full-SHA message and `ACCEPTANCE_STAGING_ENABLED=false`.
- Live Cloudflare Worker inventory contained no `mustaflow-snapshot-worker`.
- `PROJECT_RETIREMENT_EXECUTION_ENABLED` remained absent during this publication;
  boot logs carried the expected fail-closed warning and no retirement mutation
  was invoked.
- Activation publication commit `f82139402b1fbd6c47c5f63ab654f798e24e78ee`,
  tree `97f09a9a62b9b7a3dbddc113d07289ef8ec25430`, passed the 22-check
  `ora_gate` release gate and is served by `/api/version`; `/api/healthz`
  reports the same build commit with every named subsystem `ok`.
- Fresh production boot `3c58ac19` completed all 152 startup migrations. It
  adopted the six legacy Trash tombstones (projects 8, 9, 11, 12, 14, and 15)
  and surfaced the stale Snapshot-Worker KV dependency described below before
  any broad retirement batch was invoked.

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
- Release gate on implementation tip `49c7ec5c2e0351fd3ee6d051b81d9c205cb1a676`:
  22 passed, 0 warned, 0 failed; database `ora_gate`, environment lab, store A.
- Rollout-guard code tip: `2f2993cf70fc4df66b549f86ad64929c0d931230`;
  tree `9e90dd82b00538c6610f2cc1c26477941be6beb1`.
- Changed-file Prettier: 213 files checked across the implementation and guard
  follow-up, passed.
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
6. **Application boot could begin provider cleanup before compatible Workers were
   live.** Fixed by making retirement execution explicitly opt-in and disabled by
   default. Preventive: exact-value activation tests and the two-stage rollout
   contract keep Trash writes and cleanup fail closed until Worker parity is
   proven.
7. **Trash promised automatic permanent removal although no purger exists.** Fixed
   by describing only the real 30-day recovery window until governed purge ships.
   Preventive: a web regression test forbids the false terminal phrase.
8. **The first final release-gate attempt had no local test database.** It failed
   19/22 with loopback connection refusals and did not authorize publication. The
   dedicated A-drive `ora_gate` harness was started and bootstrapped using the CI
   sequence; the clean retry passed 22/22. Preventive: every gate receipt names its
   database, environment, store, and kind.
9. **C-drive free space fell during the release workload.** The cause was measured:
   the Windows-managed pagefile expanded to 13,946,441,728 bytes. No repository,
   package, test, PostgreSQL, or browser artifact was written to C. Preventive:
   paired drive readings remain mandatory; OS-managed virtual memory is reported
   rather than deleted or reconfigured.
10. **A dormant snapshot package still exposed an unsafe production command.**
    Live Cloudflare inventory proved no snapshot Worker exists, while the checked
    configuration still contains placeholders. Fixed by making production deploy
    fail closed. Preventive: a regression test forbids both generic and production
    Wrangler deployment until the surface has an audited configuration and
    identity path.
11. **The shared Owner refusal named only Admin Page access, even when protecting
    project retirement.** Fixed with action-neutral factual copy. Preventive: the
    central authorization test exercises the retirement path and pins the receipt.
12. **The retirement design prose allowed restore after any terminal although the
    implementation correctly requires completed cleanup.** Fixed by naming the
    completed prerequisite. Preventive: restore tests continue to reject accepted,
    running, and non-completed terminal operations.
13. **The rollout text instructed deletion of a duplicate acceptance Worker without
    separate irreversible-action authority.** No deletion occurred. Fixed by
    moving that observation to a separate authorization boundary. Preventive: the
    activation contract now forbids duplicate cleanup during retirement rollout.
14. **Retirement treated the deliberately absent legacy Workers KV namespace as a
    required production route registry.** The live provider inventory proves the
    KV namespace list is empty; current published routing lives in the Runtime
    Worker's Control Durable Object. The six adopted legacy tombstones therefore
    stopped before any provider call with typed
    `project_retirement_operation_unavailable`, and the broad batch was withheld.
    Fixed by making the legacy KV posture explicit: absent namespace plus disabled
    edge serving is `not_configured`, while required, partial, or ambiguous KV
    configurations still fail closed. Runtime route inventory and absence proofs
    remain mandatory. Preventive: the activation decision table, persisted
    `legacyHostnameKv` receipt, zero-provider-call empty-cache test, and coordinator
    ordering guard prevent this retired call site from blocking or weakening the
    authoritative route cleanup again.

## Retirement convergence implementation (2026-09-01)

This is a branch-tree implementation record, not a rollout receipt. It does not
attest to a commit, push, merge, publication, live convergence, or full-suite run.

- **Cloudflare cache-purge preflight is fail closed before mutation.** Current
  hostname eviction requires nonblank `CF_ZONE_ID` and `CF_API_TOKEN`; startup
  diagnostics expose only missing binding names. With either binding missing,
  any database hostname fact (public slug, custom domain, project-domain or
  purchased-domain row, or stored production release) produces the typed
  `project_retirement_provider_configuration_unavailable` refusal. If those
  facts are empty, preflight reads both the legacy KV and current runtime route
  inventories. Only complete, empty inventories permit retirement; a
  `not_configured` or blocked legacy posture, an incomplete or unsupported
  inventory, a provider error, or any observed hostname is unavailable rather
  than inferred empty.
- **Stored release hostnames remain eviction targets.** The referenced published
  version's non-null `productionRelease` counts as hostname inventory during
  preflight. During cleanup, a string `productionRelease.hostname` is included
  in the normalized, deduplicated cache-purge set after release rollback, so a
  hostname retained only in release history is not lost. Purge responses now
  distinguish missing configuration, invalid input, provider denial, malformed
  success, and provider unavailability; no route reaches `verified_absent` when
  exact tag eviction is unverified.
- **Configuration recovery has one exact platform-owner exception.** Ordinary
  terminal reconciliation remains capped at two generations. After that cap,
  only a platform `owner` may mint one additional `configuration_recovery`
  receipt, only for terminal route-deactivation failed/unverified evidence,
  only after the current Cloudflare binding pair is restored, and only when a
  prior configuration recovery was not recorded. The consumed flag is persisted;
  missing bindings, other failure classes, Operators, project owners using the
  ordinary self-service path, and a second exception remain refused.
- **Historical Fly cleanup requires identity, storage, and absence proofs.** A
  legacy `containerId` or `prodContainerId` is first syntax-checked, then read
  from Fly. An initial 404 is an absence proof; otherwise DELETE is possible
  only when the provider document exactly matches the machine id,
  `project-<id>` name, and `PROJECT_ID`, contains no contradictory nested
  identity marker, and explicitly proves an empty mount inventory with no other
  mount or volume marker. DELETE must be followed by a GET 404 before the pointer
  is cleared. Ambiguous identity or storage is retained without DELETE;
  provider and post-delete ambiguity remains typed and retryable. Cross-project
  current-runtime identities are never sent to Fly, and `testContainerId`
  remains retained behind the separate SQLite-preservation boundary.
- **Security-review boundaries remain non-leaking.** The related findings were
  the risk of a stale Fly pointer authorizing deletion of another or mounted
  machine, and cache/provider details escaping through logs or historical
  receipts. Cache purge logs and results now carry only bounded counts, status,
  missing binding names, and numeric provider error codes. Persisted legacy Fly
  evidence is projected to closed counts, pointer kinds, states, proofs, reasons,
  and retryability; the status API and admin UI never render raw machine ids,
  hostnames, provider bodies, credentials, actor ids, or resource identifiers.
  The UI presents plain-language retained, already-absent, and
  deleted-then-verified-absent evidence for failed and completed history.
- **Preventive regression coverage is present in the branch.** The added cases
  pin missing-binding refusal before writes, provider-only and stored-release
  hostname discovery, incomplete-inventory refusal, bounded sanitized cache
  purge outcomes, the single owner recovery exception, malformed/cross-project/
  mounted Fly retention, exact GET-DELETE-GET absence, pointer clearing only
  after proof, `testContainerId` isolation, sanitized status projection, and
  plain-language UI rendering without raw provider identity. These are coverage
  additions, not test-execution claims in this section.
