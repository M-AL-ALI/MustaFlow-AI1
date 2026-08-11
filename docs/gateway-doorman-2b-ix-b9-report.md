# Slice 2b-ix-b9 — Staging Acceptance Provisioner

- Date: 2026-08-11
- Branch: `codex/staging-acceptance-provisioner`
- Verified base: `242d445308492a51b2a7d8cf7e7e6d6a61bdd901`
- Delivery status: branch-only; no merge, publish, deployment, secret installation, or live provider call

## Scope restatement

This slice establishes the credential-free half of the staging Acceptance Provisioner: a separate, production-inert Worker; an encrypted Acceptance Vault; narrowly guarded Neon, Stripe-test, and disposable-Fly adapters; an opaque lease API; shared durable-job execution; TTL and cost controls; and independent janitor reconciliation. It deliberately stops before the founder's one-time atomic bootstrap. No provider management credential was requested, minted, installed, read, or used.

The shipped Stripe test capability is extended additively to accept least-privilege restricted test credentials (prefix written at rest as `rk_` + `test_`). Existing standard test behavior (`sk_` + `test_`) remains unchanged, while both live variants are rejected at the contract/vault and broker boundaries. Secret scanners recognize both restricted-key prefixes without retaining matched text.

## Authority and approved amendments

- Recovered build plan: `C:/Users/mus_1/Documents/Mustaflow AI/docs/gateway-doorman-2b-ix-b-build-plan.md`
  - SHA-256: `3b60669b59fb8bed7d9e7049e13390ad7d347210a8f57d130f59daa03f19324c`
- Durable design note: `C:/Users/mus_1/Documents/Mustaflow AI/docs/gateway-doorman-2b-ix-b-design.md`
  - amended before code for both founder decisions
  - SHA-256 after amendments: `06ecbd3fcae798af61899047ddad10358e91dd52e25507844e0e41b690315f14`

The Fly amendment replaces the superseded Fly-Secrets proposal. The Provisioner writes the disposable direct-mode `DATABASE_URL` server-to-server into the configuration of the exact lease-created disposable Machine through the documented Machines REST API. The value never appears in a lease response, audit, lab environment, Capability Vault record, gateway Worker, or CI output. `verify-gone` requires both Machine absence and configuration absence. The exception sunsets if Fly publishes a stable app-secret value-writing endpoint.

The Stripe amendment permits the restricted test prefix only on the test-mode acceptance path. The standard and restricted live variants (`sk_` + `live_`, `rk_` + `live_`) fail closed. Every accepted Stripe object must report `livemode === false`.

### Synthetic-secret fixture reconstruction

The first branch push was correctly blocked by GitHub push protection (`GH013`) because realistic synthetic Stripe values were stored contiguously in three test blobs. No real credential was present, and the founder explicitly declined a bypass.

The fixtures in `stripe-restricted-secret-scan.test.ts`, `runtime-artifact.test.ts`, and `runtime-artifact-layers.test.ts` now assemble the exact scanner inputs at runtime from separately committed kind, mode, separator, and suffix fragments. The same reconstruction rule was applied across every other changed test, assertion, validator spelling, report, and authority note. Production scanner semantics are unchanged: equivalent regular-expression spelling avoids storing the literal prefix while matching the identical runtime language.

Permanent rule: no committed test, fixture, evidence, report, or authority document may contain a contiguous literal matching a real credential pattern. Synthetic values exist only in memory or runtime temp files. Before push, the entire changed-blob set and both report copies are scanned; evidence records only sanitized path, rule ID, and redacted fingerprint, never matched text. Local history is rewritten so the rejected blob is absent from every commit in the pushed range.

Reconstruction proof: all 35 changed blobs, the durable design note, the branch report, the permanent report, and the evidence JSON were swept for the four Stripe prefix variants and a broader set of common provider-token/private-key patterns. At-rest matches: zero. The runtime scanner tests remain 21/21 green, demonstrating that the reconstructed values still reach the real scanner contiguously in memory.

## Architecture delivered

### Public contract

`lib/tenant-runtime-contracts` now defines:

- the strict lease, scope, request, opaque response, verify-gone, and typed-error schemas;
- canonical, content-derived lease and operation identities;
- 5–120 minute TTL bounds, a one-hour default, a hard cost ceiling, and a 50-record janitor batch bound;
- one named five-minute provider operation bound with a 30-second observation margin;
- short-lived workload claims capped at ten minutes;
- the `acceptance-lease` shared durable-job kind and its checkpoint sequence.

Responses are schema-closed. They can carry lease/resource IDs, provider, state, timestamps, and sanitized USD cost only. Connection strings, hostnames, credentials, and key fragments are rejected additions.

### Workload authentication and isolation

The service accepts ES256 workload JWTs only. Verification requires a configured public-key ID, issuer, audience, allowlisted subject, bounded lifetime, and valid raw P1363 signature. The private signer never belongs to this Worker.

Every lease stores a hash of the owner subject. Foreign and nonexistent leases return the same typed 403 body after removing the per-request UUID. Scope is checked before provider dispatch against one configured dedicated Neon organization, one configured Stripe test sandbox, or one configured disposable Fly organization. Cross-project Fly/Neon composition is rejected.

### Acceptance Vault

The Acceptance Vault Durable Object stores lease state, bounded metadata-only audit records, TTL alarms, and derived provider material. Derived material uses AES-256-GCM application-level envelope encryption with a fresh 96-bit nonce and AAD binding the ciphertext to lease identity, project, provider, material kind, and key revision. The exact 32-byte Base64URL/no-padding KEK is imported from a Worker secret binding; temporary byte copies are zeroed.

Provider management credentials are not persisted in the Durable Object. They remain Worker secret bindings after the later founder bootstrap.

### Durable execution and janitor

Lease mutations reuse the shipped queue-driven durable-operation chassis rather than creating a second coordinator. Requests claim, observe, or nudge; queue consumers own execution with checkpoints, heartbeat, lease adoption, named deadline terminalization, typed failure, and idempotent replay. Only typed retryable provider weather receives bounded exact-operation retry.

TTL alarms enqueue destruction. A five-minute scheduled janitor independently reconciles at most 50 records and also discovers lease-tagged provider resources whose locator was lost before vault persistence. This closes the create-response-loss orphan case without exposing a list route to the harness.

### Provider guards

All native provider traffic is server-to-server, bounded, and pinned to official origins. No endpoint, URL, hostname, credential, or provider request ID is included in the public error surface.

| Provider | Create/adopt posture                                                                                                  | Provision posture                                                                                       | Destroy/verify posture                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Neon     | Deterministic lease tag/name; read/list before create; adopt exact existing disposable project                        | connection URI is format/host checked, then encrypted or provisioned vault-to-vault                     | exact project delete; list/get verifies absence; janitor discovers tagged orphans                    |
| Stripe   | dedicated configured sandbox; restricted test key required; metadata + derived idempotency; `livemode:false` enforced | restricted test material goes directly to the project's Stripe capability record                        | lease-tagged test PaymentIntents are left in a known canceled state; list verifies no active residue |
| Fly      | deterministic disposable app/Machine; existing lease-tagged Machine is adopted                                        | database URL is written only after GET confirms exact lease/org ownership, via full Machine config POST | Machine and app are deleted; verify-gone requires Machine and configuration absence                  |

The adapter never accepts a tenant-controlled provider URL. Production Fly orgs, foreign resources, live Stripe mode, standard/live Provisioner Stripe keys, and foreign Neon organizations fail before a provider call.

### Opaque lease API

Prefix: `/_nabuflow/acceptance/v1`

| Method and path                               | Meaning                                                                                                                                                        |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /leases`                                | create/adopt one scoped lease                                                                                                                                  |
| `GET /leases/{leaseId}/status`                | read opaque state                                                                                                                                              |
| `POST /leases/{leaseId}/provision-capability` | vault-to-vault DB or Stripe-test capability provisioning                                                                                                       |
| `POST /leases/{leaseId}/provision-fly-secret` | write the referenced same-project Neon lease material into the exact disposable Fly Machine config; route name retained from the recovered contract vocabulary |
| `POST /leases/{leaseId}/destroy`              | durable teardown and capability revocation                                                                                                                     |
| `POST /leases/{leaseId}/verify-gone`          | typed resource/configuration absence proof                                                                                                                     |

Every mutation requires a bounded printable idempotency key. Idempotency identity is canonical and content-derived; changed bodies under one key return typed conflict.

## Credential-free acceptance

### Provisioner matrix

| Required behavior                                  | Result | Concrete proof                                                                                    |
| -------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------- |
| valid short-lived workload identity                | PASS   | ES256 verification accepts the configured issuer/audience/subject/key only                        |
| tampered, expired, wrong audience, foreign subject | PASS   | all reject before lease handling                                                                  |
| opaque response/redaction                          | PASS   | response and audit scans find no DB URL, host, or Stripe credential shape                         |
| idempotent create                                  | PASS   | replay returns the same lease; fake provider create count remains one                             |
| same key/different meaning                         | PASS   | typed `acceptance_idempotency_conflict`                                                           |
| cross-lease anti-enumeration                       | PASS   | foreign and nonexistent lease bodies are byte-equal after request UUID removal                    |
| cross-org/cross-sandbox/production target          | PASS   | identical typed scope failure; fake provider call count unchanged                                 |
| live Stripe target                                 | PASS   | schema/adapter rejection before provider call                                                     |
| cost ceiling                                       | PASS   | over-ceiling lease rejected before provider call                                                  |
| DB capability provisioning                         | PASS   | fake Neon material moves Acceptance Vault to Capability Vault without appearing in response/audit |
| restricted Stripe capability provisioning          | PASS   | synthetic restricted-test material moves vault-to-vault; policy required                          |
| Fly direct configuration custody                   | PASS   | exact lease-created Machine receives DB URL server-to-server; response/audit remain clean         |
| killed consumer                                    | PASS   | next consumer adopts destroy and reaches verified-gone without manual action                      |
| TTL expiry                                         | PASS   | alarm schedules durable destroy                                                                   |
| independent janitor                                | PASS   | fake provider residual resource is reconciled                                                     |
| locator-loss orphan                                | PASS   | tagged Neon resource created before vault persistence is discovered and removed                   |
| Fly verify-gone                                    | PASS   | both Machine and configuration absence are required                                               |

### Stripe contract, broker, and scanners

| Required behavior                                                                  | Result                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| contract accepts existing standard test prefix                                     | PASS; unchanged regression retained                                          |
| contract accepts additive restricted test prefix                                   | PASS                                                                         |
| contract rejects standard and restricted live prefixes                             | PASS                                                                         |
| Capability Vault accepts restricted test and rejects both live prefixes            | PASS                                                                         |
| broker accepts restricted test and retains `livemode:false` enforcement            | PASS                                                                         |
| broker rejects standard and restricted live prefixes                               | PASS                                                                         |
| API artifact/sealer, trusted-build, and agent redactors detect restricted variants | PASS                                                                         |
| scan evidence remains sanitized                                                    | PASS; path/category or path/rule/hash-prefix/offset only; never matched text |

### Automated results

| Command/suite                                            | Result                                    |
| -------------------------------------------------------- | ----------------------------------------- |
| `pnpm --filter @workspace/tenant-runtime-contracts test` | 18 files, 179/179 tests passed            |
| `pnpm --filter @workspace/nabuflow-runtime-worker test`  | 27 files, 211/211 tests passed            |
| focused workload/provider/Provisioner tests              | 3 files, 15/15 tests passed               |
| focused API restricted-key/artifact scanners             | 3 files, 21/21 tests passed               |
| Worker typecheck and lint                                | PASS                                      |
| contracts lint                                           | PASS                                      |
| repo-wide typecheck                                      | PASS                                      |
| repo-wide lint                                           | PASS                                      |
| format check                                             | PASS                                      |
| Wrangler Provisioner config dry-run                      | PASS; no deployment performed             |
| Ora fast profile                                         | 14 pass, 1 dirty-tree warning, 0 failures |

### Release-profile base parity

The branch and pristine exact base both fail exactly the same three database-dependent checks because this Windows lab has no PostgreSQL listener at `127.0.0.1:5432`:

1. `api-release-extended` — `ora-realtime-usage.test.ts` cannot connect.
2. `api-account-billing-history` — `ora-memory-consolidation.test.ts` receives API 500 instead of 201 after the DB refusal.
3. `web-build` — the bundle and size gate pass; dynamic-route prerender fails on the same DB refusal.

Exact base `242d4453` result: 18 pass, 0 warnings, 3 failures. The pre-commit branch result was 17 pass, 1 expected dirty-tree warning, and the same 3 failures. The final clean-tree branch result was 18 pass, 0 warnings, and the same 3 failures. No Provisioner, contract, broker, scanner, or Stripe assertion failed. Replit's Linux/DB-backed merge gate remains authoritative.

Durable raw reports:

- exact base SHA-256: `a0be09dbeea50c5bb1e41b5bcf476d30c5d0b9ce477fa1525d2f2bdcc6ea76f5`
- final reconstructed clean branch report: `C:/Users/mus_1/Documents/Mustaflow AI/docs/gateway-doorman-2b-ix-b9-reconstruction-release-gate-20260811T202300Z.md`
- final reconstructed clean branch report SHA-256: `e05812853794e9c15b2c3d3ab3578df816600725aefbafc4eee70e93426fbaa2`

The exact-base worktree used pnpm `10.26.1`; a clean `pnpm install --frozen-lockfile --prefer-offline` completed against the existing store in 660.163 seconds with zero downloads before the parity run.

## Manifest and shipped-surface declaration

No `package.json` and no `pnpm-lock.yaml` changed. The frozen-lockfile merge ritual is therefore not triggered by this slice.

One new staging deployment configuration, `artifacts/nabuflow-runtime-worker/wrangler.acceptance.jsonc`, is declared explicitly. It defaults to disabled, uses no workers.dev or preview URL, contains placeholder/nonsecret configuration only, and was dry-run validated. Nothing was deployed.

### New Provisioner files

- `lib/tenant-runtime-contracts/src/acceptance-provisioner.ts`
- `lib/tenant-runtime-contracts/test/acceptance-provisioner.test.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-model.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-workload-identity.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-vault-durable-object.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-provider-adapters.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-worker.ts`
- `artifacts/nabuflow-runtime-worker/src/acceptance-provisioner-index.ts`
- `artifacts/nabuflow-runtime-worker/test/acceptance-workload-identity.test.ts`
- `artifacts/nabuflow-runtime-worker/test/acceptance-provider-adapters.test.ts`
- `artifacts/nabuflow-runtime-worker/test/acceptance-provisioner.test.ts`
- `artifacts/nabuflow-runtime-worker/wrangler.acceptance.jsonc`

### Shared durable-job chassis files

- `lib/tenant-runtime-contracts/src/artifact-commit.ts` — adds the `acceptance-lease` job kind/checkpoints.
- `lib/tenant-runtime-contracts/src/index.ts` — exports the Provisioner contract.
- `artifacts/nabuflow-runtime-worker/src/model.ts` — models the additional shared job kind.
- `artifacts/nabuflow-runtime-worker/src/control-durable-object.ts` — typed acceptance abandonment/checkpoint support.
- `artifacts/nabuflow-runtime-worker/test/artifact-commit-coordinator.test.ts` — proves the Acceptance Provisioner consumes the shared chassis.

### Stripe contract and broker surface files

- `lib/tenant-runtime-contracts/src/capability-request.ts`
- `lib/tenant-runtime-contracts/test/capability-request.test.ts`
- `artifacts/nabuflow-runtime-worker/src/capability-vault-durable-object.ts`
- `artifacts/nabuflow-runtime-worker/src/stripe-broker.ts`
- `artifacts/nabuflow-runtime-worker/test/capability-vault.test.ts`
- `artifacts/nabuflow-runtime-worker/test/stripe-broker.test.ts`

### Secret scanner/redactor files

- `artifacts/api-server/src/lib/agent-loop.ts`
- `artifacts/api-server/src/lib/builder.ts`
- `artifacts/api-server/src/lib/runtime-artifact.ts`
- `artifacts/api-server/src/lib/runtime-artifact.test.ts`
- `artifacts/api-server/src/lib/runtime-artifact-layers.ts`
- `artifacts/api-server/src/lib/runtime-artifact-layers.test.ts`
- `artifacts/api-server/src/lib/stripe-restricted-secret-scan.test.ts`
- `artifacts/nabuflow-runtime-worker/src/trusted-build-cell.ts`
- `artifacts/nabuflow-runtime-worker/src/trusted-build-worker.ts`
- `artifacts/nabuflow-runtime-worker/test/trusted-build.test.ts`

No Cloudflare runtime provider selection, tenant egress, Artifact v1/layer wire format, tenant runtime, production configuration, production Fly code, or production traffic path changed.

## Bootstrap line — deliberately not crossed

The founder must perform the following later from a human-controlled secure terminal. No agent/browser automation may read or install a value.

### Exact secret bindings

1. `ACCEPTANCE_NEON_MANAGEMENT_KEY`
2. `ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY`
3. `ACCEPTANCE_FLY_ORG_TOKEN`
4. `ACCEPTANCE_VAULT_KEK`

The KEK is exactly 32 cryptographically random bytes encoded Base64URL without padding. The human installer must format-check it before submission. Stripe material must match the restricted test prefix; the standard test prefix, either live prefix, or an unknown format fails closed at the Provisioner boundary.

The complete four-key JSON object is supplied once to:

```text
wrangler secret bulk --config wrangler.acceptance.jsonc
```

through stdin from a human-owned secure prompt/launcher. Values must not appear in command arguments, shell history, a JSON file, clipboard automation, browser output, or terminal logs. After Wrangler confirms the write, inspect names/version only and clear the prompt/session input.

Before enabling or deploying, the human must also replace every inert nonsecret placeholder: workload public-key set, issuer, audience, subject allowlist, dedicated Neon organization ID, dedicated NabuFlow Testing Stripe sandbox ID, disposable Fly organization slug, pinned disposable Fly image, and cost ceiling. `ACCEPTANCE_STAGING_ENABLED` changes to `true` only after all guards validate.

### Post-bootstrap opaque verification

For each provider, the human-run verification uses only a short-lived workload token and opaque lease IDs:

1. create a Neon lease, reach active, provision the DB capability, destroy, then require `verify-gone` with project absent;
2. create a Stripe-test lease, reach active with `livemode:false`, provision the Stripe capability, destroy/cancel the tagged test object, then require `verify-gone` in a known test state;
3. create a Neon lease plus a Fly lease, use `provision-fly-secret` server-to-server, prove direct-mode configuration without receiving it, destroy both, then require Fly Machine/app/config and Neon project absence.

Afterward, confirm $0/known test cost, revoke paths, and no secret-shaped response/log/audit content. These live proofs are explicitly deferred; this delivery does not claim them.

## Recommendations and open gates

1. Bootstrap and the three opaque live lease proofs are the next hard checkpoint. Slices 10/11 must not rely on the Provisioner until that founder-run ceremony passes.
2. Keep the Stripe restricted key minimal: test PaymentIntent create/read/update/cancel permissions only, dedicated sandbox only. Never accept a standard test key in the Provisioner even though the existing broker remains backward compatible with it.
3. Verify Neon management-key scope in the provider account. If Neon cannot enforce project-only actions, the dedicated organization remains the hard isolation boundary.
4. Keep the Fly Machines config exception visibly bounded and remove it when a stable documented app-secret write API exists.
5. PG-1 still owns KEK/key-set overlap and rotation. This slice supplies a versioned `keyId` foundation, not finished rotation.
6. PG-3 and PG-4 remain hard gates for durable database/payment semantics. This service automates disposable acceptance resources; it does not weaken either product gate.

## Primary provider references

- Neon create/list/connection APIs: <https://api-docs.neon.tech/reference/createproject>, <https://api-docs.neon.tech/reference/listprojects>, <https://api-docs.neon.tech/reference/getconnectionuri>
- Stripe API keys and PaymentIntent listing: <https://docs.stripe.com/keys>, <https://docs.stripe.com/api/payment_intents/list>
- Fly Machines and Apps REST resources: <https://fly.io/docs/machines/api/>, <https://fly.io/docs/machines/api/machines-resource/>, <https://fly.io/docs/machines/api/apps-resource/>
