# Gateway Doorman slice 2b-ix-b2 - Additive artifact layers

Status: **implementation, local verification, and credential-free Cloudflare staging acceptance passed; branch-only delivery**

- Branch: `codex/gateway-artifact-dependency-layers`
- Audited base: `81c3f978723a98af5c8decac3d5c29e8496d18ad`
- Staging Worker: `nabuflow-runtime-staging.mustafa-alali74.workers.dev`
- Accepted staging deployment version: `43d69d86-849b-4a76-a09b-6494bd03de24` at 100%
- Scratch runtime: `nrf-e919a75364398a44-p980917278-preview-primary`
- Credentials: no third-party credential was requested, captured, or used

## Delivered extension

This slice adds `nabu-artifact-layers/v1` as an optional Cloudflare-only extension to the shipped loading dock. The original `nabu-artifact/v1` schema, routes, object layout, and behavior remain valid and unchanged.

The layered seal binds all of the following into one content-addressed envelope:

- the complete unchanged v1 application envelope;
- a committed dated Pantry revision and immutable revision root;
- the dependency-closure and trusted-build-attestation hashes;
- the exact Node runtime, Node ABI, OS, CPU, libc, and toolchain image digest;
- ordered dependency-layer descriptors and their raw/unpacked hashes;
- target `nrf-...` identity, manifest revision, source revision, and artifact revision;
- a final merged-release hash covering every application and layer path, mode, size, and file hash.

Every envelope and layer is strictly parsed. The receiver independently verifies the application seal, outer seal, layer payload hashes, unpacked manifest hashes, exact platform tuple, overlay collision rules, final merged-release hash, chunk sizes, chunk hashes, and committed Pantry state. This slice deliberately supports `compression: none` only; unknown or future compressed layers fail closed.

## Storage and lifecycle

Application chunks and reusable dependency chunks occupy separate private R2 prefixes:

- `artifacts/layers-v1/<runtime-identity>/<sealed-artifact>/app/chunks/...`
- `dependency-layers/v1/<layer-content-sha>/chunks/...`

The Control Durable Object owns metadata, pending upload TTLs, and durable artifact references. A committed layer is uploaded once and may be referenced by multiple sealed releases. Removing one release drops one reference but retains the shared R2 objects; removing the final reference deletes the layer objects. Pending and incomplete uploads are removed fail-closed.

Materialization writes application files and layers into the same sealed release root, validates every written file hash and mode, and writes the seal marker only after the complete merged release verifies. Start, restart, and rehydration refuse missing, pending, quarantined, wrong-platform, or mismatched artifacts. A stopped runtime rehydrates from private R2 before health checks and binding.

## Provider compatibility

The provider seam gains the optional `LayeredArtifactDeployingTenantRuntimeProvider` capability and `supportsLayeredArtifactDeployment()` guard. `CloudflareRuntimeProvider` requires the `artifact-layers-v1` `/version` advertisement before it uploads anything, validates all bytes locally, skips already-committed shared layers, and fails closed when configuration or infrastructure is missing.

`FlyRuntimeProvider` is byte-identical to base. Provider defaults and production configuration are untouched; production still has `TENANT_RUNTIME_PROVIDER` unset and therefore remains on Fly. No production traffic, DNS, Replit secret, Fly resource, project 27 resource, or production machine was accessed.

## Four-surface post-rotation gate

The Worker source deployment completed first, after which one atomic Wrangler `secret bulk` rotation updated the complete Worker-owned staging set. Values were generated in-process, Base64URL-without-padding checked where applicable, passed write-only over stdin, retained in session memory, and erased at process exit. No browser was involved.

| Independently consumed surface      | Required result                       | Consecutive result |   Probes | First green | Completed |
| ----------------------------------- | ------------------------------------- | -----------------: | -------: | ----------: | --------: |
| Control HMAC signed `/version`      | 200                                   |              20/20 |       64 |      63.71s |    96.59s |
| Fresh ES256 preview grant           | 302                                   |              20/20 |       64 |      63.78s |    96.65s |
| Vault KEK provision + strict revoke | 200                                   |              20/20 |       63 |      62.28s |    95.25s |
| Fresh preview redeem + replay pair  | 302 then 409 `preview_grant_replayed` |              20/20 | 63 pairs |      62.63s |    95.51s |

The gate used 380 HTTP requests and completed in 96.71 seconds, within the permanent five-minute / 600-request bound. The clock offset was freshly derived from the Worker's `Date` header for the run.

## Live staging acceptance

### Compatibility and positive path

| Check                                            | Result                          | Evidence                                                                                |
| ------------------------------------------------ | ------------------------------- | --------------------------------------------------------------------------------------- |
| `/version` feature negotiation                   | 200                             | Both `artifact-v1` and `artifact-layers-v1` advertised                                  |
| Existing v1 delivery                             | 200                             | Sealed v1 application uploaded through the original routes                              |
| Existing v1 start and health                     | 200                             | `healthy-v1` on manifest port 8080 `/healthz`                                           |
| Layered begin / app chunk / layer chunk / commit | 200 throughout                  | Commit materialized the sealed application and layer                                    |
| Layered start                                    | 200                             | Node application imported the delivered dependency layer                                |
| Binary round trip                                | 200                             | 4,097 bytes; SHA-256 `9b011563e298fa7ebf743c14368d51c6bf96cf478d5ea2309274ffc4425289d2` |
| Executable mode                                  | 200                             | Delivered tool verified as mode `0755`                                                  |
| Application response                             | 200                             | Returned `dated-shelf-ingredient` from the layer                                        |
| Duplicate begin/chunk/commit                     | 200, identical cached responses | Idempotency replay did not duplicate storage or behavior                                |
| Second release sharing same layer                | 200                             | Begin returned zero layer hashes to upload                                              |
| Shared layer physical upload count               | 1                               | First release uploaded once; second uploaded zero times                                 |
| Remove first reference                           | 200                             | Second release still started and served correctly                                       |
| Tamper then stop/start                           | 200                             | R2 rehydration restored app and layer; per-file hash verification passed                |
| Final release removal                            | 200                             | Final dependency-layer reference released                                               |

### Fail-closed matrix

| Probe                                                 |        Status | Typed result                                                |
| ----------------------------------------------------- | ------------: | ----------------------------------------------------------- |
| Altered layer chunk bytes                             |           422 | `artifact_integrity_mismatch`                               |
| Valid fully sealed arm64 artifact against x64 staging |           422 | `artifact_layer_platform_mismatch`                          |
| Mutated build-attestation hash                        |           422 | `artifact_integrity_mismatch`                               |
| Mutated manifest binding                              |           422 | `artifact_integrity_mismatch`                               |
| Quarantined Pantry revision                           |           400 | `invalid_request`; no begin accepted                        |
| Application/layer overlay collision                   |           400 | `invalid_request`; no materialization                       |
| Foreign existing runtime target                       |           403 | `artifact_runtime_mismatch`                                 |
| Foreign nonexistent runtime target                    |           403 | Byte-identical body after request-ID removal                |
| Start using uncommitted layered hash                  |           409 | `artifact_not_committed`                                    |
| Commit with incomplete layer chunk set                |           409 | `artifact_incomplete`; pending metadata and objects cleaned |
| Planted fake Stripe-shaped test credential            | Local refusal | `artifact_secret_detected`; no envelope and no upload begun |

Contract tests additionally pin layer-order mutation, altered unpacked manifests, target binding, app-envelope binding, final merged hash, platform/toolchain binding, overlay collisions, and quarantined revision refusal. API tests prove secret scan, binary/mode preservation, and local rejection before transport. Worker tests prove missing platform configuration suppresses the feature and returns a typed 503 from a directly addressed layered endpoint.

## Harness diagnosis and permanent guard

The first acceptance attempt stopped at the v1 compatibility start with a persistent typed `502 runtime_start_failed`. Inspection proved the Worker behaved correctly: the slice harness declared `server.mjs` in the runtime manifest while the shared delivery helper sealed `server.cjs`. No Worker or contract path was implicated.

The helper now requires both the manifest start command and the intended server path, then asserts that the direct Node entrypoint exists in the exact file set before sealing or sending any signed request. Failure is labeled `HARNESS_ENTRYPOINT_MISSING` or `HARNESS_ENTRYPOINT_UNRESOLVED`. A permanent unit test proves an absent entrypoint fails with zero signed requests. All existing staging harness call sites now state their entrypoint explicitly.

One permitted self-correction occurred on the next run: the wrong-platform negative fixture initially combined an arm64 layer with an x64 outer envelope, so the local contract correctly rejected it before staging. The fixture was corrected to seal the complete envelope consistently as arm64. Staging then returned the intended typed `422 artifact_layer_platform_mismatch`. This was wholly acceptance-tooling input construction; no product behavior or contract was changed.

## Cleanup and cost

| Cleanup check                 | Result                   |
| ----------------------------- | ------------------------ |
| Scratch stop                  | 200                      |
| Layered artifacts removed     | 200                      |
| Scratch destroy               | 200                      |
| Post-destroy runtime lookup   | 404 `runtime_not_found`  |
| Readiness vault records       | 0                        |
| R2 bucket readout             | 0 objects / 0 B          |
| Active secret deployment      | One version, 100%        |
| Session-held generated values | Erased at process exit   |
| Third-party resources         | None created or accessed |

No running container or retained object remains, so the acceptance run has no ongoing compute or storage cost.

## Verification evidence

| Gate                             | Result                                           |
| -------------------------------- | ------------------------------------------------ |
| Existing frozen-lockfile install | Passed with repository-pinned pnpm 10.26.1       |
| Tenant runtime contracts         | 11 files / 137 tests passed                      |
| Runtime Worker                   | 13 files / 87 tests passed                       |
| Focused API/provider seams       | 5 files / 31 tests passed                        |
| Runtime Worker typecheck/lint    | Passed / passed                                  |
| Repository-wide typecheck        | Passed                                           |
| Repository-wide lint             | Passed                                           |
| Ora fast stability gate          | 14 pass / 1 expected dirty-tree warning / 0 fail |
| `git diff --check`               | Passed                                           |

The fast gate warning is solely the intentional uncommitted slice. The clean-tree release profile is run after commit. The lab has no local PostgreSQL; if the documented three release rows fail with `ECONNREFUSED 127.0.0.1:5432`, exact parity against base `81c3f978` is the accepted environmental evidence. Any other failure is a stop.

No `package.json` or `pnpm-lock.yaml` changed, so the standing pristine isolated-store frozen-lockfile proof is not triggered. The existing frozen install was used without modifying the dependency graph.

## Recommendations and gate register

1. **Keep PG-5 open.** This slice proves additive storage, delivery, verification, reference retention, and rehydration, but the Pantry stocker, upstream provenance acquisition, immutable shelf publication, trusted build plane, quarantine operations, compressed layer formats, and cross-substrate portability remain later serial slices.
2. **Publish platform tuples from the trusted build plane.** The staging tuple is deliberately exact and fail-closed. The future builder should derive and attest Node ABI, libc, CPU, and toolchain digest rather than relying on handwritten configuration.
3. **Add compression only as a new negotiated capability.** `compression: none` is deterministic and proven. A future compressed format must pin compressed and raw hashes, decompressor limits, and archive traversal behavior without reinterpreting this version.
4. **Operationalize reference reconciliation before scale.** Durable reference updates are transactional and live proof is green, but a later Pantry operations slice should add orphan detection, quarantine-aware garbage collection, and metrics for shared-layer hit rate and retained bytes.
5. **Keep Fly separate.** The eventual Fly dual-run should consume dependency-complete output through its existing path. It must not inherit Cloudflare R2 routes or optional-interface assumptions.

PG-1, PG-2, PG-3, and PG-4 are unchanged by this slice. No key-rotation claim is expanded; the acceptance rotation uses the existing single-key staging mechanism only.

## Addendum - 2026-08-08 clean release-profile base parity

After the complete slice was committed at `5f1e324f42b1d889cbacd92f0428a974bac86a8d`, the clean-tree release profile ran on the branch. It completed with 18 passes, 0 warnings, and 3 failed rows:

| Release row                   | Exact failure set                                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `api-release-extended`        | Two `ora-realtime-usage.test.ts` cases failed with `ECONNREFUSED 127.0.0.1:5432`                                  |
| `api-account-billing-history` | Two `ora-memory-consolidation.test.ts` cases returned 500 instead of 201 because database setup could not connect |
| `web-build`                   | Bundle and size checks passed; dynamic-route prerender then failed with `ECONNREFUSED 127.0.0.1:5432`             |

A fresh detached worktree at the exact audited base `81c3f978723a98af5c8decac3d5c29e8496d18ad` was populated with `pnpm install --frozen-lockfile` using repository-pinned pnpm 10.26.1. The install reused the healthy store, changed no lockfile, and completed after 8m29s on the known slow Windows filesystem. The identical clean release command then produced 18 passes, 0 warnings, and the exact same 3 failed rows, test names, assertion shapes, and `127.0.0.1:5432` refusal.

This is exact base parity. The release-only failures are the documented no-local-PostgreSQL environment baseline, not an artifact-layer regression. No additional branch or base failure occurred; Replit's PostgreSQL-backed full merge gate remains authoritative.
