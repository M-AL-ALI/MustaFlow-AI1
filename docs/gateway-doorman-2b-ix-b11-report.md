# Gateway Doorman 2b-ix-b11 — Fly parity and Pantry closure

Date: 2026-08-14  
Branch: `codex/zero-fly-parity-acceptance`  
Verified base: `2e9235c552c59d261a2b2f2fc426568a854f1c42`  
Result: **PASS — branch delivery only; no merge or product publish performed**

## Scope, restated

This closing slice proves that one real Zero-generated, dependency-complete source revision runs on
both supported substrates without moving a real tenant. Cloudflare receives the source through the
trusted Pantry/build plane, seals it as the shipped Artifact v1 plus additive dependency layer, and
runs database operations through the credential-free doorman capability. Fly receives the same
corrected source and exact lock, uses the platform-owned direct PostgreSQL adapter, and receives its
disposable database configuration directly from the Acceptance Provisioner through the documented
Machines API custody path. Both runtimes listen on port 8080, pass the same overlapping functional
matrix, survive a Fly stop/start cycle, and finish with all disposable resources independently
verified gone.

Stripe is deliberately outside the overlapping Fly contract. No Fly payment-custody path was added.
No live tenant project, production Fly organization, production provider configuration, Artifact v1
wire format, dependency-layer format, or tenant egress policy was changed.

## Verdict

- Cloudflare and Fly accepted the same corrected generated source SHA-256
  `761073b5afa6c902aa11c96a9031144c2d7cb451b029ea22e8ead11c0924f998`.
- Cloudflare cold-stocked and built the source through Pantry, sealed and delivered artifact
  `9615dbe86468524c503b2ac7980b8d4ced8d54ceead4ef90b5f05ccfeb49270f`, and reached healthy on
  port 8080.
- Fly built that source with the same exact lock SHA-256
  `24dd838b5fc05da5e6cbf309ae5ffd5a070690ee3a1d1da0bbc828671347fc2c`, reached healthy, passed the
  full database matrix, stopped, restarted, and passed the matrix again.
- The Fly runtime made zero doorman capability calls. Its database credential was written directly
  by the Provisioner to the disposable machine configuration and was never returned by a lease API.
- Fly recorded USD 0 against the approved USD 5 ceiling; active machine time was 198,603 ms.
- The disposable Fly app/machine and Neon project were destroyed and returned typed
  `resourcesGone=true` and `configurationGone=true`.
- Fly organization inventory is empty. Runtime, trusted-build, and Pantry ledgers/buckets are all
  empty; the authoritative R2 result is 0 objects / 0 bytes for both build and Pantry storage.
- The temporary auth-gated Provisioner route is closed. The final inert deployment is
  `e0293180-d24f-413e-90f0-dc1721bca6f5`; five consecutive external probes returned 404.
- No real tenant project was read, migrated, or modified.

## Parity amendment and source identity

Slice 10's accepted generated source remains a shipped acceptance fact. Slice 11 found that the
vendored dual-mode SDK lacked a concrete Fly PostgreSQL driver, so freezing the old source bytes
would have made honest direct-mode database parity impossible. The founder therefore amended the
target from “the frozen Slice 10 source hash” to “the same corrected source revision accepted on
both substrates.”

| Identity                  | SHA-256                                                            | Meaning                                                                                |
| ------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Slice 10 accepted source  | `ef9835e00a455e4cd53244e97189cc0fc72a923846c5a6b068efe01ea7e3529b` | Original Cloudflare dress-rehearsal source; acceptance stands unchanged                |
| Slice 11 corrected source | `761073b5afa6c902aa11c96a9031144c2d7cb451b029ea22e8ead11c0924f998` | Same corrected files presented to both Cloudflare and Fly                              |
| Corrected package lock    | `24dd838b5fc05da5e6cbf309ae5ffd5a070690ee3a1d1da0bbc828671347fc2c` | Exact dependency resolution used by Fly and represented by the Cloudflare build intent |
| Dependency intent         | `79e337dd2b47fcf236a6d811517f0b7918b2fe8fdbc94635232016daf063a6d7` | Pantry-facing intent derived from the corrected source                                 |

The correction adds a platform-owned, lazy PostgreSQL adapter and exact `pg@8.20.0` runtime plus
`@types/pg@8.20.0` build declarations. Generated application code still calls the provider-neutral
SDK entry point. Cloudflare mode neither imports the driver nor reads a database URL; Fly direct mode
constructs the driver only when selected by the shipped mode detector.

This is source-and-lock parity, not a claim that both substrates execute the same binary container.
Cloudflare uses the trusted Pantry/build/sealer/dock path. Fly uses the same corrected source and lock
in a disposable Depot/Fly image because the shipped Fly substrate consumes application images.

## Live acceptance matrix

| Area                    | Cloudflare                                                   | Fly                                                | Result |
| ----------------------- | ------------------------------------------------------------ | -------------------------------------------------- | ------ |
| Generated source        | Corrected source hash above                                  | Same corrected source hash                         | PASS   |
| Dependencies            | Pantry-only, cold build                                      | Exact corrected lock, image build                  | PASS   |
| Runtime mode            | `cloudflare-sealed-v1`                                       | `fly-direct-v1`                                    | PASS   |
| Runtime port/health     | 8080; `/healthz` 200                                         | 8080; `/healthz` 200                               | PASS   |
| Database custody        | Doorman capability; no tenant credential                     | Provisioner → Machines REST configuration          | PASS   |
| Database schema         | Table/index setup completed                                  | Same setup completed                               | PASS   |
| Create/select           | Insert 201; parameterized select 200                         | Insert 201; parameterized select 200               | PASS   |
| Replace/patch/list      | All 200 with expected values/count                           | All 200 with expected values/count                 | PASS   |
| Atomic rollback         | Conflict rejected; transaction rolled back                   | Same rollback proof                                | PASS   |
| Delete/absent           | Delete 200, subsequent 404                                   | Delete 200, subsequent 404                         | PASS   |
| Direct tenant egress    | Blocked 520                                                  | Direct mode is the approved substrate contract     | PASS   |
| Credential posture      | SDK read no database URL                                     | Value remained in disposable machine configuration | PASS   |
| Stop/start              | Runtime lifecycle already covered by shipped Cloudflare path | Stop then start succeeded                          | PASS   |
| Restart persistence     | Sealed runtime remained healthy                              | Full matrix passed again after restart             | PASS   |
| Capability endpoint use | All DB operations through doorman                            | Exactly zero capability endpoint calls             | PASS   |
| Payments                | Cloudflare capability remains shipped                        | Excluded from overlapping Fly contract             | PASS   |
| Cleanup                 | Runtime 404; artifact/build/Pantry retired                   | Machine/config/app absent                          | PASS   |

### Cloudflare identity

| Property           | Evidence                                                                       |
| ------------------ | ------------------------------------------------------------------------------ |
| Project / runtime  | `861338155` / `nrf-e919a75364398a44-p861338155-preview-primary`                |
| Build              | `pbuild_zero_dd83941d0cd5919ac9bc9e66d1b29b511f6e3d77cec09a2f2a4ba2cdebec8316` |
| Pantry shelf root  | `abbbf484507c9dd505e861e897f95fc0f8b4e92b8c4c144e8d02224557da0552`             |
| Dependency closure | `e58d11244d55f56bfebd28e0ccff24bde413904d8e2dfd6a8c9402fb1205fb34`             |
| Sealed artifact    | `9615dbe86468524c503b2ac7980b8d4ced8d54ceead4ef90b5f05ccfeb49270f`             |
| Build posture      | `coldBuild=true`; Pantry-only dependency acquisition                           |
| Health / egress    | `/healthz` 200; direct egress blocked 520                                      |
| SDK custody proof  | `databaseUrlReadByCloudflareSdk=false`                                         |

### Fly identity and lifecycle

| Property           | Evidence                                                           |
| ------------------ | ------------------------------------------------------------------ |
| Disposable app     | `nabu-accept-7a15ae426b96282080c11620`                             |
| Disposable machine | `d8d52e6f9263d8`                                                   |
| Image              | 67 MB; content-addressed registry digest recorded in evidence      |
| Database custody   | `provisioner-machines-rest-option-b`                               |
| First matrix       | Health, CRUD, atomic rollback, delete, and 404 all passed          |
| Lifecycle          | Stop succeeded; start succeeded; runtime returned healthy          |
| Restart matrix     | Entire functional matrix passed again                              |
| Cost               | USD 0 recorded; ceiling USD 5; 198,603 ms active                   |
| Final authority    | Typed verify-gone for machine and configuration; org app list `[]` |

The first machine image update encountered one exact Fly registry propagation race:
`MANIFEST_UNKNOWN` immediately after a successful push. The harness retried only that exact signature
under a named 120-second bound; attempt 2 succeeded. On Windows, `flyctl ssh console` returned a
complete valid JSON result and then exited 1 with the exact post-output wrapper artifact
“The handle is invalid.” The harness accepted it only after parsing and asserting every matrix row;
any truncated output or different stderr remains a failure.

## Four-surface sustained-green gate

Fresh session-only Worker control secrets were atomically generated, self-checked, installed, and
erased. All four surfaces reached 20 consecutive greens within 43.848 seconds and 130 requests,
below the five-minute / 600-probe ceiling.

| Surface                 |           Required | Consecutive |   First green |      Complete |
| ----------------------- | -----------------: | ----------: | ------------: | ------------: |
| Control HMAC            |                200 |          20 |    204.913 ms | 35,835.637 ms |
| Preview grant           |                302 |          20 |    291.449 ms | 35,902.913 ms |
| Vault KEK               |                200 |          20 | 11,564.394 ms | 43,743.511 ms |
| Preview redeem + replay | 302 then typed 409 |    20 pairs |  2,317.856 ms | 36,493.475 ms |

## Stripe boundary

The Fly overlap intentionally excludes payment operations. Cloudflare payments remain on the shipped
brokered capability. No payment secret was placed in a Fly machine, no new payment custody surface
was created, and the Provisioner was not extended for Fly payments.

If a payments-dependent generated application were deliberately rolled back to Fly today, the
vendored SDK would fail closed with `NabuFlowPaymentsError`, code `configuration`,
`retryable=false`, and message `The payments runtime is not configured`. The accepted sample app's
HTTP boundary would return status 500 with that same sanitized message. That is the documented
contract boundary, not an acceptance omission.

## Product findings and corrections

1. **Concrete Fly database adapter.** Added a lazy `pg` Pool-backed implementation with bounded
   pooling, parameterized statements, atomic transactions, cancellation, deterministic release, and
   sanitized SQLSTATE classification. Generation injects it without changing application imports.
2. **Eligibility is exact, not a package allowlist.** The raw-database guard permits `pg` only when
   the vendored adapter bytes and both exact dependency versions match platform authority. Arbitrary
   raw drivers remain ineligible.
3. **Optional peer closure.** npm optional peers are metadata unless independently selected by an
   explicit/root/runtime edge. Required peers remain closure-verified. This prevented `pg-native`
   from being treated as a required ingredient and failing on an absent native toolchain.
4. **Pantry read liveness.** Shelf metadata reads now verify the signed manifest rather than
   re-reading every ingredient object. Provenance reads independently verify every consumed object;
   full stamp/replay verification remains unchanged. A regression proves one metadata R2 read.
5. **Build quarantine reclamation.** Inputs orphaned before coordinator registration are reclaimed,
   and an aged bounded sweep runs only while the build plane is quiescent.
6. **Caller-owned operation bounds.** Kitchen Pantry waits and Cloudflare provider polling divide the
   named outer bound across retries and preserve cancellation/progress evidence.
7. **Durable deployment fence.** A queue message delivered to an older inert deployment no longer
   claims or executes a newly deployed job. The shared fence records
   `deployment-version-deferred`, keeps attempt 0, and re-enqueues after five seconds for the expected
   deployment. Both acceptance and runtime durable queues use the same implementation.
8. **Fly provisioned state.** After Machines REST configuration succeeds, the Acceptance Vault now
   durably transitions the Fly lease to `provisioned`; storing a provider result can no longer reset
   it to `active`.
9. **Typed terminal observability.** Authenticated lease status includes nullable `terminalCode`, so
   a terminal provider failure is diagnosable without exposing provider material.
10. **Harness liveness and evidence.** Provisioner open/close requires five consecutive stable
    observations under a named 120-second bound. Fly build and image activation are separate; only
    the exact propagation signature retries. Evidence remains uniquely named and pre-cleanup-first.

## Shipped-path enumeration

### Zero/generator/provider paths

| File                                                                | Rationale                                                               |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `artifacts/api-server/src/lib/zero-runtime-sdk.ts`                  | Vendored lazy Fly PostgreSQL adapter and exact dependency authority     |
| `artifacts/api-server/src/lib/zero-runtime-sdk.test.ts`             | Adapter bytes, mode separation, errors, disposal, and generated exports |
| `artifacts/api-server/src/lib/zero-sealed-generation.ts`            | Inject exact runtime/build dependencies into corrected generated source |
| `artifacts/api-server/src/lib/zero-sealed-generation.test.ts`       | Corrected-source, dependency-plan, and legacy behavior regressions      |
| `artifacts/api-server/src/lib/zero-capability-eligibility.ts`       | Exact attested-adapter exception without a package-name allowlist       |
| `artifacts/api-server/src/lib/zero-capability-eligibility.test.ts`  | Attested match and divergent/raw-driver rejection regressions           |
| `artifacts/api-server/src/lib/zero-generation-kitchen.ts`           | Progress-aware Pantry transport retry and named bound ownership         |
| `artifacts/api-server/src/lib/zero-generation-kitchen-wait.test.ts` | Progress, cancellation, timeout, and transport-weather regressions      |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts`       | Caller-owned GET budget partition and cancellation propagation          |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts`  | Multi-attempt operation-bound regression                                |

### Pantry, trusted build, durable operations, and Provisioner

| File                                                                       | Rationale                                                                   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `artifacts/nabuflow-runtime-worker/src/pantry-ingest.ts`                   | Optional-peer semantics and required-peer completeness                      |
| `artifacts/nabuflow-runtime-worker/src/pantry-worker.ts`                   | Manifest-only metadata verification; provenance/full verification preserved |
| `artifacts/nabuflow-runtime-worker/src/trusted-build-storage.ts`           | Pre-coordinator quarantine reclamation and guarded aged sweep               |
| `artifacts/nabuflow-runtime-worker/src/trusted-build-worker.ts`            | Invoke bounded reclamation under quiescent-state guard                      |
| `artifacts/nabuflow-runtime-worker/src/durable-operation-deployment.ts`    | New shared expected-deployment execution fence                              |
| `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts`          | Durable deployment observation and event persistence                        |
| `artifacts/nabuflow-runtime-worker/src/model.ts`                           | Deployment event/version evidence model                                     |
| `artifacts/nabuflow-runtime-worker/src/worker.ts`                          | Apply fence to runtime durable queue consumption                            |
| `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-worker.ts`   | Apply fence and typed terminal code to acceptance queue/status              |
| `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-model.ts`    | Persist expected deployment identity for acceptance jobs                    |
| `artifacts/nabuflow-runtime-worker/src/acceptance-vault-durable-object.ts` | Atomic Fly `provisioned` transition after configuration custody             |
| `lib/tenant-runtime-contracts/src/artifact-commit.ts`                      | Typed deployment-deferral event contract                                    |
| `lib/tenant-runtime-contracts/src/acceptance-provisioner.ts`               | Nullable typed terminal code on opaque lease status                         |

### Tests and acceptance harness

| File                                                                         | Rationale                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `artifacts/nabuflow-runtime-worker/test/pantry-ingest.test.ts`               | Optional/required peer closure class tests                                |
| `artifacts/nabuflow-runtime-worker/test/pantry-catalog.test.ts`              | Pantry catalog compatibility under corrected closure                      |
| `artifacts/nabuflow-runtime-worker/test/trusted-build.test.ts`               | Quarantine reclamation and safety-window guards                           |
| `artifacts/nabuflow-runtime-worker/test/acceptance-provisioner.test.ts`      | Fly provisioned state, terminal observability, deployment fence           |
| `artifacts/nabuflow-runtime-worker/test/helpers.ts`                          | Deterministic deployment-version test binding                             |
| `lib/tenant-runtime-contracts/test/acceptance-provisioner.test.ts`           | Terminal-code schema regression                                           |
| `lib/tenant-runtime-contracts/test/zero-eligibility.test.ts`                 | Corrected dependency intent fixture                                       |
| `artifacts/nabuflow-runtime-worker/scripts/artifact-layers-staging-smoke.ts` | Stable open/close propagation and evidence hardening                      |
| `artifacts/nabuflow-runtime-worker/scripts/slice11-fly-parity-acceptance.ts` | New live dual-substrate matrix, cost/cleanup, and unique evidence harness |

## Manifest, dependency, and safety declaration

- Repository `package.json` changes: **none**.
- Repository `pnpm-lock.yaml` changes: **none**.
- New repository dependency: **none**.
- Generated application dependency correction: exact `pg@8.20.0` and `@types/pg@8.20.0`.
- Frozen-lockfile proof trigger for the repository: **not triggered; manifests are unchanged**.
- Artifact v1 format: **unchanged**.
- Artifact layer format: **unchanged**.
- Fly repository configuration: **unchanged**.
- Tenant `enableInternet` / `allowedHosts`: **unchanged**.
- Production provider selection, routes, DNS, secrets, and traffic: **untouched**.
- Live deployments made by this work: **staging only**. Pantry and trusted-build staging received the
  tested code; the Provisioner route was temporary and is now closed/inert.

## Authoritative cleanup and cost closure

| Resource             | Final proof                                                                          |
| -------------------- | ------------------------------------------------------------------------------------ |
| Fly machine/config   | Typed verify-gone: `resourcesGone=true`, `configurationGone=true`                    |
| Fly app/org          | Disposable app deleted; `fly apps list -o nabuflow-acceptance-staging` returned `[]` |
| Neon                 | Project `rough-mouse-14739609` destroyed; typed resources/configuration gone         |
| Cloudflare runtime   | Destroyed; subsequent lookup typed `404 runtime_not_found`                           |
| Runtime artifact     | Targeted artifact remove succeeded                                                   |
| Trusted-build ledger | queued/running/succeeded/failed/cancelled all 0; active cells 0                      |
| Trusted-build R2     | Authoritative List Objects 0 objects / 0 bytes; quarantine 0                         |
| Pantry ledger        | assemblies/shelves/committed objects/external refs all 0                             |
| Pantry R2            | Authoritative List Objects 0 objects / 0 bytes; quarantine 0                         |
| Provisioner route    | Inert deployment current; five consecutive 404 responses                             |
| Session material     | Generated Worker rotation values and local transient values erased                   |
| Cost                 | Fly lease USD 0 / USD 5 ceiling; Neon USD 0; no residual compute                     |

The build/Pantry zero proof is the 122-check cleanup run. It used side-effect-free authoritative
inventory to discover and retire the exact shelf root, then verified both ledgers and R2 stores.

## Verification

| Verification                          | Result                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Tenant-runtime-contracts tests        | 18 files / 179 tests passed                                                                    |
| Tenant-runtime-contracts typecheck    | Passed                                                                                         |
| Runtime Worker tests                  | 30 files / 230 tests passed                                                                    |
| Runtime Worker typecheck / lint       | Passed / passed                                                                                |
| API focused provider/generator suites | 5 files / 83 tests passed                                                                      |
| API typecheck / lint                  | Passed / passed                                                                                |
| Workspace library typecheck           | Passed                                                                                         |
| `git diff --check`                    | Passed                                                                                         |
| Full API suite                        | Not a standing local gate; unrelated Ora/database/global-mock rows fail without lab PostgreSQL |
| Clean release profile                 | 18 pass / 0 warn / 3 database-environment failures                                             |
| Three-DB-suite exact-base parity      | Exact match: base also 18 pass / 0 warn / same 3 failures                                      |

Replit's database-equipped full gate remains the authoritative ship gate. The branch release profile
and exact-base profile were both run from clean committed trees. The only failures on each were:

1. `api-release-extended`: `ora-realtime-usage` cannot connect to local PostgreSQL at
   `127.0.0.1:5432`.
2. `api-account-billing-history`: `ora-memory-consolidation` receives API 500 from that same absent
   local PostgreSQL service.
3. `web-build`: dynamic prerender cannot connect to the same local PostgreSQL service.

The branch introduced no additional red row. This is exact environmental base parity, not a waiver
of Replit's database-equipped ship gate.

## Evidence index

| Evidence                                                                          | SHA-256                                                            |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Final cohesive dual-substrate run, `...204623427Z-final.json`                     | `890ee5796d7e11efe5022bbe7094974f1bcdf971fd5771d0efaebd228f15b43a` |
| Four-surface gate, `...204623427Z-four-surface-gate.json`                         | `4ba8b652aa25071fcc2ad12853b25d2a5d837f106a8bb057648f35f8a8305dd7` |
| Pantry/build closure, `...210445152Z-989ae5c5eed54118a2dda305bd31690a-final.json` | `7c7d20de243101e68ea689f15546a047d658de90c6a5f37720bc631a0d6e4d29` |
| Clean branch release profile                                                      | `8ea14d77f2e7e8537a90576d4390fb735c0b43631c7dfd166897a0e5b1a2719e` |
| Exact-base release profile                                                        | `046e2f907fa45e5c159fbc38ca5bcb39717ffd666f2680d2bee24fb8143567ef` |

The final cohesive record contains 525 sanitized entries and was persisted before cleanup and again
after cleanup under unique filenames. No credential value, connection string, provider token, or
matched secret text appears in committed material or cited evidence.

## PG register and 2b-ix-b closure

- **PG-1 — preview-grant key overlap:** remains open. Fly parity does not change preview-key
  rotation semantics.
- **PG-3 — database policy and portability:** narrowed. The same generated database contract now
  passes on Cloudflare doorman mode and Fly direct PostgreSQL mode, including rollback and restart.
  Real-tenant migration, persistent production-database policy, and cutover remain outside this arc.
- **PG-5 — artifact/build portability:** narrowed but not closed. Pantry, dependency-complete
  Cloudflare sealing, and one real dual-substrate app establish the integration floor. Broad native
  dependency/catalog scaling and general binary portability remain future work.
- **Payments boundary:** unchanged. Cloudflare payment capability remains supported; Fly payments
  are excluded and fail closed as documented above.

The 2b-ix-b arc is now closed at its commissioned boundary: contracts, additive layers, open Pantry
catalog/ingest, trusted build plane, dual-mode SDK, real Zero generation, capability eligibility,
Acceptance Provisioner, real Cloudflare dress rehearsal, and Fly parity all have live evidence.
Every disposable resource has been destroyed and independently verified absent. Provider cutover,
real tenant migration, and production publication remain separate founder/Replit actions.

## Permanent rules added by this slice

1. A durable job executes only on its recorded expected deployment version. Older deployments
   observe, persist, and defer without claiming or spending an attempt.
2. Post-output CLI-wrapper artifacts may be classified only by an exact signature after the entire
   expected structured result has parsed and passed; partial output never qualifies.
3. Registry propagation retry is exact-signature and bounded, not a generic deploy retry.
4. Provisioner route open/close is accepted only after consecutive stable observations, and closure
   is mandatory on every exit path.
5. Parity means one corrected source-and-lock authority accepted by both substrates; substrate-native
   packaging is recorded honestly rather than described as byte-identical execution.
6. Synthetic secret-scan fixtures are assembled only in memory. The final changed-blob sweep found
   no contiguous production credential prefix or other common push-protection signature at rest.

## Delivery state

Implementation commit: `50272b8bc699d8283e742ded1d91d62473755ed6`. The report addendum commit is
the delivery tip identified by the pushed branch ref; embedding its own hash would be
self-referential. The branch is ready for Replit's merge/ship ritual. No merge or publish was
performed here.
