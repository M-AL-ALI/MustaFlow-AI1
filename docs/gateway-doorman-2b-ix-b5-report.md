# Slice 2b-ix-b5 — trusted build plane

- Date: 2026-08-09
- Branch: `codex/gateway-trusted-build-plane`
- Audited base: `cd4bb53327afac6457a60554676fe70567d1a191`
- Staging only; not merged or published

## Outcome

The trusted build plane is complete on the branch. It resolves exact dependency closures from immutable Pantry shelves, runs secretless two-pass builds in isolated Cloudflare Sandbox cells, proves deterministic output from canonical manifests, scans all non-public bytes, seals dependency-complete output through the shipped artifact dock, and starts the resulting application on the runtime Worker. Tenant containers remain offline and credential-free; Fly and Artifact v1 remain unchanged.

Continuation 16 closes the last liveness gap. Dock commit is now a coordinator-owned, checkpointed job rather than work whose correctness depends on one HTTP request surviving. Live owners retain the existing `409 request_in_progress` response. Once a lease is abandoned, a same-key retry adopts the durable job at its last checkpoint. A job that receives no retry expires through the coordinator alarm into typed `503 artifact_commit_abandoned`; it cannot remain orphaned indefinitely.

The clean staging run recorded 517 successful checks. A 1,910-file, 55,349,725-byte dependency-complete artifact built twice, passed manifest determinism, scanner and sealer checks, committed through the aggregate materializer, started on port 8080, and served `/healthz`. Both required live owner-loss scenarios were recovered without manual intervention. Final runtime, Pantry, build ledger, build-cell, and R2 cleanup was zero.

## Implementation

### Secretless trusted build plane

- Build requests reference immutable Pantry shelf revisions and exact locks. The build path has no direct npm fetch path; misses are fulfilled only by the trusted Pantry ingest machinery.
- Pantry inputs stream into each build pass using bounded buffers. Per-pass resource scopes own Sandbox handles, RPC stubs/results, input transfer resources, and output streams, and dispose them before the next pass.
- Sandbox cell IDs are deterministic, contract-safe names derived from the full build ID, attempt, and pass using a 128-bit truncated cryptographic digest. The full build ID remains in coordinator metadata; only the bounded derived ID reaches Sandbox APIs.
- npm binary links become deterministic regular-file shims. The strict collector continues to reject symlinks and every other non-regular entry.
- Output collection uses a canonical, timestamp-free manifest plus a few content-addressed aggregate payloads. Paths, modes, sizes, offsets, and every per-file SHA-256 are reverified at the trusted boundary.
- Output verification is streaming. Aggregate and per-file hashes, secret scanning with a cross-chunk sliding window, and R2 writes use bounded buffers; payloads are never retained as one Worker allocation.
- The two build passes compare canonical manifests, not retained bytes. A changed byte changes the per-file hash and produces a typed determinism failure.

### Provenance and sealing

The shelf-content hash set is sourced only from the trusted Pantry ledger through a signed, builder-readonly control endpoint. Its response contains shelf identity, sealed catalog root, and the attested content-hash set—no file contents. Unknown shelves return typed 404. The sealer independently hashes every file and exempts only exact matches against that trusted set. A cell-supplied or tampered set is never accepted.

In the heavy run, each pass scanned two app files and five hash-divergent dependency files while exempting 1,903 exact shelf-content matches. The layer sealer independently repeated the classification. No finding occurred. Regressions prove that a modified dependency containing a planted marker is rejected at the sealer, while proven-public sample-key bytes seal successfully.

### Aggregate runtime materialization

The dock preserves Artifact v1 and the dependency-layer wire format. It converts the already-sealed app and layer file sets into canonical aggregate manifests and content-addressed payloads for transport into the runtime cell. The cell unpacks bounded batches and re-hashes each resulting file for transport correctness. The trusted Worker remains authoritative for seal, path, mode, regular-file, aggregate, and per-file verification.

This replaces the former per-file Sandbox RPC toll without relaxing the collector or changing an artifact hash. The final heavy commit completed in 127,166 ms, leaving 172,834 ms (57.6%) against the five-minute request wall. The actual adopted attempt's aggregate materialization stage completed in 30,867 ms.

### Coordinator-resumable commit

Artifact v1 and layered commits share a durable commit-job model. Jobs are keyed by runtime identity, sealed artifact hash, and the hashed idempotency key. The Durable Object stores the request fingerprint, owner, lease, adoption deadline, operation deadline, attempt, and checkpoint:

1. `initialized`
2. `verification-complete`
3. `payloads-transferred`
4. `unpack-complete`
5. `finalized`

The Worker heartbeats a 15-second lease while it owns a job. An expired lease is adoptable after a bounded grace period; an adopter increments the attempt and resumes at the stored checkpoint. Re-entry at `payloads-transferred` re-stages the deterministic aggregates and verifies their hashes before unpack, so ephemeral cell state cannot be trusted across owners. Successful or failed terminal responses are replayed from the existing idempotency record.

| Condition                               | Result                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------- |
| Same key, live owner                    | Existing `409 request_in_progress`; no competing materializer                       |
| Same key, expired/dead owner            | Retry adopts the job at the durable checkpoint and continues                        |
| No durable job exists                   | Fresh coordinator job starts                                                        |
| Abandoned and no retry arrives          | Alarm records typed `503 artifact_commit_abandoned` and clears the live reservation |
| Same key, different request fingerprint | Existing idempotency conflict; no adoption                                          |

The no-single-request rule now applies to build and dock state. Build queue leases already resume or terminate through the watchdog. Dock commit now has the same durable ownership property.

### Staging live-fault path

The staging Worker has an explicit, inert-by-default recovery probe used only by the acceptance harness. Its two marker forms terminate the current owner immediately before unpack or after the first in-cell file write. Production configuration must omit `NABUFLOW_STAGING_ARTIFACT_COMMIT_RECOVERY_PROBE`; no production configuration was touched.

The probe does not change artifact, control, or provider contracts. It exists to live-test lease adoption against deployed Durable Object and Sandbox behavior. The acceptance harness records owner termination, the preserved live-owner 409, elapsed lease time, adoption attempt, checkpoint, start, health, and cleanup.

## Live liveness proofs

Both proofs used the deployed staging Worker and real scratch runtimes. They were not unit simulations.

| Proof                               | First owner                                                     | Immediate same-key retry                   | Adopted retry                                        | End state                                              |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ |
| Abort before materializer starts    | `503 artifact_commit_owner_lost` after durable payload transfer | `409 request_in_progress` while lease live | `200`, attempt 2 after lease expiry; 26,102 ms total | Runtime start 200, health 200, stop/remove 200         |
| Abort after first materialized file | `503 artifact_commit_owner_lost` mid-unpack                     | `409 request_in_progress` while lease live | `200`, attempt 2 from checkpoint; 127,166 ms total   | 1,910 files verified; runtime start and `/healthz` 200 |

The runtime tail contained exactly two intentional staging-owner terminations and two adoptions. It contained zero `undisposed RPC`, `exceededMemory`, or out-of-memory matches. Cancellation paths dispose staging and unpack RPC scopes in `finally`; the existing same-key live-owner 409 remains covered.

Unit regressions additionally cover live-owner preservation, checkpoint adoption after lease expiry, fresh start and fingerprint conflict, and alarm-driven typed terminal failure when no retry arrives.

## Staging acceptance

Gateway deployment used by the code run: `83d414eb-b114-410d-ada2-1db405688faa`. The acceptance harness then performed the required atomic full-set secret update; the active secret deployment observed by `/version` was `fdd37c4a-6bf0-4880-8e8b-85e6b82a13a0`.

The four generated values passed Base64URL-without-padding format checks, were written atomically, remained session-only, and were erased at harness exit. No third-party credential was requested or used. Fresh measured clock offset was `-11,811,678 ms`.

### Four-surface sustained-green gate

All four independently consumed secret surfaces reached 20 consecutive greens within the five-minute/600-probe bound. The gate used 216 HTTP requests and completed in 64,158 ms.

| Surface                      | First green | 20th consecutive green |   Probes | Final response                 |
| ---------------------------- | ----------: | ---------------------: | -------: | ------------------------------ |
| Control HMAC                 |   21,889 ms |              63,118 ms |       36 | 200                            |
| Fresh ES256 preview grant    |   21,953 ms |              63,185 ms |       36 | 302                            |
| Vault KEK                    |   22,631 ms |              63,920 ms |       36 | 200                            |
| Preview redeem + replay pair |   22,925 ms |              64,158 ms | 36 pairs | 302 then 409 `replay_detected` |

### Complete check table

The final evidence transcript contains 517 successful rows. Poll and heartbeat rows are retained in the evidence; the functional rows are summarized here.

| Area                             | Live result                                                                                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Atomic secret rotation and clock | Four-value format self-check passed; no persisted values; fresh Worker-Date offset recorded                                       |
| Pantry catalog and ingest        | Heavy roots `esbuild`, `leaflet`, `postgres`, `sharp`, `stripe`, `ws`; 17 exact ingredients; immutable shelf verified             |
| Concurrent miss coalescing       | 100 demanders converged through one queue delivery; committed shelf reused                                                        |
| Closure and binaries             | Complete runtime closure; declared bins materialized as deterministic regular-file shims; node-gyp-build class regression covered |
| Build pass 1                     | Transfer, install, rebuild, build, aggregate collection, streaming verification, scan all completed                               |
| Build pass 2                     | Independent resource scope completed the same stages; canonical manifest matched pass 1                                           |
| Determinism                      | Same sorted paths, modes, sizes, and per-file hashes; single-byte mutation regression returns typed failure                       |
| Live build consumer death        | Attempt 1 killed; attempt 2 resumed and succeeded automatically in 276,238 ms; zero manual intervention                           |
| Heavy cold build                 | Success in 187,446 ms, below the normal 20-minute product bound                                                                   |
| Warm deterministic build         | Success in 818 ms; approximately 229× faster than cold                                                                            |
| Output posture                   | 2 app files + 1,908 layer files; 55,349,725 bytes; genuine symlink/non-regular entries still rejected                             |
| Scanner classification           | Per pass: 2 app + 5 divergent dependency files scanned; 1,903 exact shelf files exempt; zero findings                             |
| Sealer classification            | Trusted-ledger source; 5 divergent dependency files scanned, 1,903 exact matches exempt; zero findings                            |
| Provenance authorization         | Builder-signed read succeeds; unsigned/missigned/wrong identity reject; unknown shelf 404; contents absent                        |
| Sealed artifact                  | Layer seal completed with existing wire format and supplied checksums                                                             |
| Runtime ensure                   | Full `nrf-...` runtime identity used; derived `nbb-...` cell ID never leaks into delivery addressing                              |
| Commit before materializer       | Live 503/409/adopt-200 sequence; runtime start/health/stop/remove green                                                           |
| Commit mid-materialization       | Live 503/409/adopt-200 sequence; checkpoint resume and all 1,910 hashes verified                                                  |
| Runtime start                    | `nrf-e919a75364398a44-p824262530-preview-primary`, port 8080, `/healthz` 200                                                      |
| Tenant egress                    | `enableInternet=false` and tenant `allowedHosts` remain unchanged                                                                 |
| Credential posture               | Build and runtime are secretless; scanner/sealer zero findings; no third-party credential used                                    |
| Fly                              | No Fly provider or Fly configuration file changed                                                                                 |
| Artifact compatibility           | Artifact v1 and dependency-layer wire formats remain valid and unchanged                                                          |

### Memory and RPC posture

Inputs stream through bounded buffers and are released per pass. Outputs stream through R2-backed verification. The evidence records controlled bytes owned by the build transport; isolated Sandbox runtime heap counters are not exposed to the Worker and therefore remain zero rather than being presented as a false whole-process measurement.

| Phase                          |             Pass 1 controlled peak |             Pass 2 controlled peak |
| ------------------------------ | ---------------------------------: | ---------------------------------: |
| Transfer/install/rebuild/build |                1,048,576 B or less |                1,048,576 B or less |
| Aggregate collection           |                       31,082,010 B |                       32,130,586 B |
| Trusted verification           | 640,950 B shared verification peak | 640,950 B shared verification peak |

The largest measured controlled allocation was 32,130,586 bytes, leaving about 95.9 MiB relative to the Worker's 128 MiB ceiling. The earlier approximately 166 MiB retained-payload design was removed, not tuned. Pass 1 resources were torn down before pass 2. Runtime and build tails contained zero undisposed-RPC warnings and zero memory-limit failures.

### Cleanup and cost posture

| Resource                  | Final readout                                                   |
| ------------------------- | --------------------------------------------------------------- |
| Scratch runtime           | stop 200, destroy 200, post-destroy 404                         |
| Build jobs                | Four acceptance build IDs garbage-collected                     |
| Build ledger              | queued/running/succeeded/failed/cancelled all 0; active cells 0 |
| Build R2                  | 0 objects / 0 bytes / 0 quarantine objects                      |
| Pantry ledger             | assemblies/shelves/committed/external references all 0          |
| Pantry R2                 | 0 objects / 0 bytes / 0 quarantine objects                      |
| Shelf reads after cleanup | structured 404                                                  |
| Session values            | erased at harness exit                                          |

No running container, retained object, or third-party billable resource remained.

## Deterministic verification

| Check                    | Result                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| Runtime Worker suite     | 22 files / 150 tests passed                                      |
| Tenant runtime contracts | 13 files / 145 tests passed                                      |
| API artifact-layer focus | 1 file / 5 tests passed                                          |
| Repository typecheck     | Passed                                                           |
| Repository lint          | Passed                                                           |
| Ora fast stability gate  | 14 pass / 1 expected dirty-tree warning / 0 fail                 |
| Release profile          | 17 pass / 1 dirty-tree warning / 3 fail; exact base parity below |

The release profile's three failures are the known lab-without-PostgreSQL baseline:

- `api-release-extended`: the same three `ora-realtime-usage.test.ts` failures and four explicit `ECONNREFUSED 127.0.0.1:5432` signatures as base.
- `api-account-billing-history`: the same four `ora-memory-consolidation.test.ts` failures as base.
- `web-build`: the same prerender database connection failure at `127.0.0.1:5432` as base.

A detached pristine worktree at exact base `cd4bb53327afac6457a60554676fe70567d1a191` used the unchanged lockfile and completed `pnpm install --frozen-lockfile --prefer-offline` with zero downloads. Its release profile reported the same three failing gate IDs and the same assertion/connection signatures. Anything beyond those three would have been a stop; none occurred. Replit's Linux release gate remains authoritative at merge.

No `package.json` or `pnpm-lock.yaml` changed in this slice, so the standing manifest/lockfile-triggered two-pristine-install proof does not apply. The base-parity checkout's frozen install was performed solely to establish the database-environment baseline.

## Diagnostic and correction record

The long continuation was evidence-led; each failure mode was classified before its correction:

1. A stuck process cleanup call was bounded and made disposable.
2. A missing Sandbox `ContainerProxy` path was wired as a product fix.
3. Exit 127 was traced to the shell wrapper, not an absent platform toolchain.
4. The `node-gyp-build` failure separated closure completeness from `.bin` materialization; shelving now rejects incomplete runtime closures.
5. npm symlinks became deterministic regular-file shims while the collector retained its strict posture.
6. Per-file output RPC was measured as slow and replaced by deterministic aggregate collection.
7. A roughly 166 MiB retained output set exceeded the Worker limit; streaming verification replaced the in-memory design.
8. Build consumer death exposed orphanable leases; watchdog recovery and idempotent resume now cover every non-terminal build stage.
9. Long build IDs exceeded Sandbox limits; deterministic 128-bit-derived cell IDs fixed the API boundary without narrowing the contract.
10. Resume-path RPC ownership was brought under the same per-pass scope; live recovery now produces zero warnings.
11. A stale harness `runtime.ensure`/destroy route was corrected only after the Worker was shown to behave per contract.
12. Scanner false positives in immutable public registry bytes became exact-hash Pantry provenance exemptions; divergent bytes remain scanned.
13. The sealer gained an independently authenticated trusted-ledger provenance source.
14. Per-file runtime materialization was measured as too slow and replaced with the inverse aggregate transport.
15. A deliberately interrupted commit proved that the reservation itself could deadlock.
16. This continuation replaced request-owned reservations with durable checkpoints, leases, adoption, and alarm-driven terminal failure.

The harness also now preserves uniquely named, sanitized pre-cleanup evidence. Terminal evidence includes stage progression, attempt, typed error, exact sanitized command, exit code, PATH, bounded stdout/stderr tails, collection/verification heartbeats, memory samples, and secret-scan path/rule/fingerprint—never secret content. Cleanup-only runs cannot overwrite a failed run's record.

## Compatibility and safety

| Boundary            | Proof                                                                                |
| ------------------- | ------------------------------------------------------------------------------------ |
| Production          | No production deployment, secret, provider selection, or traffic change              |
| Fly                 | No Fly file changed; default provider behavior untouched                             |
| Tenant egress       | Runtime manifests retain `enableInternet=false`; tenant allowlist unchanged          |
| Tenant credentials  | None in build cells or runtime container; no third-party credential used             |
| Pantry traffic      | Only trusted Pantry ingest reaches npm; build cells consume sealed shelf material    |
| Artifact v1         | Existing format and readers unchanged                                                |
| Dependency layers   | Existing wire format unchanged; aggregate transport is internal materialization only |
| Collector           | Genuine symlinks and all non-regular filesystem entries remain rejected              |
| Staging fault probe | Explicit staging variable only; production must omit and therefore fails closed      |

`wrangler.build.jsonc` adds the private, secretless trusted build Worker and its service bindings. The staging runtime `wrangler.jsonc` adds only the build/provenance bindings and the explicit staging recovery-probe flag. These are deployment manifests, not package manifests. Any production rollout remains a separate Replit-controlled action.

## Recommendations

1. Keep the staging owner-loss probe absent from every production environment and add a deployment-policy assertion for that omission before publish.
2. Alert on lease adoption and `artifact_commit_abandoned`; adoption is safe but should be operationally visible. Retain the five-minute operation deadline until production workload data justifies a different bound.
3. Preserve aggregate checkpoint object retention until the job is terminal, then garbage-collect by coordinator record. Periodically reconcile coordinator metadata and R2 as a defense-in-depth orphan sweep.
4. Continue PG-5 as a hard gate: Pantry provenance, toolchain attestations, deterministic shims, stream scanning, and artifact/delivery evidence must remain jointly verifiable before arbitrary user builds.
5. PG-1 remains relevant to signing-key rotation for builder-read provenance and other control surfaces; active-key-set overlap must precede production rotation without downtime.
6. Before production scale, load-test concurrent large commits and build-cell quotas. The present heavy row has wide request-wall margin and bounded Worker memory, but it is a staging proof, not final capacity tuning.
7. Keep Fly as the byte-identical default until the later dual-run slice proves the same generated application on both providers.

## Evidence index

- Final 517-row transcript: `tmp/gateway-trusted-build-plane/staging-acceptance-20260809T203610421Z-558e8693740b47d4bfb61841f96c7f1f-final.json`
- Preserved harness-only failed-run transcript: `tmp/gateway-trusted-build-plane/staging-acceptance-20260809T202114609Z-d081ea7ddb934511b25a00a08f27cf0d-final.json`
- Runtime live tail: `artifacts/nabuflow-runtime-worker/tmp/cont16-rerun-runtime-tail-20260809T123542591Z.jsonl`
- Build live tail: `artifacts/nabuflow-runtime-worker/tmp/cont16-rerun-build-tail-20260809T123542591Z.jsonl`
- Branch release profile: `tmp/trusted-build-plane-release-gate.md`
- Exact-base release profile: `.verify-trusted-build-plane-base/tmp/trusted-build-plane-base-release-gate.md`

All evidence paths are ignored diagnostic output; no secret value was written to the worktree, report, or logs.
