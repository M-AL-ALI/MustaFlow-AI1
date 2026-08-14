# Gateway Doorman 2b-ix-b10 — real Cloudflare dress rehearsal

Date: 2026-08-14  
Branch: `codex/zero-cloudflare-runtime-acceptance`  
Verified base: `80170e938dab8022ddbf94d9e12d6551f9ce44d9`  
Final implementation-under-test: `80a4986fcc88f216d3140575789f0159d33db40d`  
Result: **PASS — branch delivery only; no merge or product publish performed**

## Scope, restated

This slice proves the assembled Cloudflare path rather than adding another platform primitive. A fresh, non-fixture Node/Express application was generated through the live staging Zero product path, stocked and built through the trusted Pantry/build plane, sealed as Artifact v1 plus an immutable dependency layer, materialized through the dock, and started healthy on Cloudflare at port 8080. The run then exercised the Phase B gateway, database, Stripe-test, artifact, routing, isolation, security, performance, and cleanup matrices using only opaque Acceptance Provisioner leases. Fly is deliberately outside slice 10.

The work also includes the minimal product and harness corrections revealed by the real path. Production provider selection was not changed, tenant egress was not widened, Artifact v1 and layer wire formats were not changed, and no tenant or harness received a provider credential.

## Verdict

- The real Project 12 / Task 32 product-path app reached `STARTED` and `HEALTHY` on Cloudflare.
- The final gateway matrix passed **1,103 checks**.
- The cleanup harness passed **122 checks** after a fresh four-surface rotation/gate.
- The deliberately failed manifest restart path returned typed `502 runtime_restart_failed` in **10/10 consecutive iterations**, with zero untyped escapes.
- Two Neon and two Stripe-test opaque leases reached `destroyed` with `resourcesGone=true`, `configurationGone=true`, and recorded cost `USD 0`.
- Runtime, trusted-build, and Pantry R2 buckets all finish at authoritative List Objects **0 objects / 0 bytes**.
- The temporary auth-gated Provisioner surface is closed. Its inert deployment is current and the former workers.dev readiness URL returns **404**.
- No Fly call was made. No real-world charge was incurred.

## Real Zero application proof

| Property           | Evidence                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product origin     | Live staging Zero, Project 12 / Task 32; not a fixture injection                                                                                               |
| Runtime identity   | `nrf-e919a75364398a44-p12-preview-primary`                                                                                                                     |
| Build              | `pbuild_zero_a8a8f2da0c0f33a9f6901a33baaeea85cb7b185b57ab4762ee7bae25bde1f1b7`; attempt 1; succeeded                                                           |
| Runtime            | `running`, port `8080`, `/healthz` aligned, ready at `2026-08-14T02:14:34.148Z`                                                                                |
| Runtime deployment | `f3479d0f-1240-4857-978c-078b92b1e7f8`                                                                                                                         |
| Manifest           | `zero-node-v1-b5f4cc4e586d5d44f885da17dc7b8ff283fba9185731bede20996c43bb814aac`                                                                                |
| Source             | 7 generated files; source artifact `ef9835e00a455e4cd53244e97189cc0fc72a923846c5a6b068efe01ea7e3529b`                                                          |
| Dependencies       | 11 declared; dependency intent `ff32ffe6dc89c79d6cdf01cd7df512dbde0c3da0c482073602bd85def078f49a`                                                              |
| Pantry shelf       | `pantry-2026-08-14.1`; root `c4bc4fd2bfe0cd6154940bd55c7d76b235434c239091ae5f070d9c0a4156d420`                                                                 |
| Lock / SBOM        | lock `a5c11d58c28d15ea5e51ad65113be82f27510f522dd4422e5c4285bb58eeafea`; SBOM `5b7ecfb83e91d0cc2f4c8f4d842cf22a913c28091b91c17b0abd7a35cde63a3f`               |
| Toolchain          | Node 22.18.0 / Linux x64 / glibc; pinned image digest and toolchain attestation recorded                                                                       |
| Determinism        | Two complete passes; all 58 recorded stage transitions succeeded; manifest comparison passed                                                                   |
| Output             | App: 5 files / 34,239 B. Dependency layer: 2,152 files / 55,261,854 B. Output SHA-256 `ee89ee6e2da2736492b4217dc4e11faca58ce3b7622dd14dbb60a2be392db977`       |
| Pantry-only build  | `coldBuild=true`; 196 Pantry object reads; **0 direct upstream requests from the build cell**                                                                  |
| Memory             | Maximum recorded collection buffer 32,171,907 B, leaving wide headroom below the 128 MiB Worker limit                                                          |
| Scanning           | Secret, malware, and license checks passed; dependency vulnerability result was a recorded warning; provenance was mixed/public-registry; reproducible offline |
| Secrets            | Runtime evidence records `secretMaterial: none`; untyped error count 0                                                                                         |

The build output contains the sealed-native vendored SDK under `nabuflow/runtime/`; database and payments access route through the doorman capability surfaces. It contains no database URL or provider secret expectation.

## Phase B matrix

| Area                         | Live result                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real generation              | PASS — actual Zero project/task path produced the accepted source and build identity                                                                                                            |
| Cold Pantry stock/build      | PASS — immutable dated shelf, exact lock, SBOM, toolchain attestation, dependency closure, and dependency-complete output recorded                                                              |
| Warm/immutable-shelf posture | PASS — canonical shelf/closure regression matrix remained green; cleanup discovered both retained test shelf roots by authoritative inventory and retired them without probing payload channels |
| Pantry trust boundary        | PASS — build used 196 Pantry reads and zero direct upstream requests; tenant egress remained disabled                                                                                           |
| Deterministic build          | PASS — two passes, canonical manifest equality, content-addressed app/layer output                                                                                                              |
| Artifact v1 compatibility    | PASS — existing v1 rows remained valid; layered extension remained additive                                                                                                                     |
| Binary materialization       | PASS — 4,097-byte binary round trip, exact SHA-256 verified                                                                                                                                     |
| Duplicate upload             | PASS — begin/chunk/commit replayed idempotently; one logical artifact                                                                                                                           |
| Uncommitted start            | PASS — typed `409 artifact_not_committed`                                                                                                                                                       |
| Tamper/rehydration           | PASS — release tampered, restart restored from private R2, `server.cjs` and binary hashes independently verified                                                                                |
| Manifest CAS                 | PASS — stale revision conflict, immutable-field rejection, running-update rejection, successful explicit update/restart                                                                         |
| Manifest failure repetition  | PASS — 10/10 typed `502 runtime_restart_failed`; each recovered before the next iteration; no `unexpected_worker_error`                                                                         |
| Database auth/isolation      | PASS — unsigned/tampered/expired/replay and existing-vs-missing foreign-project matrices returned typed, non-enumerating outcomes                                                               |
| Database function            | PASS — table create, insert, parameterized select, update, delete, atomic batch commit                                                                                                          |
| Atomic rollback              | PASS — conflict typed `409`; post-failure select returned zero rows                                                                                                                             |
| Database sanitization        | PASS — malformed operation returned typed sanitized `400`                                                                                                                                       |
| Stripe auth/isolation        | PASS — unsigned/tampered/expired/replay, foreign existing/missing, and revision ambiguity matrices                                                                                              |
| Stripe function              | PASS — test-mode create, retrieve, and same-object idempotent replay; provider object count remained one                                                                                        |
| Stripe policy                | PASS — idempotency conflict `409`; amount and currency policy rejections `403`; `livemode=false`                                                                                                |
| Preview auth                 | PASS — fresh grant `302`; replay `409 preview_grant_replayed`; missing/tampered/expired/wrong-key cases typed                                                                                   |
| Published routing            | PASS — anonymous GET/POST/PUT/DELETE, 2,818,048-byte stream, SSE timing, and WebSocket echo `101`                                                                                               |
| Header/response hygiene      | PASS — routing and cookie assertions passed; unknown/unregistered routes returned immediate typed `404`                                                                                         |
| Direct egress denial         | PASS — direct database and Stripe host attempts both returned blocked `520`, with no connection                                                                                                 |
| Runtime cleanup              | PASS — runtime destroy followed by typed `404 runtime_not_found`                                                                                                                                |
| Provider cleanup             | PASS — all four opaque leases destroyed and independently verified gone at $0                                                                                                                   |
| Storage cleanup              | PASS — runtime/build/Pantry R2 authoritative List Objects all 0/0                                                                                                                               |

### Four-surface sustained-green gate

The final run generated and atomically installed a fresh staging Worker control-secret set, then gated every independently consumed surface. All four completed within 32.292 seconds and 120 total requests, below the five-minute / 600-probe bound.

| Surface                      | Required result    | Consecutive green |  First green |    Completion |
| ---------------------------- | ------------------ | ----------------: | -----------: | ------------: |
| Control HMAC `/version`      | 200                |                20 |   532.842 ms | 31,804.989 ms |
| Preview grant redeem         | 302                |                20 |   602.721 ms | 31,869.178 ms |
| Preview redeem + replay pair | 302 then typed 409 |          20 pairs | 1,631.154 ms | 32,291.658 ms |
| Vault KEK envelope/revoke    | 200                |                20 | 1,310.597 ms | 32,129.299 ms |

### Provider lease proof

| Provider    |   Project | Opaque lease                                   | Final proof                             |  Cost |
| ----------- | --------: | ---------------------------------------------- | --------------------------------------- | ----: |
| Neon        | 811821929 | `nal_da85aa3f27e8e5a3ed3d8f1d5ecf8f1457aa684d` | destroyed; resources/configuration gone | USD 0 |
| Neon        | 811821930 | `nal_e5b1ffe60a8d7b736841ff778420804dedd2857e` | destroyed; resources/configuration gone | USD 0 |
| Stripe test | 811821929 | `nal_891c8438fa74355b8ab8c94741e5e6b1a86872a4` | destroyed; resources/configuration gone | USD 0 |
| Stripe test | 811821930 | `nal_88d8cda51979b7987cb11e46dfc3df6a3b8ae550` | destroyed; resources/configuration gone | USD 0 |

Only opaque lease and provider test-object identifiers entered evidence. No management key, connection string, hostname, or key fragment left Acceptance Vault custody.

## Temporary Provisioner surface and closure

The founder authorized one temporary auth-gated workers.dev route for the staging Acceptance Provisioner. The passing window used version `bf7f160a-4f1c-4aa1-91d3-6532724bda01`, created at `2026-08-14T03:59:48.581Z`. Workload identity remained mandatory; the route did not expose a credential-bearing response.

The finally deployed inert/closed version is `fc9aa8f3-cdba-47fb-9439-af93027e5109`, created at `2026-08-14T04:15:21.783Z`, with the deployment message `slice10-manual-final-close-proof-surface`. A fresh read-only probe at `2026-08-14T08:06:41Z` returned HTTP 404. The generated open-route config was deleted; the committed acceptance config remains `workers_dev=false`, `preview_urls=false`, with no route and gate disabled by default.

## Authoritative cleanup

The final cleanup did not trust dashboard metrics. It used Worker diagnostics plus Cloudflare REST List Objects.

| Resource                     |                      Before targeted final cleanup | Action                                                                                                                           |         Final authority |
| ---------------------------- | -------------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------: |
| Project 12 runtime artifacts |                          55 objects / 55,330,066 B | Deleted the captured Project 12 keys individually; scope validator rejected any key outside the two captured Project 12 prefixes |         0 objects / 0 B |
| Trusted-build staging R2     |        112 objects / 111,381,219 B before build GC | Signed GC of the three Project 12 build IDs; zero-cleanup harness confirmed ledger/cells empty                                   |         0 objects / 0 B |
| Pantry staging R2            | 308 objects / 11,328,524 B before shelf retirement | Authoritative inventory discovered both shelf roots; signed retirement/GC; refs/quarantine checked                               |         0 objects / 0 B |
| Runtime                      |            Project 12 runtime existed during proof | Destroy                                                                                                                          | `404 runtime_not_found` |
| Neon / Stripe                |                                        Four leases | Destroy + typed verify-gone                                                                                                      |         all gone, USD 0 |

The targeted runtime-artifact deletion evidence records all 55 exact keys, sizes, ETags, and deletion responses. The final List Objects evidence records all three buckets at 0/0. Session-generated control values were erased at harness exit.

## Corrections made on this branch

The real path exposed orchestration and evidence defects that deterministic earlier slices could not reach. Corrections were kept within the shipped contracts:

1. Product generation/build continuation now keeps the project job lock and sealed source repair inside the agent lifecycle, publishes a complete runtime descriptor, preserves the full runtime identity, and uses the contract's operation bounds without an initialization-cycle `NaN`.
2. Cloudflare provider retries retain stable idempotency identities and follow coordinator-owned operations rather than treating retryable pending results as terminal.
3. Staging acceptance follows durable artifact/lifecycle operations, requires a post-dispatch lease timestamp before accepting `provisioned`, and persists terminal evidence before cleanup.
4. The zero-cleanup harness discovers all shelf roots by side-effect-free authoritative inventory before retiring them.
5. The API production bundle now carries eligibility assets so the live service classifies generated output from the same machine-readable authority used in source.

### Shipped-path file inventory

| File                                                                       | Rationale                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `artifacts/api-server/build.mjs`                                           | Copy blueprint/skill eligibility authorities into the production bundle                          |
| `artifacts/api-server/src/lib/agent-loop.ts`                               | Keep sealed repair/finalization inside the live agent lifecycle                                  |
| `artifacts/api-server/src/lib/builder.ts`                                  | Carry sealed-native generation/build state through the product path                              |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.ts`              | Follow durable operations with stable idempotency and evidence-rich bounds                       |
| `artifacts/api-server/src/lib/jobs.ts`                                     | Correct project-job lock lifetime and terminal release                                           |
| `artifacts/api-server/src/lib/nabuflow-billing.ts`                         | Keep staging acceptance billing decisions typed and testable                                     |
| `artifacts/api-server/src/lib/provisioning.ts`                             | Align sealed runtime provisioning with port 8080 and descriptor handoff                          |
| `artifacts/api-server/src/lib/stuck-run-scheduler.ts`                      | Prevent the scheduler from racing an active sealed generation                                    |
| `artifacts/api-server/src/lib/tenant-runtime-provider.ts`                  | Preserve full sealed runtime identity/manifest across provider retries                           |
| `artifacts/api-server/src/lib/zero-capability-eligibility.ts`              | Resolve packaged eligibility authority in the production bundle                                  |
| `artifacts/api-server/src/lib/zero-runtime-sdk.ts`                         | Remove sealed SDK export collision and preserve vendored imports                                 |
| `artifacts/api-server/src/lib/zero-sealed-finalize-check.ts`               | Add typed finalization readiness for the real generated tree                                     |
| `artifacts/api-server/src/lib/zero-sealed-generation.ts`                   | Continue repair/build/delivery using the authoritative descriptor                                |
| `artifacts/api-server/src/routes/projects.ts`                              | Wire the real project/task route to sealed generation continuation                               |
| `artifacts/nabuflow-runtime-worker/src/capability-vault-durable-object.ts` | Support the accepted staging capability lifecycle and sanitized evidence                         |
| `artifacts/nabuflow-runtime-worker/src/model.ts`                           | Carry the accepted typed staging state                                                           |
| `artifacts/nabuflow-runtime-worker/src/stripe-broker.ts`                   | Exercise additive test-only restricted-key capability without changing live rejection            |
| `artifacts/nabuflow-runtime-worker/src/worker.ts`                          | Staging acceptance/readiness/control wiring; production remains inert                            |
| `lib/tenant-runtime-contracts/src/control-schemas.ts`                      | Make the 5-minute artifact control bound self-contained and eliminate initialization-order `NaN` |
| `lib/mustaflow-cli/tsconfig.json`                                          | Use Node16 module resolution required by the sealed SDK build path                               |
| `artifacts/nabuflow-runtime-worker/wrangler.acceptance.jsonc`              | Add version metadata binding; still closed and inert by default                                  |

### Harness and regression files

| File                                                                         | Coverage                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `artifacts/nabuflow-runtime-worker/scripts/slice10-cloudflare-acceptance.ts` | Unique evidence, route lifecycle, real build capture, gateway matrix, cleanup |
| `artifacts/nabuflow-runtime-worker/scripts/published-staging-smoke.ts`       | Durable following, fresh lease-state proof, full Phase B rows                 |
| `artifacts/nabuflow-runtime-worker/scripts/trusted-build-staging-smoke.ts`   | Authoritative shelf discovery and zero cleanup                                |
| `artifacts/api-server/src/lib/__tests__/nabuflow-billing.test.ts`            | Billing acceptance posture                                                    |
| `artifacts/api-server/src/lib/cloudflare-runtime-provider.test.ts`           | Operation following and bounds                                                |
| `artifacts/api-server/src/lib/jobs.stop-button.http.test.ts`                 | HTTP cancellation/lock behavior                                               |
| `artifacts/api-server/src/lib/jobs.stop-button.test.ts`                      | Job cancellation/lock behavior                                                |
| `artifacts/api-server/src/lib/project-job-lock-posture.test.ts`              | No premature lock release                                                     |
| `artifacts/api-server/src/lib/stuck-run-scheduler.test.ts`                   | Scheduler cannot steal active work                                            |
| `artifacts/api-server/src/lib/tenant-runtime-provider.test.ts`               | Descriptor/identity retry preservation                                        |
| `artifacts/api-server/src/lib/zero-capability-eligibility.test.ts`           | Packaged authority lookup                                                     |
| `artifacts/api-server/src/lib/zero-generation-job-wiring.test.ts`            | Real job continuation wiring                                                  |
| `artifacts/api-server/src/lib/zero-generation-kitchen-wait.test.ts`          | Kitchen/follower bound ownership                                              |
| `artifacts/api-server/src/lib/zero-runtime-sdk.test.ts`                      | Vendored SDK exports/import resolution                                        |
| `artifacts/api-server/src/lib/zero-sealed-finalize-check.test.ts`            | Typed finalization checks                                                     |
| `artifacts/api-server/src/lib/zero-sealed-generation.test.ts`                | Source repair, descriptor, and delivery regressions                           |
| `artifacts/nabuflow-runtime-worker/test/acceptance-wrangler-config.test.ts`  | Inert/closed acceptance config posture                                        |
| `artifacts/nabuflow-runtime-worker/test/capability-vault.test.ts`            | Vault acceptance lifecycle                                                    |
| `artifacts/nabuflow-runtime-worker/test/slice10-acceptance-launcher.test.ts` | Launcher evidence and cleanup rules                                           |
| `artifacts/nabuflow-runtime-worker/test/stripe-broker.test.ts`               | Test-only restricted-key and live-prefix rejection                            |
| `lib/tenant-runtime-contracts/test/artifact-commit.test.ts`                  | Finite named operation-bound regression                                       |

## Validation

| Gate                                           | Result                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Runtime Worker unit suite                      | 30 files / **226 tests passed**                            |
| Focused harness lint                           | PASS                                                       |
| Runtime Worker typecheck                       | PASS                                                       |
| Clean branch release profile                   | **18 pass / 0 warn / 3 fail**                              |
| Clean exact-base release profile at `80170e93` | **18 pass / 0 warn / 3 fail — exact row/assertion parity** |

Both release profiles fail only these environment-dependent rows because this Windows lab has no PostgreSQL listener at `127.0.0.1:5432`:

1. `api-release-extended`: the same two `ora-realtime-usage` assertions.
2. `api-account-billing-history`: the same two memory-consolidation assertions.
3. `web-build`: bundle and size check pass, then dynamic prerender receives the same `ECONNREFUSED`.

Every non-database row passes in both profiles. Replit's PostgreSQL-backed merge gate remains the authoritative ship gate.

## Manifest and production declaration

- No `package.json` or `pnpm-lock.yaml` changed; no dependency version changed. Therefore the manifest-triggered pristine frozen-install ritual was not invoked.
- `wrangler.acceptance.jsonc` changed only to bind deployment version metadata. It remains staging-only, `workers_dev=false`, `preview_urls=false`, route-less, and gate-disabled by default.
- Artifact v1 and dependency-layer wire formats are unchanged.
- Fly provider/configuration is untouched and no Fly API call occurred.
- Live production provider selection and behavior remain unchanged; Replit retains merge/publish authority.

## Evidence ledger

| Evidence                                            | SHA-256                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Final 1,103-check gateway envelope                  | `6b79fa1c2323fa68f286d4dc6fb22b1d19781b13dc1ed1420c10fa3c2a8a6d83` |
| Gateway evidence payload                            | `be9e46e13e7e62e11e870bf60276db5108c4cdcefd4b2eaf7359e11202703738` |
| Project 12 / Task 32 authoritative runtime evidence | `733dfed31a3d8b84a14565a729ecb8854adbe9ad15767cb3f6344032f7888db3` |
| Final 122-check build/Pantry cleanup evidence       | `8b7fab1c9fae1f7d845f8c849449d4698b5132537b61b438cfe6c56dd48751aa` |
| Exact-key Project 12 R2 deletion evidence           | `d504a31145df2994f429ebffafc09170bc9011c369de549ed5f045b215668b07` |
| Final three-bucket List Objects evidence            | `f2484960d780dadcc06a8e92d6cab4cb3f9642e9f925c3e73efe8b4f7d717ae2` |
| Branch release profile log                          | `3a3dc404afd1a6edb88379c734ce5ac415bc6e473d3118b4d47dcc1abdbab47c` |
| Exact-base release profile log                      | `3c29ce5d17dc30aeab24709bc48cb244a4ff96b244ad1167ccbb93b9e816d38c` |
| Runtime Worker unit log                             | `3de4564f1267b44c902dbbb66de3c92011d2b873f5f1dcabfed3ef95ab985c2c` |

No evidence or report contains a credential value. Findings retain identifiers, typed codes, counts, timings, and fingerprints only.

## Replit configuration containment note

The `ENCRYPTION_KEY` entry observed during Slice 10 belonged to the **staging Zero service**, not the main product app. Its existing value was moved unchanged from the visible Configurations pane into Replit Secrets, the visible entry was removed, local/browser capture traces were scrubbed, and the key was deliberately not rotated pending the separate dual-key migration plan.
