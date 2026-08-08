# Slice 2b-ix-b4 — self-stocking npm ingest

Date: 2026-08-08  
Branch: `codex/gateway-pantry-ingest`  
Audited base: `c4db2ffd35fd109296560999e5c72b6367dd38a4`  
Implementation commit: `cba9d681b1de0821b281a200aeae7a7d0bc7dd27`  
Staging only; not merged or published

## Outcome

The Pantry now self-stocks public npm ingredients from the trusted private Pantry Worker. A stock request resolves every range or dist-tag once to exact versions, constructs the complete runtime/optional/peer closure, verifies the npm SHA-512 SRI and registry signature before extraction, applies bounded safe extraction, records origin/provenance evidence, writes immutable objects to R2 with supplied hashes and conditional create semantics, and commits a dated catalog shelf. A warm request returns the existing shelf without another queue delivery or upstream request.

No credential was requested or used. All upstream reads were anonymous and restricted to `https://registry.npmjs.org`. The private Worker remains `workers_dev=false` and returned 404 to a public route probe.

## Implementation

### Trusted registry boundary

- Only credential-free HTTPS GET requests to the exact `registry.npmjs.org` origin are permitted.
- Redirects are manual, capped at three, and every target is revalidated against the same exact origin. URLs with user info, other ports, another host, or a private/metadata address fail closed before a fetch.
- No `Authorization` or `Cookie` header is constructed or forwarded. Responses are streamed into bounded buffers; packuments, attestations, and tarballs have separate caps and a 15-second request timeout.
- Full packuments are requested because npm's abbreviated install document omits the exact publication-time ledger field.

### Resolution and immutable shelving

- Semver ranges and dist-tags resolve to exact versions before any shelf record is constructed. Git, URL, file, workspace, npm-alias, and private-registry selectors are rejected.
- Runtime, optional, and peer edges are recursively resolved; platform-ineligible optional edges may be omitted, while required platform/engine mismatches reject the stock request.
- Cycles terminate without duplicating coordinates. Slice limits are 2,000 ingredients, 10,000 edges, 256 MiB compressed closure bytes, 1 GiB unpacked closure bytes, and 120 seconds total ingest time.
- R2 object keys remain content-addressed. Writes use `onlyIf: etagDoesNotMatch: "*"`, supply SHA-256, and are read back and rehashed before catalog commit. Registry metadata, raw tarball, normalized per-file manifest, provenance bundle, exact lock, CycloneDX SBOM seed, and toolchain record all become immutable catalog references.
- The existing Durable Object remains the single-flight coordinator. Queue work is leased, observable through a signed assembly-progress route, negatively cached on a typed terminal failure, and retryable only for typed weather. Revision allocation retains the existing parent-root chain.

### Supply-chain posture

The implementation verifies npm registry signatures over `name@version:integrity`, including the registry's ASN.1/DER ECDSA encoding converted to Worker-native IEEE P1363, and verifies the downloaded tarball against the normalized SHA-512 SRI. Published DSSE/in-toto subjects must bind the exact package PURL and SHA-512 bytes or the package is rejected. The raw attestation is stored as origin evidence.

This slice deliberately records a structurally bound attestation as `unverified`, not `verified`: it does not yet implement complete Sigstore certificate/transparency-chain verification. Provenance is never treated as evidence that code is benign. Absent provenance is recorded as `unavailable`; malformed or mismatched published provenance is `provenance_rejected`.

Install lifecycle scripts are never executed. Packages declaring preinstall/install/postinstall are recorded as `disabled`. License presence is recorded; malware, vulnerability, and secret scan fields remain explicit warnings rather than false passes. Compilation and policy-grade scanners belong to later Pantry builder/security slices.

### Archive safety

Tarballs are SRI-verified before decompression. Gzip output, individual files, and file count are capped. Tar header checksums are verified. A single archive root is required and stripped. Absolute paths, drive paths, backslashes, empty segments, dot/dot-dot traversal, multiple roots, duplicates, symlinks, hardlinks, devices, FIFOs, and unknown entry types are rejected. PAX and GNU long-name metadata are parsed only to derive a path that is revalidated by the same rules.

## Compatibility and isolation

| Surface                                    | Result                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Artifact v1                                | No file changed; byte-identical to base                                                  |
| Additive artifact layers                   | No contract/storage/runtime file changed; byte-identical to base                         |
| Fly provider                               | No Fly/provider file changed; byte-identical to base                                     |
| Tenant sandbox egress                      | `enableInternet=false` and tenant `allowedHosts` files have an empty base-to-branch diff |
| Shipped preview/published/capability paths | Worker suite green; only additive signed Pantry progress routing changed                 |
| Private Pantry surface                     | Direct probe 404; access remains service-binding-only                                    |

The private Worker is the only component that contacts npm. No registry hostname was added to a tenant manifest, sandbox configuration, or allowlist.

## Verification

### Deterministic tests

| Check                            | Result                                           |
| -------------------------------- | ------------------------------------------------ |
| Tenant runtime contracts         | 12 files / 141 tests passed                      |
| Runtime Worker                   | 16 files / 111 tests passed                      |
| New ingest/catalog/gateway focus | 3 files / 24 tests passed                        |
| Repository typecheck             | Passed                                           |
| Repository lint                  | Passed                                           |
| Ora fast stability gate          | 14 pass / 1 expected dirty-tree warning / 0 fail |

Negative coverage includes mutated SRI, invalid registry signature, nonexistent/invalid selector, wrong platform/engine, private-host redirect, malformed/mismatched provenance, archive size/file-count rejection, traversal, absolute path, duplicate path, symlink/forbidden type, typed upstream failure, dependency cycles, negative-cache state, signed progress authorization, and R2/catalog CAS conflict behavior.

The existing 100-concurrent test was upgraded through the real queue/commit path: one request created the assembly, 99 joined it, one ingest ran, one queue message was acknowledged, one shelf committed, and the next request was a warm committed hit.

### Anonymous official-registry compatibility matrix

The same production ingest code was run locally against current public npm data with no credential and no allowlist:

| Domain                | Root                | Result                                                |
| --------------------- | ------------------- | ----------------------------------------------------- |
| Database              | `pg@8.22.0`         | Exact closure verified                                |
| Payments              | `stripe@22.4.0`     | Exact closure plus bound provenance evidence verified |
| Image/native metadata | `sharp@0.35.3`      | Platform-filtered optional closure verified           |
| Maps/visualization    | `maplibre-gl@6.2.0` | Exact closure verified                                |
| Realtime messaging    | `socket.io@4.8.3`   | Exact closure verified                                |

The combined run produced 74 exact ingredients and 245 immutable objects; every ingredient's npm registry signature verified. No source-package allowlist exists in schema, resolution, tests, or runtime logic.

### Frozen-lockfile proof

This branch intentionally adds exact `semver@7.8.5`, `@types/semver@7.8.0`, and `@types/node@25.6.2`, so the permanent clean frozen-lockfile rule applies.

Two independent clean checkouts at exact commit `cba9d681` used repository-pinned pnpm 10.26.1 and one isolated proof store:

1. Empty isolated store: `pnpm install --frozen-lockfile --store-dir <isolated>` passed with 2,259 packages in 554.3 seconds.
2. Newly recreated pristine checkout: `pnpm install --frozen-lockfile --prefer-offline --store-dir <same-isolated>` passed with 2,259 packages, 2,227 store reuses, zero downloads, and no lockfile change in 177.1 seconds.

Both checkout trees were clean after installation.

## Staging acceptance

Staging deployments:

- Private Pantry Worker version: `5d9ce39f-7409-4b43-b3b9-f6029f9eaf10`
- Gateway Worker version: `b94b828a-28a4-464d-b133-28d8f96af3ec`

The standard atomic full-set Worker-secret rotation used fresh generated session-only values with Base64URL prechecks. No values were printed or persisted. Fresh measured clock offset: `-11,811,736 ms` (the known Windows lab drift).

### Four-surface sustained-green gate

All surfaces reached 20 consecutive greens inside the five-minute/600-request bound. Total: 125,798 ms and 462 HTTP requests.

| Surface                      | First green | 20th consecutive green |   Probes | Final response               |
| ---------------------------- | ----------: | ---------------------: | -------: | ---------------------------- |
| Control HMAC                 |   82,218 ms |             124,866 ms |       77 | 200                          |
| Fresh ES256 preview grant    |   82,277 ms |             124,926 ms |       77 | 302                          |
| Vault KEK                    |   82,997 ms |             125,642 ms |       77 | 200                          |
| Preview redeem + replay pair |   83,285 ms |             125,798 ms | 77 pairs | 302 then 409 replay detected |

### Live rows

| Row                                | Observed result                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| Private Worker direct reachability | 404                                                                                                |
| 100 concurrent identical misses    | 1 created / 99 coalesced / one queue delivery                                                      |
| Signed assembly progress           | Queued/running/typed-failure states available only through signed gateway                          |
| Real anonymous npm cold miss       | `is-number@7.0.0` committed, six objects, registry signature verified                              |
| Exact shelf readback               | Root `6e7cc3cee2273d37443ee45e0b568dc43d7043ea545037ce22338606dc4f6af2` reverified from R2/catalog |
| Warm identical request             | Existing committed shelf; zero new queue deliveries                                                |
| Conditional object replay          | 200 replay; conflicting kind/digest 409 typed conflict                                             |
| Incomplete assembly                | 409 typed incomplete; TTL cleanup removed quarantine                                               |
| New dated shelf                    | Parent/child commit left old shelf response byte-identical                                         |
| Reference retention                | Referenced retired shelf blocked; release permitted scoped GC                                      |
| Final authoritative cleanup        | 0 assemblies, 0 shelves, 0 committed references, 0 external references, R2 0 objects / 0 B         |

The final sanitized evidence transcript is `tmp/pantry-catalog-staging-evidence.json` (ignored, not committed), 7,980 bytes, SHA-256 `e9dd220c7e328f39bc4fd7b27f2c5b6e2f7edd9de46244b310319f42f0f99515`.

### Harness-only correction

The first staging attempt committed and verified the real npm shelf, then stopped on a racy harness assertion: a global queue-delivery delta included earlier fixture messages still draining. The Worker behaved correctly. Cleanup transitioned the shelf; the second run's preflight scoped GC collected it. The harness now requires three stable queue observations before/after the cold miss and proves the warm hit against another stable observation. The second full run passed. No product or contract behavior changed for this correction.

## Recommendations and gate register

1. **PG-5 remains a hard gate.** This slice advances trusted ingest, exact closure resolution, npm SRI and registry-signature verification, immutable origin evidence, archive safety, coalescing, and live self-stocking. Complete Sigstore verification, policy-grade malware/CVE/secret scanning, poisoning response/revocation operations, reproducible trusted builds, and cross-substrate output remain open.
2. **Do not equate provenance with safety.** Even after full Sigstore verification, provenance proves an origin/build claim, not benign behavior. Scanner and policy decisions must remain separate fields.
3. **Keep native/lifecycle execution out of ingest.** Slice 4 stocks source and metadata only. Slice 5's trusted builder must sandbox lifecycle/native compilation, attest the build, and never run it in the catalog Worker or tenant container.
4. **Tune bounds from production telemetry.** Current packument/archive/closure/time limits are deliberate staging fail-closed values. Observe legitimate cold misses before production tuning; do not silently raise them in response to one package.
5. **Move the staging fixture attestor under PG-1 before production.** The staging Pantry uses deliberately public, checked-in test signing material that conveys no production authority. Production configuration must have a protected versioned attestor and active-key overlap or fail closed.
6. **Preserve the trusted-plane split.** The current narrow code boundary is suitable for staging. A dedicated ingest Worker/service with explicit outbound policy and resource quotas should be evaluated before high-scale production.

## Primary npm references

- npm registry package metadata: <https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md>
- npm public registry API: <https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md>
- npm registry signature verification: <https://docs.npmjs.com/verifying-registry-signatures/>
- npm provenance posture: <https://docs.npmjs.com/generating-provenance-statements/>
