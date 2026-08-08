# Gateway Doorman slice 2b-ix-b1 - Pantry contracts

Status: **implementation and local acceptance passed; branch-only delivery**

- Branch: `codex/gateway-pantry-contracts`
- Audited base: `8bef8406e454a09ec3e8e37110ee39fb73cbc8d3`
- Scope: provider-neutral contracts, compatibility vectors, and contract tests only
- Provider calls/deployments: none
- Credentials/browser use: none

## Delivered contract

The slice adds `nabu-pantry/*/v1` contracts for:

- untrusted npm package intent, exact resolved package coordinates, and complete platform-bound dependency closures;
- exact resolved ingredients with credential-free HTTPS source, npm SHA-512 SRI, raw/normalized content hashes, dependency edges, lifecycle-script status, scanner policy, and provenance status;
- Node runtime platform tuples carrying runtime version, Node ABI, OS, CPU, libc, and the exact toolchain image digest;
- domain-separated canonical closure hashes and deterministic ingredient Merkle roots;
- immutable dated Pantry revision content and a separate monotonic lifecycle record with `assembling`, `committed`, `quarantined`, and `retired` states;
- dependency-layer descriptors, opaque build IDs, exact build inputs, and build attestations;
- ES256 raw-P1363 signed-digest envelopes with schema version, protected `kid`, record kind, and payload hash;
- closed typed stocking/build errors with code-defined retryability and HTTP status defaults.

Ranges and dist-tags are accepted only by the explicitly untrusted package-intent schema. Any resolved ingredient or dependency edge requires an exact semantic version. Unknown fields, unknown schema versions, unknown error codes, malformed hashes/integrity, and noncanonical inputs fail closed.

There is no Pantry storage, network fetch, Worker route, runtime SDK, generator behavior, or provider behavior in this slice.

## Canonical and Merkle rules

Pantry canonical JSON is deliberately narrower than ordinary JSON:

- all strings and object keys must be well-formed NFC Unicode;
- keys are ordered by their UTF-8 bytes;
- numbers must be safe integers, with negative zero rejected;
- undefined values, non-plain objects, malformed Unicode, fractions, and non-finite/unsafe values reject rather than being rewritten;
- schemas require array order where order is semantically meaningful: exact coordinates, dependency edges, roots, layers, and attestation layer hashes.

Hashes are SHA-256 with the `NABUFLOW_PANTRY_V1` domain and an operation discriminator. Ingredient records are Merkle leaves; parent nodes hash the ordered left/right lowercase-hex child hashes, duplicating an odd final node. Revision roots hash the complete immutable revision content, including the closure hash, ingredient Merkle root, platform/toolchain, layers, scanner policy, and provenance status. Lifecycle state is intentionally outside the immutable revision root.

The fixed v1 vector pins these values:

| Output                 | Fixed SHA-256                                                      |
| ---------------------- | ------------------------------------------------------------------ |
| Dependency closure     | `2768db3c54bb2de34adf539ddbf08cc3c915425566c1dc6231fe873bf28708d3` |
| Ingredient Merkle root | `67d2875d48c393bd93b669b3987f99fb2a3895861a7f155a7209a6580bf6c3b6` |
| Layer descriptor       | `f1dbe71e25ae58fa983dfcacb97ed4ecf06009efb098e04564ec0a353c194836` |
| Revision root          | `0f89ad1aa02ef435291ed6c1731ec75b1cff7c8bda8a814669de1d28a959b7a1` |
| Build input            | `73854200f9354888cc9b50a05344ba4cc632bcdd9829015b221327f2d959a7a0` |
| Build attestation      | `317d8c7722478df2be6a5d631206d781f1122d7093cd5e2cf2fcccc46cd5bc13` |

The fixture also pins valid raw 64-byte ES256 signatures for the revision and build attestation using a clearly marked public test keypair. Fresh signatures need not have identical ECDSA bytes, but must produce the identical protected signing input and verify against the fixed public key. The same fixture runs unchanged in every consumer and CI OS, making any cross-platform byte drift a deterministic test failure.

## Fail-closed and immutability coverage

| Contract case                                             | Result                                         |
| --------------------------------------------------------- | ---------------------------------------------- |
| Object key order changes                                  | Identical canonical bytes/hash                 |
| Decomposed Unicode or unpaired surrogate                  | Rejected                                       |
| Fraction, negative zero, unsafe integer, undefined, Date  | Rejected                                       |
| Range/dist-tag in untrusted intent                        | Accepted as intent only                        |
| Range/dist-tag in resolved coordinate                     | Rejected                                       |
| Malformed/non-SHA512 SRI                                  | Rejected                                       |
| HTTP or credential-bearing package URL                    | Rejected                                       |
| Duplicate/unsorted ingredient or unresolved edge          | Rejected                                       |
| Invalid OS/libc tuple or wrong attestation platform       | Rejected                                       |
| Absolute, drive, traversal, or backslash layer path       | Rejected                                       |
| Unknown format/schema version/field/error code            | Rejected                                       |
| Unknown `kid`                                             | `unknown_kid` rejection                        |
| Altered valid signature                                   | `invalid_signature` rejection                  |
| Altered revision or attestation content                   | `content_hash_mismatch` rejection              |
| Failed scan, rejected provenance, failed lifecycle script | Revision not committable                       |
| Revision root changes during lifecycle transition         | Transition rejected                            |
| Backward lifecycle transition                             | Transition rejected                            |
| Ingredient added                                          | New Merkle/revision root; old vector unchanged |

## Verification evidence

| Gate                                | Result                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| Frozen install of existing lockfile | Passed; pnpm 10.26.1, 21 workspace projects                       |
| Contracts baseline before change    | 9 files / 103 tests passed                                        |
| Full contracts suite after change   | 10 files / 129 tests passed                                       |
| Contracts typecheck                 | Passed                                                            |
| Contracts lint (`--max-warnings 0`) | Passed                                                            |
| Runtime Worker full suite           | 11 files / 80 tests passed                                        |
| Runtime Worker typecheck/lint       | Passed / passed                                                   |
| Focused API/provider regressions    | 6 files / 36 tests passed                                         |
| Repository-wide typecheck           | Passed                                                            |
| Repository-wide lint                | Passed                                                            |
| Ora fast stability gate             | Passed: 14 pass, 1 expected pre-commit dirty-tree warning, 0 fail |
| `git diff --check`                  | Passed                                                            |

The focused API set covered `cloudflare-runtime-provider`, runtime artifact sealing, runtime manifest, provider selection, preview-grant compatibility, and container capability behavior. The full Worker set covered the shipped artifact dock, control plane, capability vault/endpoint, DB and Stripe brokers, preview data plane, published routing, and sandbox policy.

The fast stability gate's sole warning was the intentional uncommitted Pantry slice during its pre-commit run. A clean-tree release check is run after the slice commit.

## Diff and production-safety record

Source/test changes are confined to:

- `lib/tenant-runtime-contracts/src/pantry.ts`
- `lib/tenant-runtime-contracts/src/index.ts` (one additive export)
- `lib/tenant-runtime-contracts/test/pantry-vector.ts`
- `lib/tenant-runtime-contracts/test/pantry.test.ts`
- this report

No `package.json` or `pnpm-lock.yaml` changed, so the standing pristine isolated-store frozen-lockfile proof requirement is not triggered. The install recorded above used the existing frozen lockfile only.

`FlyRuntimeProvider`, Cloudflare runtime-provider behavior, provider selection, runtime manifests, artifact-v1, Worker code/config, production configuration, and production traffic are byte-identical to the audited base. No provider endpoint, browser, credential surface, secret, deployment, or live resource was accessed.

## Recommendation

Proceed to slice 2 only after this contract is merged and published. That slice should add the layered artifact extension without reinterpreting `nabu-artifact/v1`, consume these exact layer/revision/attestation hashes, reject unknown `kid` or wrong-platform records before materialization, and leave Fly optional-interface behavior untouched.

PG-1 remains open: this contract provides protected key IDs and active-key-set verification, but issuance cutover, overlap windows, retirement, and long-term verification-material retention belong to the dedicated key-rotation work. PG-5 likewise remains open until Pantry storage, ingest, offline reproducibility, quarantine, builder separation, layered delivery, and cross-substrate portability are proven in their serial slices.

## Addendum - 2026-08-07 release-gate environment parity

After the original findings above were committed, the clean-tree Ora release profile was run as an additional local gate. It completed with 18 passes, 0 warnings, and 3 failed gate rows. All three rows attempted to use PostgreSQL at `127.0.0.1:5432`:

| Release gate row              | Exact failure set                                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `api-release-extended`        | Two `ora-realtime-usage.test.ts` cases failed with `ECONNREFUSED 127.0.0.1:5432`                                     |
| `api-account-billing-history` | Two `ora-memory-consolidation.test.ts` cases returned 500 instead of 201 when their database setup could not connect |
| `web-build`                   | Production bundle and size check completed, then dynamic-route prerender failed with `ECONNREFUSED 127.0.0.1:5432`   |

Machine inspection found PostgreSQL absent rather than stopped: there was no port 5432 listener, Windows service, PostgreSQL process, `psql`/`postgres`/`pg_ctl` executable, standard `C:\Program Files\PostgreSQL` installation, or PostgreSQL installed-program registry entry. No database software or configuration was installed or changed.

The exact release profile was then run in a clean, detached scratch worktree at the audited base `8bef8406e454a09ec3e8e37110ee39fb73cbc8d3`, after a clean `pnpm install --frozen-lockfile` with pinned pnpm 10.26.1. Base produced the identical terminal result: 18 passes, 0 warnings, and the same 3 failed gate rows with the same four failing database tests and the same dynamic-prerender connection refusal at `127.0.0.1:5432`. No additional base or branch failure appeared.

This establishes exact base parity and classifies the release-only failures as a pre-existing Windows-lab environment dependency, not a Pantry regression. The Pantry contract suite, Worker/API regressions, repository typecheck/lint, and fast stability profile remain green as recorded above. Replit's full merge gate remains the authoritative ship gate.
