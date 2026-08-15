# Cloudflare production cutover recon report

Date: 2026-08-14

Verified base: `cf741dc47c4113caf8b77a644cf32071021bc3da`

Branch: `codex/cloudflare-production-cutover-recon`

## Scope restatement

This branch maps every lock, binding, resource, staging assumption, canary dependency, and Fly
deletion target between the shipped inert Pantry stack and a production Cloudflare cutover. It makes
only fail-closed and additive compatibility changes exposed by that recon. It does not deploy,
configure, route, lease, delete, or spend against any live service.

## Recon verdict

Production is **NO-GO pending two implementation slices**:

1. production artifact promotion/publish through the layered dock; and
2. production database allocation and Capability Vault handoff.

The precise topology, configuration, canary, deletion sequence, and rollback points are in
`docs/cloudflare-production-cutover-plan.md`.

## Read-only live inventory

### Cloudflare

The account contains only staging Pantry-era resources:

- Workers: runtime staging, Pantry staging, trusted-build staging, and Acceptance Provisioner
  staging;
- R2: `nabuflow-runtime-artifacts-staging`, `nabuflow-pantry-catalog-staging`, and
  `nabuflow-trusted-build-staging` (plus unrelated pre-existing `mustaflowimages`);
- queues: staging acceptance operations, artifact commit + DLQ, Pantry ingest, and trusted build +
  DLQ;
- container applications: staging runtime sandbox and staging trusted-build sandbox;
- no production runtime/Pantry/build Workers, no production R2 buckets, no production queues, and
  no production container applications.

No D1 database was listed and the KV namespace list was empty. No resource was created or changed.

The runtime staging secret-name inventory contains the expected control, preview, and vault
bindings plus two legacy misspelled control-token names. The production ceremony must install only
the canonical names and must not copy staging values.

### DNS

`mustaflow.app`, the current code default, returned no NS, SOA, A, or AAAA record. `mustaflow.com`
is delegated to Cloudflare nameservers; `www.mustaflow.com` currently resolves outside the Worker
stack. The plan therefore recommends the isolated `apps.mustaflow.com` tenant namespace. No DNS or
route was changed.

### Fly

The `personal` org contains exactly one suspended app, `mustaflow-containers`, with 41 stopped
Machines. There are no volumes, app secrets, allocated public IPs, or certificates. The full
Machine inventory is in the cutover plan. The dedicated `nabuflow-acceptance-staging` org contains
no apps. No Fly operation other than listing/status was performed.

### Replit/application configuration

The committed `.replit` file still names `mustaflow-containers`, `iad`, and `personal`. It does not
declare the Cloudflare provider, production control/preview origins, production namespace, sealed
generation target, Pantry verifier set, or tenant platform domain. The runtime provider defaults to
Fly when unset. Cloudflare selection must therefore be one atomic Replit deployment, not a sequence
of piecemeal edits.

## Shipped gaps and staging assumptions

| Finding                                                                                            | Classification           | Disposition                                                                                              |
| -------------------------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------- |
| Only `cloudflare-sealed-staging-v1` was a generator contract target                                | staging assumption       | Fixed additively with production target `cloudflare-sealed-v1`, locked to namespace `production`         |
| Eligibility and dependency plans could not carry a production target                               | staging assumption       | Fixed; both consume one target and contract rejects target mismatch                                      |
| Several generator call sites compared the literal staging target                                   | staging assumption       | Fixed through the shared sealed-target predicate and target propagation                                  |
| Preview issuer required a `.workers.dev` hostname                                                  | staging assumption       | Fixed with strict public HTTPS hostname-origin validation, allowing an approved custom production origin |
| Published WebSocket path forwarded the original request while only a comment prohibited production | security defect          | Fixed fail-closed outside staging with typed `published_websocket_unavailable`                           |
| Production Worker configs do not exist                                                             | expected inert posture   | Cutover task; exact resources and omissions are specified in the plan                                    |
| Pantry/build configs contain checked-in staging signing fixtures                                   | production blocker       | Do not promote; use independent protected production attestors under PG-1                                |
| Staging host overrides and recovery probes exist                                                   | expected staging tooling | Omit every `NABUFLOW_STAGING_*` and build recovery probe from production                                 |
| Acceptance Provisioner is staging-only                                                             | expected                 | Never bind it into production runtime provisioning                                                       |
| Cloudflare production create/deploy methods are typed unavailable                                  | product blocker          | Dedicated production artifact-promotion/publish slice                                                    |
| Publish route still uses the Fly source-files + secret-env production contract                     | product blocker          | Replace with persisted kitchen artifact promotion and durable route activation                           |
| Kitchen artifact identity is not persisted as the publishable project-version result               | product blocker          | Add durable version linkage in the production publish slice                                              |
| Sealed provisioning has no production DB allocator/vault handoff                                   | product blocker          | Dedicated production database-capability slice under PG-3                                                |
| Billing bypass is staging triple-locked                                                            | correct                  | Leave unchanged; production uses normal credit/billing enforcement                                       |
| Snapshot Worker config is placeholder/incomplete and its named R2/KV resources are absent          | legacy surface gap       | Decide deprecation versus coexistence before wildcard routing; do not route it accidentally              |
| `PLATFORM_DOMAIN` silently defaults to nonexistent `mustaflow.app`                                 | configuration hazard     | Require explicit `apps.mustaflow.com` in the cutover manifest                                            |

## Branch changes

### Contracts and generator

- `lib/tenant-runtime-contracts/src/zero-generation.ts`: adds the production sealed target and
  production namespace constants; dependency plans accept either sealed target.
- `lib/tenant-runtime-contracts/src/zero-eligibility.ts`: carries the same target and rejects a
  dependency-plan/envelope target mismatch.
- `artifacts/api-server/src/lib/zero-sealed-generation.ts`: resolves staging and production only
  when provider, target, and namespace agree; propagates the selected target into plans and
  refinements.
- `artifacts/api-server/src/lib/agent-loop.ts`, `builder.ts`, `jobs.ts`, `knowledge.ts`,
  `zero-sealed-finalize-check.ts`, and `zero-capability-eligibility.ts`: replace staging literals
  with the shared sealed-target path and preserve the selected target end to end.

### Production-origin and data-plane posture

- `artifacts/api-server/src/lib/cloudflare-preview-grant.ts`: permits a deployment-owned custom
  public HTTPS origin while rejecting credentials, path/query/fragment/port, malformed hostnames,
  and IPv4 literal origins.
- `artifacts/nabuflow-runtime-worker/src/published-data-plane.ts`: production WebSockets fail typed
  and closed until PG-2 is resolved; staging behavior remains unchanged.

### Tests

- contract regressions cover both target values and cross-layer target mismatch;
- generator regressions cover the production lock combination and production plan stamp;
- preview regressions cover custom origin acceptance and non-origin/IP rejection;
- published-data-plane regression proves staging WebSockets are unchanged and production invokes no
  sandbox WebSocket call.

No `package.json`, lockfile, `.replit`, or Wrangler manifest changed. Artifact v1, dependency-layer
format, Fly provider/configuration, tenant egress, and staging resource behavior are unchanged.

## Verification

| Gate                               | Result                                               |
| ---------------------------------- | ---------------------------------------------------- |
| Frozen install                     | PASS, `--prefer-offline`, lockfile unchanged, 10m57s |
| Tenant-runtime-contracts suite     | PASS — 18 files / 179 tests                          |
| Runtime Worker suite               | PASS — 30 files / 231 tests                          |
| Broader Zero/generator/API set     | PASS — 11 files / 104 tests                          |
| Focused preview/generator set      | PASS — 5 files / 41 tests                            |
| Workspace library TypeScript build | PASS                                                 |
| API TypeScript check               | PASS after required library declaration build        |
| Runtime Worker TypeScript check    | PASS                                                 |
| Contracts lint                     | PASS                                                 |
| Runtime Worker lint                | PASS                                                 |
| Changed API lint                   | PASS                                                 |
| Modified-blob secret-pattern sweep | PASS — 20 files / 0 findings                         |
| `git diff --check`                 | PASS                                                 |

The first API typecheck in the fresh worktree reported only missing workspace declaration outputs
(`TS6305`). Running the repository's required `tsc --build` prerequisite produced those declarations;
the unchanged API typecheck then passed. This was build ordering, not a source failure.

## Safety and live-state declaration

- No live deployment, route, DNS record, Worker variable/secret, queue, bucket, Durable Object,
  container, database, or application was created, modified, or deleted.
- No provider credential value was requested, read, captured, or written.
- No lease was created and no billable workload was started.
- Cloudflare, Fly, DNS, and repository inspection was read-only.
- The old Fly estate remains intact as the rollback anchor.

## Permanent-rule and PG updates

- One canonical generation target now crosses generator, dependency plan, and eligibility identity;
  layers no longer infer target sameness independently.
- Production protocol-upgrade safety is executable, not comment-only.
- PG-1, PG-3, and PG-5 are promoted production gates; PG-2 is explicitly fail-closed as detailed in
  the plan.
- The Fly deletion is sequenced after canary acceptance and is marked as the irreversible cutover
  boundary.
