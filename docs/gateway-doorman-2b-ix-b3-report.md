# Gateway Doorman 2b-ix-b3 — Pantry Catalog Report

Date: 2026-08-08

- Branch: `codex/gateway-pantry-catalog`
- Audited base: `bdc8622b6ecec085d62c8dfe704b1112fe07c432`
- Scope: immutable Pantry catalog ledger, private trusted storage/service foundation, and staging proof
- Production: untouched
- Fly: byte-identical to the audited base
- Upstream package registries: not contacted; ingest remains slice 4

## Outcome

The catalog foundation is implemented and live in Cloudflare staging. A private `nabuflow-pantry-staging` Worker owns the catalog coordinator Durable Object, the private `nabuflow-pantry-catalog-staging` R2 content-addressed store, and the `nabuflow-pantry-ingest-staging` queue. The public runtime Worker can reach it only through a service binding and exposes a narrow, HMAC-authenticated control proxy. The Pantry Worker has `workers_dev=false` and `preview_urls=false`; a direct workers.dev probe returned 404.

No static package allowlist exists. Stock identity accepts arbitrary valid npm package intents and is content-addressed from the requested selectors plus exact platform tuple. The catalog commits only complete, signed, exact dependency closures. Upstream registry access and package execution are absent by construction in this slice.

## Architecture delivered

### Immutable catalog and dated shelves

The contract adds strict v1 schemas for stock requests, staged object references, commits, committed shelf records, lifecycle transitions, retention/GC, external references, typed errors, and build-facing shelf stamps. A committed shelf binds:

- the exact dependency closure and ingredient Merkle root;
- exact package versions, dependency edges, registry metadata digest, tarball digest, normalized-content digest, integrity, provenance status, scan results, and lifecycle-script posture;
- lockfile, SBOM, toolchain-image, and toolchain-attestation digests;
- parent shelf root, immutable revision ID, revision signature/key ID, retention namespace, and manifest digest.

Shelf commits are append-only. A new shelf requires a CAS match against the current lineage head. Collecting the latest retired child restores its still-present parent as the head, so GC cannot silently fork the dated lineage. Adding a child never rewrites the parent record or its R2 manifest.

The build-facing `nabu-pantry-catalog-stamp/v1` contains enough hashes to verify a build's exact shelf using the catalog alone. Verification requires a committed lifecycle state and re-verifies the shelf manifest and every referenced R2 object before returning success.

### Private CAS, quarantine, and queue boundary

R2 keys are split into quarantine, immutable SHA-256 CAS objects, and immutable dated revision manifests. Writes use conditional create, supplied SHA-256, immediate readback, byte-length verification, and full byte comparison on replay. Commit verifies the complete staged reference set and all bytes before promoting anything out of quarantine. Incomplete uploads remain quarantined and are removed by TTL alarm or the narrowly scoped `expired-uncommitted` GC operation.

The coordinator Durable Object provides single-flight stock assembly, immutable commit indexing, revision/root lookup, object reference counts, external retention references, lifecycle CAS, TTL scheduling, and retired/unreferenced collection. Identical stock requests coalesce to one assembly and one queue message. Normal ingest cannot overwrite or delete a committed record. Only the privileged GC principal can collect a retired, unreferenced, retention-expired shelf.

The queue consumer deliberately performs no network access in this slice; it validates the message, records delivery, and acknowledges it. Slice 4 owns trusted upstream acquisition.

### Principal and gateway boundary

The private service recognizes only three fixed principals:

| Principal          | Surface                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `catalog-admin`    | stock, stage, commit, lifecycle, references, diagnostics         |
| `builder-readonly` | shelf lookup, stamp verification, verified internal object reads |
| `catalog-gc`       | scoped garbage collection and diagnostics                        |

Unknown or tenant principals receive the same structured 403 across list, read, and write attempts. The runtime Worker maps only an exact control-path allowlist to these principals after the existing HMAC, timestamp, nonce, body-hash, replay, idempotency, and audit boundary succeeds. Missing service binding, malformed private response, oversized response, or private-service exception fails closed as `pantry_infrastructure_unavailable`.

No tenant route, public URL, presigned URL, API-server R2 credential, registry credential, or container credential was added.

## Live staging acceptance

The final run used one fresh atomic write-only rotation of the existing staging Worker secret set. Values were generated as Base64URL without padding, format-checked before application, kept only in process memory, never printed or persisted, and erased at process exit. No third-party credential was used.

The fresh Worker clock measurement was `-11,812,121 ms`, consistent with the known Windows lab drift. All signed times used the measured offset.

### Four-surface sustained-green gate

All surfaces achieved 20 consecutive greens within the five-minute/600-request bound. The final gate completed in 92,703 ms using 330 HTTP requests.

| Independently consumed secret surface |    Expected result | Probes | First green | 20th consecutive green |
| ------------------------------------- | -----------------: | -----: | ----------: | ---------------------: |
| Control HMAC signed `/version`        |                200 |     55 |   50,091 ms |              91,718 ms |
| Fresh ES256 preview grant             |                302 |     55 |   50,162 ms |              91,781 ms |
| Vault KEK provision + revoke          |                200 |     55 |   50,861 ms |              92,536 ms |
| Preview redeem + replay pair          | 302 then typed 409 |     55 |   51,096 ms |              92,703 ms |

This again confirms why first-success readiness is insufficient on this platform.

### Catalog matrix

| Probe                                        |            Result | Evidence                                         |
| -------------------------------------------- | ----------------: | ------------------------------------------------ |
| Private Pantry health through signed gateway |               200 | Service binding healthy                          |
| Direct Pantry workers.dev URL                |               404 | No public/tenant surface                         |
| 100 concurrent identical stock misses        | 1 x 201, 99 x 200 | One created assembly, 99 coalesced               |
| Queue emission for those 100 misses          |                 1 | Cumulative counter delta exactly +1              |
| Initial staged object                        |               201 | Conditional quarantine write + readback verified |
| Identical staged retry                       |               200 | Typed `replay`, no second object                 |
| Same digest with conflicting object kind     |               409 | `catalog_conflict`                               |
| Complete two-package shelf commit            |               201 | Exact root + transitive closure committed        |
| Identical commit retry                       |               200 | Typed `replay`, byte-stable manifest             |
| Lookup by root and dated revision ID         |         200 / 200 | Bodies byte-identical                            |
| Build shelf-stamp verification               |               200 | Catalog-only stamp verified                      |
| Commit child dated shelf                     |               201 | Parent-root CAS honored                          |
| Read old shelf after child                   |               200 | Old response bytes unchanged                     |
| Commit with incomplete staged set            |               409 | `catalog_incomplete`; nothing published          |
| Expired-uncommitted collection               |               200 | Pending assembly/quarantine removed              |
| Committed shelf after TTL collection         |               200 | Committed records unaffected                     |
| Retain shelf + attempt retired GC            |               200 | No deletion while externally referenced          |
| Release reference + retired GC               |               200 | Child removed                                    |
| Shared CAS read after child GC               |               200 | Parent's shared objects retained and reverified  |
| Final parent GC                              |               200 | Final revision and unreferenced CAS removed      |

The fixture closure contained the exact versions `1.0.0` and `2.0.0`. Its fixed evidence hashes were:

- ingredient Merkle root: `7920d4e8d71090298179e189be502a1765b5b2845d2c8a4eeaeee7f23cc64b26`
- lockfile: `3e327b0371f69df339940e9d127f81d0ad14e885ff812b594259eb197cc03999`
- SBOM: `ddca6bddfa77e4d611fe8dcd4dacdf30f3f35ddcf090e6cf51fcdc0df1f850a1`
- toolchain attestation: `036be31c73375f91ba76cdf6bae33276076c6f93fa8bed399e23ddda6d411534`

### Cleanup and cost posture

The final authoritative diagnostics after reference release and scoped GC were:

| Resource                    | Final state |
| --------------------------- | ----------: |
| Pending assemblies          |           0 |
| Shelf records               |           0 |
| Committed object references |           0 |
| External references         |           0 |
| R2 objects                  |           0 |
| R2 bytes                    |         0 B |
| R2 quarantine objects       |           0 |

No sandbox runtime or container was created by this slice, so there was no container compute to clean up or accrue cost. The empty private bucket, queue, Durable Object namespace, and private Worker remain as the staging catalog foundation. The queue reports exactly one producer and one consumer, both `nabuflow-pantry-staging`. Final Pantry deployment `23fc121a-e563-4587-bd26-ef5afa8eef9e` is at 100%.

## Tests and standing gates

| Gate                             | Result                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| Fresh-worktree frozen install    | Passed; pnpm 10.26.1, `--frozen-lockfile --prefer-offline`, 2,258 packages, 0 downloads |
| Install timing                   | 5m36.8s; existing store reused; root bins and Worker Wrangler 4.118.0 verified          |
| Tenant runtime contracts         | 12 files / 141 tests passed                                                             |
| Runtime Worker                   | 15 files / 97 tests passed                                                              |
| Focused API/provider regressions | 7 files / 41 tests passed                                                               |
| Contracts typecheck/lint         | Passed / passed                                                                         |
| Runtime Worker typecheck/lint    | Passed / passed                                                                         |
| Repository-wide typecheck        | Passed                                                                                  |
| Repository-wide lint             | Passed                                                                                  |
| Ora fast stability gate          | 14 pass / 1 expected dirty-tree warning / 0 fail                                        |
| `git diff --check`               | Passed                                                                                  |

The initial dependency installation timed out while linking on the known slow Windows filesystem. Only this worktree's incomplete `node_modules` was removed with the established long-path-safe procedure. The single approved retry used a 60-minute bound and `--prefer-offline`; it completed cleanly in 5m36.8s with 2,226 reused packages and zero downloads. This enacts the standing lab rule: fresh-worktree installs on this machine default to a 60-minute bound plus `--prefer-offline`.

No `package.json` or `pnpm-lock.yaml` changed. The standing pristine isolated-store frozen-install proof trigger therefore does not apply; the recorded install used the unchanged main lockfile. The clean release profile and its accepted three-suite PostgreSQL base-parity evidence are appended after commit.

## Diff and safety record

The branch adds the Pantry catalog contract/tests, coordinator DO, private Worker/queue handler, signed gateway proxy, staging-only Worker/R2/queue configuration, deterministic fixture, live smoke harness, and test-helper R2 conditional behavior. Existing artifact v1 and additive layer contracts remain unchanged.

`FlyRuntimeProvider`, Fly configuration, production provider selection, production secrets, production DNS, tenant egress, and production traffic are byte-identical/untouched. No manifest or lockfile changed. The fixture private key is clearly marked public test material; only its public half is installed as a staging Worker variable.

## Recommendations and gate register

1. **Proceed to slice 4 only after merge/publish.** The next slice should consume the queue and perform trusted, narrowly pinned upstream registry acquisition. It must preserve quarantine and never make the catalog Worker or tenant container a general-purpose fetch proxy.
2. **Keep the builder read-only.** Build-plane reads should remain a private service-binding call with object hashes supplied by a verified committed shelf. It should not receive list, stock, lifecycle, or GC authority.
3. **Add operational reconciliation before scale.** A later operations slice should report stalled assemblies, queue age/retries, orphaned quarantine, catalog/R2 reference drift, and GC dry-run plans. Normal ingest must still be unable to mutate committed content.
4. **Treat scanner warnings as policy input, not silent acceptance.** This foundation records scan state exactly. Slice 4/5 must define when warnings can enter quarantine versus committed shelves and preserve the decision in provenance.
5. **PG-1 remains open.** The catalog consumes signed revisions with `kid`, but staging currently uses a fixed public fixture key. Production needs active verification-key sets, overlap/cutover semantics, retirement, and long-term verification material before real shelves.
6. **PG-3 remains open and unchanged.** No database behavior changed. Pantry-provided database client ingredients will later need the database gate's policy, migration, quota, timeout, and credential-custody guarantees.
7. **PG-5 advances but remains a hard gate.** This slice proves immutable catalog storage, exact closure/Merkle/stamp verification, single-flight, quarantine TTL, scoped retention/GC, and a private service boundary. Trusted ingest/provenance, poisoning response, reproducible builders, dependency-complete real Zero output, cross-substrate portability, and production operational controls remain unproven.

## Addendum — 2026-08-08 clean release-profile base parity

After the implementation and original report were committed at `cf7d6a66`, the clean-tree Ora release profile ran on the branch. It completed with 18 passes, 0 warnings, and exactly 3 failed rows:

| Release row                   | Exact failure set                                                                                                                |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `api-release-extended`        | The same two `ora-realtime-usage.test.ts` cases failed with `ECONNREFUSED 127.0.0.1:5432`                                        |
| `api-account-billing-history` | The same two `ora-memory-consolidation.test.ts` cases returned 500 instead of 201 because local database setup could not connect |
| `web-build`                   | Bundle and size checks passed; dynamic-route prerender then failed with `ECONNREFUSED 127.0.0.1:5432`                            |

A clean detached worktree at exact audited base `bdc8622b6ecec085d62c8dfe704b1112fe07c432` was populated with repository-pinned pnpm 10.26.1 using `pnpm install --frozen-lockfile --prefer-offline`. The 60-minute slow-disk bound was active. It reused 2,226 packages, downloaded zero, and completed in 9m04.2s without changing the lockfile.

The identical clean release profile on that base also completed with 18 passes, 0 warnings, and the exact same 3 failed rows, test names, assertion shapes, and `127.0.0.1:5432` refusal. This is exact base parity. The failures are the documented no-local-PostgreSQL Windows-lab baseline, not a Pantry catalog regression. Replit's PostgreSQL-backed merge gate remains the authoritative ship gate.
