# Gateway Doorman slice 2b-ix-a — artifact delivery loading dock

Status: **staging acceptance passed; branch approved for branch-only push**

- Branch: `codex/gateway-artifact-delivery`
- Audited base: `ca8cb9723d8e4732005c0122df471cd18e86a72c`
- Staging Worker: `nabuflow-runtime-staging`
- Accepted Worker version: `04a9af35-7d03-4c6d-a029-b35bdd2f7a4c`
- Accepted scratch: `nrf-e919a75364398a44-p821030572-production-blue`
- Accepted tenant port after manifest transition: `8080`
- Final transcript: 436 checks
- Final evidence SHA-256: `c43d65a116a0e96be9ff896415a820baa6d7e192516bb2e66878859e14728300`

This slice was confined to the Cloudflare staging Worker, scratch runtimes, a private staging R2 bucket, one disposable Neon project, and the dedicated **NabuFlow Testing** Stripe sandbox. It did not touch production traffic, production configuration or secrets, production DNS, Fly, project 27, the existing 41 Fly machines, or any other Stripe account/sandbox or Neon project. `TENANT_RUNTIME_PROVIDER` remains unset in production, preserving the existing Fly default.

No `package.json` or `pnpm-lock.yaml` changed. The frozen-lockfile proof rule is therefore not triggered. `FlyRuntimeProvider` is byte-identical to the audited base.

## Design note and delivered architecture

### Artifact format

Artifact v1 is an uncompressed, deterministic byte package:

- format discriminator: `nabu-artifact/v1`;
- files sorted by UTF-8 path bytes with unique normalized paths;
- each file records path, `0644`/`0755` mode, contiguous payload offset, byte size, and SHA-256;
- the content manifest records exact payload bytes, 1 MiB chunk size, ordered chunk hashes, and file records;
- `contentSha256` hashes canonical JSON for the exact content manifest;
- `sealedArtifactSha256` hashes the envelope containing the content hash, full target `nrf-` identity, manifest revision, artifact revision, source revision, and zero-secret scan attestation;
- text and binary inputs both become exact `Uint8Array` bytes; no UTF-8 reinterpretation occurs on the receiving side.

Staging limits are 64 MiB total payload, 16 MiB per file, 5,000 files, 2 MiB begin envelope, 1,000 UTF-8 bytes per path, and 1 MiB per raw chunk request. Oversized inputs fail before upload when sealed by the API and again at the Worker boundary. Dependency acquisition is intentionally deferred to 2b-ix-b; this slice used a dependency-free Node artifact and did not widen tenant egress.

### Transfer path and storage

The existing HMAC control plane now exposes:

```text
POST   /_nabuflow/control/v1/runtimes/:project/:role/:slot/artifacts/:sealedSha/begin
PUT    /_nabuflow/control/v1/runtimes/:project/:role/:slot/artifacts/:sealedSha/chunks/:index
POST   /_nabuflow/control/v1/runtimes/:project/:role/:slot/artifacts/:sealedSha/commit
DELETE /_nabuflow/control/v1/runtimes/:project/:role/:slot/artifacts/:sealedSha
PUT    /_nabuflow/control/v1/runtimes/:project/:role/:slot/manifest
```

Every operation retains HMAC authentication, request-body hashing, timestamp validation, nonce replay protection, idempotency, deployment-version pinning, strict request schemas, typed errors, and metadata-only audits. Raw chunk endpoints receive bytes directly and apply endpoint-specific body caps; the global control parser was not loosened.

The private staging bucket `nabuflow-runtime-artifacts-staging` is available only through the Worker R2 binding `NABUFLOW_RUNTIME_ARTIFACTS`. There are no API-server R2 credentials, tenant credentials, public URLs, or presigned URLs. `ControlDurableObject` stores metadata and received-chunk state only. Pending uploads expire after ten minutes through the DO alarm, which deletes their R2 objects and metadata.

Committed artifacts materialize at:

```text
/workspace/.nabuflow/releases/<sealed-artifact-sha>/app
```

The Worker reconstructs each file from ranged R2 chunk reads, verifies each file SHA-256 before writing it, applies executable mode only after verification, then writes a seal marker. `start` fails closed unless the exact artifact is committed, identity-bound, revision-bound, and deployment-version compatible. Every start rematerializes from R2 before launching, which closes the previous trust gap where pre-existing workspace files could run without provenance.

### Security model

- The seal and receiver both reject absolute paths, drive paths, backslashes, NUL/control bytes, non-NFC paths, empty/`.`/`..` segments, and `.nabuflow` as a tenant-controlled root.
- The envelope binds artifact bytes to the exact full runtime identity and manifest revision.
- An artifact addressed to a foreign existing runtime and one addressed to a nonexistent runtime return the same `403 artifact_runtime_mismatch` body.
- The API sealer refuses credential-shaped content before it creates an envelope or begins an upload.
- The tenant cannot call R2, the DO, or artifact control endpoints and still runs with `enableInternet=false`.
- App delivery uses only the sealed loading dock. Harness `exec` is retained solely to destructively simulate eviction/tampering while a scratch is running; it never injects app files.

### Manifest update and restart semantics

The manifest operation uses revision CAS and deployment-version pinning. It permits a new revision, runtime label, build command, start command, service port, and health path. `resourceProfile` and `public` are immutable after provisioning. A running runtime defaults to `409 runtime_busy`; an explicit restart additionally requires a committed artifact sealed for the new manifest revision.

Explicit restart performs: unbind caller capability authority → persist the new manifest/release in `starting` state → materialize and verify the sealed release → start and health-check the declared port/path → persist `running` → rebind. A failure persists the new revision in `error`, leaves the runtime unbound, and returns typed `502 runtime_restart_failed`; there is no silent rollback.

### Provider seam

The provider capability check adds Cloudflare-only `deployArtifact` and `updateRuntimeManifest`. Cloudflare `syncFiles` and `restoreFiles` seal and deploy through the dock; `writeFile` remains explicitly unavailable. The adapter fails closed if control URL/token/namespace, `artifact-v1` version advertisement, deployment version, R2 binding, or a committed artifact is missing. The Fly implementation and unset-provider selection path are untouched.

## Atomic rotation and four-surface readiness gate

The final run generated Base64URL-without-padding control and vault secrets, self-checked their format, and applied the complete staging set with one atomic `wrangler secret bulk`. The measured Worker/lab clock offset was `-11,811,760 ms` and was applied to all provider-time predicates.

The atomic set has five entries but four independently consumed surfaces: the legacy `CLOUFLOW_RUNTIME_CONTROL_TOKEN` alias carries the same control value and has no independent Worker binding.

| Surface                                |              Expected terminal signal |  First green | 20th consecutive green |   Probes | Result |
| -------------------------------------- | ------------------------------------: | -----------: | ---------------------: | -------: | ------ |
| Control HMAC `/version`                |                                   200 | 70,284.86 ms |          102,439.46 ms |       72 | passed |
| Fresh ES256 preview redemption         |                                   302 | 70,498.16 ms |          102,502.98 ms |       72 | passed |
| Fresh preview redeem + replay pair     | 302 then 409 `preview_grant_replayed` | 71,521.45 ms |          103,023.08 ms | 72 pairs | passed |
| Vault KEK encrypt + strict-body revoke |                                   200 | 71,273.36 ms |          102,774.34 ms |       72 | passed |

The gate completed in 103,023.11 ms with 432 raw requests, below both the five-minute and 600-request bounds. Acceptance began only after every surface had 20 consecutive greens. Expected-auth-success operations retained bounded backoff; typed operation-level errors remained terminal.

## Complete acceptance check table

The 436-entry transcript includes the 432 raw gate requests, the gate enumeration/final summary, and the semantic checks below. Repeated pre-convergence reset entries are represented by the per-surface table above rather than copied hundreds of times.

### Control, version, clock, and preview regression

| Check                                  | HTTP/result | Code/evidence                                           |
| -------------------------------------- | ----------: | ------------------------------------------------------- |
| Unsigned control version               |         401 | `unauthorized`                                          |
| Offset measured from Worker `Date`     |         200 | `-11,811,760 ms`                                        |
| Provider predicate uses corrected time |         200 | passed                                                  |
| Valid signed version                   |         200 | Worker version pinned                                   |
| Artifact feature advertisement         |         200 | `artifact-v1` present                                   |
| Preview missing grant/session          |         401 | `preview_auth_required`                                 |
| Preview tampered grant                 |         401 | `invalid_preview_grant`                                 |
| Preview expired grant                  |         401 | `preview_grant_expired`                                 |
| Preview wrong-key grant                |         401 | `invalid_preview_grant`                                 |
| Preview valid one-use grant            |         302 | secure session minted                                   |
| Preview replay                         |         409 | `preview_grant_replayed`                                |
| Valid session before runtime exists    |         503 | `preview_runtime_unavailable`; authentication succeeded |

### Artifact seal, transfer, integrity, isolation, and idempotency

| Check                                         | HTTP/result | Code/evidence                                   |
| --------------------------------------------- | ----------: | ----------------------------------------------- |
| Ensure initial react-vite manifest, port 8081 |         200 | stopped runtime created                         |
| Planted fake credential at seal               |     refused | `artifact_secret_detected`; no envelope/upload  |
| Oversized file at seal                        |     refused | `artifact_too_large`; no envelope/upload        |
| Traversal path at seal                        |     refused | `artifact_invalid_path`; no envelope/upload     |
| Integrity probe begin                         |         200 | pending upload created                          |
| Mutate body after signing                     |         401 | `invalid_signature`                             |
| Correctly signed but wrong chunk bytes        |         422 | `artifact_integrity_mismatch`                   |
| Remove failed integrity probe                 |         200 | objects/metadata removed                        |
| Tampered sealed envelope                      |         422 | `artifact_integrity_mismatch`                   |
| Receiver-side traversal                       |         400 | `invalid_request`                               |
| Receiver-side oversized envelope              |         413 | `artifact_too_large`                            |
| Foreign existing runtime                      |         403 | `artifact_runtime_mismatch`                     |
| Nonexistent foreign runtime                   |         403 | byte-identical anti-enumeration response        |
| Incomplete upload begin/chunk                 |     200/200 | first of two chunks accepted                    |
| Commit incomplete chunk set                   |         409 | `artifact_incomplete`; pending objects cleaned  |
| Re-begin after cleanup                        |         200 | clean pending state                             |
| Empty commit after re-begin                   |         409 | `artifact_incomplete`; cleaned again            |
| Duplicate begin initial/retry                 |     200/200 | cached body identical                           |
| Duplicate chunk initial/retry                 |     200/200 | cached body identical                           |
| Duplicate commit initial/retry                |     200/200 | cached body identical                           |
| Duplicate upload summary                      |         200 | one logical artifact; begin/chunk/commit cached |
| Remove duplicate probe                        |         200 | removed                                         |
| Start with uncommitted SHA-256                |         409 | `artifact_not_committed`                        |
| Deliver and start sealed react-vite release   |         200 | running on 8081                                 |

### Manifest transition, binary fidelity, rehydration, and tamper repair

| Check                                                | HTTP/result | Evidence                                                                 |
| ---------------------------------------------------- | ----------: | ------------------------------------------------------------------------ |
| Stale expected manifest revision                     |         409 | `manifest_revision_conflict`                                             |
| Immutable resource profile change                    |         400 | `manifest_immutable_field`                                               |
| Running update without explicit restart              |         409 | `runtime_busy`                                                           |
| Explicit react-vite → node-api restart               |         200 | running on port 8080, `/health` healthy                                  |
| Binary read from materialized release                |         200 | 4,097 bytes                                                              |
| Binary SHA-256                                       |         200 | `6dea11fd585c26a1d50de04c9fc6c9b3f6918df71bcd53eda777069cd5512243` exact |
| Destructively evict release while running            |         200 | harness simulation only; no delivery bypass                              |
| Stop after eviction                                  |         200 | stopped                                                                  |
| Start after eviction                                 |         200 | release rehydrated from private R2                                       |
| Rehydrated server hash                               |         200 | exact sealed hash                                                        |
| Rehydration summary                                  |         200 | per-file verification before serving                                     |
| Tamper `server.cjs` and binary fixture while running |         200 | both files changed locally                                               |
| Stop after tamper                                    |         200 | stopped                                                                  |
| Start after tamper                                   |         200 | R2 rematerialization succeeded                                           |
| Hash both restored files                             |         200 | both exact                                                               |
| Tamper-repair summary                                |         200 | `server.cjs` and binary fixture independently verified                   |

### Manifest failure repetition and typed boundary

Each iteration installed a committed artifact whose declared health path could not become healthy, persisted the failed manifest revision in `error`, returned the typed failure, then used the current revision to recover to a healthy committed release.

| Iteration | Failure                      | Persisted state      | Recovery          |
| --------: | ---------------------------- | -------------------- | ----------------- |
|         1 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         2 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         3 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         4 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         5 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         6 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         7 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         8 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|         9 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |
|        10 | 502 `runtime_restart_failed` | `error`, no rollback | stopped → running |

Result: 10/10 typed 502 responses, zero `unexpected_worker_error` escapes, zero silent rollbacks.

### Echo capability and tenant-isolation regression

| Check                                         |   HTTP/result | Code/evidence                                              |
| --------------------------------------------- | ------------: | ---------------------------------------------------------- |
| Active container binding                      |           200 | exact `nrf-` runtime bound                                 |
| Provision caller/foreign echo records         |       200/200 | separate project vaults                                    |
| Container echo intent                         |           200 | doorman acted                                              |
| Cross-project existing/missing from container | 200 transport | signed handler reached                                     |
| Foreign existing/missing capability           |       403/403 | identical `capability_tenant_mismatch`                     |
| Unsigned/tampered/expired signed endpoint     |   401/401/401 | `unauthorized` / `invalid_signature` / `expired_signature` |
| Valid signed endpoint                         |           200 | echo result                                                |
| Signed replay                                 |           409 | `replay_detected`                                          |
| Missing binding                               |           403 | `capability_runtime_unbound`                               |
| WebSocket attempt                             |           426 | `capability_upgrade_not_supported`                         |
| Direct vault reachability from tenant         |           520 | origin disallowed                                          |

### Database broker regression

| Check                                   | HTTP/result | Code/evidence                                  |
| --------------------------------------- | ----------: | ---------------------------------------------- |
| Provision caller/foreign DB records     |     200/200 | vault-only credential custody                  |
| Foreign existing/missing DB capability  |     403/403 | identical `capability_tenant_mismatch`         |
| Unsigned/tampered/expired DB invocation | 401/401/401 | expected auth codes                            |
| Valid/replayed DB invocation            |     200/409 | success / `replay_detected`                    |
| Create table                            |         200 | succeeded                                      |
| Insert/select/update/delete             |    200 each | parameterized round trips verified             |
| Atomic batch commit                     |         200 | both writes visible                            |
| Failing atomic batch                    |         409 | `database_conflict`                            |
| Rollback verification                   |         200 | zero rolled-back rows                          |
| Sanitized induced error                 |         400 | `database_invalid_query`; no provider material |
| Direct Neon host from tenant            |         520 | blocked                                        |

### Stripe broker regression

| Check                                       | HTTP/result | Code/evidence                                     |
| ------------------------------------------- | ----------: | ------------------------------------------------- |
| Provision caller/foreign Stripe records     |     200/200 | `sk_test_` only, vault-only custody               |
| Foreign existing/missing Stripe capability  |     403/403 | identical `capability_tenant_mismatch`            |
| Unsigned/tampered/expired Stripe invocation | 401/401/401 | expected auth codes                               |
| Valid/replayed Stripe invocation            |     200/409 | success / `replay_detected`                       |
| Create PaymentIntent                        |         200 | `livemode:false`, `confirm:false`                 |
| Retrieve PaymentIntent                      |         200 | same owned object                                 |
| Same business idempotency key retry         |         200 | same object, `idempotentReplay:true`              |
| Provider object count after retry           |         200 | exactly 1                                         |
| Same key, changed payload                   |         409 | `stripe_idempotency_conflict`; still 1 object     |
| Over-max amount                             |         403 | `capability_policy_rejected`; 0 objects           |
| Disallowed currency                         |         403 | `capability_policy_rejected`; 0 objects           |
| Sanitized invalid request                   |         400 | `stripe_invalid_request`; no provider identifiers |
| Credential-revision ambiguity               |         409 | fails closed; no extra object                     |
| Direct `api.stripe.com` from tenant         |         520 | blocked                                           |
| Test objects cleanup                        |     200/200 | both PaymentIntents canceled                      |

### Published routing, streaming data plane, and hygiene regression

| Check                                |  HTTP/result | Evidence                                                                      |
| ------------------------------------ | -----------: | ----------------------------------------------------------------------------- |
| Activate unsigned/tampered/expired   |     401 each | expected auth errors                                                          |
| Activate production-green            |          400 | `production_blue_required`                                                    |
| Activate valid/replay                |      200/409 | route stored / `replay_detected`                                              |
| Unknown host                         |          404 | `published_route_not_found`                                                   |
| Anonymous GET/POST/PUT/DELETE        |     200 each | non-GET methods preserved                                                     |
| Large streamed POST                  |          200 | 2,818,048 bytes; SHA-256 exact                                                |
| SSE                                  |          200 | first event 61.05 ms; second 1,561.43 ms, unbuffered                          |
| WebSocket echo                       |          101 | `anonymous-published-websocket` → `echo:anonymous-published-websocket`        |
| Request header/cookie hygiene        |          200 | platform/control and injected forwarding stripped; trusted forwarding rebuilt |
| Response cookie hygiene              |          200 | `.mustaflow.com` tenant cookie suppressed                                     |
| Container credential scan            |          200 | `none`                                                                        |
| Deactivate unsigned/tampered/expired |     401 each | expected auth errors                                                          |
| Deactivate valid/replay              |      200/409 | removed / `replay_detected`                                                   |
| Immediate request after unregister   |          404 | invalidation proved                                                           |
| workers.dev self-route unregister    | 200 then 404 | staging root restored to structured 404                                       |

## The intermittent untyped 503

### Root cause

The explicit-restart code correctly constructed `ControlHttpError(502, "runtime_restart_failed", ...)`. The outer control catch then performed two fallible Durable Object finalization RPCs before returning that response: idempotency abandonment/completion and audit recording. A transient rejection from either awaited RPC escaped the catch itself, reached the Worker-level boundary, and replaced the already-classified 502 with generic `503 unexpected_worker_error`. It was timing-dependent because the secondary DO RPC happened after a long health timeout, when DO/RPC lifecycle churn was most likely.

The historical untyped response remained sanitized: it contained only the generic code/message, retryability, and request ID. No stack, hostname, artifact path/content, runtime internals, credential, provider identifier, or exception message leaked.

### Fix

Idempotency finalization and audit recording are now independently guarded. Either may emit only a metadata-only internal `control_error_finalization_failed` event containing request ID, endpoint, operation class, and error type. Neither can alter the primary client response. Audit failure is best-effort observability, never response authority.

The regression test makes both `abandonIdempotency` and `recordAudit` reject after a manifest restart failure and asserts that the client still receives typed 502 `runtime_restart_failed`, while both metadata-only internal events are produced. Live repetition then passed 10/10 with zero untyped escapes.

## Other diagnosed stops and corrections

1. **Initial artifact commit returned 500.** The Sandbox SDK default HTTP file client rejects streamed `writeFile` payloads. Artifact materialization now requests the SDK's RPC transport, which preserves the stream into the Sandbox DO. The same previously failing sealed artifact then committed, materialized, and hash-verified.
2. **Explicit restart initially returned 502.** Fully stopping the Sandbox before immediate filesystem RPC created a shutdown/rematerialization race. Materialization already kills all tenant processes, so the redundant full Sandbox stop was removed. Restart now unbinds, persists, rematerializes, starts, health-checks, and rebinds deterministically.
3. **Retry after a persisted failed manifest hit revision conflict.** This was a harness error: typed operation failures are terminal, and recovery rereads/uses the persisted current revision. The product contract correctly keeps the failed revision and does not silently roll back.
4. **Stale capability expected 403 but saw 400.** The harness attempted a malformed signed request when no container binding existed. The corrected sequence constructs a valid invocation and proves `403 capability_runtime_unbound`; no taxonomy change was needed.
5. **Rehydration attempted `exec` after stop.** Worker refusal was correct. The harness now destructively evicts the release while running, then stops/starts and proves R2 rehydration. This does not reintroduce exec-based delivery.
6. **Windows launcher artifacts.** The lab workspace path contains a space, recursive pnpm errors can mask wrapper failures, and root `tmp/` has CommonJS semantics. Harnesses now launch from the Worker package with relative paths; temporary executable scripts live inside the package boundary and are removed afterward.
7. **Final self-audit found missing live rows.** Binary materialization, upload idempotency, uncommitted-hash start, and tamper-restart were added as explicit live probes. The accepted 436-check run exercised all four.

## PG-1 preview-key overlap design note

Preview grants need explicit key identity before safe rotation overlap is possible:

1. Add a bounded `kid` to the signed protected header and make it part of the signed bytes. The signer must never accept tenant-provided `kid` authority.
2. Replace the single Worker verification key with a versioned active public-key set keyed by exact `kid`. Verification selects one key by `kid`; it must not trial-verify against every key.
3. Rotation order is: atomically publish `new public key + old public key` → wait for the multi-surface gate on the new key → switch the API signer to the new private key/`kid` → retain the old public key for at least maximum grant TTL + accepted clock skew + observed platform propagation margin → stop old issuance → prove the overlap drain → retire the old public key.
4. The Worker changes are key-set parsing, exact `kid` lookup, unknown/retired-key typed rejection, audit of non-secret `kid`, and replay scoping that remains safe across key generations (for example `kid:jti`).
5. The API signer changes are key-ID/private-key pairing, atomic signer selection, issuance cutoff tracking, and a rollback path that never restores a private key after its verifier has been retired.
6. Legacy grants without `kid` need an explicit short migration window or a hard cut coordinated with their maximum TTL; indefinite fallback to a default key would defeat the safety property.

This should be a near-term PG-1 slice. The same multi-surface readiness principle applies: signer readiness, every Worker verification edge, redeem, and replay behavior must all converge before old-key retirement.

## Containment event and permanent credential rule

After the accepted run, a narrowly targeted Stripe test-key copy action exceeded the browser tool timeout. Its locator diagnostic emitted the secret-bearing control's accessible text, exposing the disposable test key in tool output. This was structural browser-tool leakage, not application leakage and not a NabuFlow broker/log/audit failure.

Containment was immediate and complete:

- the exposed key was rotated/expired;
- an independent Stripe API request with that exact key returned 401;
- the clipboard, browser variables, launcher process, and session values were cleared;
- the dedicated NabuFlow Testing sandbox was retained;
- both acceptance PaymentIntents were canceled;
- no production/live Stripe account, key, charge, or object was touched.

Permanent rule adopted: **no secret value may be captured through browser automation, regardless of sandbox disposability**. Browser automation may perform non-reading navigation, deletion, and expiry only. Secret values return to human-only session handoff until a separately approved unattended design exists.

## Cleanup and cost posture

| Cleanup assertion                    | Result                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Published simulated route            | removed; immediate structured 404                                                                    |
| workers.dev self-route               | removed; staging root structured 404                                                                 |
| Scratch stop                         | 200                                                                                                  |
| Capability binding after stop        | inactive; container ID null                                                                          |
| Echo/DB/Stripe invocation after stop | 403 `capability_runtime_unbound`                                                                     |
| Echo vault records                   | revoked for caller and foreign project                                                               |
| DB vault records                     | revoked for caller and foreign project                                                               |
| Stripe vault records                 | revoked for caller and foreign project                                                               |
| Scratch destroy                      | 200                                                                                                  |
| Status after destroy                 | 404 `runtime_not_found`                                                                              |
| Container application health         | `active: 0`, `assigned: 0`, errors empty                                                             |
| Authoritative R2 List Objects        | 0 objects / 0 B                                                                                      |
| Disposable Neon project              | deleted; absent after bounded organization-list retry                                                |
| Used Stripe test key                 | expired; independent API probe 401                                                                   |
| Stripe test objects                  | both PaymentIntents canceled                                                                         |
| Ongoing disposable-resource cost     | zero: no runtime, R2 object, Neon project, usable test key, or uncanceled test PaymentIntent remains |

Cloudflare's `LIVE INSTANCES = 5` list value remains configured capacity/tombstone noise rather than running compute; the authoritative health counters are zero active and zero assigned.

## Verification

| Check                                                | Result                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime Worker unit suite                            | 11 files, 80 tests passed                                                                                                                                                |
| API artifact/provider focused suite                  | 2 files, 17 tests passed                                                                                                                                                 |
| Tenant runtime contracts                             | 9 files, 103 tests passed                                                                                                                                                |
| Worker typecheck and lint after final harness probes | passed                                                                                                                                                                   |
| Repository typecheck                                 | passed                                                                                                                                                                   |
| Repository lint                                      | passed                                                                                                                                                                   |
| Ora fast stability gate                              | passed on a clean tree in 99.6s: 15 passed, 0 warnings, 0 failures                                                                                                       |
| Manifest/lockfile diff                               | none                                                                                                                                                                     |
| Secret-shape scan                                    | three explicit test-marker matches (the planted fake credential fixture and its assertions); no database URL with password, private-key PEM, or real credential material |

## Recommendation

The loading dock is suitable as the artifact-delivery foundation for 2b-ix-b staging work. The fundamental path—content sealing, signed transfer, private R2 custody, exact identity/revision binding, per-file verification, committed-only start, restart rematerialization, and cleanup—is sound. Before production:

1. Close PG-1 with versioned preview verifier sets and measured overlap/retirement evidence.
2. Close PG-2 before any production WebSocket traffic; evaluate a separate registrable apex for published apps so platform cookies cannot share `mustaflow.com` scope.
3. Keep PG-3 and PG-4 hard gates for database and payments policy, quotas, rotation, observability, and dedicated broker isolation.
4. Extend PG-5 with artifact provenance/signing policy, dependency acquisition/SBOM, malware and license scanning, reproducible build metadata, retention/garbage collection, and disaster recovery for committed R2 releases.
5. Define the human-only or purpose-built machine credential handoff for unattended staging before 2b-ix-b; do not use browser DOM/accessibility/clipboard automation for secret values.
6. Evaluate a read-through artifact/route metadata cache only with explicit invalidation. The current authoritative DO/R2 path is correct and should remain the baseline until measurements justify complexity.

No design contradiction requires changing the 2b-i identity contract, the vault isolation wall, the published production-blue invariant, or the default Fly provider behavior.
