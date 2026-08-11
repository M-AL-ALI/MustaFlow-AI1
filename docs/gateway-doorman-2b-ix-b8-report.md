# Gateway Doorman 2b-ix-b8 — blueprint/skill capability eligibility

Date: 2026-08-11

Branch: `codex/zero-capability-eligibility`

Audited base: `3cc6f0579229275c4e1b2251e86110aae54511fa`

## Scope restatement

This slice adds the deterministic eligibility boundary between Zero's integration inventory and sealed-native generation. Every shipped blueprint and skill receives machine-readable legacy/sealed substrate metadata. Cloudflare-sealed generation consumes only integrations that can be satisfied by the shipped vendored database or Stripe capabilities; unsupported server integrations fail with a typed, content-addressed capability gap and Zero gets one automatic opportunity to select a supported implementation. The existing direct/Fly generation path, its stored blueprint/skill text, and all current production entry points remain unchanged. No new provider mode is enabled, no tenant egress is opened, and no artifact or dependency-layer wire format changes.

## Authority and pre-flight

- Fresh `git fetch` showed `origin/main` exactly at the required base above; the branch and dedicated worktree were cut from that object.
- Recovered build plan: SHA-256 `3b60669b59fb8bed7d9e7049e13390ad7d347210a8f57d130f59daa03f19324c`.
- Recovered design note: SHA-256 `1d05e6e812f54b76cb61e253dfec917033fdfea2e9efe044935fea0777b4d326`.
- No authority divergence was required.
- Dependency installation used repository-pinned pnpm 10.26.1 with `--frozen-lockfile --prefer-offline`; it completed from the existing store with zero downloads. The timestamped external lab log is `tmp/slice8-pnpm-install-20260811-000648.log`, SHA-256 `64a46def904839fceaef396c60176305720e79304081ac0ae9c07cabf78a8c76`.
- No credentials, browser interaction, human handoff, provider API, or production surface was used.

## Delivered design

### Canonical contracts and typed outcomes

`lib/tenant-runtime-contracts` now owns the v1 eligibility metadata/envelope schemas, supported sealed capabilities, supported toolchain, canonical identity derivation, and result union. A result is either `zero_generation_eligible` or non-retryable `zero_capability_gap`; it is never a bare boolean. Reasons are typed and optionally identify only a sanitized file path:

| Reason                           | Meaning                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `undeclared_dependency`          | generated package declarations and the exact Pantry dependency plan disagree                     |
| `pantry_unresolvable_dependency` | the dynamic Pantry closure was not fully verified                                                |
| `credential_assumption`          | non-SDK generated code reads a disallowed environment value                                      |
| `port_manifest_incompatible`     | the sealed runtime is not aligned to Node API / port 8080 / `/healthz` / the shipped start shape |
| `unsupported_toolchain`          | the output is outside this Node-first slice                                                      |
| `raw_database_client`            | generated output bypasses the vendored database capability                                       |
| `raw_payment_client`             | generated output bypasses the vendored Stripe capability                                         |
| `arbitrary_runtime_fetch`        | generated server code attempts uncontrolled outbound access                                      |
| `tenant_package_install`         | generated runtime code attempts its own package acquisition                                      |
| `undeclared_capability`          | SDK use lacks matching declared capability coverage                                              |
| `dependency_output_unattested`   | dependency-complete output was not attested by the trusted build plane                           |
| `unclassified_integration`       | a blueprint or skill lacks valid authoritative metadata                                          |

The identity is SHA-256 over a domain-separated, canonically serialized semantic envelope: target, toolchain, sorted file hashes, exact dependency plan, manifest, capabilities, closure-verification fact, and output-attestation fact. Transient timestamps and execution details are absent. Integration metadata uses the same content-derived doctrine under a distinct domain tag.

### Exhaustive inventory

- 40/40 integration blueprints have `eligibility.json`.
- 31/31 relevant skills have `eligibility.json`.
- A marker-bearing blueprint/skill without a valid sidecar makes the inventory loader fail typed as `zero_eligibility_unclassified`; this is the CI tripwire for future additions.
- Legacy metadata is uniformly `{ mode: "direct", behavior: "preserve" }`.
- Pantry policy is uniformly `dynamic-demand-driven`; there is no positive package-name allowlist in metadata or selection logic.
- Package-name sets in the scanner are deny signatures for raw credential/network bypass clients, not eligibility lists. Dependency acceptance comes from the exact Pantry plan, verified closure, and build attestation.

Current sealed-eligible inventory:

| Kind      | Integration        | Resolution | Capability        |
| --------- | ------------------ | ---------- | ----------------- |
| blueprint | `db-neon`          | capability | `database`        |
| blueprint | `db-postgres`      | capability | `database`        |
| blueprint | `payments-stripe`  | capability | `stripe-payments` |
| skill     | `drizzle`          | capability | `database`        |
| skill     | `postgres-drizzle` | capability | `database`        |
| skill     | `stripe-payments`  | capability | `stripe-payments` |

All other entries fail closed for sealed mode. AI, auth, storage, messaging, deployment, observability, non-Node toolchains, and unbrokered databases/payments are therefore never allowed to turn into a secret request, direct migration, tenant install, uncontrolled fetch, or human stocking request. They return a typed capability gap so generation can select a supported implementation automatically.

### Generation-time enforcement

- The ordinary Node builder, agent-loop builder, and trusted kitchen all run the shared scanner for sealed generation.
- The source pass rejects bypasses before Pantry/build work. The attested-output pass also requires verified dynamic closure and trusted dependency-output attestation; this composes with the shipped build scanner and layer sealer rather than replacing either.
- Zero performs one bounded automatic regeneration using sanitized reason codes only. If the replacement remains ineligible, the typed gap is returned; there is no loop, egress escape, or operator request.
- Sealed skill listing exposes only eligible entries. A direct request for an ineligible skill returns a typed, content-addressed gap.
- Sealed blueprint knowledge is rebuilt from eligibility metadata, so stale `filesSnapshot` guidance cannot reintroduce old secret instructions. Legacy knowledge still reads exactly the existing stored text.
- Sealed database context no longer queries or solicits `DATABASE_URL`, drivers, or direct migrations. Legacy database context remains on the original direct path.

### Vendored capability guidance

- The existing vendored database SDK remains the only sealed database surface.
- A vendored payments module now exposes only the shipped Stripe capability operations: create a non-confirming PaymentIntent and retrieve an owned PaymentIntent.
- Cloudflare mode sends bounded unsigned intent to the trusted virtual capability handler and contains no credential or identity authority.
- Direct/Fly mode requires an explicitly injected direct adapter. The SDK does not acquire a Stripe key itself.
- The Node generation prompt names these surfaces and forbids direct drivers, secret environment reads, migrations, package installation, and arbitrary runtime fetch for sealed mode.

## Acceptance evidence

### Eligibility and generation matrix

| Proof                               | Result                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inventory completeness              | PASS — exactly 40 blueprints and 31 skills classified                                                                                                |
| Unclassified manifest tripwire      | PASS — missing sidecars return typed `unclassified_integration` inventory failure                                                                    |
| Every reason in the taxonomy        | PASS — targeted source/manifest/closure cases return the expected typed reason                                                                       |
| DB generated example                | PASS — sealed generation uses `createNabuFlowDatabase`; direct raw DB clients are rejected                                                           |
| Stripe generated example            | PASS — sealed generation uses `createNabuFlowPayments`; direct Stripe clients are rejected                                                           |
| Fly/direct adapters                 | PASS — legacy generation remains free of sealed additions; SDK direct behavior is explicitly injected and covered                                    |
| AI/auth/storage/messaging           | PASS — representative inventory entries are ineligible and expose no secret/network fallback                                                         |
| Automatic alternative               | PASS — first arbitrary-fetch output becomes a typed gap, one automatic replacement succeeds without Pantry/doorman configuration in user-facing text |
| Dynamic catalog                     | PASS — all 71 entries declare `dynamic-demand-driven`; scanner relies on Pantry closure/attestation, not a positive package allowlist                |
| Sealed guidance secret/install scan | PASS — zero matches for `DATABASE_URL`, `STRIPE_SECRET_KEY`, key/connection-string shapes, registry URLs, or install commands across all sidecars    |
| Legacy blueprint/skill authority    | PASS — zero changes to every `blueprint.json` and `SKILL.md`                                                                                         |
| Copy guard                          | PASS — 3/3 NabuFlow product / MustaFlow AI Technology company guard tests                                                                            |

### Automated verification

| Gate                                   | Result                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Slice-focused API suite                | PASS — 6 files, 64 tests                                                                                                                  |
| Tenant runtime contracts               | PASS — 17 files, 175 tests                                                                                                                |
| Runtime Worker package                 | PASS — 24 files, 194 tests                                                                                                                |
| Contracts lint/typecheck               | PASS                                                                                                                                      |
| Worker lint/typecheck                  | PASS                                                                                                                                      |
| Repository typecheck                   | PASS                                                                                                                                      |
| Repository lint                        | PASS                                                                                                                                      |
| Repository format check                | PASS                                                                                                                                      |
| Changed API files ESLint               | PASS                                                                                                                                      |
| `git diff --check`                     | PASS                                                                                                                                      |
| Ora fast stability profile             | PASS — clean-tree post-commit run: 15 passed / 0 warned / 0 failed (pre-commit was also green apart from its expected dirty-tree warning) |
| Release profile on slice               | EXPECTED ENVIRONMENTAL RED — 17 passed / 3 failed before commit; all failures originate at unavailable local Postgres `127.0.0.1:5432`    |
| Release profile at pristine exact base | EXACT PARITY — 18 passed / 3 failed; the same three stages and assertions fail for the same `ECONNREFUSED` root cause                     |

An unconstrained API-wide Vitest invocation was also attempted. It is not a hermetic suite on this lab: unrelated files require database state, Ora provider secrets, and integration URLs. The slice does not claim that invocation as a gate. The repository's focused suites plus the release-profile exact-base comparison are the authoritative local evidence.

### Staging/live surfaces

The recovered Slice 8 plan explicitly marks this slice as needing no deployment, account, credential, or human step. All behavior is production-inert and exercised at generation/contract level, so no staging Worker was deployed or rotated and no scratch runtime was created. Therefore:

- the four-surface post-rotation gate was not triggered;
- no new egress path exists, and tenant `enableInternet=false` / allowed-host configuration was not modified; the shipped blocked-520 proof remains the governing live evidence;
- neither build nor Pantry R2 received an object from this slice, so no cleanup/storage mutation was required.

This is intentional scope adherence, not a substituted live acceptance claim.

## Compatibility and change declaration

- Fly provider and Fly configuration: no files changed.
- Existing generation mode: legacy prompts, stored blueprint JSON, skill markdown, emitted file shape, and absence of sealed SDK files are covered as unchanged.
- Production mode selection: unchanged; sealed target remains explicit staging-only input.
- Tenant egress: unchanged.
- Artifact v1 and dependency layer contracts: unchanged.
- Package manifests: no `package.json` changed.
- Lockfile: `pnpm-lock.yaml` unchanged.
- Because no manifest or lockfile changed, the standing pristine frozen-install merge ritual was not triggered. The branch nevertheless has a successful frozen-lockfile installation from its fresh worktree, recorded above.

## Files changed by responsibility

- `lib/tenant-runtime-contracts/src/{zero-eligibility.ts,index.ts,runtime-sdk.ts}` and contract tests: canonical schemas, identities, typed reasons, payments capability contract.
- `artifacts/api-server/src/lib/zero-capability-eligibility*`: exhaustive inventory and content-derived source/output scanner.
- `builder.ts`, `agent-loop.ts`, `jobs.ts`, `knowledge.ts`, `builder-skills.ts`: generation-time consult, one bounded replacement, target-aware skills and blueprint knowledge, sealed DB guidance.
- `zero-sealed-generation.ts`, `zero-generation-kitchen.ts`: shared scan integration at source and attested-output boundaries.
- `zero-runtime-sdk.ts` and tests: additive vendored Stripe capability/direct-adapter module and dual-mode regressions.
- `blueprints/*/eligibility.json` (40) and `skills/*/eligibility.json` (31): exhaustive machine-readable inventory.

## Security findings and recommendations

1. The eligibility boundary is deliberately conservative. Integrations remain sealed-ineligible until a brokered capability exists and the metadata can describe it honestly; this is safer than treating a Pantry-resolvable SDK as runtime-safe.
2. `nabuflow/` remains generator-reserved by convention from Slice 7. Enforcing that reservation against user-authored collisions is still worth a dedicated hardening check before broad sealed-native availability.
3. The deny scanner is defense in depth, not a full JavaScript semantic analyzer. PG-5 should retain trusted build/sealer scans and add adversarial obfuscation coverage before production.
4. PG-3 continues to govern database policy/migrations; generator guidance intentionally does not grant direct migration authority.
5. PG-4 continues to govern payments production readiness; this slice exposes no new Stripe operation beyond the shipped capability.
6. Future capabilities should extend the contracts taxonomy and inventory atomically. No integration should be flipped eligible merely because its package stocks successfully.

## Exact-base parity addendum — 2026-08-11

The release profile was run independently in a clean detached worktree at exact base `3cc6f0579229275c4e1b2251e86110aae54511fa`, after a pristine frozen installation from the isolated checkout. Both base and branch failed exactly these three release stages:

1. `api-release-extended`: the two `ora-realtime-usage.test.ts` database cases fail to connect to `127.0.0.1:5432`.
2. `api-account-billing-history`: the two `ora-memory-consolidation.test.ts` API/DB cases receive 500 instead of 201 because local Postgres is unavailable.
3. `web-build`: compilation and bundle-size checks pass, then dynamic prerender fails to connect to `127.0.0.1:5432`.

Every other release-profile stage passes on both trees. The base completed with 18 pass / 0 warn / 3 fail; the pre-commit branch completed with 17 pass / 1 expected dirty-tree warning / 3 fail. The trailing `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL` / `tsx not found` text is the repository wrapper's first-failure artifact after the real gate failure, not an independent missing dependency; both clean and branch worktrees had `tsx` and used it throughout the profile.

Implementation commit `43d6ac3ba85f4292c6dd8e535a493daa8557dfea` was followed by the clean-tree fast profile above. The final pushed tip and permanent-doc copy hash are recorded in the delivery handoff.
