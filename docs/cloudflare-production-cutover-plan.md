# Cloudflare production cutover plan

Date: 2026-08-14

Recon base: `cf741dc47c4113caf8b77a644cf32071021bc3da`

Recon branch: `codex/cloudflare-production-cutover-recon`

## Decision and current gate

The production cutover is **not configuration-ready yet**. The Pantry, trusted-build plane, sealed
runtime, doorman capabilities, generator, durable artifact promotion, and durable production
database allocation paths are implemented and deliberately inert. Production Worker configurations,
resources, independent authorities, and the key ceremony still stand between the inert stack and a
production canary.

The Acceptance Provisioner remains staging-only and is not the production database allocator. The
staging attestation fixtures must never be promoted into production.

The safest cutover keeps the stopped Fly estate intact until a newly generated Cloudflare canary is
published and healthy. Deleting the Fly app is the irreversible point.

## Target production topology

Use the already delegated `mustaflow.com` Cloudflare zone. The recommended tenant namespace is
`apps.mustaflow.com`, yielding published hosts such as `platform-canary.apps.mustaflow.com` and
preview hosts beneath `preview.apps.mustaflow.com`. This avoids buying or delegating another domain
and does not disturb the product frontend at `www.mustaflow.com`.

Do not use the current code default, `mustaflow.app`: on 2026-08-14 it had no NS, SOA, A, or AAAA
answer. `PLATFORM_DOMAIN` must be explicit in production.

### Cloudflare resources to create

None of the following production resources existed at recon time.

| Layer                   | Production resource                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Runtime Worker          | `nabuflow-runtime-production`                                                                                                   |
| Pantry Worker           | `nabuflow-pantry-production`                                                                                                    |
| Build Worker            | `nabuflow-build-production`                                                                                                     |
| Runtime R2              | `nabuflow-runtime-artifacts-production`                                                                                         |
| Pantry R2               | `nabuflow-pantry-catalog-production`                                                                                            |
| Build R2                | `nabuflow-trusted-build-production`                                                                                             |
| Runtime queue           | `nabuflow-artifact-commit-production`                                                                                           |
| Runtime DLQ             | `nabuflow-artifact-commit-dead-letter-production`                                                                               |
| Pantry queue            | `nabuflow-pantry-ingest-production`                                                                                             |
| Build queue             | `nabuflow-trusted-build-production`                                                                                             |
| Build DLQ               | `nabuflow-trusted-build-dead-letter-production`                                                                                 |
| Runtime Durable Objects | `NabuflowSandbox`, `ControlDurableObject`, `CapabilityVaultDurableObject` in the production Worker namespace                    |
| Pantry Durable Object   | `PantryCatalogDurableObject` in the production Worker namespace                                                                 |
| Build Durable Objects   | `TrustedBuildSandbox`, `TrustedBuildDurableObject` in the production Worker namespace                                           |
| Container applications  | production runtime sandbox and trusted-build sandbox applications created by the corresponding Wrangler deployments             |
| Service bindings        | runtime -> production Pantry and build Workers; build -> production Pantry Worker                                               |
| Public routing          | exact runtime/control origin plus `*.apps.mustaflow.com/*` published route, installed only at the approved surface-opening step |

Production container ceilings and `TRUSTED_BUILD_MAX_ACTIVE` require a cost/capacity decision before
creation. Staging currently advertises five runtime cells, five build cells, and a build active limit
of 32; those values are evidence, not production sizing.

### Existing binding names to install

Only names are recorded here. Values remain founder-installed secrets.

#### API / Zero service

| Kind     | Binding                                   | Required setting                                          |
| -------- | ----------------------------------------- | --------------------------------------------------------- |
| Variable | `TENANT_RUNTIME_PROVIDER`                 | `cloudflare`                                              |
| Variable | `CLOUDFLARE_RUNTIME_CONTROL_URL`          | proposed `https://runtime.apps.mustaflow.com`             |
| Secret   | `CLOUDFLARE_RUNTIME_CONTROL_TOKEN`        | same authority installed write-only on the runtime Worker |
| Variable | `CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE` | `production`                                              |
| Variable | `CLOUDFLARE_RUNTIME_PREVIEW_URL`          | proposed `https://runtime.apps.mustaflow.com`             |
| Secret   | `CLOUDFLARE_RUNTIME_PREVIEW_PRIVATE_KEY`  | production preview signer                                 |
| Variable | `NABUFLOW_ZERO_GENERATION_TARGET`         | `cloudflare-sealed-v1`                                    |
| Variable | `NABUFLOW_PANTRY_TRUSTED_PUBLIC_KEYS`     | production Pantry verifier set                            |
| Variable | `PLATFORM_DOMAIN`                         | proposed `apps.mustaflow.com`                             |

The provider, control URL/token/namespace, generation target, preview origin/key, and verifier set
must be installed in one Replit deployment. Partial Cloudflare configuration fails closed. Leave
`PROD_HEALTH_BASE_URL` unset so post-publish checks exercise each real tenant hostname.

#### Runtime Worker

- resources: `NABUFLOW_RUNTIME_ARTIFACTS`, `DURABLE_OPERATION_QUEUE`, `PANTRY_CATALOG`,
  `TRUSTED_BUILD_PLANE`, `NABUFLOW_SANDBOX`, `CONTROL_COORDINATOR`, `CAPABILITY_VAULT`,
  `CF_VERSION_METADATA`;
- secrets: `CLOUDFLARE_RUNTIME_CONTROL_TOKEN`, `CLOUDFLARE_CAPABILITY_VAULT_KEK_V1`,
  `NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY`;
- public verification material: `CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY`;
- variables: `CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE=production`,
  `NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID`, `NABUFLOW_RUNTIME_SLEEP_AFTER`,
  `NABUFLOW_RUNTIME_LAYER_PLATFORM`, `NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED=enabled`,
  `NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID`, `NABUFLOW_PRODUCTION_NEON_REGION_ID`,
  `NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS`, and
  `NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS`.

Every `NABUFLOW_STAGING_*` binding is omitted in production.

#### Pantry Worker

- `PANTRY_CATALOG_COORDINATOR`, `PANTRY_CATALOG_OBJECTS`, `PANTRY_INGEST_QUEUE`;
- `PANTRY_INGEST_SIGNING_KEY_ID`, `PANTRY_INGEST_SIGNING_PRIVATE_KEY`;
- `PANTRY_REVISION_PUBLIC_KEYS`.

The private signer must be a protected production binding. The checked-in staging fixture has no
production authority.

#### Trusted-build Worker

- `PANTRY_CATALOG`, `TRUSTED_BUILD_OBJECTS`, `TRUSTED_BUILD_QUEUE`;
- `TRUSTED_BUILD_COORDINATOR`, `TRUSTED_BUILD_SANDBOX`;
- `TRUSTED_BUILD_PLATFORM`, `TRUSTED_BUILD_MAX_ACTIVE`;
- `TRUSTED_BUILD_SIGNING_KEY_ID`, `TRUSTED_BUILD_SIGNING_PRIVATE_KEY`,
  `TRUSTED_BUILD_PUBLIC_KEYS`.

Omit `TRUSTED_BUILD_STAGING_LIVE_RECOVERY_PROBE`. The private signer must be a protected production
binding.

## Product work required before the switch

### 1. Production artifact promotion and publish

`CloudflareRuntimeProvider.createProduction()` and `deployProduction()` currently fail typed as
unavailable. The publish route still hands source files and a secret environment map to the generic
production-container API, which is the Fly contract. The kitchen's sealed artifact identity is not
durably attached to a publishable project version.

Build this as one clean slice:

1. persist the accepted kitchen result (source revision, shelf revision, manifest revision, layer
   identities, and sealed artifact identity) against the project version;
2. produce or promote an envelope targeted to the deterministic production runtime identity;
3. drive layered begin/transfer/commit, runtime ensure, manifest update, start, health, and route
   activation through the existing durable job/follower infrastructure;
4. keep exactly one idempotency identity from publish request through route activation;
5. on failure, preserve the prior active route and runtime; and
6. make unimplemented/partial states typed, never the current generic `container_deploy_failed`.

Artifact v1 and dependency-layer wire formats remain unchanged.

#### Slice A implementation record (2026-08-14)

Implemented on `codex/production-artifact-promotion`, inert until the production provider and
Worker locks are deliberately enabled:

- the trusted kitchen's accepted release record is stored on its exact project version and copied
  into the immutable deployment snapshot;
- one canonical content-derived promotion identity binds source version, accepted sealed hash,
  target slot, and published hostname;
- the Runtime Worker promotes verified application chunks into the deterministic production
  namespace, reuses verified immutable dependency layers, independently reseals the target
  envelope, and runs the work as a checkpointed `layered-artifact-promotion` durable job;
- the provider follows ensure, promotion, start, and activation under stable phase keys derived
  from that one promotion identity; and
- project-state persistence failure performs a compare-and-swap route rollback to the previously
  active release (or removes the first route), leaving the previous runtime intact.

Reality correction: the earlier runtime implementation admitted only `production/blue` at route
activation and data-plane dispatch, although the shipped locator and route contracts already
defined both `blue` and `green`. Safe republish cannot preserve an active candidate with a single
slot. Slice A therefore makes the existing `blue|green` contract real: promotion always targets the
inactive slot, health precedes compare-and-swap activation, and rollback reactivates the prior
slot. This is additive control behavior; Artifact v1 and layer wire formats remain byte-unchanged.
The historical “production-blue is the sole active slot” implementation note is superseded for
Cloudflare production publishing by this blue/green rule.

### 2. Production database capability provisioning

Sealed project provisioning deliberately skips direct `DATABASE_URL` creation. The production path
uses a distinct trusted allocator with provider management custody, org/cost guards, idempotent
project ownership, deletion, and verify-gone. Its management-secret binding is
`NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY`; installing it remains a founder ceremony and cutover gate.

The result handed to the runtime remains an opaque database capability. No connection string or
provider management credential may reach the API process, generated source, tenant environment,
logs, or evidence.

#### Slice B implementation record (2026-08-15)

Implemented on `codex/production-database-capability`, inert until the production database lock and
the complete production Worker configuration are deliberately installed:

- a canonical identity derived only from deployment namespace `production` and project ID owns one
  Neon allocation across publishes, versions, runtime restarts, and blue/green flips;
- database-declaring accepted releases allocate before artifact promotion, while releases that do
  not declare the capability preserve the existing publish path;
- a checkpointed `production-database` job in the shared durable-operation chassis performs
  provider allocation, independent region/history-retention verification, and atomic encrypted
  Capability Vault handoff;
- provider management custody is isolated to
  `NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY` on the Runtime Worker. The API receives opaque allocation
  metadata only; generated code and tenant containers continue to invoke the fixed doorman
  `neon-postgres/database` capability and never receive a connection string;
- exact replay returns the existing allocation, ambiguous body-bearing creates discover and verify
  the deterministic provider object before retry, and project-count/org/region/retention guards
  fail before or immediately after the narrow provider operation as appropriate; and
- soft deletion retains the allocation through the existing 30-day recovery window. Only hard GDPR
  erasure begins release; provider deletion plus authoritative 404 verification completes before
  the vault credential/ownership record and product project row may be removed.

Reality correction: the recon described backup policy as undefined. Neon project history retention
is now an explicit, bounded production input and is independently read/repair/read verified for
every allocation or reuse. The production ceremony must choose the retention value, region,
dedicated organization, and project ceiling; it must install the management key by founder handoff.
No production provider call, resource, route, or binding was created by Slice B.

### 3. Production configuration files and key ceremony

After the two implementation slices above, add explicit production Wrangler configurations for the
three Workers.
They must reference only the production resources in this plan, omit staging probes and host
overrides, keep Pantry/build private, and contain no private signing material. Run a production key
ceremony with PG-1 overlap (read old+new, write new) for control, preview, Pantry attestation, build
attestation, and vault encryption authorities.

### 4. PG-2

This recon makes production published WebSocket upgrades fail closed with typed
`published_websocket_unavailable`. HTTP, streaming HTTP, and SSE remain eligible. Either ship the
sanitized WebSocket boundary before cutover or retain the typed exclusion in the published-product
contract. Never forward the original upgrade request in production.

## Canary replacement

There is no hard-coded Towco target in `runPostPublishHealthCheck`; it already checks the published
project passed to it and records the result in `prod_health_checks`. The swap is operational:

1. through the live production Zero route, create a new non-fixture Node/Express project named and
   tagged as the platform canary;
2. require at least one cold Pantry stock, a doorman database write/read, dependency-complete build,
   layered seal, production promotion, start on 8080, `/healthz`, and public-route activation;
3. publish at `platform-canary.apps.mustaflow.com` and verify the persisted post-publish health row;
4. restart and verify database persistence and artifact rehydration;
5. run the post-publish probe again after the publish deployment; and
6. only then designate the new project as the standing smoke canary.

After acceptance, remove the obsolete project-86/Towco repair and upload utilities in a separate
cleanup commit. They are retained until the rollback window closes.

## Fly estate scheduled for deletion

Fly organization `personal` contains one suspended app, `mustaflow-containers`. It has 41 stopped
Machines in `iad`, no volumes, no app secrets, no allocated public IPs, and no certificates. Forty
Machines use the Node 22 Alpine image; project 28 uses Python 3.12 slim. Project 86, Machine
`d895134c606e98`, is the Towco canary being replaced.

| Project | Machine ID       | Project | Machine ID       |
| ------- | ---------------- | ------- | ---------------- |
| 21      | `7810307fe03508` | 26      | `3d8d0e17c14128` |
| 27      | `18551d6b7229e8` | 28      | `2879091f4d9138` |
| 29      | `080d69da65e1e8` | 30      | `6837010bee7d28` |
| 31      | `d89796df2d0368` | 32      | `683037da2704d8` |
| 33      | `185e290a915d68` | 34      | `0805091bee9518` |
| 35      | `7813442c2053d8` | 36      | `185d62eb2d3278` |
| 37      | `683542dc14d978` | 38      | `185137da701678` |
| 39      | `683540ebdd3148` | 40      | `185e299cd11748` |
| 41      | `48ee5d6f7d2218` | 42      | `d894556b303248` |
| 43      | `2862e79fe53268` | 67      | `1854533a169068` |
| 68      | `e82e0e2f642008` | 70      | `e820253a073358` |
| 71      | `0805452b900698` | 72      | `e82d662b1456e8` |
| 73      | `e826329b232448` | 74      | `7812611a905928` |
| 75      | `822301b79396e8` | 76      | `2869762c324768` |
| 77      | `846435a22975d8` | 78      | `185d33ec15e978` |
| 79      | `0801679ae27708` | 80      | `d893e06f0d2718` |
| 81      | `185e292a012948` | 82      | `865990ce734128` |
| 83      | `d895e15f0345e8` | 84      | `148ee64ea75558` |
| 85      | `4d895265ae03d8` | 86      | `d895134c606e98` |
| 94      | `7845e19f21e548` | 95      | `7812132c930798` |
| 96      | `7845037fed4478` | —       | —                |

The dedicated `nabuflow-acceptance-staging` Fly org had no apps at recon time and is outside the
production deletion target unless the founder separately retires acceptance infrastructure.

Before deleting the app, reconcile those 41 project IDs against production database rows and each
project-owned external resource. Production database access was not used during this read-only
recon, so that cross-provider deletion inventory is an explicit pre-delete task.

## Ordered cutover with rollback points

1. **Ship this recon.** Production remains Fly and the sealed target remains unset. Rollback: normal
   code revert.
2. **Approve DNS and capacity.** Confirm `apps.mustaflow.com`, Worker/container ceilings, and cost
   alerts. No route yet. Rollback: none needed.
3. **Ship production publish and production DB-capability slices.** Exercise them on isolated
   production-named resources without a public wildcard. Rollback: delete only those empty/new
   resources.
4. **Provision production resources and keys.** Deploy Pantry, build, then runtime privately; prove
   signatures, queues, DO migrations, R2 zero baselines, and key overlap. Rollback: undeploy the new
   Workers and remove their still-unreferenced resources.
5. **Open the approved runtime/control and wildcard routes.** Keep the Replit API on Fly. Verify
   unauthenticated control denial, signed control, preview grants, and unknown-host 404. Rollback:
   remove routes; Fly is untouched.
6. **Atomic API flip.** Install the complete API binding set in one Replit deployment and set the
   production sealed target. Do not remove Fly configuration. Rollback: atomically restore provider
   `fly` and remove all Cloudflare partial configuration.
7. **Generate and publish the new canary.** Run the matrix in the canary section. Any red rolls the
   API back to Fly while the stopped Fly Machines remain available.
8. **Observation window.** Require post-publish checks, queue/DLQ zero, no untyped tail errors,
   storage/accounting evidence, and a restart/rehydration proof. Rollback remains the atomic API
   flip.
9. **Inventory and delete founder test projects.** Export the authoritative project/resource list,
   delete project-owned external resources, delete product rows through the product deletion path,
   and verify gone. This begins irreversible cleanup.
10. **Delete `mustaflow-containers`.** Verify the app, all 41 Machines, configs, volumes, IPs, and
    certificates are absent. This is the no-rollback point for the old runtime estate.
11. **Retire Fly.** Remove `FLY_API_TOKEN` from Replit Secrets; remove `FLY_APP_NAME`, `FLY_REGION`,
    and `FLY_ORG_SLUG` from `.replit`; delete the Fly provider and Towco repair scripts in clean
    follow-up commits. Keep the dedicated acceptance org only if it remains an approved test asset.
12. **Close.** Prove production queue/DLQ health, expected nonzero referenced artifact/Pantry
    storage, zero orphan/quarantine storage, zero old Fly resources, and the new canary health row.

## PG register

- **PG-1 — promoted production blocker.** Production needs independent control, preview, Pantry,
  build, and vault authorities with overlap/rotation; staging fixtures are forbidden.
- **PG-2 — explicitly fail closed.** Published production WebSockets return typed 501 until the
  sanitizing boundary exists.
- **PG-3 — implementation closed; operational gate remains.** Allocation, project ownership,
  verified hard-delete destruction, history-retention policy, region pinning, and Capability Vault
  handoff are implemented and staging-rehearsed. Cutover still requires the founder-installed
  management key plus approved production organization, region, retention, and project ceiling.
- **PG-5 — capacity gate.** The real dual-substrate proof establishes function, not production
  capacity. Set production concurrency/cost ceilings from load evidence before opening traffic.

## Wall #8 production route diagnosis — 2026-08-17

This record was written before the Wall #8 repair branch was opened.

### Authoritative state

- GitHub `main` is `bc3070ca48bf683ac037c40d85cd5affbbaa4416`.
- Project 51 still publishes v149 and still stages/tests the approved v158. The v158 row has no
  `productionRelease`; the failed green activation did not advance project publish state.
- The v149 `productionRelease` is `active`, targets slot `blue`, and names runtime
  `nrf-ab8e18ef4ebebedd-p51-production-blue`. Both `promotedAt` and `activatedAt` are
  `2026-08-15T23:11:58.905Z`, proving that the original publication completed its final route
  activation rather than merely starting a runtime.
- The original route did serve. Persisted post-publish checks for v149 returned HTTP 200 at
  `2026-08-15T23:12:37.411820Z` and `2026-08-15T23:17:37.406407Z`, at 629 ms and 628 ms.
- The production route registry is the `control-v1` Control Durable Object's `_cf_KV` storage,
  not a Workers KV namespace. Cloudflare Data Studio exposes the table but rejects value reads
  with `SQLITE_AUTH`. The public data plane nevertheless proves the current entry is present and
  internally consistent with the old blue runtime: every missing-route, malformed-identity,
  manifest, port, or persisted-status mismatch returns immediate typed JSON before forwarding;
  instead both `/` and `/healthz` reached Cloudflare and timed out after 15.01 seconds with zero
  response bytes. The only remaining code path is `containerFetch` to the stored blue target.
- Cloudflare's live container census names three Project 51 instances: preview-primary,
  production-blue, and production-green. Blue is reported `Running` in Washington with 244 MiB
  memory, 625.5 MB disk, and four `VMStopped` events at deployment `d0345428` beginning
  `2026-08-16T03:18:29Z`. Green is reported `Running` in Washington with 347.6 MiB memory and no
  recent errors.
- The green candidate is
  `nrf-ab8e18ef4ebebedd-p51-production-green`. It is started but unreferenced: v158 has no
  production release, Project 51 and v149 still reference blue, and the route-activation function
  rejects green before its compare-and-swap call. Therefore tonight's failed activation did not
  mutate route state, while its pre-activation start left a live orphan candidate.

### Mechanism and repair scope

There are two independent product defects.

1. Route activation accepts a `blue|green` route contract, then hard-codes the parsed identity and
   runtime descriptor to `blue`. Blue-to-green publication therefore fails before the route CAS.
   The validation must instead require the parsed identity and runtime descriptor slot to equal
   the route's actual `activeSlot`, in both directions.
2. Published liveness trusts a durable `running` descriptor but never verifies that its tenant
   process survived a container VM stop/restart, and the unbounded `containerFetch` can then hold a
   public request forever. The trigger is also concrete: `CloudflareSandboxBackend.start()` sets
   keepalive true, but its `status()` and `logs()` accessors reopen the same Sandbox with
   `keepAlive: false`; the installed Sandbox SDK persists that change and stops the container when
   its activity window expires. The v149 health history, later `VMStopped` events, and current
   zero-byte hang are the resulting sequence. The repair must keep read-only inspection from
   disabling live keepalive, bound forwarding, return a typed retryable failure rather than a dark
   connection, and drive recovery through the existing durable runtime-start job rather than
   making one public request own execution.

Activation failure cleanup is part of the same repair. A target runtime that was promoted and
started but not made authoritative must be stopped/destroyed and its target artifact reclaimed.
Cleanup must first reconcile whether activation committed, so an ambiguous response can never
destroy the runtime that actually became active.

### Incidental findings

1. **Route-store terminology/observability mismatch.** Operational requests and earlier reports
   call the record a KV route, but it lives in opaque Control Durable Object `_cf_KV` storage and
   has no signed metadata-only read surface. Cloudflare Data Studio blocks reads with
   `SQLITE_AUTH`, so direct forensic discovery depends on behavioral and application-ledger
   correlation. Evidence: production `control-v1` object
   `e57de76559a30d3ba40c8aa34f307e1d9b7ef9a6a5d258ec499336b20be9b691` and the rejected `_cf_KV`
   query. Reported only; no diagnostic surface is added in this commission.
2. **Container observability disabled.** The production container Logs tab reports “Workers
   Observability is Disabled,” preventing application-log correlation for the dark blue runtime.
   Reported only; enabling it may affect cost and is outside this commission.
